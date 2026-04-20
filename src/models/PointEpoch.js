const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * PointEpoch - Ethena-style season. Pre-launch "simulation" epochs and
 * post-launch "live" epochs coexist; the leaderboard surfaces only `live` points.
 */
const PointEpoch = sequelize.define('PointEpoch', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  key: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true
  },
  name: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  mode: {
    type: DataTypes.ENUM('simulation', 'live'),
    allowNull: false,
    defaultValue: 'live'
  },
  boost: {
    type: DataTypes.DECIMAL(6, 2),
    defaultValue: 1.0,
    comment: 'Global multiplier applied on top of per-source multiplier (e.g. 2.0 for "double points week")'
  },
  startAt: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'start_at'
  },
  endAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'end_at',
    comment: 'NULL means open-ended.'
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active'
  }
}, {
  tableName: 'point_epochs',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['mode'] },
    { fields: ['is_active'] },
    { fields: ['start_at'] }
  ]
});

module.exports = PointEpoch;
