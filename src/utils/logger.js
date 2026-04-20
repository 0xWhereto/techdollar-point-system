'use strict';

/**
 * Tiny logger so the points subsystem stays drop-in. The host app likely has
 * a richer logger (winston, pino, etc.) — replace this file with a re-export
 * when you integrate.
 */
const noColor = process.env.NO_COLOR === '1' || process.env.NODE_ENV === 'test';
const ts = () => new Date().toISOString();
const fmt = (level, args) => `${ts()} [${level}] ` + args.map(a => (
  a instanceof Error ? (a.stack || a.message) : (typeof a === 'object' ? JSON.stringify(a) : String(a))
)).join(' ');

module.exports = {
  debug: (...a) => { if (process.env.LOG_LEVEL === 'debug') process.stdout.write(fmt('DEBUG', a) + '\n'); },
  info:  (...a) => process.stdout.write(fmt('INFO', a) + '\n'),
  warn:  (...a) => process.stderr.write(fmt('WARN', a) + '\n'),
  error: (...a) => process.stderr.write(fmt('ERROR', a) + '\n'),
  noColor
};
