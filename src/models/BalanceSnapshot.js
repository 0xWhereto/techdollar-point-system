const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * BalanceSnapshot - periodic snapshot of (source, address) USD-denominated exposure.
 * The accrual engine consumes consecutive snapshots and integrates over time.
 *
 * `usdValue` is what actually drives points. For Curve LP this is the FULL LP value
 * (LP balance * virtual_price), not just the USDte slice — per spec.
 */
const BalanceSnapshot = sequelize.define('BalanceSnapshot', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  sourceId: {
    type: DataTypes.UUID,
    allowNull: false,
    field: 'source_id',
    references: { model: 'point_sources', key: 'id' }
  },
  address: {
    type: DataTypes.STRING(42),
    allowNull: false,
    set(val) {
      this.setDataValue('address', val ? val.toLowerCase() : val);
    }
  },
  blockNumber: {
    type: DataTypes.BIGINT,
    allowNull: true,
    field: 'block_number'
  },
  snapshotAt: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'snapshot_at'
  },
  rawBalance: {
    type: DataTypes.DECIMAL(40, 0),
    allowNull: false,
    defaultValue: 0,
    field: 'raw_balance',
    comment: 'Underlying token amount in smallest unit (wei).'
  },
  usdValue: {
    type: DataTypes.DECIMAL(36, 6),
    allowNull: false,
    defaultValue: 0,
    field: 'usd_value',
    comment: 'USD-denominated exposure used for points calculation.'
  },
  metadata: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON. Optional details: virtual_price used, oracle prices, subgraph cursor, etc.',
    get() {
      const raw = this.getDataValue('metadata');
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    set(val) {
      this.setDataValue('metadata', val ? JSON.stringify(val) : null);
    }
  }
}, {
  tableName: 'balance_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['source_id', 'address', 'snapshot_at'], unique: true },
    { fields: ['source_id', 'snapshot_at'] },
    { fields: ['address'] }
  ]
});

module.exports = BalanceSnapshot;
