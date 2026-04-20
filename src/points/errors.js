'use strict';

/**
 * PointsError — structured error type for the points subsystem.
 *
 * Borrowed from almanac-engine's AdapterError pattern: every failure carries
 * a stable `code`, the offending `field`, and a one-line `fixHint` so the
 * caller (route handler, frontend, operator) can act on it without parsing
 * the human-readable message.
 *
 * Codes are stable strings — frontends pin against them; do not rename.
 */

const CODES = Object.freeze({
  // 4xx — caller can fix
  VALIDATION:           'VALIDATION',           // bad/missing input
  NOT_FOUND:            'NOT_FOUND',            // unknown source / address / epoch
  CONFLICT:             'CONFLICT',             // duplicate key, constraint
  // 5xx — operator must fix
  CONFIG_MISSING:       'CONFIG_MISSING',       // env var or address not set
  RPC_FAILURE:          'RPC_FAILURE',          // ethers / provider error
  SUBGRAPH_FAILURE:     'SUBGRAPH_FAILURE',     // Morpho subgraph error
  IDEMPOTENCY:          'IDEMPOTENCY',          // accrual idempotency violation
  INTERNAL:             'INTERNAL'              // catch-all, but prefer specific
});

const HTTP_STATUS_BY_CODE = Object.freeze({
  VALIDATION:       400,
  NOT_FOUND:        404,
  CONFLICT:         409,
  CONFIG_MISSING:   503,
  RPC_FAILURE:      502,
  SUBGRAPH_FAILURE: 502,
  IDEMPOTENCY:      500,
  INTERNAL:         500
});

class PointsError extends Error {
  constructor(code, message, { field = null, fixHint = null, cause = null } = {}) {
    super(message);
    this.name = 'PointsError';
    this.code = code in CODES ? code : CODES.INTERNAL;
    this.field = field;
    this.fixHint = fixHint;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      field: this.field,
      fixHint: this.fixHint
    };
  }

  httpStatus() {
    return HTTP_STATUS_BY_CODE[this.code] || 500;
  }

  static validation(field, message, fixHint) {
    return new PointsError(CODES.VALIDATION, message, { field, fixHint });
  }

  static notFound(field, message, fixHint) {
    return new PointsError(CODES.NOT_FOUND, message, { field, fixHint });
  }

  static configMissing(field, fixHint) {
    return new PointsError(
      CODES.CONFIG_MISSING,
      `points config missing: ${field}`,
      { field, fixHint }
    );
  }

  static rpc(message, { cause, field } = {}) {
    return new PointsError(CODES.RPC_FAILURE, `rpc: ${message}`, {
      field,
      fixHint: 'check ETH_RPC_URL is reachable and the contract is deployed at the configured address',
      cause
    });
  }

  static subgraph(message, { cause, field } = {}) {
    return new PointsError(CODES.SUBGRAPH_FAILURE, `subgraph: ${message}`, {
      field,
      fixHint: 'check MORPHO_SUBGRAPH_URL is reachable and returns 200',
      cause
    });
  }
}

PointsError.CODES = CODES;

/**
 * Express helper — turns any error into the standard {success,error} response.
 * Non-PointsError errors are wrapped to INTERNAL and never leak stack traces.
 */
function sendError(res, err, fallbackMessage) {
  const pe = err instanceof PointsError
    ? err
    : new PointsError(CODES.INTERNAL, fallbackMessage || 'Internal error');
  return res.status(pe.httpStatus()).json({
    success: false,
    error: pe.message,
    code: pe.code,
    field: pe.field,
    fixHint: pe.fixHint
  });
}

/**
 * Address validator used on every public endpoint that takes an address.
 * Lower-cases on success.
 */
function requireAddress(value, field = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw PointsError.validation(
      field,
      `invalid ethereum address: ${value}`,
      'pass a 0x-prefixed 20-byte hex string'
    );
  }
  return value.toLowerCase();
}

module.exports = { PointsError, sendError, requireAddress };
