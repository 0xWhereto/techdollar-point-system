'use strict';

/**
 * Slim models registry — only the points subsystem.
 *
 * In a host app you'd merge this with your existing models/index.js. The
 * adapter file `src/middleware/auth.js` references a `User` model only for
 * JWT-backed routes; if you don't use those routes, the User import can be
 * deleted.
 */

const { sequelize } = require('../config/database');

const PointSource = require('./PointSource');
const BalanceSnapshot = require('./BalanceSnapshot');
const BalanceEvent = require('./BalanceEvent');
const PointEpoch = require('./PointEpoch');
const PointAccrual = require('./PointAccrual');
const PointsExcludedAddress = require('./PointsExcludedAddress');

PointSource.hasMany(BalanceSnapshot, { foreignKey: 'source_id', as: 'snapshots' });
BalanceSnapshot.belongsTo(PointSource, { foreignKey: 'source_id', as: 'source' });

PointSource.hasMany(BalanceEvent, { foreignKey: 'source_id', as: 'events' });
BalanceEvent.belongsTo(PointSource, { foreignKey: 'source_id', as: 'source' });

PointSource.hasMany(PointAccrual, { foreignKey: 'source_id', as: 'accruals' });
PointAccrual.belongsTo(PointSource, { foreignKey: 'source_id', as: 'source' });

PointEpoch.hasMany(PointAccrual, { foreignKey: 'epoch_id', as: 'accruals' });
PointAccrual.belongsTo(PointEpoch, { foreignKey: 'epoch_id', as: 'epoch' });

module.exports = {
  sequelize,
  PointSource,
  BalanceSnapshot,
  BalanceEvent,
  PointEpoch,
  PointAccrual,
  PointsExcludedAddress
};
