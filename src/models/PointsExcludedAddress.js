const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * Addresses that should never earn points: protocol contracts (sUSDte, PSM,
 * Curve pools, Morpho vaults), team wallets, CEX hot wallets, etc.
 * The accrual engine filters these out.
 */
const PointsExcludedAddress = sequelize.define('PointsExcludedAddress', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  address: {
    type: DataTypes.STRING(42),
    allowNull: false,
    unique: true,
    set(val) {
      this.setDataValue('address', val ? val.toLowerCase() : val);
    }
  },
  reason: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  category: {
    type: DataTypes.ENUM('protocol', 'cex', 'team', 'other'),
    defaultValue: 'other'
  }
}, {
  tableName: 'points_excluded_addresses',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['address'] }
  ]
});

module.exports = PointsExcludedAddress;
