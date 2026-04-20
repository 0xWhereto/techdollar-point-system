const BaseAdapter = require('./BaseAdapter');
const { PointsError } = require('../errors');

/**
 * MorphoVaultAdapter
 * ------------------
 * Tracks user positions in a MetaMorpho vault (ERC-4626) where USDte is the
 * underlying asset. Uses the Morpho Blue subgraph to:
 *   1) enumerate the set of vault depositors
 *   2) read each depositor's `assets` (USDte equivalent) at snapshot time
 *
 * Subgraph is preferred over per-address `convertToAssets()` calls because
 * it gives us the holder set in a single query (no Transfer scanning needed).
 *
 * If the vault address isn't configured yet the adapter no-ops so the
 * orchestrator can keep running pre-launch.
 */
class MorphoVaultAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.vaultAddress = (this.config.vaultAddress || '').toLowerCase();
    this.subgraphUrl = this.config.subgraphUrl;
  }

  isLive() {
    return !!this.vaultAddress && this.vaultAddress !== '0x0000000000000000000000000000000000000000' && !!this.subgraphUrl;
  }

  async fetchSubgraph(query, variables) {
    const res = await fetch(this.subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) {
      throw PointsError.subgraph(`http ${res.status} from ${this.subgraphUrl}`, { field: 'subgraphUrl' });
    }
    const json = await res.json();
    if (json.errors) {
      throw PointsError.subgraph(`graphql errors: ${JSON.stringify(json.errors)}`, { field: 'subgraphUrl' });
    }
    return json.data;
  }

  async discoverHolders() {
    if (!this.isLive()) return [];
    const newOnes = [];
    let skip = 0;
    const pageSize = 500;
    while (true) {
      const data = await this.fetchSubgraph(
        `query Positions($vault: String!, $skip: Int!, $first: Int!) {
           metaMorphoPositions(
             where: { metaMorpho: $vault, shares_gt: "0" }
             first: $first, skip: $skip
           ) {
             user { id }
             shares
           }
         }`,
        { vault: this.vaultAddress, skip, first: pageSize }
      ).catch(err => {
        this.logger.warn(`[${this.source.key}] subgraph holder discovery failed: ${err.message}`);
        return null;
      });
      if (!data) break;
      const positions = data.metaMorphoPositions || [];
      for (const p of positions) {
        const addr = (p.user?.id || '').toLowerCase();
        if (addr && !this.holders.has(addr)) {
          this.holders.add(addr);
          newOnes.push(addr);
        }
      }
      if (positions.length < pageSize) break;
      skip += pageSize;
    }
    return newOnes;
  }

  async snapshotAll(snapshotAt) {
    if (!this.isLive() || !this.holders.size) return [];

    // Re-query subgraph for current `assets` (USDte equivalent) so we don't
    // round-trip RPC for every holder. The subgraph stores this directly.
    const rows = [];
    let skip = 0;
    const pageSize = 500;
    while (true) {
      const data = await this.fetchSubgraph(
        `query Positions($vault: String!, $skip: Int!, $first: Int!) {
           metaMorphoPositions(
             where: { metaMorpho: $vault, shares_gt: "0" }
             first: $first, skip: $skip
           ) {
             user { id }
             shares
             assets
           }
         }`,
        { vault: this.vaultAddress, skip, first: pageSize }
      ).catch(err => {
        this.logger.warn(`[${this.source.key}] subgraph snapshot failed: ${err.message}`);
        return null;
      });
      if (!data) break;

      const positions = data.metaMorphoPositions || [];
      for (const p of positions) {
        const addr = (p.user?.id || '').toLowerCase();
        const sharesRaw = p.shares || '0';
        // assets is in underlying token units (USDte, 18d) → USDte == $1.
        const usdValue = Number(p.assets || 0) / 1e18;
        if (usdValue <= 0) continue;
        rows.push({
          sourceId: this.source.id,
          address: addr,
          blockNumber: null,
          snapshotAt,
          rawBalance: sharesRaw,
          usdValue,
          metadata: { vaultAddress: this.vaultAddress, source: 'subgraph' }
        });
        this.holders.add(addr);
      }
      if (positions.length < pageSize) break;
      skip += pageSize;
    }

    await this.markProgress({ snapshotAt });
    return rows;
  }
}

module.exports = MorphoVaultAdapter;
