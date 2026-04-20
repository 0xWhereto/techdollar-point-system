const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * BalanceEvent - granular log of balance-changing events.
 * Used for sources where event-driven indexing is cheaper than snapshots
 * (e.g. ERC20 Transfer events). Optional. Snapshots are the source of truth.
 */
const BalanceEvent = sequelize.define('BalanceEvent', {
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
    allowNull: false,
    field: 'block_number'
  },
  blockTimestamp: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'block_timestamp'
  },
  txHash: {
    type: DataTypes.STRING(66),
    allowNull: false,
    field: 'tx_hash'
  },
  logIndex: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'log_index'
  },
  delta: {
    type: DataTypes.DECIMAL(60, 0),
    allowNull: false,
    defaultValue: 0,
    comment: 'Signed change in raw balance (wei).'
  },
  newBalance: {
    type: DataTypes.DECIMAL(60, 0),
    allowNull: true,
    field: 'new_balance'
  },
  eventType: {
    type: DataTypes.STRING(32),
    allowNull: true,
    field: 'event_type',
    comment: 'transfer | mint | burn | deposit | withdraw'
  }
}, {
  tableName: 'balance_events',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['source_id', 'tx_hash', 'log_index'], unique: true },
    { fields: ['source_id', 'address', 'block_number'] },
    { fields: ['address'] }
  ]
});

module.exports = BalanceEvent;
