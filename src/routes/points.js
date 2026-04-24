const express = require('express');
const router = express.Router();
const { authenticate, authorize, optionalAuth } = require('../middleware/auth');
const { PointSource, PointEpoch, PointsExcludedAddress } = require('../models');
const pointsService = require('../points/pointsService');
const indexer = require('../points/indexer');
const accrualEngine = require('../points/accrualEngine');
const { PointsError, sendError, requireAddress } = require('../points/errors');
const logger = require('../utils/logger');

// ==================== PUBLIC ENDPOINTS ====================

router.get('/sources', async (req, res) => {
  try {
    const sources = await pointsService.getSources();
    res.json({ success: true, data: sources });
  } catch (err) {
    logger.error('points/sources error:', err);
    sendError(res, err, 'Failed to load sources');
  }
});

router.get('/epochs', async (req, res) => {
  try {
    const epochs = await pointsService.getEpochs();
    res.json({ success: true, data: epochs });
  } catch (err) {
    logger.error('points/epochs error:', err);
    sendError(res, err, 'Failed to load epochs');
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const mode = req.query.mode === 'all' ? 'all' : 'live';
    const result = await pointsService.getLeaderboard({ limit, offset, mode });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('points/leaderboard error:', err);
    sendError(res, err, 'Failed to load leaderboard');
  }
});

router.get('/stats', async (req, res) => {
  try {
    const mode = req.query.mode === 'all' ? 'all' : 'live';
    const stats = await pointsService.getStats({ mode });
    res.json({ success: true, data: stats });
  } catch (err) {
    logger.error('points/stats error:', err);
    sendError(res, err, 'Failed to load stats');
  }
});

/**
 * GET /api/points/wallet/:address
 * Single-roundtrip dashboard payload: lifetime points, current per-hour and
 * per-day rate, rank, active epoch, and per-source positions (USD currently
 * deployed in each surface + lifetime points + per-hour rate per surface).
 *
 * The response intentionally also exposes:
 *   - `total` (alias of `lifetimePoints`)        — kept for older clients
 *   - `exposure` (alias of `positions`)          — kept for Points.jsx
 * Newer clients should consume `lifetimePoints`, `pointsPerHour`, `positions`.
 */
router.get('/wallet/:address', async (req, res) => {
  try {
    const address = requireAddress(req.params.address, 'address');
    const mode = req.query.mode === 'all' ? 'all' : 'live';
    const summary = await pointsService.getWalletSummary(address, { mode });
    res.json({
      success: true,
      data: { ...summary, total: summary.lifetimePoints }
    });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('points/wallet error:', err);
    sendError(res, err, 'Failed to load wallet points');
  }
});

/**
 * GET /api/points/wallet/:address/positions
 * Just the per-source positions array — the lightest read for components that
 * only render the "where is my capital and what is each surface earning?" list.
 */
router.get('/wallet/:address/positions', async (req, res) => {
  try {
    const address = requireAddress(req.params.address, 'address');
    const mode = req.query.mode === 'all' ? 'all' : 'live';
    const positions = await pointsService.getPositions(address, { mode });
    res.json({ success: true, data: { address, positions } });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('points/wallet/positions error:', err);
    sendError(res, err, 'Failed to load wallet positions');
  }
});

/**
 * GET /api/points/wallet/:address/rate
 * Current per-hour earning rate only — for a polling "ticker" UI element.
 */
router.get('/wallet/:address/rate', async (req, res) => {
  try {
    const address = requireAddress(req.params.address, 'address');
    const mode = req.query.mode === 'all' ? 'all' : 'live';
    const rate = await pointsService.getWalletRate(address, { mode });
    res.json({ success: true, data: rate });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('points/wallet/rate error:', err);
    sendError(res, err, 'Failed to load wallet rate');
  }
});

router.get('/me', optionalAuth, async (req, res) => {
  try {
    const mode = req.query.mode === 'all' ? 'all' : 'live';
    const raw = req.query.address || req.user?.walletAddress;
    if (!raw) {
      return res.json({
        success: true,
        data: {
          address: null,
          total: 0, lifetimePoints: 0,
          pointsPerHour: 0, pointsPerDay: 0,
          rank: null, epoch: null,
          sources: [], positions: [], exposure: []
        }
      });
    }
    const address = requireAddress(raw, req.query.address ? 'address' : 'walletAddress');
    const summary = await pointsService.getWalletSummary(address, { mode });
    res.json({
      success: true,
      data: { ...summary, total: summary.lifetimePoints }
    });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('points/me error:', err);
    sendError(res, err, 'Failed to load your points');
  }
});

// ==================== ADMIN ENDPOINTS ====================

router.use('/admin', authenticate, authorize('admin'));

router.get('/admin/health', async (req, res) => {
  try {
    res.json({ success: true, data: indexer.health() });
  } catch (err) {
    logger.error('admin/health:', err);
    sendError(res, err, 'Failed to read indexer health');
  }
});

router.post('/admin/sources', async (req, res) => {
  try {
    const {
      key, name, description, sourceType, contractAddress,
      decimals, multiplier, basePointsPerUsdPerDay,
      snapshotIntervalSeconds, startBlock, isActive, extraConfig, chainId
    } = req.body;

    if (!key || !name || !sourceType || !contractAddress) {
      throw PointsError.validation(
        'key|name|sourceType|contractAddress',
        'key, name, sourceType, contractAddress are required',
        'pass all four when upserting a point source'
      );
    }
    const lcAddr = requireAddress(contractAddress, 'contractAddress');

    const [source, created] = await PointSource.findOrCreate({
      where: { key },
      defaults: {
        key, name, description, sourceType, contractAddress: lcAddr,
        decimals: decimals ?? 18,
        multiplier: multiplier ?? 1.0,
        basePointsPerUsdPerDay: basePointsPerUsdPerDay ?? 1.0,
        snapshotIntervalSeconds: snapshotIntervalSeconds ?? 3600,
        startBlock,
        isActive: isActive ?? true,
        extraConfig: extraConfig || {},
        chainId: chainId ?? 42161
      }
    });

    if (!created) {
      await source.update({
        name, description, sourceType,
        contractAddress: lcAddr,
        decimals: decimals ?? source.decimals,
        multiplier: multiplier ?? source.multiplier,
        basePointsPerUsdPerDay: basePointsPerUsdPerDay ?? source.basePointsPerUsdPerDay,
        snapshotIntervalSeconds: snapshotIntervalSeconds ?? source.snapshotIntervalSeconds,
        startBlock: startBlock ?? source.startBlock,
        isActive: isActive ?? source.isActive,
        extraConfig: extraConfig || source.extraConfig,
        chainId: chainId ?? source.chainId
      });
    }

    accrualEngine.invalidateCaches();
    res.json({ success: true, data: source, created });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('admin/sources upsert:', err);
    sendError(res, err, 'Failed to upsert source');
  }
});

router.patch('/admin/sources/:key', async (req, res) => {
  try {
    const source = await PointSource.findOne({ where: { key: req.params.key } });
    if (!source) {
      throw PointsError.notFound(
        'key',
        `source not found: ${req.params.key}`,
        'create the source first via POST /api/points/admin/sources'
      );
    }
    const allowed = ['name', 'description', 'multiplier', 'basePointsPerUsdPerDay',
                     'snapshotIntervalSeconds', 'isActive', 'extraConfig',
                     'contractAddress', 'startBlock'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    if (update.contractAddress) update.contractAddress = requireAddress(update.contractAddress, 'contractAddress');
    await source.update(update);
    accrualEngine.invalidateCaches();
    res.json({ success: true, data: source });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('admin/sources patch:', err);
    sendError(res, err, 'Failed to update source');
  }
});

router.post('/admin/epochs', async (req, res) => {
  try {
    const { key, name, description, mode, boost, startAt, endAt, isActive } = req.body;
    if (!key || !name || !startAt) {
      throw PointsError.validation(
        'key|name|startAt',
        'key, name, startAt are required',
        'pass all three when upserting an epoch'
      );
    }
    const [epoch, created] = await PointEpoch.findOrCreate({
      where: { key },
      defaults: {
        key, name, description,
        mode: mode || 'live',
        boost: boost ?? 1.0,
        startAt: new Date(startAt),
        endAt: endAt ? new Date(endAt) : null,
        isActive: isActive ?? true
      }
    });
    if (!created) {
      await epoch.update({
        name, description,
        mode: mode || epoch.mode,
        boost: boost ?? epoch.boost,
        startAt: new Date(startAt),
        endAt: endAt ? new Date(endAt) : null,
        isActive: isActive ?? epoch.isActive
      });
    }
    accrualEngine.invalidateCaches();
    res.json({ success: true, data: epoch, created });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('admin/epochs upsert:', err);
    sendError(res, err, 'Failed to upsert epoch');
  }
});

router.post('/admin/exclude', async (req, res) => {
  try {
    const { address, reason, category } = req.body;
    if (!address) {
      throw PointsError.validation('address', 'address is required', 'pass a 0x address');
    }
    const lc = requireAddress(address, 'address');
    const [row, created] = await PointsExcludedAddress.findOrCreate({
      where: { address: lc },
      defaults: { reason, category: category || 'other' }
    });
    if (!created) await row.update({ reason, category: category || row.category });
    accrualEngine.invalidateCaches();
    res.json({ success: true, data: row, created });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('admin/exclude:', err);
    sendError(res, err, 'Failed to exclude address');
  }
});

router.delete('/admin/exclude/:address', async (req, res) => {
  try {
    const lc = requireAddress(req.params.address, 'address');
    await PointsExcludedAddress.destroy({ where: { address: lc } });
    accrualEngine.invalidateCaches();
    res.json({ success: true });
  } catch (err) {
    if (!(err instanceof PointsError)) logger.error('admin/exclude delete:', err);
    sendError(res, err, 'Failed to remove exclusion');
  }
});

router.post('/admin/recompute', async (req, res) => {
  try {
    indexer.runOnce()
      .then(() => logger.info('admin-triggered recompute finished'))
      .catch(err => logger.error('admin-triggered recompute failed:', err));
    res.json({ success: true, message: 'Indexer run triggered (running in background)' });
  } catch (err) {
    logger.error('admin/recompute:', err);
    sendError(res, err, 'Failed to trigger recompute');
  }
});

router.post('/admin/accrue', async (req, res) => {
  try {
    const { since, upTo } = req.body || {};
    const written = await accrualEngine.processAll({
      since: since ? new Date(since) : undefined,
      upTo: upTo ? new Date(upTo) : undefined
    });
    res.json({ success: true, data: { rowsWritten: written } });
  } catch (err) {
    logger.error('admin/accrue:', err);
    sendError(res, err, 'Failed to run accrual');
  }
});

module.exports = router;
