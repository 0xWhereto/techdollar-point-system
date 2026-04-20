'use strict';

/**
 * Tiny in-tree p-limit. ~15 lines, zero deps. We avoid the npm dep because
 * we already ship to a backend that ban-lists new transitive dependencies.
 *
 *   const limit = pLimit(8);
 *   const results = await Promise.all(items.map(x => limit(() => doWork(x))));
 *
 * Concurrency cap is hard — at most `concurrency` tasks ever run at once.
 */
function pLimit(concurrency) {
  const c = Math.max(1, Math.floor(Number(concurrency) || 1));
  const queue = [];
  let active = 0;

  const next = () => {
    if (active >= c || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(
        (v) => { active -= 1; resolve(v); next(); },
        (e) => { active -= 1; reject(e); next(); }
      );
  };

  return function (fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = pLimit;
