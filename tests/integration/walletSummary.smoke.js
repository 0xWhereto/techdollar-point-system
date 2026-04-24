/**
 * End-to-end smoke for the new wallet endpoints. Spins up an in-memory SQLite,
 * seeds an active epoch, three sources (mint event, sUSDte stake, Curve LP),
 * a few snapshots and accruals matching the user's example:
 *   - 20,000 USD on Curve LP
 *   - 5,000 USD staked in sUSDte
 *   - 25,000 USD minted (USDte mint event, one-shot)
 * Then calls getWalletSummary / getPositions / getWalletRate and asserts the
 * frontend-facing shape is correct.
 */

process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
process.env.LOG_LEVEL = 'silent';

(async () => {
  const { sequelize, PointSource, PointEpoch, BalanceSnapshot, PointAccrual } = require('../../src/models');
  const pointsService = require('../../src/points/pointsService');

  await sequelize.sync({ force: true });

  const now = new Date('2026-04-21T12:00:00Z');
  const wallet = '0x1111111111111111111111111111111111111111';

  // 1) Active epoch (1× boost — matches user's spec).
  const epoch = await PointEpoch.create({
    key: 'season-1', name: 'Season 1', mode: 'live',
    boost: 1.0, startAt: new Date('2026-01-01T00:00:00Z'),
    endAt: null, isActive: true
  });

  // 2) Three sources.
  const mint = await PointSource.create({
    key: 'usdte_mint', name: 'USDte Mint',
    sourceType: 'erc20_mint_event',
    contractAddress: '0xaaa0000000000000000000000000000000000001',
    decimals: 18, multiplier: 1.0,
    basePointsPerUsdPerDay: null,
    snapshotIntervalSeconds: 3600,
    isActive: true,
    extraConfig: { pointsPerMint: 10 },
    chainId: 42161
  });
  const stake = await PointSource.create({
    key: 'susdte_stake', name: 'sUSDte Stake',
    sourceType: 'erc20_balance',
    contractAddress: '0xaaa0000000000000000000000000000000000002',
    decimals: 18, multiplier: 2.0,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    isActive: true, extraConfig: {}, chainId: 42161
  });
  const curve = await PointSource.create({
    key: 'curve_lp', name: 'Curve USDte/USDC LP',
    sourceType: 'curve_lp',
    contractAddress: '0xaaa0000000000000000000000000000000000003',
    decimals: 18, multiplier: 3.0,
    basePointsPerUsdPerDay: 1.0,
    snapshotIntervalSeconds: 3600,
    isActive: true, extraConfig: {}, chainId: 42161
  });

  // 3) Snapshots: latest USD value per time-weighted source.
  await BalanceSnapshot.create({
    sourceId: stake.id, address: wallet, blockNumber: 100,
    snapshotAt: now, balanceRaw: '5000000000000000000000',
    balanceFormatted: 5000, usdValue: 5000
  });
  await BalanceSnapshot.create({
    sourceId: curve.id, address: wallet, blockNumber: 100,
    snapshotAt: now, balanceRaw: '20000000000000000000000',
    balanceFormatted: 20000, usdValue: 20000
  });

  // 4) Lifetime accruals: a one-shot mint of 25,000 USDte (250,000 pts) plus
  //    a few hours of stake & LP accrual to seed lifetime totals.
  await PointAccrual.create({
    sourceId: mint.id, epochId: epoch.id, address: wallet,
    accrualType: 'mint_event', txHash: '0xdeadbeef'.padEnd(66, '0'),
    periodStart: now, periodEnd: now,
    durationSeconds: 0, avgUsdValue: 25000, basePoints: 250000,
    multiplier: 1.0, epochBoost: 1.0, points: 250000, mode: 'live'
  });
  await PointAccrual.create({
    sourceId: stake.id, epochId: epoch.id, address: wallet, accrualType: 'time_weighted',
    txHash: '', periodStart: new Date(now.getTime() - 3600_000), periodEnd: now,
    durationSeconds: 3600, avgUsdValue: 5000,
    basePoints: 5000 / 24, multiplier: 2.0, epochBoost: 1.0,
    points: (5000 / 24) * 2, mode: 'live'
  });
  await PointAccrual.create({
    sourceId: curve.id, epochId: epoch.id, address: wallet, accrualType: 'time_weighted',
    txHash: '', periodStart: new Date(now.getTime() - 3600_000), periodEnd: now,
    durationSeconds: 3600, avgUsdValue: 20000,
    basePoints: 20000 / 24, multiplier: 3.0, epochBoost: 1.0,
    points: (20000 / 24) * 3, mode: 'live'
  });

  // 5) Exercise the public API.
  const summary = await pointsService.getWalletSummary(wallet, { mode: 'live', now });
  const positions = await pointsService.getPositions(wallet, { mode: 'live', now });
  const rate = await pointsService.getWalletRate(wallet, { mode: 'live', now });

  const errs = [];
  const eq = (label, actual, expected, tol = 1e-6) => {
    const ok = Math.abs(actual - expected) <= tol;
    if (!ok) errs.push(`${label}: expected ${expected}, got ${actual}`);
  };
  const truthy = (label, v) => { if (!v) errs.push(`${label}: expected truthy, got ${v}`); };

  // -- summary
  truthy('summary.address', summary.address === wallet.toLowerCase());
  // Lifetime: 250000 mint + (5000/24)*2 + (20000/24)*3
  eq('summary.lifetimePoints', summary.lifetimePoints, 250000 + (5000 / 24) * 2 + (20000 / 24) * 3, 1e-3);
  // Per-hour: stake (5000/24*2) + curve (20000/24*3) + mint (0)
  eq('summary.pointsPerHour', summary.pointsPerHour, (5000 / 24) * 2 + (20000 / 24) * 3, 1e-9);
  eq('summary.pointsPerDay', summary.pointsPerDay, summary.pointsPerHour * 24, 1e-9);
  truthy('summary.epoch', summary.epoch && summary.epoch.key === 'season-1');
  truthy('summary.positions length=3', summary.positions.length === 3);
  truthy('summary.exposure alias', summary.exposure === summary.positions);

  // -- positions: find each surface and assert its shape.
  const byKey = Object.fromEntries(positions.map(p => [p.sourceKey, p]));
  truthy('mint position present', !!byKey.usdte_mint);
  truthy('mint accrualType=mint_event', byKey.usdte_mint.accrualType === 'mint_event');
  truthy('mint currentUsdValue null', byKey.usdte_mint.currentUsdValue === null);
  eq('mint lifetimeMintedUsd', byKey.usdte_mint.lifetimeMintedUsd, 25000);
  eq('mint lifetimePoints', byKey.usdte_mint.lifetimePoints, 250000);
  eq('mint pointsPerHour', byKey.usdte_mint.pointsPerHour, 0);

  truthy('stake position present', !!byKey.susdte_stake);
  truthy('stake accrualType=time_weighted', byKey.susdte_stake.accrualType === 'time_weighted');
  eq('stake currentUsdValue', byKey.susdte_stake.currentUsdValue, 5000);
  eq('stake pointsPerHour', byKey.susdte_stake.pointsPerHour, (5000 / 24) * 2, 1e-9);
  eq('stake projectedDailyPoints alias', byKey.susdte_stake.projectedDailyPoints, byKey.susdte_stake.pointsPerDay, 1e-9);

  truthy('curve position present', !!byKey.curve_lp);
  eq('curve currentUsdValue', byKey.curve_lp.currentUsdValue, 20000);
  eq('curve pointsPerHour (3× mult)', byKey.curve_lp.pointsPerHour, (20000 / 24) * 3, 1e-9);

  // -- rate
  eq('rate.pointsPerHour', rate.pointsPerHour, summary.pointsPerHour, 1e-9);
  truthy('rate.epochKey', rate.epochKey === 'season-1');

  if (errs.length) {
    console.error('SMOKE FAILED:');
    errs.forEach(e => console.error(' -', e));
    process.exit(1);
  }

  console.log('SMOKE OK — wallet endpoints return the expected shape.');
  console.log('  lifetimePoints =', summary.lifetimePoints.toFixed(4));
  console.log('  pointsPerHour  =', summary.pointsPerHour.toFixed(4));
  console.log('  pointsPerDay   =', summary.pointsPerDay.toFixed(4));
  console.log('  positions      =', summary.positions.map(p => `${p.sourceKey}(${p.accrualType})`).join(', '));
  await sequelize.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
