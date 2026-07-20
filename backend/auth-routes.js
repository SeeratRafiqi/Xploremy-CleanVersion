/**
 * Cookie session + /api/auth/* routes for viewer sign-in / sign-up.
 */
'use strict';

const crypto = require('crypto');
const authStore = require('./auth-store');
const { sendMail } = require('./mailer');

const COOKIE_NAME = 'ts_session';
const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_MAX_MS = 60 * 60 * 1000; // password reset link valid for 1 hour
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sessionSecret() {
  return String(process.env.SESSION_SECRET).trim();
}

function createSessionToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, iat: Date.now() }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.uid) return null;
    if (typeof data.iat !== 'number' || Date.now() - data.iat > SESSION_MAX_MS) return null;
    return String(data.uid);
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  });
  return out;
}

function getSessionUserId(req) {
  const raw = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  return verifySessionToken(raw);
}

function setSessionCookie(res, userId) {
  const token = createSessionToken(userId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_MAX_MS / 1000);
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/**
 * Fingerprint of the current password hash. A reset token carries this, so once
 * the password changes the fingerprint no longer matches → the link becomes
 * single-use without any server-side token storage.
 */
function passwordFingerprint(passwordHash) {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update('pwfp:' + String(passwordHash || ''))
    .digest('base64url')
    .slice(0, 24);
}

function createResetToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ uid: user.id, fp: passwordFingerprint(user.passwordHash), iat: Date.now(), typ: 'reset' }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update('reset.' + payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyResetToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update('reset.' + payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.typ !== 'reset' || !data.uid || !data.fp) return null;
    if (typeof data.iat !== 'number' || Date.now() - data.iat > RESET_TOKEN_MAX_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function resolveBaseUrl(req) {
  const envBase = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  const xfProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto || req.protocol || 'http').toString().split(',')[0].trim();
  const xfHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost || req.headers.host || 'localhost').toString().split(',')[0].trim();
  return proto + '://' + host;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(Array.isArray(xf) ? xf[0] : xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Tiny fixed-window in-memory limiter (best-effort abuse throttle per instance). */
const _rlBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const b = _rlBuckets.get(key);
  if (!b || now > b.reset) {
    _rlBuckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

// Failed-login throttling: same in-memory per-IP bucket pattern as above, but
// counts only failed attempts and is cleared on a successful login.
const LOGIN_MAX_FAILS = 7;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

function loginThrottled(key) {
  const b = _rlBuckets.get(key);
  if (!b || Date.now() > b.reset) return false;
  return b.count >= LOGIN_MAX_FAILS;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const b = _rlBuckets.get(key);
  if (!b || now > b.reset) {
    _rlBuckets.set(key, { count: 1, reset: now + LOGIN_FAIL_WINDOW_MS });
    return;
  }
  b.count += 1;
}

function resetLoginFailures(key) {
  _rlBuckets.delete(key);
}

function mapAuthError(res, e, fallback) {
  if (e && e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
  if (e && e.code === 'DUPLICATE') return res.status(409).json({ error: e.message });
  if (e && e.code === 'INVALID_EMAIL') return res.status(400).json({ error: e.message });
  if (e && e.code === 'WEAK_PASSWORD') return res.status(400).json({ error: e.message });
  if (e && e.code === 'NO_DATABASE') {
    return res.status(503).json({ error: 'Database not configured. Set DATABASE_URL on the server.' });
  }
  console.error(fallback, e);
  return res.status(500).json({ error: e && e.message ? e.message : 'Request failed' });
}

function setupAuth(app) {
  app.post('/api/auth/onboarding', async function (req, res) {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = await authStore.completeOnboarding(uid, body);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user: authStore.publicUser(user) });
    } catch (e) {
      return mapAuthError(res, e, '[auth onboarding]');
    }
  });

  app.get('/api/auth/me', async function (req, res) {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ user: null });
    try {
      const u = await authStore.findById(uid);
      if (!u) {
        clearSessionCookie(res);
        return res.status(401).json({ user: null });
      }
      return res.json({ user: authStore.publicUser(u) });
    } catch (e) {
      console.error('[auth me]', e);
      return res.status(500).json({ user: null });
    }
  });

  app.post('/api/auth/register', async function (req, res) {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = await authStore.createUser(body);
      setSessionCookie(res, user.id);
      return res.status(201).json({ user: authStore.publicUser(user) });
    } catch (e) {
      return mapAuthError(res, e, '[auth register]');
    }
  });

  app.post('/api/auth/login', async function (req, res) {
    const loginKey = 'login-fail:' + clientIp(req);
    if (loginThrottled(loginKey)) {
      return res.status(429).json({ error: 'Too many login attempts, please try again later.' });
    }
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const u = await authStore.verifyLogin(email, password);
      if (!u) {
        recordLoginFailure(loginKey);
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      resetLoginFailures(loginKey);
      setSessionCookie(res, u.id);
      return res.json({ user: authStore.publicUser(u) });
    } catch (e) {
      return mapAuthError(res, e, '[auth login]');
    }
  });

  // Request a password reset link. Always returns a generic response so the
  // endpoint can't be used to discover which emails have accounts.
  app.post('/api/auth/forgot-password', async function (req, res) {
    const generic = {
      ok: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    };
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = String(body.email || '').trim().toLowerCase();

    if (rateLimited('forgot:' + clientIp(req), 5, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    if (!EMAIL_RE.test(email)) return res.json(generic);

    try {
      const u = await authStore.findByEmail(email);
      if (u) {
        const token = createResetToken(u);
        const link = resolveBaseUrl(req) + '/reset?token=' + encodeURIComponent(token);
        await sendMail({
          to: u.email,
          subject: 'Reset your Event Explorer password',
          text:
            'We received a request to reset your Event Explorer password.\n\n' +
            'Reset it using this link (valid for 1 hour):\n' +
            link +
            '\n\nIf you did not request this, you can safely ignore this email.',
          html:
            '<p>We received a request to reset your Event Explorer password.</p>' +
            '<p><a href="' + link + '">Reset your password</a> (valid for 1 hour).</p>' +
            '<p>If you did not request this, you can safely ignore this email.</p>',
        });
      }
    } catch (e) {
      // Log server-side only; still return the generic message to the client.
      console.error('[auth forgot-password]', e && e.message ? e.message : e);
    }
    return res.json(generic);
  });

  // Complete a password reset using a token from the emailed link.
  app.post('/api/auth/reset-password', async function (req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = String(body.token || '');
    const password = String(body.password || '');

    if (rateLimited('reset:' + clientIp(req), 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const data = verifyResetToken(token);
    if (!data) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const u = await authStore.findById(data.uid);
      if (!u || passwordFingerprint(u.passwordHash) !== data.fp) {
        return res.status(400).json({ error: 'This reset link is invalid or has already been used. Request a new one.' });
      }
      await authStore.updatePassword(u.id, password);
      // Do not auto-sign-in: require an explicit login with the new password.
      return res.json({ ok: true, message: 'Your password has been updated. You can now sign in.' });
    } catch (e) {
      return mapAuthError(res, e, '[auth reset-password]');
    }
  });

  app.post('/api/auth/logout', function (req, res) {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.patch('/api/auth/profile', async function (req, res) {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = await authStore.updateProfile(uid, body);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user: authStore.publicUser(user) });
    } catch (e) {
      return mapAuthError(res, e, '[auth profile]');
    }
  });
}

module.exports = {
  setupAuth,
  getSessionUserId,
};
