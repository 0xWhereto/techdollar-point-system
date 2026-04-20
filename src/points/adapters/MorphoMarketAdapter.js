const BaseAdapter = require('./BaseAdapter');
const { PointsError } = require('../errors');

/**
 * MorphoMarketAdapter
 * -------------------
 * Tracks direct supply positions in a Morpho Blue market where USDte is the
 * loan token. Uses the Morpho Blue subgraph to enumerate `Position` entities
 * for the configured `marketId` and reads the supply assets denominated in
 * the loan token (USDte == $1).
 *
 * Borrow positions are NOT counted toward points (you only earn for supplying
 * liquidity, not for taking it out).
 */
class MorphoMarketAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.marketId = this.config.marketId;
    this.subgraphUrl = this.config.subgraphUrl;
  }

  isLive() {
    return !!this.marketId && !!this.subgraphUrl;
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
        `query Positions($market: String!, $skip: Int!, $first: Int!) {
           positions(
             where: { market: $market, supplyShares_gt: "0" }
             first: $first, skip: $skip
           ) {
             user { id }
             supplyShares
             supplyAssets
           }
         }`,
        { market: this.marketId, skip, first: pageSize }
      ).catch(err => {
        this.logger.warn(`[${this.source.key}] subgraph holder discovery failed: ${err.message}`);
        return null;
      });
      if (!data) break;
      const positions = data.positions || [];
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
    if (!this.isLive()) return [];
    const rows = [];
    let skip = 0;
    const pageSize = 500;
    while (true) {
      const data = await this.fetchSubgraph(
        `query Positions($market: String!, $skip: Int!, $first: Int!) {
           positions(
             where: { market: $market, supplyShares_gt: "0" }
             first: $first, skip: $skip
           ) {
             user { id }
             supplyShares
             supplyAssets
           }
         }`,
        { market: this.marketId, skip, first: pageSize }
      ).catch(err => {
        this.logger.warn(`[${this.source.key}] subgraph snapshot failed: ${err.message}`);
        return null;
      });
      if (!data) break;
      const positions = data.positions || [];
      for (const p of positions) {
        const addr = (p.user?.id || '').toLowerCase();
        const usdValue = Number(p.supplyAssets || 0) / 1e18; // USDte (18d) at $1
        if (usdValue <= 0) continue;
        rows.push({
          sourceId: this.source.id,
          address: addr,
          blockNumber: null,
          snapshotAt,
          rawBalance: p.supplyShares,
          usdValue,
          metadata: { marketId: this.marketId, source: 'subgraph' }
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

module.exports = MorphoMarketAdapter;
