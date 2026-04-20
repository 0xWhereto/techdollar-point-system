const { Op, fn, col, literal } = require('sequelize');
const {
  PointAccrual,
  PointSource,
  PointEpoch,
  BalanceSnapshot,
  sequelize
} = require('../models');

/**
 * Read-side service. Reports leaderboard, per-address breakdown and source
 * catalog from the accrual table.
 *
 * `mode='live'` excludes simulation epochs from public-facing numbers.
 * `mode='all'` includes everything (used by admin tools and pre-launch tests).
 */

function modeFilter(mode) {
  if (mode === 'all') return {};
  return { mode: mode || 'live' };
}

async function getLeaderboard({ limit = 50, offset = 0, mode = 'live' } = {}) {
  const rows = await PointAccrual.findAll({
    where: modeFilter(mode),
    attributes: [
      'address',
      [fn('SUM', col('points')), 'total_points']
    ],
    group: ['address'],
    order: [[literal('total_points'), 'DESC']],
    limit,
    offset,
    raw: true
  });

  // Total addresses with any points (for pagination)
  const totalRow = await PointAccrual.findOne({
    where: modeFilter(mode),
    attributes: [[fn('COUNT', fn('DISTINCT', col('address'))), 'cnt']],
    raw: true
  });
  const total = totalRow ? Number(totalRow.cnt) : 0;

  return {
    entries: rows.map((r, i) => ({
      rank: offset + i + 1,
      address: r.address,
      points: Number(r.total_points)
    })),
    total
  };
}

async function getAddressTotals(address, { mode = 'live' } = {}) {
  if (!address) return { total: 0, sources: [], rank: null };
  const lc = address.toLowerCase();

  const rows = await PointAccrual.findAll({
    where: { address: lc, ...modeFilter(mode) },
    attributes: [
      'sourceId',
      [fn('SUM', col('points')), 'total_points'],
      [fn('SUM', col('base_points')), 'base_points']
    ],
    group: ['sourceId'],
    raw: true
  });

  const sourceIds = rows.map(r => r.sourceId);
  const sources = sourceIds.length
    ? await PointSource.findAll({ where: { id: sourceIds } })
    : [];
  const sourceMap = new Map(sources.map(s => [s.id, s]));

  const breakdown = rows.map(r => {
    const src = sourceMap.get(r.sourceId);
    return {
      sourceId: r.sourceId,
      sourceKey: src?.key,
      sourceName: src?.name,
      sourceType: src?.sourceType,
      multiplier: Number(src?.multiplier ?? 1),
      points: Number(r.total_points),
      basePoints: Number(r.base_points)
    };
  }).sort((a, b) => b.points - a.points);

  const total = breakdown.reduce((s, x) => s + x.points, 0);

  // Rank: count addresses with strictly more points than this caller, in the
  // same mode. mode='all' must NOT be coerced to 'live' — that would make the
  // rank wrong during simulation. We use a parameterless WHERE for 'all', and
  // a parameterized WHERE for 'live' (works the same on SQLite + Postgres).
  let rank = null;
  if (total > 0) {
    const sql = mode === 'all'
      ? `SELECT COUNT(*) AS cnt FROM (
           SELECT address, SUM(points) AS p
           FROM point_accruals
           GROUP BY address
           HAVING SUM(points) > :total
         ) sub`
      : `SELECT COUNT(*) AS cnt FROM (
           SELECT address, SUM(points) AS p
           FROM point_accruals
           WHERE mode = :mode
           GROUP BY address
           HAVING SUM(points) > :total
         ) sub`;
    const replacements = mode === 'all' ? { total } : { mode, total };
    const ranked = await sequelize.query(sql, {
      replacements,
      type: sequelize.QueryTypes.SELECT
    });
    rank = Number(ranked[0]?.cnt || 0) + 1;
  }

  return { address: lc, total, sources: breakdown, rank };
}

async function getCurrentExposure(address) {
  if (!address) return [];
  const lc = address.toLowerCase();
  const sources = await PointSource.findAll({ where: { isActive: true } });

  const out = [];
  for (const s of sources) {
    const latest = await BalanceSnapshot.findOne({
      where: { sourceId: s.id, address: lc },
      order: [['snapshotAt', 'DESC']]
    });
    const basePerDay = Number(s.basePointsPerUsdPerDay);
    const multiplier = Number(s.multiplier);
    const usd = latest ? Number(latest.usdValue) : 0;
    out.push({
      sourceKey: s.key,
      sourceName: s.name,
      sourceType: s.sourceType,
      multiplier,
      basePointsPerUsdPerDay: basePerDay,
      currentUsdValue: usd,
      lastSnapshotAt: latest ? latest.snapshotAt : null,
      projectedDailyPoints: usd * basePerDay * multiplier
    });
  }
  return out;
}

async function getSources() {
  const sources = await PointSource.findAll({
    order: [['multiplier', 'ASC'], ['name', 'ASC']]
  });
  return sources.map(s => ({
    key: s.key,
    name: s.name,
    description: s.description,
    sourceType: s.sourceType,
    multiplier: Number(s.multiplier),
    basePointsPerUsdPerDay: Number(s.basePointsPerUsdPerDay),
    isActive: s.isActive,
    isConfigured: s.contractAddress && s.contractAddress !== '0x0000000000000000000000000000000000000000',
    contractAddress: s.contractAddress,
    extraConfig: s.extraConfig
  }));
}

async function getEpochs() {
  const epochs = await PointEpoch.findAll({ order: [['startAt', 'ASC']] });
  return epochs.map(e => ({
    key: e.key,
    name: e.name,
    description: e.description,
    mode: e.mode,
    boost: Number(e.boost),
    startAt: e.startAt,
    endAt: e.endAt,
    isActive: e.isActive
  }));
}

async function getStats({ mode = 'live' } = {}) {
  const totalRow = await PointAccrual.findOne({
    where: modeFilter(mode),
    attributes: [
      [fn('SUM', col('points')), 'total_points'],
      [fn('COUNT', fn('DISTINCT', col('address'))), 'unique_users']
    ],
    raw: true
  });

  const bySource = await PointAccrual.findAll({
    where: modeFilter(mode),
    attributes: ['sourceId', [fn('SUM', col('points')), 'total_points']],
    group: ['sourceId'],
    raw: true
  });

  const sources = await PointSource.findAll();
  const sm = new Map(sources.map(s => [s.id, s]));

  return {
    totalPoints: Number(totalRow?.total_points || 0),
    uniqueUsers: Number(totalRow?.unique_users || 0),
    bySource: bySource.map(r => ({
      key: sm.get(r.sourceId)?.key,
      name: sm.get(r.sourceId)?.name,
      points: Number(r.total_points)
    }))
  };
}

module.exports = {
  getLeaderboard,
  getAddressTotals,
  getCurrentExposure,
  getSources,
  getEpochs,
  getStats
};
