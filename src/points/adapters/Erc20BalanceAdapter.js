const { ethers } = require('ethers');
const BaseAdapter = require('./BaseAdapter');
const { BalanceEvent } = require('../../models');
const { ERC20_ABI, SUSDTE_ABI, EVENT_BLOCK_RANGE } = require('../config');
const pLimit = require('../pLimit');

const RPC_CONCURRENCY = Math.min(
  25,
  Math.max(1, parseInt(process.env.POINTS_RPC_CONCURRENCY || '10', 10))
);

/**
 * Erc20BalanceAdapter
 * -------------------
 * Used for both USDte (mint, 1×) and sUSDte (stake, 2×).
 *
 * Holder discovery: scan ERC20 Transfer events in batches and record any
 * non-zero recipient. Persisted as BalanceEvent rows so we don't re-scan
 * historical blocks on restart.
 *
 * Snapshot: read `balanceOf(address)` for every known holder. For sUSDte,
 * convert the share balance to USDte (= USD) using `getExchangeRate()`.
 */
class Erc20BalanceAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    const isSusdte = (opts.source.extraConfig || {}).useExchangeRate === true;
    this.contract = new ethers.Contract(
      this.address,
      isSusdte ? SUSDTE_ABI : ERC20_ABI,
      this.provider
    );
    this.isSusdte = isSusdte;
  }

  async discoverHolders() {
    const tip = await this.provider.getBlockNumber();
    // Resume from last indexed block; on first run start at `startBlock` if
    // configured (used to backfill history), otherwise scan one window back.
    const from = this.source.lastIndexedBlock
      ? Number(this.source.lastIndexedBlock) + 1
      : (this.source.startBlock ? Number(this.source.startBlock) : tip - EVENT_BLOCK_RANGE);
    if (from > tip) return [];

    const newOnes = [];
    let cursor = from;
    while (cursor <= tip) {
      const upper = Math.min(cursor + EVENT_BLOCK_RANGE, tip);
      try {
        const events = await this.contract.queryFilter(
          this.contract.filters.Transfer(),
          cursor,
          upper
        );
        for (const ev of events) {
          const to = (ev.args?.to || ev.args?.[1] || '').toLowerCase();
          const from = (ev.args?.from || ev.args?.[0] || '').toLowerCase();
          const value = ev.args?.value || ev.args?.[2] || 0n;
          if (to && to !== ethers.ZeroAddress) {
            this.holders.add(to);
            newOnes.push(to);
          }
          if (from && from !== ethers.ZeroAddress) {
            this.holders.add(from);
          }
          // Persist a lightweight event record so we have an audit trail and
          // don't re-scan ranges if the indexer dies mid-tick.
          try {
            await BalanceEvent.create({
              sourceId: this.source.id,
              address: to,
              blockNumber: ev.blockNumber,
              blockTimestamp: new Date(),
              txHash: ev.transactionHash,
              logIndex: ev.index ?? ev.logIndex ?? 0,
              delta: value.toString(),
              eventType: from === ethers.ZeroAddress ? 'mint' : 'transfer'
            });
          } catch (e) { /* unique-constraint dupes are fine */ }
        }
      } catch (err) {
        this.logger.warn(`[${this.source.key}] Transfer scan ${cursor}-${upper} failed: ${err.message}`);
      }
      cursor = upper + 1;
    }
    await this.markProgress({ block: tip });
    return newOnes;
  }

  async snapshotAll(snapshotAt) {
    if (!this.holders.size) return [];
    const blockNumber = await this.provider.getBlockNumber();

    let exchangeRate = null;
    if (this.isSusdte) {
      try {
        const rate = await this.contract.getExchangeRate();
        // rate is sUSDte->USDte * 1e18
        exchangeRate = Number(ethers.formatUnits(rate, 18));
      } catch {
        exchangeRate = 1.0;
      }
    }

    const limit = pLimit(RPC_CONCURRENCY);
    const startMs = Date.now();
    let rpcErrors = 0;

    const settled = await Promise.all(
      [...this.holders].map(addr =>
        limit(async () => {
          try {
            const raw = await this.contract.balanceOf(addr);
            if (raw === 0n) return null;
            const tokenAmount = this.toTokenAmount(raw);
            const usdValue = this.isSusdte ? tokenAmount * exchangeRate : tokenAmount;
            return {
              sourceId: this.source.id,
              address: addr,
              blockNumber,
              snapshotAt,
              rawBalance: raw.toString(),
              usdValue,
              metadata: this.isSusdte ? { exchangeRate } : null
            };
          } catch (err) {
            rpcErrors += 1;
            this.logger.warn(`[${this.source.key}] balanceOf failed for ${addr}: ${err.message}`);
            return null;
          }
        })
      )
    );

    const rows = settled.filter(Boolean);
    const elapsedMs = Date.now() - startMs;
    this.logger.info(
      `[${this.source.key}] snapshot tick: ${rows.length}/${this.holders.size} balances in ${elapsedMs}ms ` +
      `(concurrency=${RPC_CONCURRENCY}, rpcErrors=${rpcErrors})`
    );
    await this.markProgress({ snapshotAt });
    return rows;
  }
}

module.exports = Erc20BalanceAdapter;
