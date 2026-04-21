/**
 * Central config for the points indexer.
 *
 * The actual source rows live in the `point_sources` table — this file just
 * provides defaults that can be seeded, plus the static ABIs / env-derived
 * settings the indexer needs at boot.
 */

require('dotenv').config();

// ---------- Network + protocol addresses ----------

const RPC_URL = process.env.ETH_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const CHAIN_ID = parseInt(process.env.ETH_CHAIN_ID || '42161', 10);

const USDTE_ADDRESS = (process.env.USDTE_TOKEN_ADDRESS || '0x7d03aa7584889f6e63039B06e408F278f990Bd3F').toLowerCase();
const SUSDTE_ADDRESS = (process.env.SUSDTE_TOKEN_ADDRESS || '0xc611221C5DF7aC39EC25451cbd1dFA4f271124D4').toLowerCase();
const USDC_ADDRESS = (process.env.USDC_ADDRESS || '0xaf88d065e77c8cC2239327C5EDb3A432268e5831').toLowerCase();

// ---------- Curve config (configurable, defaults to a real test pool on Arbitrum) ----------
// Default test pool: 2crv (USDC/USDT) on Arbitrum — `0x7f90122BF0700F9E7e1F688fe926940E8839F353`.
// When the official USDte Curve pool ships, paste it into env or via admin API.
const CURVE_POOL_ADDRESS = (process.env.CURVE_POOL_ADDRESS || '0x7f90122BF0700F9E7e1F688fe926940E8839F353').toLowerCase();
const CURVE_LP_TOKEN_ADDRESS = (process.env.CURVE_LP_TOKEN_ADDRESS || CURVE_POOL_ADDRESS).toLowerCase(); // most NG pools are LP=pool
const CURVE_GAUGE_ADDRESS = (process.env.CURVE_GAUGE_ADDRESS || '').toLowerCase() || null;

// ---------- Morpho config (configurable, subgraph-driven) ----------
// MetaMorpho vault address (USDte vault). When the vault is deployed, paste here.
const MORPHO_VAULT_ADDRESS = (process.env.MORPHO_VAULT_ADDRESS || '').toLowerCase() || null;
// Morpho Blue market id (bytes32) — for direct market exposure. Optional.
const MORPHO_MARKET_ID = process.env.MORPHO_MARKET_ID || null;
// Morpho Blue main contract on Arbitrum
const MORPHO_BLUE_ADDRESS = (process.env.MORPHO_BLUE_ADDRESS || '0x6c247b1F6182318877311737BaC0844bAa518F5e').toLowerCase();
// Subgraph endpoint — Morpho Blue Arbitrum (Goldsky-hosted, switch via env if needed)
const MORPHO_SUBGRAPH_URL = process.env.MORPHO_SUBGRAPH_URL ||
  'https://api.goldsky.com/api/public/project_clx0lkjn83qet01w69wii1d5w/subgraphs/morpho-blue-arbitrum/1.0.0/gn';

// ---------- Indexer behavior ----------

const INDEXER_ENABLED = process.env.POINTS_INDEXER_ENABLED !== 'false';
const INDEXER_TICK_MS = parseInt(process.env.POINTS_INDEXER_TICK_MS || '60000', 10); // 1 min orchestrator tick
const SNAPSHOT_BATCH_SIZE = parseInt(process.env.POINTS_SNAPSHOT_BATCH || '500', 10);
const EVENT_BLOCK_RANGE = parseInt(process.env.POINTS_EVENT_BLOCK_RANGE || '5000', 10);

// ---------- Multipliers per spec ----------
//
// Per the points spec:
//   - Mint USDte    : ONE-SHOT, 1× multiplier, 10 points per USDte minted
//   - Hold USDte    : per-hour, 1× multiplier
//   - Stake (sUSDte): per-hour, 2× multiplier
//   - Curve LP      : per-hour, 3× multiplier (full LP value via virtual_price)
//   - Morpho supply : per-hour, 3× multiplier (vault and market alike)
//
const MULTIPLIERS = {
  mint: 1.0,        // USDte mint (one-shot)
  hold: 1.0,        // USDte hold (time-weighted)
  stake: 2.0,       // sUSDte hold (time-weighted)
  liquidity: 3.0    // Curve LP + Morpho (time-weighted)
};

// One-shot bonus: how many points per USDte minted, BEFORE the source multiplier.
// Tunable per season via PointSource.extraConfig.pointsPerMint without a redeploy.
const POINTS_PER_USDTE_MINTED = parseFloat(process.env.POINTS_PER_USDTE_MINTED || '10');

// ---------- ABIs ----------

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

const SUSDTE_ABI = [
  ...ERC20_ABI,
  'function getExchangeRate() view returns (uint256)',
  'function totalDeposited() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'event Staked(address indexed user, uint256 usdteAmount, uint256 susdteAmount)',
  'event Unstaked(address indexed user, uint256 usdteAmount, uint256 susdteAmount)'
];

// Curve Stableswap-NG pool (works for v1/v2 stable pools too — only the methods we need are common).
const CURVE_POOL_ABI = [
  'function get_virtual_price() view returns (uint256)',
  'function balances(uint256) view returns (uint256)',
  'function coins(uint256) view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// ---------- Season setup ----------

const OFFICIAL_LAUNCH_AT = process.env.POINTS_LAUNCH_AT || '2026-05-01T00:00:00Z';
const SIMULATION_START_AT = process.env.POINTS_SIMULATION_START_AT || '2026-04-01T00:00:00Z';

// ---------- Default seed sources (used by seed script) ----------

const DEFAULT_SOURCES = [
  {
    key: 'usdte_mint',
    name: 'USDte Mint',
    description: `One-shot bonus credited when you mint USDte. ${POINTS_PER_USDTE_MINTED} points per USDte minted, 1× multiplier.`,
    sourceType: 'erc20_mint_event',
    chainId: CHAIN_ID,
    contractAddress: USDTE_ADDRESS,
    decimals: 18,
    multiplier: MULTIPLIERS.mint,
    basePointsPerUsdPerDay: null,                 // not used for event sources
    snapshotIntervalSeconds: 3600,                // governs how often the indexer polls for new mint events
    extraConfig: {
      pegUsd: 1.0,
      pointsPerMint: POINTS_PER_USDTE_MINTED,
      fromAddress: '0x0000000000000000000000000000000000000000'
    }
  },
  {
    key: 'usdte_hold',
    name: 'USDte Hold',
    description: 'Earn points every hour you hold USDte in your wallet. 1× multiplier.',
    sourceType: 'erc20_balance',
    chainId: CHAIN_ID,
    contractAddress: USDTE_ADDRESS,
    decimals: 18,
    multiplier: MULTIPLIERS.hold,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    extraConfig: { pegUsd: 1.0 }
  },
  {
    key: 'susdte_stake',
    name: 'sUSDte Stake',
    description: 'Earn points by staking USDte for sUSDte. 2× multiplier.',
    sourceType: 'erc20_balance',
    chainId: CHAIN_ID,
    contractAddress: SUSDTE_ADDRESS,
    decimals: 18,
    multiplier: MULTIPLIERS.stake,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    extraConfig: { useExchangeRate: true }
  },
  {
    key: 'curve_lp',
    name: 'Curve LP',
    description: 'Provide liquidity in the Curve USDte pool. 3× multiplier on full LP value.',
    sourceType: 'curve_lp',
    chainId: CHAIN_ID,
    contractAddress: CURVE_LP_TOKEN_ADDRESS,
    decimals: 18,
    multiplier: MULTIPLIERS.liquidity,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    isActive: true,
    extraConfig: {
      poolAddress: CURVE_POOL_ADDRESS,
      lpTokenAddress: CURVE_LP_TOKEN_ADDRESS,
      gaugeAddress: CURVE_GAUGE_ADDRESS,
      valuationMode: 'virtual_price'
    }
  },
  {
    key: 'morpho_vault',
    name: 'Morpho Vault',
    description: 'Supply USDte to the MetaMorpho vault. 3× multiplier on supplied USD value.',
    sourceType: 'morpho_vault',
    chainId: CHAIN_ID,
    contractAddress: MORPHO_VAULT_ADDRESS || '0x0000000000000000000000000000000000000000',
    decimals: 18,
    multiplier: MULTIPLIERS.liquidity,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    isActive: !!MORPHO_VAULT_ADDRESS,
    extraConfig: {
      vaultAddress: MORPHO_VAULT_ADDRESS,
      subgraphUrl: MORPHO_SUBGRAPH_URL,
      underlying: USDTE_ADDRESS
    }
  },
  {
    key: 'morpho_market',
    name: 'Morpho Market',
    description: 'Supply USDte directly to a Morpho Blue market. 3× multiplier on supplied USD value.',
    sourceType: 'morpho_market',
    chainId: CHAIN_ID,
    contractAddress: MORPHO_BLUE_ADDRESS,
    decimals: 18,
    multiplier: MULTIPLIERS.liquidity,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    isActive: !!MORPHO_MARKET_ID,
    extraConfig: {
      marketId: MORPHO_MARKET_ID,
      morphoBlueAddress: MORPHO_BLUE_ADDRESS,
      subgraphUrl: MORPHO_SUBGRAPH_URL,
      loanToken: USDTE_ADDRESS
    }
  }
];

// Protocol contracts that should not earn points themselves
const DEFAULT_EXCLUDED_ADDRESSES = [
  { address: SUSDTE_ADDRESS, reason: 'sUSDte vault contract', category: 'protocol' },
  { address: CURVE_POOL_ADDRESS, reason: 'Curve pool contract', category: 'protocol' },
  { address: MORPHO_BLUE_ADDRESS, reason: 'Morpho Blue contract', category: 'protocol' },
  { address: '0x0000000000000000000000000000000000000000', reason: 'Zero address', category: 'protocol' }
];

if (MORPHO_VAULT_ADDRESS) {
  DEFAULT_EXCLUDED_ADDRESSES.push({
    address: MORPHO_VAULT_ADDRESS,
    reason: 'MetaMorpho vault contract',
    category: 'protocol'
  });
}

module.exports = {
  RPC_URL,
  CHAIN_ID,
  USDTE_ADDRESS,
  SUSDTE_ADDRESS,
  USDC_ADDRESS,
  CURVE_POOL_ADDRESS,
  CURVE_LP_TOKEN_ADDRESS,
  CURVE_GAUGE_ADDRESS,
  MORPHO_VAULT_ADDRESS,
  MORPHO_MARKET_ID,
  MORPHO_BLUE_ADDRESS,
  MORPHO_SUBGRAPH_URL,
  INDEXER_ENABLED,
  INDEXER_TICK_MS,
  SNAPSHOT_BATCH_SIZE,
  EVENT_BLOCK_RANGE,
  MULTIPLIERS,
  POINTS_PER_USDTE_MINTED,
  ERC20_ABI,
  SUSDTE_ABI,
  CURVE_POOL_ABI,
  OFFICIAL_LAUNCH_AT,
  SIMULATION_START_AT,
  DEFAULT_SOURCES,
  DEFAULT_EXCLUDED_ADDRESSES
};
