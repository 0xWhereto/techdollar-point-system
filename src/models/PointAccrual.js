const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * PointAccrual - one row per (source, address, period) representing
 * time-weighted points earned in that interval. Aggregating these rows
 * gives the leaderboard.
 *
 *   points = avg_usd_value * (duration_seconds / 86400) * base_points_per_usd_per_day
 *            * source_multiplier * epoch_boost
 */
const PointAccrual = sequelize.define('PointAccrual', {
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
  epochId: {
    type: DataTypes.UUID,
    allowNull: true,
    field: 'epoch_id',
    references: { model: 'point_epochs', key: 'id' }
  },
  address: {
    type: DataTypes.STRING(42),
    allowNull: false,
    set(val) {
      this.setDataValue('address', val ? val.toLowerCase() : val);
    }
  },
  periodStart: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'period_start'
  },
  periodEnd: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'period_end'
  },
  durationSeconds: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'duration_seconds'
  },
  avgUsdValue: {
    type: DataTypes.DECIMAL(36, 6),
    allowNull: false,
    field: 'avg_usd_value'
  },
  basePoints: {
    type: DataTypes.DECIMAL(36, 6),
    allowNull: false,
    field: 'base_points',
    comment: 'avg_usd_value * (duration / 86400) * base_points_per_usd_per_day'
  },
  multiplier: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: false,
    defaultValue: 1.0
  },
  epochBoost: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: false,
    defaultValue: 1.0,
    field: 'epoch_boost'
  },
  points: {
    type: DataTypes.DECIMAL(36, 6),
    allowNull: false,
    comment: 'Final points awarded (basePoints * multiplier * epochBoost)'
  },
  mode: {
    type: DataTypes.ENUM('simulation', 'live'),
    allowNull: false,
    defaultValue: 'live'
  }
}, {
  tableName: 'point_accruals',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['source_id', 'address', 'period_start'], unique: true },
    { fields: ['address', 'mode'] },
    { fields: ['epoch_id'] }
  ]
});

module.exports = PointAccrual;
