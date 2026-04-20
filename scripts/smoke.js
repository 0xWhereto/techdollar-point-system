#!/usr/bin/env node
'use strict';

/**
 * Standalone smoke runner — boots the schema, seeds the default sources
 * and epochs, runs ONE indexer tick, prints the health report, and exits.
 *
 * Useful for verifying integration against a real RPC and confirming the
 * adapters can read your deployed Curve / Morpho contracts.
 *
 *   node scripts/smoke.js
 */

require('dotenv').config();

(async () => {
  const { sequelize } = require('../src/models');
  const { seedDefaults } = require('../src/points/seed');
  const indexer = require('../src/points/indexer');

  console.log('→ syncing schema...');
  await sequelize.sync();

  console.log('→ seeding default sources + epochs + exclusions...');
  await seedDefaults();

  console.log('→ running one indexer tick...');
  await indexer.runOnce();

  console.log('\n→ health:');
  console.log(JSON.stringify(indexer.health(), null, 2));

  await indexer.stop();
  await sequelize.close();
  process.exit(0);
})().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
