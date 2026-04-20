const logger = require('../utils/logger');
const {
  PointSource,
  PointEpoch,
  PointsExcludedAddress
} = require('../models');
const config = require('./config');

/**
 * Idempotent seeder. Creates default sources, two epochs (simulation +
 * Season 1) and the protocol-contract exclusion list. Re-running is safe.
 *
 * Called automatically on server startup so a fresh DB is immediately usable.
 */
async function seedDefaults() {
  // Sources
  for (const def of config.DEFAULT_SOURCES) {
    const [src, created] = await PointSource.findOrCreate({
      where: { key: def.key },
      defaults: def
    });
    if (created) logger.info(`[points-seed] created source ${def.key}`);
    else {
      // Update mutable fields if they changed in env (multiplier, addresses, etc.)
      const update = {};
      const fields = ['name', 'description', 'sourceType', 'contractAddress',
                      'decimals', 'multiplier', 'basePointsPerUsdPerDay',
                      'snapshotIntervalSeconds', 'isActive', 'extraConfig'];
      for (const f of fields) {
        if (def[f] !== undefined && JSON.stringify(src[f]) !== JSON.stringify(def[f])) {
          update[f] = def[f];
        }
      }
      if (Object.keys(update).length) {
        await src.update(update);
        logger.info(`[points-seed] updated source ${def.key} (${Object.keys(update).join(', ')})`);
      }
    }
  }

  // Epochs
  const simStart = new Date(config.SIMULATION_START_AT);
  const launch = new Date(config.OFFICIAL_LAUNCH_AT);
  await PointEpoch.findOrCreate({
    where: { key: 'pre_launch_simulation' },
    defaults: {
      key: 'pre_launch_simulation',
      name: 'Pre-Launch Simulation',
      description: 'Simulation period for testing the points system before official launch.',
      mode: 'simulation',
      boost: 1.0,
      startAt: simStart,
      endAt: launch,
      isActive: true
    }
  });
  await PointEpoch.findOrCreate({
    where: { key: 'season_1' },
    defaults: {
      key: 'season_1',
      name: 'Season 1',
      description: 'First official points season — Ethena-style accrual, redeemable at TGE.',
      mode: 'live',
      boost: 1.0,
      startAt: launch,
      endAt: null,
      isActive: true
    }
  });

  // Excluded addresses
  for (const ex of config.DEFAULT_EXCLUDED_ADDRESSES) {
    if (!ex.address) continue;
    await PointsExcludedAddress.findOrCreate({
      where: { address: ex.address.toLowerCase() },
      defaults: { reason: ex.reason, category: ex.category }
    });
  }

  logger.info('[points-seed] defaults seeded');
}

module.exports = { seedDefaults };
