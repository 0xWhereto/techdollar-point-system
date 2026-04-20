'use strict';

/**
 * diminishingReturns
 * ------------------
 * Direct port of the gauge in almanac-engine/proving-ground/lib/diminishing_returns.cjs.
 *
 * The original module was written for an autonomous code-improvement loop —
 * "stop iterating when the proposer is no longer landing useful changes".
 * The same shape works for our points indexer — "warn when ticks are no
 * longer landing snapshots / accrual rows", which usually means every adapter
 * is in cooldown or every source is up-to-date.
 *
 * Pure functions, no side effects. The caller owns roundHistory and
 * decides what to do with the signal.
 */

const LAST_N_ROUNDS = 5;
const AVG_LANDED_THRESHOLD = 1.0;
const ROUNDS_SINCE_LANDING_STOP = 5;
const MAX_HISTORY = 100;

function recordRound(history, { attempted, landed, at }) {
  if (!Array.isArray(history)) return null;
  // roundNumber must grow monotonically even after we trim history. Derive
  // it from the previous round's number, NOT from history.length (otherwise
  // the counter rewinds the moment trimming kicks in).
  const last = history.length ? history[history.length - 1] : null;
  const round = {
    roundNumber: (last?.roundNumber || 0) + 1,
    attempted: Number(attempted) || 0,
    landed: Number(landed) || 0,
    timestamp: (at instanceof Date ? at : new Date()).toISOString()
  };
  history.push(round);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return round;
}

function computeAvgLanded(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const tail = history.slice(-LAST_N_ROUNDS);
  const total = tail.reduce((s, r) => s + (Number(r?.landed) || 0), 0);
  return total / tail.length;
}

function computeRoundsSinceLastLanding(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if ((Number(history[i]?.landed) || 0) > 0) break;
    count += 1;
  }
  return count;
}

/**
 * Returns true when EITHER:
 *   - we've completed at least LAST_N_ROUNDS rounds AND avg landed < threshold; OR
 *   - we've had ROUNDS_SINCE_LANDING_STOP consecutive rounds with zero landings.
 * Either signal means the loop is doing no useful work.
 */
function isExhausted(history) {
  if (!Array.isArray(history) || history.length < LAST_N_ROUNDS) return false;
  if (computeAvgLanded(history) < AVG_LANDED_THRESHOLD) return true;
  if (computeRoundsSinceLastLanding(history) >= ROUNDS_SINCE_LANDING_STOP) return true;
  return false;
}

module.exports = {
  recordRound,
  computeAvgLanded,
  computeRoundsSinceLastLanding,
  isExhausted,
  // exported for tests + tunable for ops
  constants: { LAST_N_ROUNDS, AVG_LANDED_THRESHOLD, ROUNDS_SINCE_LANDING_STOP, MAX_HISTORY }
};
