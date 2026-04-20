'use strict';

/**
 * curveValue
 * ----------
 * Single source of truth for "how do we value a Curve LP position in USD?".
 *
 * Spec (locked): the user's USD exposure equals the FULL LP value, not just
 * the USDte slice of the pool.
 *
 *     usdValue = lpAmount * virtualPrice
 *
 * - lpAmount is the LP token balance in human units (post-decimals).
 * - virtualPrice is `pool.get_virtual_price()` divided by 1e18 (~$/LP for a
 *   stable pool; starts at 1.0 and grows slowly with fees).
 * - gauge deposits are added to the user's LP balance before this call by
 *   the adapter, since gauged LP is still LP.
 *
 * The function is pure so the invariant can be unit-tested without an RPC.
 */
function lpUsdValue(lpAmount, virtualPrice) {
  const a = Number(lpAmount);
  const v = Number(virtualPrice);
  if (!Number.isFinite(a) || !Number.isFinite(v)) return 0;
  if (a <= 0 || v <= 0) return 0;
  return a * v;
}

module.exports = { lpUsdValue };
