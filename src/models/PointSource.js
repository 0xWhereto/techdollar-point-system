const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * PointSource - one row per earning surface (USDte hold, sUSDte, Curve LP, Morpho market, Morpho vault).
 * `extraConfig` holds source-specific knobs so a new pool can be added by inserting a row,
 * without code changes (Curve/Morpho addresses are pasted in here when deployed).
 */
const PointSource = sequelize.define('PointSource', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  key: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: 'Stable slug, e.g. "usdte_hold", "susdte", "curve_usdte_usdc", "morpho_vault_usdte"'
  },
  name: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  sourceType: {
    type: DataTypes.ENUM(
      'erc20_balance',     // Plain wallet ERC20 balance (USDte hold, sUSDte hold) — TIME-WEIGHTED
      'erc20_mint_event',  // ERC20 Transfer(0x0 → user) — ONE-SHOT per mint tx
      'curve_lp',          // Curve LP token balance, valued via get_virtual_price() — TIME-WEIGHTED
      'curve_gauge',       // Liquidity gauge deposit (LP staked in gauge) — TIME-WEIGHTED
      'morpho_market',     // Direct Morpho Blue market supply (loan token = USDte) — TIME-WEIGHTED
      'morpho_vault'       // MetaMorpho vault share (ERC-4626) — TIME-WEIGHTED
    ),
    allowNull: false,
    field: 'source_type'
  },
  chainId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 42161,
    field: 'chain_id'
  },
  contractAddress: {
    type: DataTypes.STRING(42),
    allowNull: false,
    field: 'contract_address',
    comment: 'Address read for balances. ERC20: token. Curve: LP token. Morpho vault: vault. Morpho market: morpho blue.'
  },
  decimals: {
    type: DataTypes.INTEGER,
    defaultValue: 18
  },
  multiplier: {
    type: DataTypes.DECIMAL(6, 2),
    defaultValue: 1.0,
    comment: 'Source multiplier. Mint=1x, Stake=2x, LP (Curve/Morpho)=3x.'
  },
  basePointsPerUsdPerDay: {
    type: DataTypes.DECIMAL(10, 4),
    defaultValue: 1.0,
    field: 'base_points_per_usd_per_day',
    comment: 'Base points earned per $1 of USD-denominated exposure per 24h, before multiplier.'
  },
  startBlock: {
    type: DataTypes.BIGINT,
    allowNull: true,
    field: 'start_block',
    comment: 'Block to start indexing from. NULL = use latest at first run.'
  },
  snapshotIntervalSeconds: {
    type: DataTypes.INTEGER,
    defaultValue: 3600,
    field: 'snapshot_interval_seconds',
    comment: 'How often this source is snapshotted. 1h default.'
  },
  lastIndexedBlock: {
    type: DataTypes.BIGINT,
    allowNull: true,
    field: 'last_indexed_block'
  },
  lastSnapshotAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'last_snapshot_at'
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active'
  },
  extraConfig: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'extra_config',
    comment: 'JSON. Curve: {poolAddress, lpTokenAddress, gaugeAddress, coins[]}. Morpho: {marketId|vaultAddress, subgraphUrl}.',
    get() {
      const raw = this.getDataValue('extraConfig');
      if (!raw) return {};
      try { return JSON.parse(raw); } catch { return {}; }
    },
    set(val) {
      this.setDataValue('extraConfig', val ? JSON.stringify(val) : null);
    }
  }
}, {
  tableName: 'point_sources',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['key'] },
    { fields: ['source_type'] },
    { fields: ['is_active'] }
  ]
});

module.exports = PointSource;
