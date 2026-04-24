const { computePointsPerHour, aggregateRate } = require('../../src/points/pointsService');

describe('pointsService — pure rate helpers', () => {
  describe('computePointsPerHour', () => {
    const baseInputs = {
      accrualType: 'time_weighted',
      currentUsdValue: 1000,
      basePerDay: 1,
      multiplier: 1,
      epochBoost: 1
    };

    it('matches the spec formula: usd × basePerDay × mult × boost / 24', () => {
      // 20,000 USD on Curve at 1 base point per USD per day, 3× multiplier, no
      // boost → 20000 × 1 × 3 × 1 / 24 = 2500 pts/hr.
      expect(computePointsPerHour({
        accrualType: 'time_weighted',
        currentUsdValue: 20000, basePerDay: 1, multiplier: 3, epochBoost: 1
      })).toBeCloseTo(2500, 6);
    });

    it('respects the staking 2× multiplier', () => {
      // 5,000 sUSDte at 2× → 5000 × 1 × 2 / 24 = 416.6666...
      expect(computePointsPerHour({
        accrualType: 'time_weighted',
        currentUsdValue: 5000, basePerDay: 1, multiplier: 2, epochBoost: 1
      })).toBeCloseTo(5000 / 24 * 2, 6);
    });

    it('respects the active epoch boost', () => {
      // Same Curve LP but with a 1.5× epoch boost.
      expect(computePointsPerHour({
        accrualType: 'time_weighted',
        currentUsdValue: 20000, basePerDay: 1, multiplier: 3, epochBoost: 1.5
      })).toBeCloseTo(2500 * 1.5, 6);
    });

    it('returns 0 for mint_event sources (one-shot, no continuous accrual)', () => {
      expect(computePointsPerHour({
        accrualType: 'mint_event',
        currentUsdValue: 25000, basePerDay: 999, multiplier: 999, epochBoost: 999
      })).toBe(0);
    });

    it('returns 0 when usd, basePerDay, multiplier or boost are non-positive', () => {
      expect(computePointsPerHour({ ...baseInputs, currentUsdValue: 0 })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, currentUsdValue: -10 })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, basePerDay: 0 })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, multiplier: 0 })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, epochBoost: 0 })).toBe(0);
    });

    it('returns 0 for null / NaN / non-finite inputs', () => {
      expect(computePointsPerHour({ ...baseInputs, currentUsdValue: null })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, basePerDay: undefined })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, multiplier: NaN })).toBe(0);
      expect(computePointsPerHour({ ...baseInputs, epochBoost: Infinity })).toBe(0);
    });
  });

  describe('aggregateRate', () => {
    it('sums per-hour and lifetime points across positions', () => {
      // The user's example: 20k Curve LP, 5k sUSDte stake, 25k USDte minted.
      const positions = [
        { pointsPerHour: 2500, lifetimePoints: 60000 },          // Curve (3× × 20k)
        { pointsPerHour: 5000 / 24 * 2, lifetimePoints: 10000 }, // sUSDte (2× × 5k)
        { pointsPerHour: 0, lifetimePoints: 250000 }             // USDte mint (one-shot, 25k × 10 pts)
      ];
      const rate = aggregateRate(positions);
      expect(rate.pointsPerHour).toBeCloseTo(2500 + 5000 / 24 * 2, 6);
      expect(rate.pointsPerDay).toBeCloseTo(rate.pointsPerHour * 24, 6);
      expect(rate.lifetimePoints).toBe(60000 + 10000 + 250000);
    });

    it('treats missing fields as zero', () => {
      const rate = aggregateRate([{}, { pointsPerHour: 100 }, { lifetimePoints: 5 }]);
      expect(rate.pointsPerHour).toBe(100);
      expect(rate.pointsPerDay).toBe(2400);
      expect(rate.lifetimePoints).toBe(5);
    });

    it('returns zeros for an empty positions array', () => {
      expect(aggregateRate([])).toEqual({ pointsPerHour: 0, pointsPerDay: 0, lifetimePoints: 0 });
    });
  });
});
