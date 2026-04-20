const { PointsError, requireAddress, sendError } = require('../../src/points/errors');

describe('PointsError', () => {
  it('exposes a stable code, field, fixHint, and httpStatus', () => {
    const err = PointsError.validation('address', 'bad', 'pass 0x...');
    expect(err).toBeInstanceOf(PointsError);
    expect(err.code).toBe('VALIDATION');
    expect(err.field).toBe('address');
    expect(err.fixHint).toBe('pass 0x...');
    expect(err.httpStatus()).toBe(400);
    expect(err.toJSON()).toEqual({
      code: 'VALIDATION',
      message: 'bad',
      field: 'address',
      fixHint: 'pass 0x...'
    });
  });

  it('maps each known code to the right HTTP status', () => {
    expect(new PointsError('NOT_FOUND', 'x').httpStatus()).toBe(404);
    expect(new PointsError('CONFLICT', 'x').httpStatus()).toBe(409);
    expect(new PointsError('CONFIG_MISSING', 'x').httpStatus()).toBe(503);
    expect(new PointsError('RPC_FAILURE', 'x').httpStatus()).toBe(502);
    expect(new PointsError('SUBGRAPH_FAILURE', 'x').httpStatus()).toBe(502);
    expect(new PointsError('IDEMPOTENCY', 'x').httpStatus()).toBe(500);
  });

  it('falls back to INTERNAL for unknown codes', () => {
    const err = new PointsError('GIBBERISH', 'x');
    expect(err.code).toBe('INTERNAL');
    expect(err.httpStatus()).toBe(500);
  });

  it('attaches a cause when provided (not enumerable on toJSON)', () => {
    const cause = new Error('underlying');
    const err = PointsError.rpc('boom', { cause });
    expect(err.cause).toBe(cause);
    expect(err.toJSON().cause).toBeUndefined();
  });
});

describe('requireAddress', () => {
  it('lowercases and returns valid 0x addresses', () => {
    expect(requireAddress('0xAbCDef0123456789AbCDef0123456789AbCDef01'))
      .toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('rejects non-strings, wrong length, and non-hex', () => {
    expect(() => requireAddress(undefined)).toThrow(PointsError);
    expect(() => requireAddress('')).toThrow(PointsError);
    expect(() => requireAddress('0x123')).toThrow(PointsError);
    expect(() => requireAddress('0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow(PointsError);
    try { requireAddress('not-an-address'); } catch (e) {
      expect(e.code).toBe('VALIDATION');
      expect(e.field).toBe('address');
      expect(e.httpStatus()).toBe(400);
    }
  });
});

describe('sendError', () => {
  function fakeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  it('serializes a PointsError with code/field/fixHint and the right status', () => {
    const res = fakeRes();
    sendError(res, PointsError.notFound('key', 'no source'));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'no source',
      code: 'NOT_FOUND',
      field: 'key',
      fixHint: null
    });
  });

  it('wraps a non-PointsError as INTERNAL with the fallback message', () => {
    const res = fakeRes();
    sendError(res, new Error('leaky details'), 'Something broke');
    expect(res.status).toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe('INTERNAL');
    expect(payload.error).toBe('Something broke');
    // Stack / underlying message must NOT leak.
    expect(payload.error).not.toContain('leaky');
  });
});
