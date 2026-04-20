const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { PointSource } = require('../models');
const config = require('./config');
const accrualEngine = require('./accrualEngine');
const { recordRound, isExhausted } = require('./diminishingReturns');

const BaseAdapter = require('./adapters/BaseAdapter');
const Erc20BalanceAdapter = require('./adapters/Erc20BalanceAdapter');
const CurveLpAdapter = require('./adapters/CurveLpAdapter');
const MorphoVaultAdapter = require('./adapters/MorphoVaultAdapter');
const MorphoMarketAdapter = require('./adapters/MorphoMarketAdapter');

/**
 * Indexer
 * -------
 * Single-process orchestrator.
 *
 * Reliability primitives borrowed from almanac-engine:
 *   - per-source CircuitBreaker — when an adapter throws N times in a row we
 *     skip it until `nextRetryAt`, with exponential backoff capped at 30 min.
 *     This stops "Curve pool not deployed yet" from spamming logs every minute.
 *   - per-source health record — operators can read it via /api/points/admin/health.
 *   - diminishing-returns gauge — tracks landed snapshots per round so the
 *     operator (or a cron-killed loop) knows when the indexer is doing nothing.
 */

const FAILURE_THRESHOLD = 3;            // consecutive failures before tripping
const BACKOFF_INITIAL_MS = 30_000;      // 30s after first trip
const BACKOFF_MAX_MS = 30 * 60_000;     // 30min cap

function makeHealthRecord() {
  return {
    consecutiveFailures: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    lastError: null,           // { message, code, field, at }
    lastSuccessAt: null,
    lastTickAt: null,
    nextRetryAt: null,         // null when not in cooldown
    cooldownMs: 0
  };
}

class Indexer {
  constructor() {
    this.provider = null;
    this.adapters = new Map();         // sourceId -> adapter
    this.healthBySourceId = new Map(); // sourceId -> health record
    this.isRunning = false;
    this.tickHandle = null;
    this.tickInProgress = false;
    this.roundHistory = [];            // for diminishing-returns detection
  }

  adapterFor(source) {
    switch (source.sourceType) {
      case 'erc20_balance':
        return new Erc20BalanceAdapter({ source, provider: this.provider });
      case 'curve_lp':
      case 'curve_gauge':
        return new CurveLpAdapter({ source, provider: this.provider });
      case 'morpho_vault':
        return new MorphoVaultAdapter({ source, provider: this.provider });
      case 'morpho_market':
        return new MorphoMarketAdapter({ source, provider: this.provider });
      default:
        return null;
    }
  }

  async initialize() {
    this.provider = new ethers.JsonRpcProvider(config.RPC_URL);
    await this.reloadSources();
    logger.info(`[points-indexer] initialized with ${this.adapters.size} adapters`);
  }

  async reloadSources() {
    const sources = await PointSource.findAll({ where: { isActive: true } });
    const seen = new Set();
    for (const source of sources) {
      seen.add(source.id);
      if (this.adapters.has(source.id)) continue;
      const adapter = this.adapterFor(source);
      if (!adapter) {
        logger.warn(`[points-indexer] no adapter for source type ${source.sourceType}`);
        continue;
      }
      try {
        await adapter.initialize();
      } catch (err) {
        logger.error(`[points-indexer] adapter ${source.key} failed to initialize: ${err.message}`);
        continue;
      }
      this.adapters.set(source.id, adapter);
      this.healthBySourceId.set(source.id, makeHealthRecord());
    }
    for (const id of [...this.adapters.keys()]) {
      if (!seen.has(id)) {
        this.adapters.delete(id);
        this.healthBySourceId.delete(id);
      }
    }
    accrualEngine.invalidateCaches();
  }

  async start() {
    if (this.isRunning) return;
    if (!config.INDEXER_ENABLED) {
      logger.info('[points-indexer] disabled via env (POINTS_INDEXER_ENABLED=false)');
      return;
    }
    await this.initialize();
    this.isRunning = true;
    this.tick().catch(err => logger.error('[points-indexer] first tick failed:', err));
    this.tickHandle = setInterval(() => {
      this.tick().catch(err => logger.error('[points-indexer] tick failed:', err));
    }, config.INDEXER_TICK_MS);
    logger.info(`[points-indexer] started (tick = ${config.INDEXER_TICK_MS}ms)`);
  }

  async stop() {
    this.isRunning = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    logger.info('[points-indexer] stopped');
  }

  // ---------- Circuit breaker helpers ----------

  recordSuccess(sourceId) {
    const h = this.healthBySourceId.get(sourceId);
    if (!h) return;
    h.consecutiveFailures = 0;
    h.totalSuccesses += 1;
    h.lastError = null;
    h.lastSuccessAt = new Date();
    h.nextRetryAt = null;
    h.cooldownMs = 0;
  }

  recordFailure(sourceId, err) {
    const h = this.healthBySourceId.get(sourceId);
    if (!h) return;
    h.consecutiveFailures += 1;
    h.totalFailures += 1;
    h.lastError = {
      message: err.message,
      code: err.code || null,
      field: err.field || null,
      at: new Date()
    };
    if (h.consecutiveFailures >= FAILURE_THRESHOLD) {
      // exponential backoff: 30s, 60s, 120s, ... up to 30 min
      const exponent = Math.min(h.consecutiveFailures - FAILURE_THRESHOLD, 12);
      h.cooldownMs = Math.min(BACKOFF_INITIAL_MS * Math.pow(2, exponent), BACKOFF_MAX_MS);
      h.nextRetryAt = new Date(Date.now() + h.cooldownMs);
    }
  }

  shouldSkipForCooldown(sourceId, now) {
    const h = this.healthBySourceId.get(sourceId);
    if (!h || !h.nextRetryAt) return false;
    return now < h.nextRetryAt;
  }

  // ---------- Tick ----------

  async tick() {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    const now = new Date();
    let landed = 0;
    let attempted = 0;
    try {
      await this.reloadSources();

      for (const adapter of this.adapters.values()) {
        const source = adapter.source;
        const dueAt = source.lastSnapshotAt
          ? new Date(source.lastSnapshotAt.getTime() + source.snapshotIntervalSeconds * 1000)
          : new Date(0);
        if (now < dueAt) continue;
        if (this.shouldSkipForCooldown(source.id, now)) continue;

        attempted += 1;
        const h = this.healthBySourceId.get(source.id);
        if (h) h.lastTickAt = now;

        try {
          await adapter.discoverHolders();
          const rows = await adapter.snapshotAll(now);
          if (rows.length) {
            const written = await adapter.persistSnapshots(rows);
            landed += written;
            logger.info(`[points-indexer] ${source.key}: ${written}/${rows.length} snapshots`);
          }
          this.recordSuccess(source.id);
        } catch (err) {
          this.recordFailure(source.id, err);
          // Always log first failure of a chain so it's never silent.
          if (h && h.consecutiveFailures <= FAILURE_THRESHOLD) {
            logger.error(`[points-indexer] ${source.key} failed (${h.consecutiveFailures}/${FAILURE_THRESHOLD}): ${err.message}`);
          } else if (h && h.consecutiveFailures % 10 === 0) {
            // After tripping, log every 10th retry so it doesn't go silent forever.
            logger.warn(`[points-indexer] ${source.key} still failing (${h.consecutiveFailures}× in a row, next retry ${h.nextRetryAt?.toISOString()})`);
          }
        }
      }

      const accruals = await accrualEngine.processAll();
      if (accruals) logger.info(`[points-indexer] accrued ${accruals} new (source,address,period) rows`);
      landed += accruals;
    } finally {
      this.tickInProgress = false;
      const round = recordRound(this.roundHistory, { attempted, landed, at: now });
      if (isExhausted(this.roundHistory)) {
        logger.warn(`[points-indexer] diminishing-returns: avg landed over last 5 rounds is below threshold (round ${round.roundNumber})`);
      }
    }
  }

  async runOnce() {
    if (!this.provider) await this.initialize();
    await this.tick();
  }

  /**
   * Operator-facing health snapshot. Used by GET /api/points/admin/health.
   */
  health() {
    const sources = [];
    for (const [sourceId, h] of this.healthBySourceId.entries()) {
      const adapter = this.adapters.get(sourceId);
      sources.push({
        sourceId,
        sourceKey: adapter?.source.key,
        sourceType: adapter?.source.sourceType,
        contractAddress: adapter?.source.contractAddress,
        consecutiveFailures: h.consecutiveFailures,
        totalFailures: h.totalFailures,
        totalSuccesses: h.totalSuccesses,
        lastError: h.lastError,
        lastSuccessAt: h.lastSuccessAt,
        lastTickAt: h.lastTickAt,
        nextRetryAt: h.nextRetryAt,
        cooldownMs: h.cooldownMs,
        inCooldown: !!h.nextRetryAt && new Date() < h.nextRetryAt
      });
    }
    return {
      isRunning: this.isRunning,
      tickIntervalMs: config.INDEXER_TICK_MS,
      tickInProgress: this.tickInProgress,
      sources,
      diminishing: {
        rounds: this.roundHistory.slice(-5),
        exhausted: isExhausted(this.roundHistory)
      }
    };
  }
}

const instance = new Indexer();
module.exports = instance;
