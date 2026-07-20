'use strict';

const OVERLAY_BOOK_MARKER = 'overlay_book';

const FAN_DNA_GENDERS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];

const {
  FAN_DNA_CATEGORIES,
  FAN_DNA_VIBES,
  FAN_DNA_EVENT_SIZES,
  FAN_DNA_TRAVEL,
  FAN_DNA_TIMES,
  FAN_DNA_BUDGETS,
  FAN_DNA_PROFESSIONS,
  FAN_DNA_AGE_GROUPS,
} = require('./fan-dna-scoring');
const { normalizeDna } = require('./match-calculator');

function sanitizeFanDnaPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const categories = Array.isArray(b.categories)
    ? b.categories.map((x) => String(x || '').trim().toLowerCase()).filter((x) => FAN_DNA_CATEGORIES.indexOf(x) >= 0)
    : [];
  const vibes = Array.isArray(b.vibes)
    ? b.vibes.map((x) => String(x || '').trim().toLowerCase()).filter((x) => FAN_DNA_VIBES.indexOf(x) >= 0)
    : [];
  const preferred_time = Array.isArray(b.preferred_time)
    ? b.preferred_time.map((x) => String(x || '').trim().toLowerCase()).filter((x) => FAN_DNA_TIMES.indexOf(x) >= 0)
    : [];
  const event_size = FAN_DNA_EVENT_SIZES.includes(String(b.event_size || '').toLowerCase())
    ? String(b.event_size).toLowerCase()
    : null;
  const travel_distance = FAN_DNA_TRAVEL.includes(String(b.travel_distance || '').toLowerCase())
    ? String(b.travel_distance).toLowerCase()
    : null;
  const budget = FAN_DNA_BUDGETS.includes(String(b.budget || '').toLowerCase())
    ? String(b.budget).toLowerCase()
    : null;
  const home_iata = /^[A-Z]{3}$/.test(String(b.home_iata || '').trim().toUpperCase())
    ? String(b.home_iata).trim().toUpperCase()
    : null;
  let gender;
  if (Object.prototype.hasOwnProperty.call(b, 'gender')) {
    if (b.gender === null || b.gender === '') {
      gender = null;
    } else {
      const g = String(b.gender).trim();
      gender = FAN_DNA_GENDERS.includes(g) ? g : null;
    }
  }
  let profession;
  if (Object.prototype.hasOwnProperty.call(b, 'profession')) {
    const p = String(b.profession || '').trim().toLowerCase();
    profession = FAN_DNA_PROFESSIONS.indexOf(p) >= 0 ? p : null;
  }
  let age_group;
  if (Object.prototype.hasOwnProperty.call(b, 'age_group')) {
    const a = String(b.age_group || '').trim().toLowerCase();
    age_group = FAN_DNA_AGE_GROUPS.indexOf(a) >= 0 ? a : null;
  }
  const out = {
    categories: [...new Set(categories)],
    vibes: [...new Set(vibes)],
    preferred_time: [...new Set(preferred_time)],
    event_size,
    travel_distance,
    budget,
    home_iata,
  };
  if (Object.prototype.hasOwnProperty.call(b, 'gender')) {
    out.gender = gender;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'profession')) {
    out.profession = profession;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'age_group')) {
    out.age_group = age_group;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'user_dna')) {
    out.user_dna = normalizeDna(b.user_dna);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'user_dna_custom')) {
    out.user_dna_custom = Boolean(b.user_dna_custom);
  }
  return out;
}

function validateFanDnaPayload(payload) {
  if (!payload.categories.length) {
    const err = new Error('Pick at least one event category for Fan DNA');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!payload.event_size) {
    const err = new Error('Pick a preferred event size');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!payload.travel_distance) {
    const err = new Error('Pick how far you will travel');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!payload.budget) {
    const err = new Error('Pick a budget range');
    err.code = 'VALIDATION';
    throw err;
  }
}

function isMissingTableError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('user_preferences') &&
    (msg.includes('schema cache') ||
      msg.includes('does not exist') ||
      msg.includes('could not find') ||
      msg.includes('relation'))
  );
}

function isMissingClicksTableError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('event_clicks') &&
    (msg.includes('schema cache') ||
      msg.includes('does not exist') ||
      msg.includes('could not find') ||
      msg.includes('relation'))
  );
}

async function getPreferences(supabase, userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase.from('user_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function upsertPreferences(supabase, userId, payload) {
  const row = {
    user_id: userId,
    categories: payload.categories,
    vibes: payload.vibes,
    event_size: payload.event_size,
    travel_distance: payload.travel_distance,
    preferred_time: payload.preferred_time,
    budget: payload.budget,
    home_iata: payload.home_iata || null,
    updated_at: new Date().toISOString(),
  };
  if (Object.prototype.hasOwnProperty.call(payload, 'gender')) {
    row.gender = payload.gender;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'profession')) {
    row.profession = payload.profession;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'age_group')) {
    row.age_group = payload.age_group;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'user_dna')) {
    row.user_dna = payload.user_dna;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'user_dna_custom')) {
    row.user_dna_custom = Boolean(payload.user_dna_custom);
  }

  // Strip optional columns that Supabase reports as missing, then retry (up to a few times).
  const OPTIONAL_COLUMNS = ['user_dna', 'user_dna_custom', 'profession', 'age_group', 'gender', 'home_iata'];
  let attempt = 0;
  while (attempt < OPTIONAL_COLUMNS.length + 1) {
    attempt += 1;
    const { data, error } = await supabase
      .from('user_preferences')
      .upsert(row, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (!error) return data;

    const msg = String(error.message || '').toLowerCase();
    const stripped = OPTIONAL_COLUMNS.find(
      (col) => Object.prototype.hasOwnProperty.call(row, col) && msg.includes(col),
    );
    if (!stripped) throw new Error(error.message);
    console.warn(
      `[fan-dna] "${stripped}" column missing in Supabase user_preferences — run the ALTER TABLE migration. Skipping this field for now.`,
    );
    delete row[stripped];
  }
  throw new Error('Could not save preferences after stripping missing columns');
}

async function logEventClick(supabase, row) {
  const base = {
    user_id: row.user_id || null,
    event_id: row.event_id || null,
    event_name: row.event_name || null,
    clicked_at: row.clicked_at || new Date().toISOString(),
  };
  const clickSource = String(row.click_source || row.clickSource || '').trim().slice(0, 40);
  const city = String(row.city || '').trim().slice(0, 120);
  const platform = String(row.platform || row.source || '').trim().slice(0, 80);
  const payload = Object.assign({}, base, {
    city: city || null,
    platform: platform || null,
  });
  if (clickSource) payload.click_source = clickSource;

  let insertPayload = payload;
  let { error } = await supabase.from('event_clicks').insert(insertPayload);
  let safety = 0;
  while (error && safety < 6) {
    safety += 1;
    const msg = String(error.message || '').toLowerCase();
    let stripped = false;
    ['click_source', 'city', 'platform'].forEach(function (col) {
      if (stripped || insertPayload[col] == null) return;
      if (msg.includes(col)) {
        delete insertPayload[col];
        stripped = true;
        if (col === 'click_source' && clickSource === OVERLAY_BOOK_MARKER) {
          insertPayload.platform = OVERLAY_BOOK_MARKER;
        }
      }
    });
    if (!stripped) break;
    ({ error } = await supabase.from('event_clicks').insert(insertPayload));
  }
  if (error) throw new Error(error.message);
}

async function fetchAllPreferences(supabase) {
  const { data, error } = await supabase.from('user_preferences').select('*').order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchClickStats(supabase) {
  const { data, error } = await supabase
    .from('event_clicks')
    .select('user_id, event_id, event_name, clicked_at')
    .order('clicked_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  sanitizeFanDnaPayload,
  validateFanDnaPayload,
  isMissingTableError,
  isMissingClicksTableError,
  getPreferences,
  upsertPreferences,
  logEventClick,
  fetchAllPreferences,
  fetchClickStats,
};
