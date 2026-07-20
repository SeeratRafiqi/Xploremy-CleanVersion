/**
 * PostgreSQL-backed user store (public.profiles).
 * Talks to local/Alibaba Postgres via ./db (migrated off Supabase).
 * Replaces local data/users.json for Vercel and production.
 */
'use strict';

const crypto = require('crypto');

/** @type {null | (() => import('./db') | null)} */
let getDbClient = null;

function setDb(getter) {
  getDbClient = typeof getter === 'function' ? getter : null;
}

function db() {
  if (!getDbClient) {
    const err = new Error('Database not configured (set DATABASE_URL)');
    err.code = 'NO_DATABASE';
    throw err;
  }
  const client = getDbClient();
  if (!client) {
    const err = new Error('Database not configured');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return client;
}

/** Same city hints as event-hub / itinerary — used when home IATA omitted at signup. */
const CITY_HINT_TO_IATA = [
  [/kuala\s*lumpur|kl\b/i, 'KUL'],
  [/penang|george\s*town|pulau\s*pinang/i, 'PEN'],
  [/johor|jb\b|johor\s*bahru/i, 'JHB'],
  [/kota\s*kinabalu|sabah/i, 'BKI'],
  [/kuching|sarawak/i, 'KCH'],
  [/langkawi/i, 'LGK'],
  [/melaka|malacca/i, 'MKZ'],
  [/ipoh/i, 'IPH'],
  [/kota\s*bharu|kelantan/i, 'KBR'],
  [/terengganu|kuala\s*terengganu/i, 'TGG'],
  [/miri/i, 'MYY'],
  [/singapore/i, 'SIN'],
  [/bangkok/i, 'BKK'],
  [/jakarta/i, 'CGK'],
  [/bali|denpasar/i, 'DPS'],
];

const ALLOWED_GENRES = new Set([
  'music',
  'comedy',
  'sports',
  'arts',
  'family',
  'food',
  'nightlife',
  'tech',
  'wellness',
]);

const ALLOWED_INTERESTS = new Set([
  'food',
  'culture',
  'nature',
  'adventure',
  'shopping',
  'nightlife',
  'family',
  'wellness',
]);

const PROFILE_COLUMNS =
  'user_id, email, full_name, home_airport, password_hash, onboarding_complete, profile_json, last_active, created_at, updated_at';

function guessIataFromLocationText(city, country) {
  const blob = `${city || ''} ${country || ''}`;
  for (let i = 0; i < CITY_HINT_TO_IATA.length; i++) {
    if (CITY_HINT_TO_IATA[i][0].test(blob)) return CITY_HINT_TO_IATA[i][1];
  }
  return '';
}

function normalizeIata(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .slice(0, 3);
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const i = stored.indexOf(':');
  if (i < 1) return false;
  const saltHex = stored.slice(0, i);
  const hashHex = stored.slice(i + 1);
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sanitizeGenreList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach(function (x) {
    const k = String(x || '')
      .trim()
      .toLowerCase();
    if (ALLOWED_GENRES.has(k) && out.indexOf(k) === -1) out.push(k);
  });
  return out;
}

function sanitizeInterestList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach(function (x) {
    const k = String(x || '')
      .trim()
      .toLowerCase();
    if (ALLOWED_INTERESTS.has(k) && out.indexOf(k) === -1) out.push(k);
  });
  return out;
}

function parseProfileJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return Object.assign({}, raw);
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? Object.assign({}, p) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function userFromRow(row) {
  if (!row) return null;
  const profileJson = parseProfileJson(row.profile_json);
  const profile = Object.assign({}, profileJson, {
    displayName: String(profileJson.displayName || row.full_name || '').trim(),
    homeIata: normalizeIata(profileJson.homeIata || row.home_airport) || 'KUL',
    onboardingComplete: row.onboarding_complete === true,
    updatedAt: row.updated_at || profileJson.updatedAt || row.created_at,
    lastLoginAt: profileJson.lastLoginAt || row.last_active,
  });
  return {
    id: row.user_id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    last_active: row.last_active,
    profile,
  };
}

function rowFromUser(user) {
  const p = user.profile || {};
  const now = new Date().toISOString();
  const displayName = String(p.displayName || '').trim();
  const email = String(user.email || '')
    .trim()
    .toLowerCase();
  return {
    user_id: user.id,
    email: email || null,
    full_name: displayName || (email ? email.split('@')[0] : null),
    home_airport: normalizeIata(p.homeIata) || null,
    password_hash: user.passwordHash || undefined,
    onboarding_complete: Boolean(p.onboardingComplete),
    profile_json: p,
    last_active: user.last_active || p.lastLoginAt || null,
    created_at: user.createdAt || now,
    updated_at: p.updatedAt || now,
  };
}

function minimalNewProfile(body) {
  const displayName = String(body.displayName || '').trim().slice(0, 80);
  return {
    displayName,
    locationCity: '',
    locationCountry: 'Malaysia',
    homeIata: 'KUL',
    genres: [],
    activityInterests: [],
    adventureLevel: 'medium',
    pacePreference: 'balanced',
    marketingOptIn: false,
    notes: '',
    budgetLevel: 2,
    language: '',
    onboardingComplete: false,
    updatedAt: new Date().toISOString(),
  };
}

function buildProfileFromOnboardingBody(body) {
  const locationCity = String(body.locationCity || '').trim().slice(0, 120);
  const locationCountry = String(body.locationCountry || 'Malaysia').trim().slice(0, 80);
  let homeIata = normalizeIata(body.homeIata);
  if (!homeIata) homeIata = guessIataFromLocationText(locationCity, locationCountry) || 'KUL';
  const adventureLevel = ['easy', 'medium', 'hard'].includes(String(body.adventureLevel))
    ? String(body.adventureLevel)
    : 'medium';
  const pacePreference = ['slow', 'balanced', 'packed'].includes(String(body.pacePreference))
    ? String(body.pacePreference)
    : 'balanced';
  let budgetLevel = parseInt(String(body.budgetLevel), 10);
  if (!Number.isFinite(budgetLevel) || budgetLevel < 1 || budgetLevel > 4) budgetLevel = 2;
  const out = {
    locationCity,
    locationCountry,
    homeIata,
    genres: sanitizeGenreList(body.genres),
    activityInterests: sanitizeInterestList(body.activityInterests || []),
    adventureLevel,
    pacePreference,
    budgetLevel,
    marketingOptIn: Boolean(body.marketingOptIn),
    notes: String(body.notes || '')
      .trim()
      .slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  const lang = String(body.language || '')
    .trim()
    .slice(0, 40);
  if (lang) out.language = lang;
  const dn = String(body.displayName || '').trim().slice(0, 80);
  if (dn) out.displayName = dn;
  return out;
}

function validateOnboardingPayload(body) {
  const locationCity = String(body.locationCity || '').trim();
  const locationCountry = String(body.locationCountry || '').trim();
  let homeIata = normalizeIata(body.homeIata);
  if (!homeIata) homeIata = guessIataFromLocationText(locationCity, locationCountry);
  if (!homeIata) {
    const err = new Error('Choose a home airport so we can pre-fill flights');
    err.code = 'VALIDATION';
    throw err;
  }
}

async function findByEmail(email) {
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!e) return null;
  const row = await db().queryOne(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE email = $1`, [e]);
  return userFromRow(row);
}

async function findById(id) {
  const uid = String(id || '').trim();
  if (!uid) return null;
  const row = await db().queryOne(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = $1`, [uid]);
  return userFromRow(row);
}

function publicUser(u) {
  if (!u) return null;
  const prof = u.profile || {};
  return {
    id: u.id,
    email: u.email,
    displayName: prof.displayName || '',
    profile: Object.assign({}, prof),
    createdAt: u.createdAt,
  };
}

async function persistUser(user) {
  const row = rowFromUser(user);
  // Only overwrite the password when a new hash is supplied (COALESCE below
  // keeps the existing one on plain profile updates).
  const passwordHash = user.passwordHash || null;
  try {
    const saved = await db().queryOne(
      `INSERT INTO profiles
         (user_id, email, full_name, home_airport, password_hash,
          onboarding_complete, profile_json, last_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id) DO UPDATE SET
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         home_airport = EXCLUDED.home_airport,
         password_hash = COALESCE(EXCLUDED.password_hash, profiles.password_hash),
         onboarding_complete = EXCLUDED.onboarding_complete,
         profile_json = EXCLUDED.profile_json,
         last_active = EXCLUDED.last_active,
         updated_at = EXCLUDED.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [
        row.user_id,
        row.email,
        row.full_name,
        row.home_airport,
        passwordHash,
        row.onboarding_complete,
        JSON.stringify(row.profile_json || {}),
        row.last_active,
        row.created_at,
        row.updated_at,
      ]
    );
    return userFromRow(saved);
  } catch (error) {
    if (error && (error.code === '23505' || String(error.message || '').toLowerCase().includes('duplicate'))) {
      const dup = new Error('An account with this email already exists');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    throw error;
  }
}

async function createUser(payload) {
  const email = String(payload.email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Invalid email');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  const password = String(payload.password || '');
  if (password.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  if (await findByEmail(email)) {
    const err = new Error('An account with this email already exists');
    err.code = 'DUPLICATE';
    throw err;
  }
  const profile = minimalNewProfile(payload);
  const now = new Date().toISOString();
  profile.lastLoginAt = now;
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    createdAt: now,
    last_active: now,
    profile,
  };
  return persistUser(user);
}

async function recordLogin(userId) {
  const u = await findById(userId);
  if (!u) return;
  const now = new Date().toISOString();
  u.last_active = now;
  u.profile.lastLoginAt = now;
  u.profile.updatedAt = now;
  await persistUser(u);
}

async function verifyLogin(email, password) {
  const u = await findByEmail(email);
  if (!u) return null;
  if (!verifyPassword(password, u.passwordHash)) return null;
  const now = new Date().toISOString();
  u.last_active = now;
  u.profile.lastLoginAt = now;
  u.profile.updatedAt = now;
  await persistUser(u);
  return findById(u.id);
}

async function updatePassword(userId, newPassword) {
  const password = String(newPassword || '');
  if (password.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const u = await findById(userId);
  if (!u) return null;
  const now = new Date().toISOString();
  u.passwordHash = hashPassword(password);
  u.last_active = u.last_active || now;
  u.profile = Object.assign({}, u.profile || {}, { updatedAt: now });
  await persistUser(u);
  return findById(u.id);
}

async function completeOnboarding(userId, body) {
  validateOnboardingPayload(body);
  const u = await findById(userId);
  if (!u) return null;
  const built = buildProfileFromOnboardingBody(body);
  u.profile = Object.assign({}, u.profile || {}, built, {
    onboardingComplete: true,
    updatedAt: new Date().toISOString(),
  });
  return persistUser(u);
}

async function updateProfile(userId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const u = await findById(userId);
  if (!u) return null;
  const cur = Object.assign({}, u.profile || {});

  if (Object.prototype.hasOwnProperty.call(b, 'displayName')) {
    cur.displayName = String(b.displayName || '').trim().slice(0, 80);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'locationCity')) {
    cur.locationCity = String(b.locationCity || '').trim().slice(0, 120);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'locationCountry')) {
    cur.locationCountry = String(b.locationCountry || 'Malaysia').trim().slice(0, 80);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'homeIata')) {
    const hi = normalizeIata(b.homeIata);
    if (hi) cur.homeIata = hi;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'genres')) {
    cur.genres = sanitizeGenreList(b.genres);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'activityInterests')) {
    cur.activityInterests = sanitizeInterestList(b.activityInterests);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'adventureLevel')) {
    cur.adventureLevel = ['easy', 'medium', 'hard'].includes(String(b.adventureLevel))
      ? String(b.adventureLevel)
      : cur.adventureLevel || 'medium';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'pacePreference')) {
    cur.pacePreference = ['slow', 'balanced', 'packed'].includes(String(b.pacePreference))
      ? String(b.pacePreference)
      : cur.pacePreference || 'balanced';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'budgetLevel')) {
    let bl = parseInt(String(b.budgetLevel), 10);
    if (!Number.isFinite(bl) || bl < 1 || bl > 4) bl = Number(cur.budgetLevel) || 2;
    cur.budgetLevel = Math.min(4, Math.max(1, bl));
  }
  if (Object.prototype.hasOwnProperty.call(b, 'marketingOptIn')) {
    cur.marketingOptIn = Boolean(b.marketingOptIn);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'notes')) {
    cur.notes = String(b.notes || '')
      .trim()
      .slice(0, 500);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'language')) {
    const lang = String(b.language || '').trim().slice(0, 40);
    if (lang) cur.language = lang;
    else delete cur.language;
  }

  let homeIata = normalizeIata(cur.homeIata);
  if (!homeIata) homeIata = guessIataFromLocationText(cur.locationCity, cur.locationCountry);
  if (!homeIata) {
    const err = new Error('Choose a home airport so we can pre-fill flights');
    err.code = 'VALIDATION';
    throw err;
  }
  cur.homeIata = homeIata;

  if (!Array.isArray(cur.genres) || !cur.genres.length) {
    const err = new Error('Pick at least one event type you like');
    err.code = 'VALIDATION';
    throw err;
  }

  cur.updatedAt = new Date().toISOString();
  u.profile = cur;
  return persistUser(u);
}

async function listAllUsers() {
  const rows = await db().queryAll(`SELECT ${PROFILE_COLUMNS} FROM profiles ORDER BY created_at DESC`);
  return (rows || []).map(userFromRow).filter(Boolean);
}

async function getFanDnaFromProfile(userId) {
  const u = await findById(userId);
  const fd = u && u.profile && u.profile.fanDna;
  if (!fd || typeof fd !== 'object') return null;
  const homeFromProfile =
    u && u.profile && typeof u.profile.homeIata === 'string' ? normalizeIata(u.profile.homeIata) : null;
  return {
    user_id: userId,
    categories: Array.isArray(fd.categories) ? fd.categories : [],
    vibes: Array.isArray(fd.vibes) ? fd.vibes : [],
    event_size: fd.event_size || null,
    travel_distance: fd.travel_distance || null,
    preferred_time: Array.isArray(fd.preferred_time) ? fd.preferred_time : [],
    budget: fd.budget || null,
    home_iata: homeFromProfile,
    gender: fd.gender || null,
    profession: fd.profession || null,
    age_group: fd.age_group || null,
    user_dna: fd.user_dna && typeof fd.user_dna === 'object' ? fd.user_dna : null,
    user_dna_custom: fd.user_dna_custom === true,
    updated_at: fd.updated_at || null,
    _source: 'profile',
  };
}

async function saveFanDnaToProfile(userId, payload) {
  const u = await findById(userId);
  if (!u) return null;
  const cur = Object.assign({}, u.profile || {});
  const prevFanDna = cur.fanDna && typeof cur.fanDna === 'object' ? cur.fanDna : {};
  cur.fanDna = {
    categories: payload.categories,
    vibes: payload.vibes,
    event_size: payload.event_size,
    travel_distance: payload.travel_distance,
    preferred_time: payload.preferred_time,
    budget: payload.budget,
    user_dna: payload.user_dna && typeof payload.user_dna === 'object' ? payload.user_dna : null,
    user_dna_custom: Boolean(payload.user_dna_custom),
    updated_at: new Date().toISOString(),
  };
  cur.fanDna.gender = Object.prototype.hasOwnProperty.call(payload, 'gender')
    ? payload.gender
    : prevFanDna.gender || null;
  cur.fanDna.profession = Object.prototype.hasOwnProperty.call(payload, 'profession')
    ? payload.profession
    : prevFanDna.profession || null;
  cur.fanDna.age_group = Object.prototype.hasOwnProperty.call(payload, 'age_group')
    ? payload.age_group
    : prevFanDna.age_group || null;
  if (payload.home_iata) {
    const hi = normalizeIata(payload.home_iata);
    if (hi) cur.homeIata = hi;
  }
  cur.updatedAt = new Date().toISOString();
  u.profile = cur;
  await persistUser(u);
  return getFanDnaFromProfile(userId);
}

function countUsersLoggedInWithinDays(users, days) {
  const windowMs = Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  let n = 0;
  (users || []).forEach(function (u) {
    const at = (u && u.last_active) || (u && u.profile && u.profile.lastLoginAt);
    if (!at) return;
    const t = new Date(at).getTime();
    if (Number.isFinite(t) && t >= cutoff) n += 1;
  });
  return n;
}

module.exports = {
  setDb,
  createUser,
  completeOnboarding,
  updateProfile,
  updatePassword,
  findByEmail,
  findById,
  publicUser,
  verifyLogin,
  recordLogin,
  countUsersLoggedInWithinDays,
  listAllUsers,
  getFanDnaFromProfile,
  saveFanDnaToProfile,
  guessIataFromLocationText,
  normalizeIata,
  ALLOWED_GENRES,
  ALLOWED_INTERESTS,
  userFromRow,
  rowFromUser,
};
