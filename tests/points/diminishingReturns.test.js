const {
  recordRound,
  computeAvgLanded,
  computeRoundsSinceLastLanding,
  isExhausted,
  constants
} = require('../../src/points/diminishingReturns');

function fillRounds(history, landings) {
  for (const landed of landings) {
    recordRound(history, { attempted: 1, landed });
  }
}

describe('diminishingReturns (port of almanac diminishing_returns.cjs)', () => {
  describe('recordRound', () => {
    it('appends a round with monotonic roundNumber and ISO timestamp', () => {
      const h = [];
      const r1 = recordRound(h, { attempted: 2, landed: 1 });
      const r2 = recordRound(h, { attempted: 3, landed: 0 });
      expect(r1.roundNumber).toBe(1);
      expect(r2.roundNumber).toBe(2);
      expect(typeof r1.timestamp).toBe('string');
      expect(h).toHaveLength(2);
    });

    it('caps history at MAX_HISTORY (drops oldest first)', () => {
      const h = [];
      for (let i = 0; i < constants.MAX_HISTORY + 25; i++) {
        recordRound(h, { attempted: 1, landed: 1 });
      }
      expect(h.length).toBe(constants.MAX_HISTORY);
      expect(h[h.length - 1].roundNumber).toBe(constants.MAX_HISTORY + 25);
    });
  });

  describe('computeAvgLanded', () => {
    it('returns 0 for empty history', () => {
      expect(computeAvgLanded([])).toBe(0);
    });

    it('averages over the last LAST_N_ROUNDS only', () => {
      const h = [];
      fillRounds(h, [10, 10, 10, 10, 10, 0, 0, 0, 0, 0]);
      expect(computeAvgLanded(h)).toBe(0); // last 5 are zeros
    });
  });

  describe('computeRoundsSinceLastLanding', () => {
    it('counts trailing zero-landing rounds', () => {
      const h = [];
      fillRounds(h, [3, 0, 0, 0]);
      expect(computeRoundsSinceLastLanding(h)).toBe(3);
    });

    it('returns 0 when the most recent round landed', () => {
      const h = [];
      fillRounds(h, [0, 0, 5]);
      expect(computeRoundsSinceLastLanding(h)).toBe(0);
    });
  });

  describe('isExhausted', () => {
    it('returns false until LAST_N_ROUNDS rounds have happened', () => {
      const h = [];
      fillRounds(h, [0, 0, 0, 0]);
      expect(isExhausted(h)).toBe(false);
    });

    it('trips on low average over the last 5 rounds', () => {
      const h = [];
      fillRounds(h, [0, 0, 0, 0, 0]);
      expect(isExhausted(h)).toBe(true);
    });

    it('trips on a long streak of zero landings even with a high earlier average', () => {
      const h = [];
      fillRounds(h, [10, 10, 10, 10, 10, 0, 0, 0, 0, 0]);
      expect(isExhausted(h)).toBe(true);
    });

    it('stays false while rounds keep landing above threshold', () => {
      const h = [];
      fillRounds(h, [3, 5, 7, 4, 6]);
      expect(isExhausted(h)).toBe(false);
    });
  });
});
