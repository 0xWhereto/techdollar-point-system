'use strict';

const { ethers } = require('ethers');
const Adapter = require('../../src/points/adapters/Erc20MintEventAdapter');
const { computeMintAccrualRow, pickEpochFor } = Adapter;

/**
 * Pure unit tests for the mint-event accrual computation. No DB, no RPC.
 *
 * The whole point of extracting `computeMintAccrualRow` as a free function
 * is so we can lock in the math + invariants here, without standing up
 * Sequelize.
 */

const ONE_USDTE = 10n ** 18n;
const MINT_AT = new Date('2026-04-15T12:00:00Z');

const DEFAULT_EPOCH = {
  id: 'epoch-sim',
  startAt: new Date('2026-04-01T00:00:00Z'),
  endAt: new Date('2026-05-01T00:00:00Z'),
  boost: 1.0,
  mode: 'simulation'
};

const LIVE_EPOCH = {
  id: 'epoch-live',
  startAt: new Date('2026-05-01T00:00:00Z'),
  endAt: null,
  boost: 1.0,
  mode: 'live'
};

const ALICE = '0xAAAAaaaaaaaaaaaaAAAAaaaaaaaAAAAaaaAAAAaa';

function baseEvent(overrides = {}) {
  return {
    address: ALICE,
    mintedRaw: 10000n * ONE_USDTE,        // 10,000 USDte
    decimals: 18,
    blockTime: MINT_AT,
    txHash: '0xDeAdBeEf' + '0'.repeat(58),
    sourceId: 'src-mint',
    multiplier: 1.0,
    pointsPerMint: 10.0,
    pegUsd: 1.0,
    epochs: [DEFAULT_EPOCH, LIVE_EPOCH],
    excluded: new Set(),
    ...overrides
  };
}

describe('computeMintAccrualRow', () => {
  test('10,000 USDte mint at 10 pts/USDte × 1× = 100,000 points', () => {
    const row = computeMintAccrualRow(baseEvent());
    expect(row).toBeTruthy();
    expect(row.points).toBe(100_000);
    expect(row.basePoints).toBe(100_000);
    expect(row.avgUsdValue).toBe(10_000);
    expect(row.durationSeconds).toBe(0);
    expect(row.accrualType).toBe('mint_event');
    expect(row.mode).toBe('simulation');                // MINT_AT falls in DEFAULT_EPOCH
    expect(row.epochId).toBe(DEFAULT_EPOCH.id);
  });

  test('lowercases address and tx hash', () => {
    const row = computeMintAccrualRow(baseEvent());
    expect(row.address).toBe(ALICE.toLowerCase());
    expect(row.txHash).toBe(row.txHash.toLowerCase());
    expect(row.txHash.startsWith('0xdeadbeef')).toBe(true);
  });

  test('periodStart === periodEnd (one-shot, zero duration)', () => {
    const row = computeMintAccrualRow(baseEvent());
    expect(row.periodStart.getTime()).toBe(MINT_AT.getTime());
    expect(row.periodEnd.getTime()).toBe(MINT_AT.getTime());
    expect(row.durationSeconds).toBe(0);
  });

  test('honors source.multiplier (mint surface should always be 1×, but the math composes)', () => {
    const row = computeMintAccrualRow(baseEvent({ multiplier: 2.5 }));
    expect(row.points).toBe(10_000 * 10 * 2.5);
  });

  test('honors epoch.boost', () => {
    const epochs = [{ ...DEFAULT_EPOCH, boost: 1.5 }];
    const row = computeMintAccrualRow(baseEvent({ epochs }));
    expect(row.points).toBe(10_000 * 10 * 1.0 * 1.5);
    expect(row.epochBoost).toBe(1.5);
  });

  test('respects pegUsd ≠ 1 for non-USD-pegged mints', () => {
    // Hypothetical depeg / re-peg scenario: USDte trading at $0.99
    const row = computeMintAccrualRow(baseEvent({ pegUsd: 0.99 }));
    expect(row.avgUsdValue).toBeCloseTo(10_000 * 0.99, 6);
    expect(row.points).toBeCloseTo(10_000 * 0.99 * 10, 6);
  });

  test('handles non-18-decimal tokens', () => {
    // 6-decimal token like USDC: mint 1000.000000 = raw 1_000_000_000
    const row = computeMintAccrualRow(baseEvent({
      mintedRaw: 1_000_000_000n,
      decimals: 6
    }));
    expect(row.avgUsdValue).toBe(1000);
    expect(row.points).toBe(1000 * 10);
  });

  test('returns null when address is the zero address', () => {
    expect(computeMintAccrualRow(baseEvent({ address: ethers.ZeroAddress }))).toBeNull();
  });

  test('returns null when address is empty', () => {
    expect(computeMintAccrualRow(baseEvent({ address: '' }))).toBeNull();
  });

  test('returns null when address is in the excluded set', () => {
    const excluded = new Set([ALICE.toLowerCase()]);
    expect(computeMintAccrualRow(baseEvent({ excluded }))).toBeNull();
  });

  test('returns null for zero-amount mints', () => {
    expect(computeMintAccrualRow(baseEvent({ mintedRaw: 0n }))).toBeNull();
  });

  test('returns null for negative-amount mints (defensive)', () => {
    expect(computeMintAccrualRow(baseEvent({ mintedRaw: -1n }))).toBeNull();
  });

  test('returns null for invalid mintedRaw (string that does not parse)', () => {
    expect(computeMintAccrualRow(baseEvent({ mintedRaw: 'not-a-number' }))).toBeNull();
  });

  test('returns null for non-numeric multiplier', () => {
    expect(computeMintAccrualRow(baseEvent({ multiplier: 'oops' }))).toBeNull();
  });

  test('returns null for non-numeric pointsPerMint', () => {
    expect(computeMintAccrualRow(baseEvent({ pointsPerMint: 'oops' }))).toBeNull();
  });

  test('returns null when blockTime falls outside every epoch', () => {
    expect(computeMintAccrualRow(baseEvent({
      blockTime: new Date('2025-01-01T00:00:00Z')      // before SIMULATION_START
    }))).toBeNull();
  });

  test('uses the epoch active at blockTime, not at "now"', () => {
    // mint AT exactly the live launch boundary → should use LIVE_EPOCH
    const row = computeMintAccrualRow(baseEvent({
      blockTime: new Date('2026-05-01T00:00:00Z')
    }));
    expect(row.mode).toBe('live');
    expect(row.epochId).toBe(LIVE_EPOCH.id);
  });

  test('accepts both Date and ISO-string blockTime', () => {
    const a = computeMintAccrualRow(baseEvent({ blockTime: MINT_AT }));
    const b = computeMintAccrualRow(baseEvent({ blockTime: MINT_AT.toISOString() }));
    expect(a.points).toBe(b.points);
    expect(a.periodStart.getTime()).toBe(b.periodStart.getTime());
  });

  test('is pure: same input → same output (idempotency anchor)', () => {
    const ev = baseEvent();
    const a = computeMintAccrualRow(ev);
    const b = computeMintAccrualRow(ev);
    expect(a).toEqual(b);
  });

  test('two mints in the same block produce distinct txHashes (caller responsibility, but we surface them faithfully)', () => {
    const a = computeMintAccrualRow(baseEvent({ txHash: '0x' + '1'.repeat(64) }));
    const b = computeMintAccrualRow(baseEvent({ txHash: '0x' + '2'.repeat(64) }));
    expect(a.txHash).not.toBe(b.txHash);
    expect(a.periodStart.getTime()).toBe(b.periodStart.getTime());
    // The unique index in the DB is (sourceId, address, periodStart, txHash) — distinct txHash → distinct rows.
  });
});

describe('pickEpochFor', () => {
  const epochs = [DEFAULT_EPOCH, LIVE_EPOCH];

  test('picks the simulation epoch for pre-launch timestamps', () => {
    expect(pickEpochFor(epochs, new Date('2026-04-15T12:00:00Z').getTime())).toBe(DEFAULT_EPOCH);
  });

  test('picks the live epoch from the launch boundary onwards', () => {
    expect(pickEpochFor(epochs, new Date('2026-05-01T00:00:00Z').getTime())).toBe(LIVE_EPOCH);
    expect(pickEpochFor(epochs, new Date('2099-01-01T00:00:00Z').getTime())).toBe(LIVE_EPOCH);
  });

  test('returns null for timestamps before any epoch', () => {
    expect(pickEpochFor(epochs, new Date('2025-01-01').getTime())).toBeNull();
  });

  test('treats endAt = null as +∞ (open-ended live epoch)', () => {
    expect(pickEpochFor([LIVE_EPOCH], Date.now() + 100 * 365 * 86400 * 1000)).toBe(LIVE_EPOCH);
  });

  test('returns null when epochs is undefined', () => {
    expect(pickEpochFor(undefined, Date.now())).toBeNull();
  });
});
