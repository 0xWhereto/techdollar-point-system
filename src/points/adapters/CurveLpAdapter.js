const { ethers } = require('ethers');
const BaseAdapter = require('./BaseAdapter');
const { BalanceEvent } = require('../../models');
const { CURVE_POOL_ABI, EVENT_BLOCK_RANGE } = require('../config');
const { lpUsdValue } = require('../curveValue');
const pLimit = require('../pLimit');

const RPC_CONCURRENCY = Math.min(
  25,
  Math.max(1, parseInt(process.env.POINTS_RPC_CONCURRENCY || '10', 10))
);

/**
 * CurveLpAdapter
 * --------------
 * Tracks LP token holders for a Curve pool and values their position at the
 * FULL LP value (not just the USDte slice) per spec:
 *
 *   usdValue = lpBalance * get_virtual_price() / 1e18
 *
 * For a stable pool with assets pegged to $1, virtual_price is in $/LP and
 * starts at ~1.0 — growing slowly with fees. This is the canonical way to
 * value an LP position and matches what Curve UIs display.
 *
 * If a gauge is configured, the user's gauge deposit is added to their LP
 * balance — gauged LP and idle LP both count toward points.
 *
 * Pool discovery is dynamic: when the official USDte pool is deployed,
 * update `extra_config.poolAddress` (or env CURVE_POOL_ADDRESS + restart) and
 * the adapter switches automatically.
 */
class CurveLpAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.poolAddress = (this.config.poolAddress || this.address).toLowerCase();
    this.lpAddress = (this.config.lpTokenAddress || this.poolAddress).toLowerCase();
    this.gaugeAddress = this.config.gaugeAddress ? this.config.gaugeAddress.toLowerCase() : null;

    this.pool = new ethers.Contract(this.poolAddress, CURVE_POOL_ABI, this.provider);
    this.lp = new ethers.Contract(this.lpAddress, CURVE_POOL_ABI, this.provider);
    this.gauge = this.gaugeAddress
      ? new ethers.Contract(this.gaugeAddress, [
          'function balanceOf(address) view returns (uint256)',
          'event Transfer(address indexed from, address indexed to, uint256 value)'
        ], this.provider)
      : null;
  }

  async discoverHolders() {
    const tip = await this.provider.getBlockNumber();
    const from = this.source.lastIndexedBlock
      ? Number(this.source.lastIndexedBlock) + 1
      : (this.source.startBlock ? Number(this.source.startBlock) : tip - EVENT_BLOCK_RANGE);
    if (from > tip) return [];

    const newOnes = [];
    let cursor = from;
    while (cursor <= tip) {
      const upper = Math.min(cursor + EVENT_BLOCK_RANGE, tip);

      const scan = async (contract, label) => {
        try {
          const events = await contract.queryFilter(contract.filters.Transfer(), cursor, upper);
          for (const ev of events) {
            const to = (ev.args?.to || ev.args?.[1] || '').toLowerCase();
            const fromAddr = (ev.args?.from || ev.args?.[0] || '').toLowerCase();
            // Pool & gauge contracts themselves aren't holders.
            if (to && to !== ethers.ZeroAddress && to !== this.poolAddress && to !== this.gaugeAddress) {
              this.holders.add(to);
              newOnes.push(to);
            }
            if (fromAddr && fromAddr !== ethers.ZeroAddress && fromAddr !== this.poolAddress && fromAddr !== this.gaugeAddress) {
              this.holders.add(fromAddr);
            }
            try {
              await BalanceEvent.create({
                sourceId: this.source.id,
                address: to,
                blockNumber: ev.blockNumber,
                blockTimestamp: new Date(),
                txHash: ev.transactionHash,
                logIndex: (ev.index ?? ev.logIndex ?? 0) + (label === 'gauge' ? 100000 : 0),
                delta: (ev.args?.value || 0n).toString(),
                eventType: label
              });
            } catch (_) { /* dup */ }
          }
        } catch (err) {
          this.logger.warn(`[${this.source.key}] ${label} Transfer scan ${cursor}-${upper}: ${err.message}`);
        }
      };

      await scan(this.lp, 'lp_transfer');
      if (this.gauge) await scan(this.gauge, 'gauge');

      cursor = upper + 1;
    }
    await this.markProgress({ block: tip });
    return newOnes;
  }

  async snapshotAll(snapshotAt) {
    if (!this.holders.size) return [];
    const blockNumber = await this.provider.getBlockNumber();

    // Pool may not exist yet (e.g. pre-launch placeholder address). Bail gracefully.
    let virtualPrice;
    try {
      const vp = await this.pool.get_virtual_price();
      virtualPrice = Number(ethers.formatUnits(vp, 18));
    } catch (err) {
      this.logger.warn(`[${this.source.key}] get_virtual_price failed (pool not live?): ${err.message}`);
      return [];
    }

    const limit = pLimit(RPC_CONCURRENCY);
    const startMs = Date.now();

    const settled = await Promise.all(
      [...this.holders].map(addr =>
        limit(async () => {
          let lpBal = 0n;
          let gaugeBal = 0n;
          try { lpBal = await this.lp.balanceOf(addr); } catch (_) {}
          if (this.gauge) {
            try { gaugeBal = await this.gauge.balanceOf(addr); } catch (_) {}
          }
          const total = lpBal + gaugeBal;
          if (total === 0n) return null;
          const lpAmount = Number(ethers.formatUnits(total, this.decimals));
          const usdValue = lpUsdValue(lpAmount, virtualPrice);
          return {
            sourceId: this.source.id,
            address: addr,
            blockNumber,
            snapshotAt,
            rawBalance: total.toString(),
            usdValue,
            metadata: {
              virtualPrice,
              lpBalance: lpBal.toString(),
              gaugeBalance: gaugeBal.toString(),
              poolAddress: this.poolAddress,
              gaugeAddress: this.gaugeAddress
            }
          };
        })
      )
    );

    const rows = settled.filter(Boolean);
    const elapsedMs = Date.now() - startMs;
    this.logger.info(
      `[${this.source.key}] snapshot tick: ${rows.length}/${this.holders.size} LP positions in ${elapsedMs}ms ` +
      `(concurrency=${RPC_CONCURRENCY}, virtualPrice=${virtualPrice.toFixed(6)})`
    );

    await this.markProgress({ snapshotAt });
    return rows;
  }
}

module.exports = CurveLpAdapter;
