const { lpUsdValue } = require('../../src/points/curveValue');

describe('Curve LP usd valuation (full-LP-value invariant)', () => {
  it('returns lpAmount * virtualPrice', () => {
    expect(lpUsdValue(100, 1)).toBeCloseTo(100, 9);
    expect(lpUsdValue(100, 1.05)).toBeCloseTo(105, 9);
    expect(lpUsdValue(0.5, 2.0)).toBeCloseTo(1.0, 9);
  });

  it('locks in the spec: a position holding LP tokens earns on FULL pool value, not USDte slice', () => {
    // Hypothetical pool: 50% USDte, 50% USDC, virtual_price = 1.02.
    // User holds 1000 LP. Their USD exposure for points = 1000 * 1.02 = 1020.
    // (NOT 1000 * 0.5 = 500 which would be the USDte-only slice.)
    expect(lpUsdValue(1000, 1.02)).toBeCloseTo(1020, 6);
  });

  it('returns 0 for non-positive or non-finite inputs (fail-closed)', () => {
    expect(lpUsdValue(0, 1)).toBe(0);
    expect(lpUsdValue(-1, 1)).toBe(0);
    expect(lpUsdValue(1, 0)).toBe(0);
    expect(lpUsdValue(1, -1)).toBe(0);
    expect(lpUsdValue(NaN, 1)).toBe(0);
    expect(lpUsdValue(1, Infinity)).toBe(0);
  });
});
