const { ethers } = require('ethers');
const BaseAdapter = require('./BaseAdapter');
const {
  BalanceEvent,
  PointAccrual,
  PointEpoch,
  PointsExcludedAddress
} = require('../../models');
const { ERC20_ABI, EVENT_BLOCK_RANGE } = require('../config');
const { PointsError } = require('../errors');
const pLimit = require('../pLimit');

const RPC_CONCURRENCY = Math.min(
  25,
  Math.max(1, parseInt(process.env.POINTS_RPC_CONCURRENCY || '10', 10))
);

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * Pick the epoch whose [startAt, endAt) contains timestamp t (ms). Returns
 * null when t falls outside every epoch.
 */
function pickEpochFor(epochs, t) {
  if (!epochs) return null;
  for (const e of epochs) {
    const s = e.startAt instanceof Date ? e.startAt.getTime() : new Date(e.startAt).getTime();
    const eEnd = e.endAt
      ? (e.endAt instanceof Date ? e.endAt.getTime() : new Date(e.endAt).getTime())
      : Number.POSITIVE_INFINITY;
    if (t >= s && t < eEnd) return e;
  }
  return null;
}

/**
 * Pure: turn one mint event into a PointAccrual row (or null when the event
 * should be skipped — excluded address, zero amount, no active epoch).
 *
 * Exposed as a top-level function so it can be unit-tested without an
 * RPC, a database, or instantiating the adapter.
 */
function computeMintAccrualRow(event) {
  const {
    address,
    mintedRaw,
    decimals = 18,
    blockTime,
    txHash,
    sourceId,
    multiplier,
    pointsPerMint,
    pegUsd = 1.0,
    epochs,
    excluded
  } = event;

  const addr = (address || '').toLowerCase();
  if (!addr || addr === ZERO_ADDR) return null;
  if (excluded && excluded.has(addr)) return null;

  let mintedRawBig;
  try {
    mintedRawBig = typeof mintedRaw === 'bigint' ? mintedRaw : BigInt(mintedRaw || 0);
  } catch {
    return null;
  }
  if (mintedRawBig <= 0n) return null;

  const m = parseFloat(multiplier);
  const ppm = parseFloat(pointsPerMint);
  if (!Number.isFinite(m) || !Number.isFinite(ppm)) return null;

  const mintedUsd = Number(ethers.formatUnits(mintedRawBig, decimals)) * (parseFloat(pegUsd) || 1.0);
  if (!(mintedUsd > 0)) return null;

  const t = blockTime instanceof Date ? blockTime : new Date(blockTime);
  const epoch = pickEpochFor(epochs, t.getTime());
  if (!epoch) return null;

  const basePoints = mintedUsd * ppm;
  const epochBoost = parseFloat(epoch.boost);
  const points = basePoints * m * epochBoost;

  return {
    sourceId,
    epochId: epoch.id,
    address: addr,
    periodStart: t,
    periodEnd: t,
    durationSeconds: 0,
    avgUsdValue: mintedUsd,
    basePoints,
    multiplier: m,
    epochBoost,
    points,
    mode: epoch.mode,
    accrualType: 'mint_event',
    txHash: (txHash || '').toLowerCase()
  };
}

/**
 * Erc20MintEventAdapter
 * ---------------------
 * One-shot points for ERC20 mints (Transfer from 0x0 → user). Used by USDte
 * minting per the spec:
 *
 *   - Mint = event-based bonus (not time-weighted)
 *   - Hold/Stake/LP/Morpho = time-weighted (handled by other adapters)
 *
 * Per mint event:
 *
 *   mintedUsd = amountRaw / 10^decimals * pegUsd
 *   points    = mintedUsd * pointsPerMint * source.multiplier * epoch.boost
 *
 * Idempotency: every accrual row carries the originating tx hash. The unique
 * index (source_id, address, period_start, tx_hash) is the dedup anchor — we
 * can re-scan a block range any number of times without double-counting.
 *
 * The adapter never produces BalanceSnapshot rows. It overrides snapshotAll()
 * to return [] and does its work in processEventAccruals(now), which the
 * orchestrator calls explicitly after discoverHolders().
 */
class Erc20MintEventAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.contract = new ethers.Contract(this.address, ERC20_ABI, this.provider);

    const cfg = this.source.extraConfig || {};
    this.pointsPerMint = Number.isFinite(parseFloat(cfg.pointsPerMint))
      ? parseFloat(cfg.pointsPerMint)
      : 10.0;                                         // matches "10 points per USDte minted"
    this.pegUsd = Number.isFinite(parseFloat(cfg.pegUsd))
      ? parseFloat(cfg.pegUsd)
      : 1.0;
    this.fromAddress = (cfg.fromAddress || ethers.ZeroAddress).toLowerCase();

    // Caches loaded once per tick; refreshed when reloadSources() invalidates them.
    this._epochs = null;
    this._excluded = null;
  }

  async _loadCaches() {
    this._epochs = await PointEpoch.findAll({
      where: { isActive: true },
      order: [['startAt', 'ASC']]
    });
    const excludedRows = await PointsExcludedAddress.findAll({ raw: true });
    this._excluded = new Set(excludedRows.map(r => r.address.toLowerCase()));
  }

  /**
   * Scan Transfer(from = fromAddress, to = *) for new mint events since the
   * last indexed block. Persist a BalanceEvent audit row for each, and add
   * the recipient to the holder set so other adapters can use it too.
   */
  async discoverHolders() {
    const tip = await this.provider.getBlockNumber();
    const from = this.source.lastIndexedBlock
      ? Number(this.source.lastIndexedBlock) + 1
      : (this.source.startBlock ? Number(this.source.startBlock) : tip - EVENT_BLOCK_RANGE);
    if (from > tip) {
      this._pendingMints = [];
      return [];
    }

    const newHolders = [];
    const pending = [];
    let cursor = from;
    while (cursor <= tip) {
      const upper = Math.min(cursor + EVENT_BLOCK_RANGE, tip);
      try {
        const filter = this.contract.filters.Transfer(this.fromAddress, null);
        const events = await this.contract.queryFilter(filter, cursor, upper);

        // Resolve block timestamps once per unique block to keep RPC pressure bounded.
        const uniqueBlocks = [...new Set(events.map(e => e.blockNumber))];
        const limit = pLimit(RPC_CONCURRENCY);
        const blockTimes = new Map();
        await Promise.all(uniqueBlocks.map(bn => limit(async () => {
          try {
            const blk = await this.provider.getBlock(bn);
            if (blk?.timestamp) blockTimes.set(bn, new Date(blk.timestamp * 1000));
          } catch (err) {
            this.logger.warn(`[${this.source.key}] getBlock(${bn}) failed: ${err.message}`);
          }
        })));

        for (const ev of events) {
          const to = (ev.args?.to || ev.args?.[1] || '').toLowerCase();
          const value = ev.args?.value || ev.args?.[2] || 0n;
          if (!to || to === ethers.ZeroAddress) continue;

          this.holders.add(to);
          newHolders.push(to);

          const blockTime = blockTimes.get(ev.blockNumber) || new Date();
          const txHash = (ev.transactionHash || '').toLowerCase();
          const logIndex = ev.index ?? ev.logIndex ?? 0;

          // Audit row for the raw event (idempotent on (source, txHash, logIndex)).
          try {
            await BalanceEvent.create({
              sourceId: this.source.id,
              address: to,
              blockNumber: ev.blockNumber,
              blockTimestamp: blockTime,
              txHash,
              logIndex,
              delta: value.toString(),
              eventType: 'mint'
            });
          } catch (e) { /* unique-constraint dupes are fine */ }

          pending.push({
            address: to,
            mintedRaw: value,
            blockTime,
            txHash
          });
        }
      } catch (err) {
        this.logger.warn(`[${this.source.key}] mint Transfer scan ${cursor}-${upper} failed: ${err.message}`);
      }
      cursor = upper + 1;
    }
    await this.markProgress({ block: tip });
    this._pendingMints = pending;
    return newHolders;
  }

  /**
   * Mint sources do NOT snapshot — they award points directly per event.
   */
  async snapshotAll(_snapshotAt) {
    return [];
  }

  /**
   * Convert pending mint events into PointAccrual rows. Called by the
   * indexer after discoverHolders(). Returns the number of accrual rows
   * actually written (duplicates by unique index are silently skipped —
   * that's the idempotency anchor).
   */
  async processEventAccruals(_now) {
    const pending = this._pendingMints || [];
    if (!pending.length) return 0;

    if (!this._epochs || !this._excluded) await this._loadCaches();
    const multiplier = parseFloat(this.source.multiplier);
    if (!Number.isFinite(multiplier)) {
      throw new PointsError(
        PointsError.CODES.VALIDATION,
        `source ${this.source.key} has non-numeric multiplier`,
        { field: 'multiplier', fixHint: 'set source.multiplier to a positive number' }
      );
    }

    let written = 0;
    for (const ev of pending) {
      const row = computeMintAccrualRow({
        ...ev,
        decimals: this.decimals,
        sourceId: this.source.id,
        multiplier,
        pointsPerMint: this.pointsPerMint,
        pegUsd: this.pegUsd,
        epochs: this._epochs,
        excluded: this._excluded
      });
      if (!row) continue;

      try {
        await PointAccrual.create(row);
        written++;
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') {
          this.logger.warn(`[${this.source.key}] mint accrual insert failed for ${row.address} ${row.txHash}: ${err.message}`);
        }
        // SequelizeUniqueConstraintError is the idempotency anchor — expected on re-scan.
      }
    }

    this._pendingMints = [];
    return written;
  }
}

module.exports = Erc20MintEventAdapter;
module.exports.computeMintAccrualRow = computeMintAccrualRow;
module.exports.pickEpochFor = pickEpochFor;
