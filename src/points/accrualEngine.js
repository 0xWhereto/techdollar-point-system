const { Op } = require('sequelize');
const {
  PointSource,
  BalanceSnapshot,
  PointAccrual,
  PointEpoch,
  PointsExcludedAddress
} = require('../models');
const logger = require('../utils/logger');

/**
 * accrualEngine
 * -------------
 * Pure(ish) function that turns BalanceSnapshot rows into PointAccrual rows.
 *
 * For each (source, address):
 *   - read snapshots in chronological order
 *   - between two consecutive snapshots S_i and S_{i+1} the user held
 *     `avg(S_i.usdValue, S_{i+1}.usdValue)` USD-equivalent for
 *     `S_{i+1}.snapshotAt - S_i.snapshotAt` seconds
 *   - points for that interval =
 *         avgUsd * durationDays * basePointsPerUsdPerDay
 *               * source.multiplier * epoch.boost
 *
 * The algorithm is idempotent: a (source, address, periodStart) is unique,
 * so re-running on the same data is a no-op (insert-or-skip).
 *
 * Each interval is tagged with the epoch active at periodStart and inherits
 * that epoch's `mode` (simulation vs live), so pre-launch testing data is
 * isolated from live leaderboard data.
 */

let cachedEpochs = null;
let cachedExcluded = null;

async function loadEpochs() {
  if (cachedEpochs) return cachedEpochs;
  cachedEpochs = await PointEpoch.findAll({
    where: { isActive: true },
    order: [['startAt', 'ASC']]
  });
  return cachedEpochs;
}

async function loadExcluded() {
  if (cachedExcluded) return cachedExcluded;
  const rows = await PointsExcludedAddress.findAll({ raw: true });
  cachedExcluded = new Set(rows.map(r => r.address.toLowerCase()));
  return cachedExcluded;
}

function invalidateCaches() {
  cachedEpochs = null;
  cachedExcluded = null;
}

function pickEpoch(epochs, t) {
  // Find the epoch whose [startAt, endAt) contains t. If none, default to live.
  for (const e of epochs) {
    const s = e.startAt.getTime();
    const eEnd = e.endAt ? e.endAt.getTime() : Number.POSITIVE_INFINITY;
    if (t >= s && t < eEnd) return e;
  }
  return null;
}

/**
 * Pure: turn an ordered list of snapshots for ONE address into accrual rows.
 *
 * Exposed as a top-level export so it can be unit-tested without a database.
 * The DB-touching `processSource` reuses this function for every address.
 *
 * Each snapshot is the row stored on disk; it may be either the model
 * instance shape (camelCase: snapshotAt, usdValue) or the `raw:true`
 * underscored shape (snapshot_at, usd_value). We accept both.
 *
 * @param {Array}  snapshots  in chronological order, all for the same address
 * @param {Object} source     plain object with id, multiplier, basePointsPerUsdPerDay
 * @param {Array}  epochs     active PointEpoch rows
 * @param {Set}    excluded   lower-cased addresses to skip entirely
 * @param {string} address    lowercased address for these snapshots
 * @returns {Array} accrual row objects ready for PointAccrual.create
 */
function computeAccrualRows(snapshots, source, epochs, excluded, address) {
  if (!snapshots || snapshots.length < 2) return [];
  if (excluded && excluded.has(address)) return [];

  const basePerDay = parseFloat(source.basePointsPerUsdPerDay);
  const multiplier = parseFloat(source.multiplier);
  if (!Number.isFinite(basePerDay) || !Number.isFinite(multiplier)) return [];

  const ts = (s) => s.snapshotAt || s.snapshot_at;
  const usd = (s) => s.usdValue ?? s.usd_value;

  const out = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const periodStart = new Date(ts(prev));
    const periodEnd = new Date(ts(curr));
    const durationSeconds = Math.max(0, Math.floor((periodEnd - periodStart) / 1000));
    if (durationSeconds === 0) continue;

    const epoch = pickEpoch(epochs, periodStart.getTime());
    if (!epoch) continue;

    const avgUsd = (parseFloat(usd(prev)) + parseFloat(usd(curr))) / 2;
    if (!(avgUsd > 0)) continue;

    const durationDays = durationSeconds / 86400;
    const basePoints = avgUsd * durationDays * basePerDay;
    const epochBoost = parseFloat(epoch.boost);
    const points = basePoints * multiplier * epochBoost;

    out.push({
      sourceId: source.id,
      epochId: epoch.id,
      address,
      periodStart,
      periodEnd,
      durationSeconds,
      avgUsdValue: avgUsd,
      basePoints,
      multiplier,
      epochBoost,
      points,
      mode: epoch.mode
    });
  }
  return out;
}

async function processSource(source, { since, upTo } = {}) {
  const epochs = await loadEpochs();
  const excluded = await loadExcluded();
  const basePerDay = parseFloat(source.basePointsPerUsdPerDay);
  const multiplier = parseFloat(source.multiplier);

  const where = { sourceId: source.id };
  if (since) where.snapshotAt = { [Op.gte]: since };
  if (upTo) where.snapshotAt = Object.assign(where.snapshotAt || {}, { [Op.lte]: upTo });

  const snapshots = await BalanceSnapshot.findAll({
    where,
    order: [['address', 'ASC'], ['snapshotAt', 'ASC']],
    raw: true
  });

  // Group by address
  const byAddr = new Map();
  for (const s of snapshots) {
    if (excluded.has(s.address)) continue;
    if (!byAddr.has(s.address)) byAddr.set(s.address, []);
    byAddr.get(s.address).push(s);
  }

  let written = 0;
  for (const [address, list] of byAddr.entries()) {
    const rows = computeAccrualRows(list, source, epochs, excluded, address);
    for (const row of rows) {
      try {
        await PointAccrual.create(row);
        written++;
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') {
          logger.warn(`[accrual] ${source.key} ${address} ${row.periodStart.toISOString()}: ${err.message}`);
        }
        // SequelizeUniqueConstraintError is the idempotency anchor — expected.
      }
    }
  }
  return written;
}

async function processAll(opts = {}) {
  const sources = await PointSource.findAll({ where: { isActive: true } });
  let total = 0;
  for (const s of sources) {
    const n = await processSource(s, opts);
    if (n) logger.info(`[accrual] ${s.key}: wrote ${n} accrual rows`);
    total += n;
  }
  return total;
}

module.exports = {
  processSource,
  processAll,
  invalidateCaches,
  // exported for unit testing
  computeAccrualRows,
  pickEpoch
};
