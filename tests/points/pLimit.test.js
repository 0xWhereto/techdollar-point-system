const pLimit = require('../../src/points/pLimit');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('pLimit', () => {
  it('respects the concurrency cap', async () => {
    const limit = pLimit(3);
    let active = 0;
    let peak = 0;
    const job = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(10);
      active -= 1;
    };
    await Promise.all(Array.from({ length: 10 }, () => limit(job)));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('preserves per-task results in calling order', async () => {
    const limit = pLimit(2);
    const out = await Promise.all([1, 2, 3, 4, 5].map(n => limit(async () => n * 2)));
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('propagates rejections without stalling subsequent tasks', async () => {
    const limit = pLimit(2);
    const settled = await Promise.allSettled([
      limit(async () => { throw new Error('boom'); }),
      limit(async () => 'ok'),
      limit(async () => 'still-ok')
    ]);
    expect(settled[0].status).toBe('rejected');
    expect(settled[1].status).toBe('fulfilled');
    expect(settled[2].status).toBe('fulfilled');
  });

  it('treats invalid concurrency as 1 (fail-closed, never throws)', async () => {
    const limit = pLimit(0);
    const out = await Promise.all([limit(async () => 'a'), limit(async () => 'b')]);
    expect(out).toEqual(['a', 'b']);
  });
});
