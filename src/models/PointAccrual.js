const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

/**
 * PointAccrual - one row per (source, address, period) representing
 * points earned in that interval. Aggregating these rows gives the leaderboard.
 *
 * Two accrual modes coexist in this table:
 *
 *   accrualType = 'time_weighted' (default) — used by hold, stake, LP, Morpho
 *     points = avg_usd_value * (duration_seconds / 86400) * base_points_per_usd_per_day
 *              * source_multiplier * epoch_boost
 *     idempotency anchor: (source_id, address, period_start) — tx_hash is ''
 *
 *   accrualType = 'mint_event' — used by usdte_mint
 *     points = minted_usd * pointsPerMint (from source.extraConfig)
 *              * source_multiplier * epoch_boost
 *     idempotency anchor: (source_id, address, period_start, tx_hash)
 *     period_start = period_end = block timestamp; duration_seconds = 0;
 *     avg_usd_value = minted_usd; base_points = minted_usd * pointsPerMint.
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
  },
  accrualType: {
    type: DataTypes.ENUM('time_weighted', 'mint_event'),
    allowNull: false,
    defaultValue: 'time_weighted',
    field: 'accrual_type',
    comment: 'time_weighted = avg(usd) over duration; mint_event = one-shot per Transfer(0x0 → user)'
  },
  txHash: {
    type: DataTypes.STRING(66),
    allowNull: false,
    defaultValue: '',
    field: 'tx_hash',
    comment: "Empty string for time_weighted rows. Tx hash for mint_event rows. Part of unique key so two mints in the same block don't collide."
  }
}, {
  tableName: 'point_accruals',
  timestamps: true,
  underscored: true,
  indexes: [
    // Combined unique index covers BOTH accrual modes:
    //   - time_weighted: tx_hash = '' → uniqueness is on (source, address, period_start)
    //   - mint_event:    tx_hash = '0x…' → uniqueness is on (source, address, period_start, tx_hash)
    // Two mints in the same block by the same user have distinct tx hashes, so they're distinct rows.
    { fields: ['source_id', 'address', 'period_start', 'tx_hash'], unique: true },
    { fields: ['address', 'mode'] },
    { fields: ['epoch_id'] },
    { fields: ['accrual_type'] }
  ]
});

module.exports = PointAccrual;
