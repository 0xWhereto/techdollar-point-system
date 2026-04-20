const { computeAccrualRows, pickEpoch } = require('../../src/points/accrualEngine');

const liveEpoch = {
  id: 'epoch-live-1',
  mode: 'live',
  boost: 1.0,
  startAt: new Date('2026-04-01T00:00:00Z'),
  endAt: null
};

const simEpoch = {
  id: 'epoch-sim-1',
  mode: 'simulation',
  boost: 1.0,
  startAt: new Date('2026-01-01T00:00:00Z'),
  endAt: new Date('2026-04-01T00:00:00Z')
};

const usdteSource = {
  id: 'src-usdte',
  basePointsPerUsdPerDay: 1.0,
  multiplier: 1.0
};

const stakeSource = {
  id: 'src-susdte',
  basePointsPerUsdPerDay: 1.0,
  multiplier: 2.0
};

const lpSource = {
  id: 'src-lp',
  basePointsPerUsdPerDay: 1.0,
  multiplier: 3.0
};

const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function snap(t, usd) {
  return { snapshotAt: new Date(t), usdValue: usd };
}

describe('computeAccrualRows', () => {
  it('returns [] when fewer than 2 snapshots are available', () => {
    expect(computeAccrualRows([], usdteSource, [liveEpoch], new Set(), ADDR)).toEqual([]);
    expect(computeAccrualRows([snap('2026-04-02T00:00:00Z', 100)], usdteSource, [liveEpoch], new Set(), ADDR)).toEqual([]);
  });

  it('returns [] when the address is excluded', () => {
    const snaps = [snap('2026-04-02T00:00:00Z', 100), snap('2026-04-03T00:00:00Z', 100)];
    const excluded = new Set([ADDR]);
    expect(computeAccrualRows(snaps, usdteSource, [liveEpoch], excluded, ADDR)).toEqual([]);
  });

  it('time-weights points correctly: 100 USD held for 1 day at 1× = 100 points', () => {
    const snaps = [
      snap('2026-04-02T00:00:00Z', 100),
      snap('2026-04-03T00:00:00Z', 100)
    ];
    const rows = computeAccrualRows(snaps, usdteSource, [liveEpoch], new Set(), ADDR);
    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBeCloseTo(100, 6);
    expect(rows[0].mode).toBe('live');
    expect(rows[0].address).toBe(ADDR);
  });

  it('applies the source multiplier (2× for stake)', () => {
    const snaps = [
      snap('2026-04-02T00:00:00Z', 50),
      snap('2026-04-03T00:00:00Z', 50)
    ];
    const rows = computeAccrualRows(snaps, stakeSource, [liveEpoch], new Set(), ADDR);
    expect(rows[0].points).toBeCloseTo(100, 6); // 50 USD * 1 day * 1.0 base * 2.0 mult
  });

  it('applies the liquidity multiplier (3× for LP)', () => {
    const snaps = [
      snap('2026-04-02T00:00:00Z', 1000),
      snap('2026-04-03T00:00:00Z', 1000)
    ];
    const rows = computeAccrualRows(snaps, lpSource, [liveEpoch], new Set(), ADDR);
    expect(rows[0].points).toBeCloseTo(3000, 6); // 1000 USD * 1 day * 3×
  });

  it('uses the AVERAGE of consecutive snapshots (linear interpolation)', () => {
    // Held 100 USD for 12h, then 200 USD for 12h. Avg = 150, total = 150 USD-days.
    const snaps = [
      snap('2026-04-02T00:00:00Z', 100),
      snap('2026-04-02T12:00:00Z', 100), // unchanged
      snap('2026-04-03T00:00:00Z', 200)  // jumped
    ];
    const rows = computeAccrualRows(snaps, usdteSource, [liveEpoch], new Set(), ADDR);
    // Two intervals: 100 USD * 0.5d = 50, then avg(100,200)=150 USD * 0.5d = 75.
    const total = rows.reduce((s, r) => s + r.points, 0);
    expect(total).toBeCloseTo(125, 6);
  });

  it('skips zero-duration intervals (duplicate timestamps)', () => {
    const t = '2026-04-02T00:00:00Z';
    const snaps = [snap(t, 100), snap(t, 200)];
    const rows = computeAccrualRows(snaps, usdteSource, [liveEpoch], new Set(), ADDR);
    expect(rows).toEqual([]);
  });

  it('skips intervals whose average USD is non-positive', () => {
    const snaps = [
      snap('2026-04-02T00:00:00Z', 0),
      snap('2026-04-03T00:00:00Z', 0)
    ];
    const rows = computeAccrualRows(snaps, usdteSource, [liveEpoch], new Set(), ADDR);
    expect(rows).toEqual([]);
  });

  it('ignores intervals that start outside any defined epoch', () => {
    const snaps = [
      snap('2025-01-01T00:00:00Z', 100), // before any epoch
      snap('2025-01-02T00:00:00Z', 100)
    ];
    const rows = computeAccrualRows(snaps, usdteSource, [liveEpoch, simEpoch], new Set(), ADDR);
    expect(rows).toEqual([]);
  });

  it('tags each row with the epoch.mode active at periodStart (simulation vs live)', () => {
    const snaps = [
      snap('2026-02-01T00:00:00Z', 100), // inside simEpoch
      snap('2026-02-02T00:00:00Z', 100),
      snap('2026-04-02T00:00:00Z', 100), // inside liveEpoch
      snap('2026-04-03T00:00:00Z', 100)
    ];
    const rows = computeAccrualRows(snaps, usdteSource, [liveEpoch, simEpoch], new Set(), ADDR);
    const modes = rows.map(r => r.mode);
    expect(modes).toContain('live');
    expect(modes).toContain('simulation');
  });

  it('is pure: same input → same output (idempotency anchor)', () => {
    const snaps = [
      snap('2026-04-02T00:00:00Z', 100),
      snap('2026-04-03T00:00:00Z', 100),
      snap('2026-04-04T00:00:00Z', 100)
    ];
    const a = computeAccrualRows(snaps, usdteSource, [liveEpoch], new Set(), ADDR);
    const b = computeAccrualRows(snaps, usdteSource, [liveEpoch], new Set(), ADDR);
    expect(a).toEqual(b);
    // The natural key the DB enforces: (sourceId, address, periodStart) is unique.
    const keys = a.map(r => `${r.sourceId}|${r.address}|${r.periodStart.toISOString()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('accepts both raw (snake_case) and model-instance (camelCase) snapshot shapes', () => {
    const camel = [snap('2026-04-02T00:00:00Z', 100), snap('2026-04-03T00:00:00Z', 100)];
    const snake = [
      { snapshot_at: '2026-04-02T00:00:00Z', usd_value: 100 },
      { snapshot_at: '2026-04-03T00:00:00Z', usd_value: 100 }
    ];
    const a = computeAccrualRows(camel, usdteSource, [liveEpoch], new Set(), ADDR);
    const b = computeAccrualRows(snake, usdteSource, [liveEpoch], new Set(), ADDR);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].points).toBeCloseTo(b[0].points, 9);
  });
});

describe('pickEpoch', () => {
  it('picks the epoch whose [startAt, endAt) contains t', () => {
    const t = new Date('2026-02-15T00:00:00Z').getTime();
    expect(pickEpoch([liveEpoch, simEpoch], t)).toBe(simEpoch);
  });

  it('returns null when t falls outside every epoch', () => {
    const t = new Date('2025-06-01T00:00:00Z').getTime();
    expect(pickEpoch([liveEpoch, simEpoch], t)).toBeNull();
  });

  it('treats endAt = null as +∞ (open-ended live epoch)', () => {
    const t = new Date('2099-01-01T00:00:00Z').getTime();
    expect(pickEpoch([liveEpoch], t)).toBe(liveEpoch);
  });
});
