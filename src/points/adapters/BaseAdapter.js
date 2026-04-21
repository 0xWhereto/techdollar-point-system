const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { BalanceSnapshot, BalanceEvent, PointSource } = require('../../models');

/**
 * BaseAdapter
 * -----------
 * Defines the contract every points source adapter must implement.
 * Concrete adapters are responsible for two things:
 *   1) Discovering the set of holder addresses (via Transfer events, subgraph, etc.)
 *   2) Producing USD-denominated snapshots for each holder at a given timestamp.
 *
 * The adapter writes BalanceSnapshot rows. The accrual engine downstream
 * consumes those snapshots and turns them into points.
 */
class BaseAdapter {
  constructor({ source, provider, logger: log }) {
    this.source = source;             // PointSource model instance
    this.provider = provider;         // ethers JsonRpcProvider
    this.logger = log || logger;
    this.config = source.extraConfig || {};
    this.address = source.contractAddress;
    this.decimals = source.decimals || 18;
    /**
     * In-memory set of known holders. Each adapter is responsible for
     * keeping this set up-to-date — the orchestrator persists it via
     * BalanceEvent rows so it survives restarts.
     */
    this.holders = new Set();
  }

  /** Called once when the adapter is constructed. Hydrate state from DB. */
  async initialize() {
    // Restore holders from the most recent snapshots and from balance events.
    const recentSnapshots = await BalanceSnapshot.findAll({
      where: { sourceId: this.source.id },
      attributes: ['address'],
      group: ['address'],
      raw: true
    });
    for (const row of recentSnapshots) this.holders.add(row.address);

    const events = await BalanceEvent.findAll({
      where: { sourceId: this.source.id },
      attributes: ['address'],
      group: ['address'],
      raw: true
    });
    for (const row of events) this.holders.add(row.address);

    this.logger.info(`[${this.source.key}] adapter initialized with ${this.holders.size} known holders`);
  }

  /**
   * Discover new holders (e.g. by scanning Transfer events since last block).
   * Default: no-op. Override in subclasses.
   */
  async discoverHolders() {
    return [];
  }

  /**
   * Convert event-driven accruals (e.g. ERC20 mints) into PointAccrual rows
   * directly, bypassing snapshots. Default: no-op. Override for one-shot
   * sources like Erc20MintEventAdapter.
   *
   * Returns the number of accrual rows written.
   */
  async processEventAccruals(_now) {
    return 0;
  }

  /**
   * Take a snapshot of every known holder. Returns array of snapshot rows
   * to be persisted by the orchestrator.
   */
  async snapshotAll(snapshotAt) {
    const { PointsError } = require('../errors');
    throw new PointsError(
      PointsError.CODES.INTERNAL,
      `snapshotAll not implemented for ${this.constructor.name}`,
      { field: 'sourceType', fixHint: 'subclass BaseAdapter and implement snapshotAll' }
    );
  }

  /** Convert a raw token balance (BigInt or string) to a JS number of tokens. */
  toTokenAmount(raw) {
    return Number(ethers.formatUnits(raw, this.decimals));
  }

  /**
   * Persist a batch of snapshots. Returns the number of rows actually written
   * (duplicates by unique index are skipped).
   */
  async persistSnapshots(rows) {
    if (!rows.length) return 0;
    let written = 0;
    for (const row of rows) {
      try {
        await BalanceSnapshot.create(row);
        written++;
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') {
          this.logger.warn(`[${this.source.key}] snapshot insert failed for ${row.address}: ${err.message}`);
        }
      }
    }
    return written;
  }

  /**
   * Update PointSource `lastIndexedBlock` / `lastSnapshotAt`.
   */
  async markProgress({ block, snapshotAt }) {
    const update = {};
    if (block !== undefined) update.lastIndexedBlock = block;
    if (snapshotAt !== undefined) update.lastSnapshotAt = snapshotAt;
    if (Object.keys(update).length) await this.source.update(update);
  }
}

module.exports = BaseAdapter;
