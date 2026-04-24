const { Op, fn, col, literal } = require('sequelize');
const {
  PointAccrual,
  PointSource,
  PointEpoch,
  BalanceSnapshot,
  sequelize
} = require('../models');

/**
 * Read-side service. Reports leaderboard, per-address breakdown, per-source
 * positions and per-hour earning rate from the accrual + snapshot tables.
 *
 * `mode='live'` excludes simulation epochs from public-facing numbers.
 * `mode='all'` includes everything (used by admin tools and pre-launch tests).
 *
 * Frontend contract (stable, used by Points.jsx):
 *
 *   GET /api/points/wallet/:address  → getWalletSummary()
 *     {
 *       address, lifetimePoints, pointsPerHour, pointsPerDay, rank,
 *       epoch:    { key, name, mode, boost, startAt, endAt },
 *       positions: Position[],
 *       exposure:  Position[]    // alias of positions, for backward compat
 *     }
 *
 *   Position = {
 *     sourceKey, sourceName, sourceType, accrualType, multiplier,
 *     basePointsPerUsdPerDay,
 *     currentUsdValue,           // null for mint_event sources
 *     lifetimePoints,            // sum of all PointAccrual.points for this source/address
 *     lifetimeMintedUsd,         // mint_event only — sum of avg_usd_value
 *     pointsPerHour,             // currentUsd × basePts/24 × mult × epochBoost  (0 for mint_event)
 *     pointsPerDay,              // pointsPerHour × 24                            (0 for mint_event)
 *     projectedDailyPoints,      // alias of pointsPerDay, for backward compat
 *     lastSnapshotAt,            // time-weighted only
 *     lastEventAt                // mint_event only
 *   }
 */

// ---------- Pure helpers (exported for unit tests) ----------

/**
 * Pure: compute the per-hour points rate for a single position.
 *
 *   time_weighted: usd × basePerDay × multiplier × epochBoost / 24
 *   mint_event   : 0 (one-shot, no continuous accrual)
 */
function computePointsPerHour({ accrualType, currentUsdValue, basePerDay, multiplier, epochBoost }) {
  if (accrualType === 'mint_event') return 0;
  const usd = Number(currentUsdValue);
  const bpd = Number(basePerDay);
  const m = Number(multiplier);
  const b = Number(epochBoost);
  if (!Number.isFinite(usd) || !Number.isFinite(bpd) || !Number.isFinite(m) || !Number.isFinite(b)) return 0;
  if (usd <= 0 || bpd <= 0 || m <= 0 || b <= 0) return 0;
  return (usd * bpd * m * b) / 24;
}

/**
 * Pure: aggregate a list of positions into a wallet summary rate.
 */
function aggregateRate(positions) {
  let pph = 0;
  let life = 0;
  for (const p of positions) {
    pph += Number(p.pointsPerHour) || 0;
    life += Number(p.lifetimePoints) || 0;
  }
  return {
    pointsPerHour: pph,
    pointsPerDay: pph * 24,
    lifetimePoints: life
  };
}

// ---------- DB-backed helpers ----------

function modeFilter(mode) {
  if (mode === 'all') return {};
  return { mode: mode || 'live' };
}

async function getActiveEpoch(now = new Date()) {
  const epochs = await PointEpoch.findAll({
    where: { isActive: true },
    order: [['startAt', 'ASC']]
  });
  for (const e of epochs) {
    const s = e.startAt.getTime();
    const eEnd = e.endAt ? e.endAt.getTime() : Number.POSITIVE_INFINITY;
    if (now.getTime() >= s && now.getTime() < eEnd) return e;
  }
  return null;
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

/**
 * Per-source positions for a wallet — the source of truth that the dashboard
 * renders from. Includes the current USD value, lifetime points, per-hour and
 * per-day earning rate (after epoch boost), and event-source extras.
 */
async function getPositions(address, { mode = 'live', now = new Date() } = {}) {
  if (!address) return [];
  const lc = address.toLowerCase();

  const sources = await PointSource.findAll({ where: { isActive: true } });
  if (!sources.length) return [];

  const activeEpoch = await getActiveEpoch(now);
  const epochBoost = activeEpoch ? Number(activeEpoch.boost) : 1.0;

  // One grouped query for lifetime totals + lifetime minted USD per source.
  const totals = await PointAccrual.findAll({
    where: { address: lc, ...modeFilter(mode) },
    attributes: [
      'sourceId',
      'accrualType',
      [fn('SUM', col('points')), 'total_points'],
      [fn('SUM', col('avg_usd_value')), 'sum_usd_value'],
      [fn('MAX', col('period_start')), 'last_at']
    ],
    group: ['sourceId', 'accrualType'],
    raw: true
  });
  // Keyed by sourceId. Each entry can hold both time_weighted and mint_event
  // aggregates because a source might (in pathological cases) carry both —
  // usdte_mint only emits mint_event rows, the rest only emit time_weighted.
  const totalsBySource = new Map();
  for (const t of totals) {
    const cur = totalsBySource.get(t.sourceId) || { lifetimePoints: 0, lifetimeMintedUsd: 0, lastEventAt: null };
    const pts = Number(t.total_points) || 0;
    cur.lifetimePoints += pts;
    if (t.accrualType === 'mint_event') {
      cur.lifetimeMintedUsd += Number(t.sum_usd_value) || 0;
      const at = t.last_at ? new Date(t.last_at) : null;
      if (at && (!cur.lastEventAt || at > cur.lastEventAt)) cur.lastEventAt = at;
    }
    totalsBySource.set(t.sourceId, cur);
  }

  const positions = [];
  for (const s of sources) {
    const isEvent = s.sourceType === 'erc20_mint_event';
    const basePerDay = s.basePointsPerUsdPerDay !== null && s.basePointsPerUsdPerDay !== undefined
      ? Number(s.basePointsPerUsdPerDay)
      : 0;
    const multiplier = Number(s.multiplier);

    let currentUsdValue = null;
    let lastSnapshotAt = null;
    if (!isEvent) {
      const latest = await BalanceSnapshot.findOne({
        where: { sourceId: s.id, address: lc },
        order: [['snapshotAt', 'DESC']]
      });
      currentUsdValue = latest ? Number(latest.usdValue) : 0;
      lastSnapshotAt = latest ? latest.snapshotAt : null;
    }

    const accrualType = isEvent ? 'mint_event' : 'time_weighted';
    const pointsPerHour = computePointsPerHour({
      accrualType,
      currentUsdValue,
      basePerDay,
      multiplier,
      epochBoost
    });
    const pointsPerDay = pointsPerHour * 24;

    const agg = totalsBySource.get(s.id) || { lifetimePoints: 0, lifetimeMintedUsd: 0, lastEventAt: null };

    positions.push({
      sourceKey: s.key,
      sourceName: s.name,
      sourceType: s.sourceType,
      accrualType,
      multiplier,
      basePointsPerUsdPerDay: isEvent ? null : basePerDay,
      currentUsdValue: isEvent ? null : currentUsdValue,
      lifetimePoints: agg.lifetimePoints,
      lifetimeMintedUsd: isEvent ? agg.lifetimeMintedUsd : null,
      pointsPerHour,
      pointsPerDay,
      projectedDailyPoints: pointsPerDay,                  // backward-compat alias for old frontend
      lastSnapshotAt,
      lastEventAt: isEvent ? agg.lastEventAt : null
    });
  }
  return positions;
}

/**
 * Backward-compat alias for the older frontend code that imported
 * `getCurrentExposure`. New callers should prefer `getPositions`.
 */
async function getCurrentExposure(address, opts = {}) {
  return getPositions(address, opts);
}

/**
 * Single-roundtrip dashboard payload: totals + positions + aggregated rate.
 * This is what GET /wallet/:address and GET /me return.
 */
async function getWalletSummary(address, { mode = 'live', now = new Date() } = {}) {
  if (!address) {
    return {
      address: null,
      lifetimePoints: 0,
      pointsPerHour: 0,
      pointsPerDay: 0,
      rank: null,
      epoch: null,
      sources: [],
      positions: [],
      exposure: []
    };
  }
  const lc = address.toLowerCase();

  // Run independent queries in parallel.
  const [totals, positions, activeEpoch] = await Promise.all([
    getAddressTotals(lc, { mode }),
    getPositions(lc, { mode, now }),
    getActiveEpoch(now)
  ]);

  const rate = aggregateRate(positions);
  // Prefer the snapshot-table-derived lifetime (totals.total) — it's the
  // source of truth used by the leaderboard. The aggregated `rate.lifetimePoints`
  // can lag during a tick if positions were just queried mid-write.
  const lifetimePoints = totals.total;

  return {
    address: lc,
    lifetimePoints,
    pointsPerHour: rate.pointsPerHour,
    pointsPerDay: rate.pointsPerDay,
    rank: totals.rank,
    epoch: activeEpoch ? {
      key: activeEpoch.key,
      name: activeEpoch.name,
      mode: activeEpoch.mode,
      boost: Number(activeEpoch.boost),
      startAt: activeEpoch.startAt,
      endAt: activeEpoch.endAt
    } : null,
    sources: totals.sources,                                // legacy breakdown by source
    positions,                                              // rich per-source positions (preferred)
    exposure: positions                                     // alias for backward compat
  };
}

/**
 * Lightest possible read: just the rate — useful for a "ticker" component
 * that polls every few seconds without dragging the whole positions payload.
 */
async function getWalletRate(address, { mode = 'live', now = new Date() } = {}) {
  if (!address) return { pointsPerHour: 0, pointsPerDay: 0, epochBoost: 1.0 };
  const positions = await getPositions(address, { mode, now });
  const rate = aggregateRate(positions);
  const activeEpoch = await getActiveEpoch(now);
  return {
    address: address.toLowerCase(),
    pointsPerHour: rate.pointsPerHour,
    pointsPerDay: rate.pointsPerDay,
    epochBoost: activeEpoch ? Number(activeEpoch.boost) : 1.0,
    epochKey: activeEpoch?.key || null,
    epochMode: activeEpoch?.mode || null
  };
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
    accrualType: s.sourceType === 'erc20_mint_event' ? 'mint_event' : 'time_weighted',
    multiplier: Number(s.multiplier),
    basePointsPerUsdPerDay: s.basePointsPerUsdPerDay !== null && s.basePointsPerUsdPerDay !== undefined
      ? Number(s.basePointsPerUsdPerDay)
      : null,
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
  getPositions,
  getCurrentExposure,
  getWalletSummary,
  getWalletRate,
  getActiveEpoch,
  getSources,
  getEpochs,
  getStats,
  // Pure helpers exposed for unit testing
  computePointsPerHour,
  aggregateRate
};
