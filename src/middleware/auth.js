'use strict';

/**
 * Minimal auth middleware for the standalone points repo.
 *
 * Replace this file with your host app's real middleware when integrating.
 * The included implementation:
 *   - `authenticate` — accepts a Bearer JWT signed with `JWT_SECRET` and
 *     attaches { id, email, role, walletAddress } to req.user. If
 *     POINTS_ADMIN_TOKEN is set, that exact bearer also passes as an admin.
 *   - `authorize(...roles)` — gate by role.
 *   - `optionalAuth` — same as authenticate but never rejects.
 *
 * The tests do not exercise these (the unit tests cover pure modules), so
 * you do not need to set JWT_SECRET to run `npm test`.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_TOKEN = process.env.POINTS_ADMIN_TOKEN || null;

function decode(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) {
    return { id: 'admin', role: 'admin', email: 'admin@local' };
  }
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function authenticate(req, res, next) {
  const u = decode(req);
  if (!u) return res.status(401).json({ success: false, error: 'Unauthenticated' });
  req.user = u;
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

function optionalAuth(req, _res, next) {
  const u = decode(req);
  if (u) req.user = u;
  next();
}

module.exports = { authenticate, authorize, optionalAuth };
