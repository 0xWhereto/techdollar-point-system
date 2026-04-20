'use strict';

require('dotenv').config();
const { Sequelize } = require('sequelize');

/**
 * Standalone DB bootstrap for techdollar-point-system.
 *
 * Defaults to a local SQLite file (`./database.sqlite`). Set
 * `USE_LOCAL_DB=false` plus DB_* envs to point at Postgres in production.
 *
 * Tests set `SQLITE_PATH=:memory:` so they leave nothing on disk.
 */

const useLocalDb = process.env.USE_LOCAL_DB !== 'false' && !process.env.DB_PASSWORD;

let sequelize;

if (useLocalDb) {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.SQLITE_PATH || './database.sqlite',
    logging: process.env.NODE_ENV === 'development' ? console.log : false
  });
} else {
  sequelize = new Sequelize(
    process.env.DB_NAME || 'techdollar_points',
    process.env.DB_USER || 'postgres',
    process.env.DB_PASSWORD || '',
    {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      dialect: 'postgres',
      logging: false,
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
      dialectOptions: process.env.NODE_ENV === 'production'
        ? { ssl: { require: true, rejectUnauthorized: false } }
        : {}
    }
  );
}

async function testConnection() {
  await sequelize.authenticate();
}

module.exports = { sequelize, testConnection, useLocalDb };
