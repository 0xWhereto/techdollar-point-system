#!/usr/bin/env node
'use strict';

/**
 * Migration: add the mint-event accrual mode to point_accruals.
 *
 * What this changes:
 *
 *   1. point_sources.source_type ENUM gains 'erc20_mint_event'.
 *   2. point_accruals gains:
 *        - accrual_type ENUM('time_weighted','mint_event') NOT NULL DEFAULT 'time_weighted'
 *        - tx_hash      VARCHAR(66) NOT NULL DEFAULT ''
 *   3. The unique index (source_id, address, period_start) is replaced by
 *      (source_id, address, period_start, tx_hash) so both accrual modes
 *      coexist without colliding.
 *
 * The script is idempotent: re-running is a no-op. Safe to run on Postgres
 * AND SQLite (sqlite gets the column adds via Sequelize sync; the index
 * swap is done explicitly here so neither dialect requires manual SQL).
 *
 * Usage:
 *   node scripts/migrate-points-mint-event.js
 */

require('dotenv').config();
const { sequelize } = require('../src/config/database');
const logger = require('../src/utils/logger');

const PA = 'point_accruals';
const PS = 'point_sources';
const NEW_INDEX = 'point_accruals_source_id_address_period_start_tx_hash';
const OLD_INDEX = 'point_accruals_source_id_address_period_start';

async function colExists(table, col) {
  const qi = sequelize.getQueryInterface();
  const desc = await qi.describeTable(table);
  return Object.prototype.hasOwnProperty.call(desc, col);
}

async function indexExists(table, name) {
  const qi = sequelize.getQueryInterface();
  const indexes = await qi.showIndex(table);
  return indexes.some(i => i.name === name);
}

async function up() {
  const qi = sequelize.getQueryInterface();
  const dialect = sequelize.getDialect();
  logger.info(`[migrate] dialect=${dialect}`);

  const t = await sequelize.transaction();
  try {
    if (!(await colExists(PA, 'tx_hash'))) {
      logger.info('[migrate] adding tx_hash column to point_accruals');
      await qi.addColumn(PA, 'tx_hash', {
        type: sequelize.Sequelize.STRING(66),
        allowNull: false,
        defaultValue: ''
      }, { transaction: t });
    } else {
      logger.info('[migrate] tx_hash column already exists, skipping');
    }

    if (!(await colExists(PA, 'accrual_type'))) {
      logger.info('[migrate] adding accrual_type column to point_accruals');
      if (dialect === 'postgres') {
        await sequelize.query(
          `CREATE TYPE enum_point_accruals_accrual_type AS ENUM ('time_weighted','mint_event')`,
          { transaction: t }
        ).catch(() => { /* type may already exist */ });
        await sequelize.query(
          `ALTER TABLE ${PA} ADD COLUMN accrual_type enum_point_accruals_accrual_type NOT NULL DEFAULT 'time_weighted'`,
          { transaction: t }
        );
      } else {
        await qi.addColumn(PA, 'accrual_type', {
          type: sequelize.Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'time_weighted'
        }, { transaction: t });
      }
    } else {
      logger.info('[migrate] accrual_type column already exists, skipping');
    }

    // Postgres ENUM extension for source_type — add the new value if missing.
    if (dialect === 'postgres') {
      const enumValues = await sequelize.query(
        `SELECT unnest(enum_range(NULL::"enum_point_sources_source_type"))::text AS v`,
        { type: sequelize.QueryTypes.SELECT, transaction: t }
      ).catch(() => null);
      const have = new Set((enumValues || []).map(r => r.v));
      if (!have.has('erc20_mint_event')) {
        logger.info('[migrate] extending source_type ENUM with erc20_mint_event');
        // ALTER TYPE ... ADD VALUE cannot run inside a transaction in pg < 12.
        // We commit, run it standalone, and resume.
        await t.commit();
        await sequelize.query(
          `ALTER TYPE "enum_point_sources_source_type" ADD VALUE IF NOT EXISTS 'erc20_mint_event'`
        );
        return up();   // restart with a fresh transaction
      }
    }

    // Index swap: drop the old 3-column unique, add the new 4-column unique.
    if (await indexExists(PA, OLD_INDEX)) {
      logger.info(`[migrate] dropping old unique index ${OLD_INDEX}`);
      await qi.removeIndex(PA, OLD_INDEX, { transaction: t });
    }
    if (!(await indexExists(PA, NEW_INDEX))) {
      logger.info(`[migrate] adding new unique index ${NEW_INDEX}`);
      await qi.addIndex(PA, ['source_id', 'address', 'period_start', 'tx_hash'], {
        unique: true,
        name: NEW_INDEX,
        transaction: t
      });
    }

    await t.commit();
    logger.info('[migrate] done. point_accruals now supports both time_weighted and mint_event rows.');
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    throw err;
  }
}

if (require.main === module) {
  up().then(() => process.exit(0)).catch(err => {
    console.error('[migrate] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { up };
