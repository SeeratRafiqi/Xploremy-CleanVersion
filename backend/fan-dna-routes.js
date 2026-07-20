'use strict';

const db = require('./db');
const authStore = require('./auth-store');
const fanDnaStore = require('./fan-dna-store');
const selectionStore = require('./selection-store');
const {
  getOrComputeDashboardCache,
  writeDashboardCache,
  createSupabaseForCache,
} = require('./admin-dashboard-cache');
const { buildApiUsagePayload } = require('./admin-api-usage');
const {
  calculateFanDNAScore,
  fanDnaProfileComplete,
  FAN_DNA_CATEGORIES,
  inferEventCategories,
} = require('./fan-dna-scoring');
const { calculateDnaMatch, normalizeDna } = require('./match-calculator');
const { convertPreferencesToDNA } = require('./user-dna-converter');
const { logApiUsage } = require('./api-usage-logger');

const FAN_DNA_BUDGET_MYR = {
  free: 0,
  under_rm50: 25,
  rm50_150: 100,
  rm150_plus: 200,
  under_50: 25,
  '50_150': 100,
  '150_plus': 200,
};

const FAN_DNA_TRAVEL_KM = {
  '5km': 5,
  '10km': 10,
  '25km': 25,
  '50km': 50,
  any: 75,
};

function normalizeCity(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\s+/g, ' ').slice(0, 120);
}

function averageFanDnaBudget(prefsRows) {
  let sum = 0;
  let n = 0;
  (prefsRows || []).forEach(function (p) {
    const key = String((p && p.budget) || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FAN_DNA_BUDGET_MYR, key)) return;
    sum += FAN_DNA_BUDGET_MYR[key];
    n += 1;
  });
  if (!n) return { avgMyr: null, sampleSize: 0 };
  return { avgMyr: Math.round(sum / n), sampleSize: n };
}

function averageFanDnaTravelKm(prefsRows) {
  let sum = 0;
  let n = 0;
  (prefsRows || []).forEach(function (p) {
    const key = String((p && p.travel_distance) || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FAN_DNA_TRAVEL_KM, key)) return;
    sum += FAN_DNA_TRAVEL_KM[key];
    n += 1;
  });
  if (!n) return { avgKm: null, sampleSize: 0 };
  return { avgKm: Math.round((sum / n) * 10) / 10, sampleSize: n };
}

const MALAYSIA_EVENT_CITY_RULES = [
  { label: 'Kuala Lumpur', re: /\bkuala\s*lumpur\b|\bkl\b/i },
  { label: 'Penang', re: /\bpenang\b|\bgeorge\s*town\b|\bpulau\s*pinang\b/i },
  { label: 'Johor Bahru', re: /\bjohor\s*bahru\b|\bjb\b/i },
  { label: 'Petaling Jaya', re: /\bpetaling\s*jaya\b|\bpj\b/i },
  { label: 'Shah Alam', re: /\bshah\s*alam\b/i },
  { label: 'Subang', re: /\bsubang\b/i },
  { label: 'Selangor', re: /\bselangor\b/i },
];

function cityFromLocationText(raw) {
  const s = normalizeCity(raw);
  if (!s) return '';
  for (let i = 0; i < MALAYSIA_EVENT_CITY_RULES.length; i++) {
    if (MALAYSIA_EVENT_CITY_RULES[i].re.test(s)) return MALAYSIA_EVENT_CITY_RULES[i].label;
  }
  return '';
}

function cityFromEventRow(row) {
  if (!row || typeof row !== 'object') return '';
  const parts = [row.city, row.venue, row.title, row.description].filter(Boolean);
  const blob = parts.join(' ');
  return cityFromLocationText(blob);
}

async function fetchAllEventsForCityTally(sb) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await sb
      .from('events_chatbot')
      .select('city, venue, title, description')
      .range(offset, offset + pageSize - 1);
    if (error) return { rows: null, error: error.message };
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return { rows, error: null };
}

/** Most common Malaysian city where events take place (from city + venue + title text). */
async function topCityFromEventLocations(sb) {
  const fetched = await fetchAllEventsForCityTally(sb);
  if (fetched.error || !fetched.rows || !fetched.rows.length) {
    return { city: null, count: 0, error: fetched.error || null, eventsScanned: 0, eventsMatched: 0 };
  }
  const tally = {};
  let matched = 0;
  fetched.rows.forEach(function (row) {
    const city = cityFromEventRow(row);
    if (!city) return;
    matched += 1;
    const key = city.toLowerCase();
    if (!tally[key]) tally[key] = { city: city, count: 0 };
    tally[key].count += 1;
  });
  let best = null;
  let bestN = 0;
  Object.keys(tally).forEach(function (k) {
    if (tally[k].count > bestN) {
      bestN = tally[k].count;
      best = tally[k].city;
    }
  });
  return {
    city: best,
    count: bestN,
    error: null,
    eventsScanned: fetched.rows.length,
    eventsMatched: matched,
  };
}

async function countActiveSupabaseUsersLast7Days(sb) {
  if (!sb || !sb.auth || !sb.auth.admin || typeof sb.auth.admin.listUsers !== 'function') return null;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - weekMs;
  let page = 1;
  const perPage = 1000;
  let total = 0;
  // Fetch paginated Supabase auth users, then count by last_sign_in_at.
  while (true) {
    const res = await sb.auth.admin.listUsers({ page, perPage });
    const users = (res && res.data && Array.isArray(res.data.users)) ? res.data.users : [];
    if (!users.length) break;
    users.forEach(function (u) {
      const t = new Date(u.last_sign_in_at || '').getTime();
      if (Number.isFinite(t) && t >= cutoff) total += 1;
    });
    if (users.length < perPage) break;
    page += 1;
    if (page > 50) break;
  }
  return total;
}

async function debugActiveUsersLast7Days(sb) {
  const isoCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const probe = await sb.from('auth.users').select('id', { count: 'exact', head: true }).gt('last_sign_in_at', isoCutoff);
    console.log('[admin overview] active users SQL probe (auth.users):', {
      count: probe && probe.count,
      error: probe && probe.error ? probe.error.message : null,
      cutoff: isoCutoff,
    });
  } catch (e) {
    console.log('[admin overview] active users SQL probe failed:', e.message || String(e));
  }
  try {
    const list = await sb.auth.admin.listUsers({ page: 1, perPage: 5 });
    const rows = ((list && list.data && list.data.users) || []).map((u) => ({
      id: u.id,
      email: u.email,
      last_sign_in_at: u.last_sign_in_at,
    }));
    console.log('[admin overview] auth admin sample users:', rows);
  } catch (e) {
    console.log('[admin overview] auth admin sample users failed:', e.message || String(e));
  }
}

function debugPreferenceSamples(prefsRows) {
  const budgetRaw = (prefsRows || []).map((p) => p && p.budget).filter((v) => v != null);
  const travelRaw = (prefsRows || []).map((p) => p && p.travel_distance).filter((v) => v != null);
  console.log('[admin overview] user_preferences raw budget values:', budgetRaw.slice(0, 200));
  console.log('[admin overview] user_preferences raw travel_distance values:', travelRaw.slice(0, 200));
}

async function fetchProfilesRows(sb) {
  if (!sb) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await sb
    .from('profiles')
    .select('user_id, email, full_name, home_airport, last_active, created_at')
    .order('created_at', { ascending: false });
  if (error) return { rows: [], error: error.message || 'Could not load profiles' };
  return { rows: data || [], error: null };
}

function countActiveProfilesWithinDays(rows, days) {
  const windowMs = Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  let n = 0;
  (rows || []).forEach((r) => {
    const t = new Date((r && r.last_active) || '').getTime();
    if (Number.isFinite(t) && t >= cutoff) n += 1;
  });
  return n;
}

function parseAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function isAdminUser(userId) {
  const admins = parseAdminEmails();
  if (!admins.length || !userId) return false;
  const u = await authStore.findById(userId);
  if (!u || !u.email) return false;
  return admins.indexOf(String(u.email).trim().toLowerCase()) >= 0;
}

const GOLIVE_ADMIN_EMAIL = 'admin@golive.com';
const GOLIVE_CONSOLE_PAGE_SIZE = 20;

async function isGoLiveAdminUser(userId) {
  if (!userId) return false;
  const u = await authStore.findById(userId);
  return Boolean(u && String(u.email || '').trim().toLowerCase() === GOLIVE_ADMIN_EMAIL);
}

function formatPlatformLabel(raw) {
  const s = String(raw || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return '—';
  if (s.includes('ticket2u')) return 'Ticket2U';
  if (s.includes('eventbrite')) return 'Eventbrite';
  if (s.includes('goliveasia') || s === 'golive') return 'GoLive Asia';
  if (s.includes('ticketmelon')) return 'Ticketmelon';
  return String(raw).trim() || '—';
}

function inferPlatformFromClick(eventId, eventName) {
  return formatPlatformLabel(`${eventId || ''} ${eventName || ''}`);
}

async function topEventCategoryFromDb(sb) {
  const { data, error } = await sb.from('events_chatbot').select('category').limit(25000);
  if (error || !data || !data.length) {
    return { category: null, count: 0, error: error ? error.message : null };
  }
  const tally = {};
  data.forEach((row) => {
    const k = (row.category && String(row.category).trim()) ? String(row.category).trim() : 'Uncategorized';
    tally[k] = (tally[k] || 0) + 1;
  });
  let best = null;
  let n = 0;
  Object.keys(tally).forEach((k) => {
    if (tally[k] > n) {
      n = tally[k];
      best = k;
    }
  });
  return { category: best, count: n, error: null };
}

/** Core Malaysian airports — always domestic for map split + heatmap. */
const MY_DOMESTIC_IATA = new Set([
  'KUL', 'PEN', 'JHB', 'BKI', 'KCH', 'IPH', 'KBR', 'KUA', 'MKZ',
]);

const MY_IATA_TO_STATE = {
  KUL: 'Kuala Lumpur',
  PEN: 'Pulau Pinang',
  JHB: 'Johor',
  BKI: 'Sabah',
  KCH: 'Sarawak',
  IPH: 'Perak',
  KBR: 'Kelantan',
  KUA: 'Pahang',
  MKZ: 'Melaka',
};

const MY_HOME_IATA = new Set([
  ...MY_DOMESTIC_IATA,
  'LGK', 'TGG', 'MYY', 'SZB', 'AOR', 'BTU', 'SBW', 'LDU', 'TOD', 'LBU', 'TWU', 'SDK', 'LBH',
]);
const SG_HOME_IATA = new Set(['SIN', 'XSP']);
const ID_HOME_IATA = new Set(['CGK', 'DPS', 'SUB', 'SOC', 'UPG', 'KNO', 'PLM', 'BDO', 'LOP', 'YIA', 'JKT']);
const OTHER_ASIA_HOME_IATA = new Set([
  'BKK', 'DMK', 'HKT', 'CNX', 'SGN', 'HAN', 'DAD', 'MNL', 'CEB', 'TPE', 'KHH', 'HKG', 'ICN', 'GMP',
  'NRT', 'HND', 'KIX', 'TYO', 'PEK', 'PKX', 'PVG', 'CAN', 'SZX', 'DEL', 'BOM', 'IND', 'SXR', 'CMB',
  'RGN', 'PNH', 'REP', 'VTE', 'DAC', 'KTM', 'NPL', 'MLE', 'DXB', 'DOH',
]);

function homeAirportToOriginRegion(iata) {
  const code = String(iata || '')
    .trim()
    .toUpperCase()
    .slice(0, 3);
  if (!code) return 'International';
  if (MY_HOME_IATA.has(code)) return 'Malaysia';
  if (SG_HOME_IATA.has(code)) return 'Singapore';
  if (ID_HOME_IATA.has(code)) return 'Indonesia';
  if (OTHER_ASIA_HOME_IATA.has(code)) return 'Other Asia';
  return 'International';
}

function buildTouristOriginsChart(profileRows, prefsByUser) {
  const regions = ['Malaysia', 'Singapore', 'Indonesia', 'Other Asia', 'International'];
  const counts = {};
  regions.forEach((r) => {
    counts[r] = 0;
  });
  (profileRows || []).forEach((row) => {
    const region = countryToTouristOriginRegion(resolveUserCountry(row, prefsByUser || {}));
    counts[region] = (counts[region] || 0) + 1;
  });
  return {
    labels: regions,
    values: regions.map((r) => counts[r] || 0),
  };
}

const IATA_TO_CITY_LABEL = {
  KUL: 'Kuala Lumpur',
  PEN: 'Penang',
  JHB: 'Johor Bahru',
  BKI: 'Kota Kinabalu',
  KCH: 'Kuching',
  LGK: 'Langkawi',
  MKZ: 'Melaka',
  IPH: 'Ipoh',
  KBR: 'Kota Bharu',
  TGG: 'Kuala Terengganu',
  MYY: 'Miri',
  AOR: 'Alor Setar',
  SIN: 'Singapore',
  CGK: 'Jakarta',
  DPS: 'Bali',
  BKK: 'Bangkok',
  HKG: 'Hong Kong',
  TPE: 'Taipei',
  MNL: 'Manila',
  SZB: 'Subang',
  KUA: 'Kuantan',
  JKT: 'Jakarta',
  SXR: 'Srinagar',
  IND: 'India',
  NPL: 'Nepal',
  TYO: 'Tokyo',
  DEL: 'Delhi',
  BOM: 'Mumbai',
  SYD: 'Sydney',
  LHR: 'London',
  ICN: 'Seoul',
  HAN: 'Hanoi',
  DXB: 'Dubai',
};

const MY_STATE_TILES = [
  { id: 'johor', label: 'Johor', short: 'JHR' },
  { id: 'kedah', label: 'Kedah', short: 'KDH' },
  { id: 'kelantan', label: 'Kelantan', short: 'KTN' },
  { id: 'melaka', label: 'Melaka', short: 'MLK' },
  { id: 'negeri-sembilan', label: 'Negeri Sembilan', short: 'NSN' },
  { id: 'pahang', label: 'Pahang', short: 'PHG' },
  { id: 'perak', label: 'Perak', short: 'PRK' },
  { id: 'perlis', label: 'Perlis', short: 'PLS' },
  { id: 'pulau-pinang', label: 'Pulau Pinang', short: 'PNG' },
  { id: 'sabah', label: 'Sabah', short: 'SBH' },
  { id: 'sarawak', label: 'Sarawak', short: 'SWK' },
  { id: 'selangor', label: 'Selangor', short: 'SGR' },
  { id: 'terengganu', label: 'Terengganu', short: 'TRG' },
  { id: 'kuala-lumpur', label: 'Kuala Lumpur', short: 'KL' },
  { id: 'labuan', label: 'Labuan', short: 'LBN' },
  { id: 'international', label: 'International', short: 'INT' },
];

const STATE_INFER_RULES = [
  { re: /\bkuala lumpur\b|\bkl\b|\bputrajaya\b/i, state: 'Kuala Lumpur' },
  { re: /\bselangor\b|\bpetaling\b|\bshah alam\b|\bsubang\b|\bklang\b|\bpuchong\b|\bsepang\b/i, state: 'Selangor' },
  { re: /\bpenang\b|\bgeorge town\b|\bpulau pinang\b|\bbutterworth\b/i, state: 'Pulau Pinang' },
  { re: /\bjohor\b|\bjohor bahru\b|\bjb\b/i, state: 'Johor' },
  { re: /\bsabah\b|\bkota kinabalu\b|\bkk\b/i, state: 'Sabah' },
  { re: /\bsarawak\b|\bkuching\b|\bmiri\b|\bsibu\b/i, state: 'Sarawak' },
  { re: /\bperak\b|\bipoh\b/i, state: 'Perak' },
  { re: /\bmelaka\b|\bmalacca\b/i, state: 'Melaka' },
  { re: /\bnegeri sembilan\b|\bseremban\b/i, state: 'Negeri Sembilan' },
  { re: /\bpahang\b|\bkuantan\b/i, state: 'Pahang' },
  { re: /\bkelantan\b|\bkota bharu\b/i, state: 'Kelantan' },
  { re: /\bterengganu\b|\bkuala terengganu\b/i, state: 'Terengganu' },
  { re: /\bkedah\b|\balor setar\b|\blangkawi\b/i, state: 'Kedah' },
  { re: /\bperlis\b|\bkangar\b/i, state: 'Perlis' },
  { re: /\blabuan\b/i, state: 'Labuan' },
];

function normalizeIataCode(v) {
  const s = String(v || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

function resolveProfileIata(row, prefsByUser) {
  const pj = parseProfileJsonGeo(row && row.profile_json);
  const uid = row && row.user_id;
  const pref = uid && prefsByUser ? prefsByUser[uid] : null;
  return normalizeIataCode(
    (row && row.home_airport) || pj.homeIata || (pref && pref.home_iata) || '',
  );
}

function isMalaysianDomesticIata(iata) {
  const code = normalizeIataCode(iata);
  return Boolean(code && MY_DOMESTIC_IATA.has(code));
}

function stateFromMalaysianIata(iata) {
  const code = normalizeIataCode(iata);
  return (code && MY_IATA_TO_STATE[code]) || null;
}

function parseProfileJsonGeo(raw) {
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

function iataToCityLabel(iata) {
  const code = normalizeIataCode(iata);
  return (code && IATA_TO_CITY_LABEL[code]) || (code ? code : '');
}

function inferMalaysianState(text, country) {
  const c = String(country || '').trim().toLowerCase();
  if (c && c !== 'malaysia' && c !== 'my' && !c.includes('malaysia')) {
    return 'International';
  }
  const blob = String(text || '');
  if (!blob.trim()) return 'International';
  for (let i = 0; i < STATE_INFER_RULES.length; i++) {
    if (STATE_INFER_RULES[i].re.test(blob)) return STATE_INFER_RULES[i].state;
  }
  if (/\bmalaysia\b/i.test(blob)) return 'Selangor';
  return 'International';
}

const COUNTRY_NAME_ALIASES = {
  my: 'Malaysia',
  malaysia: 'Malaysia',
  sg: 'Singapore',
  singapore: 'Singapore',
  id: 'Indonesia',
  indonesia: 'Indonesia',
  jp: 'Japan',
  japan: 'Japan',
  uk: 'United Kingdom',
  'united kingdom': 'United Kingdom',
  'great britain': 'United Kingdom',
  england: 'United Kingdom',
  us: 'United States',
  usa: 'United States',
  'united states': 'United States',
  'united states of america': 'United States',
  au: 'Australia',
  australia: 'Australia',
  cn: 'China',
  china: 'China',
  kr: 'South Korea',
  'south korea': 'South Korea',
  korea: 'South Korea',
  th: 'Thailand',
  thailand: 'Thailand',
  ph: 'Philippines',
  philippines: 'Philippines',
  vn: 'Vietnam',
  vietnam: 'Vietnam',
  in: 'India',
  india: 'India',
  ae: 'United Arab Emirates',
  uae: 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  hk: 'Hong Kong',
  'hong kong': 'Hong Kong',
  tw: 'Taiwan',
  taiwan: 'Taiwan',
  bn: 'Brunei',
  brunei: 'Brunei',
};

/** ISO 3166-1 alpha-2 + numeric (world-atlas / GeoJSON) for traveler country maps. */
const COUNTRY_ISO = {
  Malaysia: { iso2: 'MY', numeric: '458' },
  Singapore: { iso2: 'SG', numeric: '702' },
  Indonesia: { iso2: 'ID', numeric: '360' },
  Thailand: { iso2: 'TH', numeric: '764' },
  China: { iso2: 'CN', numeric: '156' },
  'United Kingdom': { iso2: 'GB', numeric: '826' },
  'United States': { iso2: 'US', numeric: '840' },
  Australia: { iso2: 'AU', numeric: '036' },
  Japan: { iso2: 'JP', numeric: '392' },
  'South Korea': { iso2: 'KR', numeric: '410' },
  India: { iso2: 'IN', numeric: '356' },
  Philippines: { iso2: 'PH', numeric: '608' },
  Vietnam: { iso2: 'VN', numeric: '704' },
  'Hong Kong': { iso2: 'HK', numeric: '344' },
  Taiwan: { iso2: 'TW', numeric: '158' },
  'United Arab Emirates': { iso2: 'AE', numeric: '784' },
  Qatar: { iso2: 'QA', numeric: '634' },
  Brunei: { iso2: 'BN', numeric: '096' },
  Germany: { iso2: 'DE', numeric: '276' },
  France: { iso2: 'FR', numeric: '250' },
  Canada: { iso2: 'CA', numeric: '124' },
  Netherlands: { iso2: 'NL', numeric: '528' },
  'Saudi Arabia': { iso2: 'SA', numeric: '682' },
  Bangladesh: { iso2: 'BD', numeric: '050' },
  Pakistan: { iso2: 'PK', numeric: '586' },
  'New Zealand': { iso2: 'NZ', numeric: '554' },
  Russia: { iso2: 'RU', numeric: '643' },
  Italy: { iso2: 'IT', numeric: '380' },
  Spain: { iso2: 'ES', numeric: '724' },
  Switzerland: { iso2: 'CH', numeric: '756' },
  Sweden: { iso2: 'SE', numeric: '752' },
  Norway: { iso2: 'NO', numeric: '578' },
  Denmark: { iso2: 'DK', numeric: '208' },
  Belgium: { iso2: 'BE', numeric: '056' },
  Austria: { iso2: 'AT', numeric: '040' },
  Poland: { iso2: 'PL', numeric: '616' },
  Turkey: { iso2: 'TR', numeric: '792' },
  Egypt: { iso2: 'EG', numeric: '818' },
  'South Africa': { iso2: 'ZA', numeric: '710' },
  Nigeria: { iso2: 'NG', numeric: '566' },
  Brazil: { iso2: 'BR', numeric: '076' },
  Mexico: { iso2: 'MX', numeric: '484' },
  Cambodia: { iso2: 'KH', numeric: '116' },
  Myanmar: { iso2: 'MM', numeric: '104' },
  Laos: { iso2: 'LA', numeric: '418' },
  Nepal: { iso2: 'NP', numeric: '524' },
  'Sri Lanka': { iso2: 'LK', numeric: '144' },
  Oman: { iso2: 'OM', numeric: '512' },
  Kuwait: { iso2: 'KW', numeric: '414' },
  Bahrain: { iso2: 'BH', numeric: '048' },
  Ireland: { iso2: 'IE', numeric: '372' },
  Portugal: { iso2: 'PT', numeric: '620' },
  Greece: { iso2: 'GR', numeric: '300' },
  Finland: { iso2: 'FI', numeric: '246' },
  Chile: { iso2: 'CL', numeric: '152' },
  Argentina: { iso2: 'AR', numeric: '032' },
  Colombia: { iso2: 'CO', numeric: '170' },
  Morocco: { iso2: 'MA', numeric: '504' },
  Israel: { iso2: 'IL', numeric: '376' },
  Iran: { iso2: 'IR', numeric: '364' },
  Iraq: { iso2: 'IQ', numeric: '368' },
};

function resolveCountryIso(label) {
  const n = normalizeCountryName(label);
  return COUNTRY_ISO[n] || null;
}

const IATA_TO_COUNTRY = {
  KUL: 'Malaysia',
  PEN: 'Malaysia',
  JHB: 'Malaysia',
  BKI: 'Malaysia',
  KCH: 'Malaysia',
  LGK: 'Malaysia',
  MKZ: 'Malaysia',
  IPH: 'Malaysia',
  KBR: 'Malaysia',
  TGG: 'Malaysia',
  MYY: 'Malaysia',
  AOR: 'Malaysia',
  SZB: 'Malaysia',
  SIN: 'Singapore',
  XSP: 'Singapore',
  CGK: 'Indonesia',
  DPS: 'Indonesia',
  SUB: 'Indonesia',
  BKK: 'Thailand',
  DMK: 'Thailand',
  HKT: 'Thailand',
  NRT: 'Japan',
  HND: 'Japan',
  KIX: 'Japan',
  LHR: 'United Kingdom',
  LGW: 'United Kingdom',
  MAN: 'United Kingdom',
  SYD: 'Australia',
  MEL: 'Australia',
  PEK: 'China',
  PVG: 'China',
  HKG: 'Hong Kong',
  TPE: 'Taiwan',
  MNL: 'Philippines',
  CEB: 'Philippines',
  SGN: 'Vietnam',
  HAN: 'Vietnam',
  DEL: 'India',
  BOM: 'India',
  DXB: 'United Arab Emirates',
  DOH: 'Qatar',
  ICN: 'South Korea',
  GMP: 'South Korea',
  JFK: 'United States',
  LAX: 'United States',
  // Profile / onboarding custom codes (not always official IATA)
  KUA: 'Malaysia',
  JKT: 'Indonesia',
  SXR: 'India',
  IND: 'India', // users often type IND for India; official IND is Indianapolis (US)
  NPL: 'Nepal', // users sometimes type NPL for Nepal; official Kathmandu code is KTM
  TYO: 'Japan', // metro alias; official Tokyo airports are NRT / HND
};

const OTHER_ASIA_COUNTRIES = new Set(
  [...OTHER_ASIA_HOME_IATA]
    .map(function (code) {
      return IATA_TO_COUNTRY[code];
    })
    .filter(Boolean),
);

function normalizeCountryName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const key = s.toLowerCase().replace(/\s+/g, ' ');
  if (COUNTRY_NAME_ALIASES[key]) return COUNTRY_NAME_ALIASES[key];
  return s
    .split(/\s+/)
    .map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function countryFromIata(iata) {
  const code = normalizeIataCode(iata);
  return (code && IATA_TO_COUNTRY[code]) || '';
}

function resolveUserCountry(row, prefsByUser) {
  const pj = parseProfileJsonGeo(row && row.profile_json);
  const iata = resolveProfileIata(row, prefsByUser);

  // Airport code always takes priority over profile_json.locationCountry
  if (isMalaysianDomesticIata(iata)) return 'Malaysia';
  const fromIata = countryFromIata(iata);
  if (fromIata) return fromIata;
  if (iata && homeAirportToOriginRegion(iata) === 'Malaysia') return 'Malaysia';
  if (iata && homeAirportToOriginRegion(iata) === 'Singapore') return 'Singapore';
  if (iata && homeAirportToOriginRegion(iata) === 'Indonesia') return 'Indonesia';

  const fromProfile = normalizeCountryName(pj.locationCountry);
  if (fromProfile && !/^other$/i.test(fromProfile) && !/^custom$/i.test(fromProfile)) {
    return fromProfile;
  }
  return 'Malaysia';
}

function isDomesticCountry(country) {
  return /^malaysia$/i.test(String(country || '').trim());
}

function countryToTouristOriginRegion(country) {
  const c = normalizeCountryName(country);
  if (isDomesticCountry(c)) return 'Malaysia';
  if (/^singapore$/i.test(c)) return 'Singapore';
  if (/^indonesia$/i.test(c)) return 'Indonesia';
  if (OTHER_ASIA_COUNTRIES.has(c)) return 'Other Asia';
  return 'International';
}

function buildTravelerCountriesChart(countryTally) {
  const sorted = topTallyEntries(countryTally, 12);
  const top = sorted.slice(0, 8);
  const otherSum = sorted.slice(8).reduce(function (s, x) {
    return s + x.count;
  }, 0);
  const labels = top.map(function (x) {
    return x.label;
  });
  const values = top.map(function (x) {
    return x.count;
  });
  if (otherSum > 0) {
    labels.push('Other');
    values.push(otherSum);
  }
  let domestic = 0;
  let international = 0;
  Object.keys(countryTally || {}).forEach(function (k) {
    const n = countryTally[k] || 0;
    if (isDomesticCountry(k)) domestic += n;
    else international += n;
  });
  const total = domestic + international;
  const mapEntries = Object.keys(countryTally || {})
    .map(function (k) {
      const iso = resolveCountryIso(k);
      return {
        label: k,
        count: countryTally[k] || 0,
        iso2: iso ? iso.iso2 : null,
        isoNumeric: iso ? iso.numeric : null,
      };
    })
    .filter(function (e) {
      return e.count > 0;
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });
  const mapMax = mapEntries.reduce(function (m, e) {
    return Math.max(m, e.count);
  }, 0);
  return {
    labels,
    values,
    mapEntries,
    mapMax,
    domesticSplit: {
      domestic,
      international,
      domesticPercent: total ? Math.round((domestic / total) * 100) : 0,
      internationalPercent: total ? Math.round((international / total) * 100) : 0,
    },
  };
}

function resolveUserOriginLabel(row, prefsByUser) {
  const pj = parseProfileJsonGeo(row && row.profile_json);
  const city = String(pj.locationCity || '').trim();
  const country = String(pj.locationCountry || 'Malaysia').trim();
  const uid = row && row.user_id;
  const pref = uid && prefsByUser ? prefsByUser[uid] : null;
  const iata = normalizeIataCode(
    (row && row.home_airport) || pj.homeIata || (pref && pref.home_iata) || '',
  );
  if (city) {
    if (country && !/malaysia/i.test(country)) return city + ', ' + country;
    return city;
  }
  const fromIata = iataToCityLabel(iata);
  if (fromIata) return fromIata;
  if (country) return country;
  return 'Unknown';
}

async function fetchProfilesForGeography(sb) {
  const { data, error } = await sb
    .from('profiles')
    .select('user_id, home_airport, last_active, profile_json');
  if (error) return { rows: [], error: error.message };
  return { rows: data || [], error: null };
}

const OVERLAY_BOOK_MARKER = 'overlay_book';

function isOverlayBookClickRow(row) {
  if (!row) return false;
  return (
    String(row.click_source || '') === OVERLAY_BOOK_MARKER ||
    String(row.platform || '') === OVERLAY_BOOK_MARKER
  );
}

const EVENT_CLICKS_SELECTS = [
  'user_id, event_id, event_name, clicked_at, click_source, platform, city',
  'user_id, event_id, event_name, clicked_at, click_source, platform',
  'user_id, event_id, event_name, clicked_at, platform, city',
  'user_id, event_id, event_name, clicked_at, platform',
  'user_id, event_id, event_name, clicked_at, click_source, city',
  'user_id, event_id, event_name, clicked_at, click_source',
  'user_id, event_id, event_name, clicked_at, city',
  'user_id, event_id, event_name, clicked_at',
];

async function fetchRecentEventClicks(sb, days) {
  const d = Math.max(1, Number(days) || 7);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  let lastError = null;
  for (let i = 0; i < EVENT_CLICKS_SELECTS.length; i++) {
    const { data, error } = await sb
      .from('event_clicks')
      .select(EVENT_CLICKS_SELECTS[i])
      .gte('clicked_at', since)
      .order('clicked_at', { ascending: false })
      .limit(15000);
    if (!error) return { rows: data || [], error: null };
    lastError = error.message;
  }
  return { rows: [], error: lastError || 'Could not load event_clicks' };
}

/** Book tickets clicks from event hub overlay only. */
async function fetchRecentOverlayBookClicks(sb, days) {
  const all = await fetchRecentEventClicks(sb, days);
  if (all.error) return { rows: [], error: all.error };
  return {
    rows: (all.rows || []).filter(isOverlayBookClickRow),
    error: null,
  };
}

function buildWeeklyEngagementByCity(overlayClicks) {
  const cityTally = {};
  const usersByCity = {};
  (overlayClicks || []).forEach(function (c) {
    const rawCity = String(c.city || '').trim();
    const city =
      cityFromLocationText(rawCity || c.event_name || '') ||
      normalizeCity(rawCity) ||
      normalizeCity(String(c.event_name || '').split('·')[0]) ||
      'Unspecified';
    cityTally[city] = (cityTally[city] || 0) + 1;
    if (c.user_id) {
      if (!usersByCity[city]) usersByCity[city] = {};
      usersByCity[city][String(c.user_id)] = true;
    }
  });
  return Object.keys(cityTally)
    .map(function (city) {
      return {
        city,
        bookClicks: cityTally[city] || 0,
        uniqueUsers: usersByCity[city] ? Object.keys(usersByCity[city]).length : 0,
      };
    })
    .sort(function (a, b) {
      return b.bookClicks - a.bookClicks;
    })
    .slice(0, 12);
}

function topTallyEntries(tally, limit) {
  return Object.keys(tally || {})
    .map((k) => ({ label: k, count: tally[k] || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit || 10));
}

const EVENT_CLICKS_ENGAGEMENT_SELECTS = [
  'id, user_id, event_id, event_name',
  'user_id, event_id, event_name',
  'id, user_id, event_name',
  'user_id, event_name',
];

/** COALESCE(event_id, event_name) — SQL null semantics, not empty-string fallback. */
function eventClickDistinctKey(row) {
  if (!row) return null;
  if (row.event_id != null) return String(row.event_id);
  if (row.event_name != null) return String(row.event_name);
  return null;
}

function summarizeRepeatEngagementRows(rows) {
  const eventsByUser = {};
  (rows || []).forEach(function (row) {
    if (row.user_id == null) return;
    const uid = String(row.user_id).trim();
    if (!uid) return;
    if (!eventsByUser[uid]) eventsByUser[uid] = {};
    const eventKey = eventClickDistinctKey(row);
    if (eventKey != null) eventsByUser[uid][eventKey] = true;
  });

  const userIds = Object.keys(eventsByUser);
  const totalActiveUsers = userIds.length;
  let repeatEngagers = 0;
  userIds.forEach(function (uid) {
    if (Object.keys(eventsByUser[uid]).length > 1) repeatEngagers += 1;
  });
  const repeatRatePercent =
    totalActiveUsers > 0 ? Math.round((repeatEngagers / totalActiveUsers) * 1000) / 10 : null;

  return { totalActiveUsers, repeatEngagers, repeatRatePercent };
}

async function fetchEventClicksForEngagement(sb) {
  const pageSize = 1000;
  let lastError = null;
  for (let s = 0; s < EVENT_CLICKS_ENGAGEMENT_SELECTS.length; s++) {
    const selectCols = EVENT_CLICKS_ENGAGEMENT_SELECTS[s];
    const orderCol = selectCols.split(',').map(function (c) {
      return c.trim();
    }).includes('id')
      ? 'id'
      : 'clicked_at';
    const rows = [];
    let offset = 0;
    let queryError = null;
    for (;;) {
      const { data, error } = await sb
        .from('event_clicks')
        .select(selectCols)
        .order(orderCol, { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) {
        queryError = error.message;
        break;
      }
      if (!data || !data.length) break;
      rows.push.apply(rows, data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    if (!queryError) return { rows, error: null };
    lastError = queryError;
  }
  return { rows: [], error: lastError || 'Could not load event_clicks for repeat engagement' };
}

function parseRepeatEngagementRpcPayload(data) {
  if (data == null) return null;
  const stats = typeof data === 'string' ? JSON.parse(data) : data;
  if (!stats || typeof stats !== 'object') return null;
  const totalActiveUsers = Number(stats.totalActiveUsers);
  const repeatEngagers = Number(stats.repeatEngagers);
  if (!Number.isFinite(totalActiveUsers) || !Number.isFinite(repeatEngagers)) return null;
  const repeatRatePercent =
    stats.repeatRatePercent != null && Number.isFinite(Number(stats.repeatRatePercent))
      ? Number(stats.repeatRatePercent)
      : totalActiveUsers > 0
        ? Math.round((repeatEngagers / totalActiveUsers) * 1000) / 10
        : null;
  return { totalActiveUsers, repeatEngagers, repeatRatePercent, error: null };
}

/** Signed-in users with ≥1 event click; repeat = distinct COALESCE(event_id, event_name) > 1. */
async function computeRepeatEngagement(sb) {
  const empty = {
    totalActiveUsers: 0,
    repeatEngagers: 0,
    repeatRatePercent: null,
    error: null,
  };
  if (!sb) return empty;

  try {
    const { data, error } = await sb.rpc('repeat_engagement_stats');
    if (!error) {
      const parsed = parseRepeatEngagementRpcPayload(data);
      if (parsed) return parsed;
    }
  } catch (e) {
    /* RPC optional until sql/repeat_engagement_stats.sql is applied */
  }

  try {
    const loaded = await fetchEventClicksForEngagement(sb);
    if (loaded.error) return Object.assign({}, empty, { error: loaded.error });
    return Object.assign({ error: null }, summarizeRepeatEngagementRows(loaded.rows));
  } catch (e) {
    return Object.assign({}, empty, { error: e.message || String(e) });
  }
}

function locationTextToTravelState(locationText) {
  const t = String(locationText || '').trim();
  if (!t) return null;
  const cityHint = cityFromLocationText(t) || iataToCityLabel(t) || t;
  return inferMalaysianState(cityHint + ' ' + t, 'Malaysia');
}

function bumpTravelDestinationState(tally, locationText) {
  const st = locationTextToTravelState(locationText);
  if (!st) return;
  tally[st] = (tally[st] || 0) + 1;
}

/** Where users travel *to* — state from flight + hotel selections only (no event clicks). */
async function aggregateTravelDestinationsByState(sb, days) {
  const tally = {};
  const d = Math.max(1, Number(days) || 7);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  let flightPicks = 0;
  let hotelPicks = 0;

  try {
    const { data } = await sb
      .from('flight_selections')
      .select('destination_city, created_at')
      .gte('created_at', since)
      .limit(8000);
    (data || []).forEach((r) => {
      flightPicks += 1;
      bumpTravelDestinationState(tally, r.destination_city);
    });
  } catch (e) {
    /* table optional */
  }

  try {
    const { data } = await sb
      .from('hotel_selections')
      .select('city, created_at')
      .gte('created_at', since)
      .limit(8000);
    (data || []).forEach((r) => {
      hotelPicks += 1;
      bumpTravelDestinationState(tally, r.city);
    });
  } catch (e) {
    /* table optional */
  }

  const sorted = topTallyEntries(tally, 14);
  return {
    labels: sorted.map((x) => x.label),
    values: sorted.map((x) => x.count),
    windowDays: d,
    flightPicks,
    hotelPicks,
  };
}

const TOURIST_STAY_BUCKET_LABELS = ['1 day', '2–3 days', '4–5 days', '6–7 days', '8–14 days', '15+ days'];

const ARRIVAL_MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function arrivalMonthIndexFromIso(iso) {
  const m = parseInt(String(iso || '').slice(5, 7), 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return -1;
  return m - 1;
}

function bumpArrivalMonth(counts, iso) {
  const idx = arrivalMonthIndexFromIso(iso);
  if (idx < 0) return false;
  counts[idx] += 1;
  return true;
}

/** Trip arrival month from itineraries, hotel check-in, and earliest outbound flight per trip. */
async function buildSeasonalArrivalChart(sb) {
  const empty = {
    labels: ARRIVAL_MONTH_LABELS.slice(),
    values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    sampleCount: 0,
    peakMonth: null,
    peakCount: 0,
    fromItineraries: 0,
    fromHotels: 0,
    fromFlights: 0,
  };
  if (!sb) return empty;

  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let fromItineraries = 0;
  let fromHotels = 0;
  let fromFlights = 0;

  try {
    const { data, error } = await sb
      .from('itineraries_generated')
      .select('arrival_date')
      .limit(8000);
    if (!error && data) {
      data.forEach(function (row) {
        const iso = String(row.arrival_date || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && bumpArrivalMonth(counts, iso)) fromItineraries += 1;
      });
    }
  } catch (e) {
    /* table optional */
  }

  try {
    const { data, error } = await sb.from('hotel_selections').select('check_in').limit(15000);
    if (!error && data) {
      data.forEach(function (row) {
        const iso = String(row.check_in || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && bumpArrivalMonth(counts, iso)) fromHotels += 1;
      });
    }
  } catch (e) {
    /* table optional */
  }

  try {
    const { data, error } = await sb
      .from('flight_selections')
      .select('user_id, event_id, flight_date')
      .limit(15000);
    if (!error && data) {
      const groups = {};
      data.forEach(function (row) {
        const fd = String(row.flight_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fd)) return;
        const key = String(row.user_id || '') + '\0' + String(row.event_id || 'trip');
        if (!groups[key] || fd < groups[key]) groups[key] = fd;
      });
      Object.keys(groups).forEach(function (key) {
        if (bumpArrivalMonth(counts, groups[key])) fromFlights += 1;
      });
    }
  } catch (e) {
    /* table optional */
  }

  let peakMonth = null;
  let peakCount = 0;
  counts.forEach(function (c, i) {
    if (c > peakCount) {
      peakCount = c;
      peakMonth = ARRIVAL_MONTH_LABELS[i];
    }
  });

  return {
    labels: ARRIVAL_MONTH_LABELS.slice(),
    values: counts,
    sampleCount: fromItineraries + fromHotels + fromFlights,
    peakMonth,
    peakCount,
    fromItineraries,
    fromHotels,
    fromFlights,
  };
}

function inclusiveStayDays(arrivalIso, departureIso) {
  const a = String(arrivalIso || '').slice(0, 10);
  const b = String(departureIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const t0 = new Date(a + 'T12:00:00Z').getTime();
  const t1 = new Date(b + 'T12:00:00Z').getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null;
  const days = Math.round((t1 - t0) / (24 * 60 * 60 * 1000)) + 1;
  if (days < 1 || days > 90) return null;
  return days;
}

function touristStayBucketIndex(days) {
  if (days <= 1) return 0;
  if (days <= 3) return 1;
  if (days <= 5) return 2;
  if (days <= 7) return 3;
  if (days <= 14) return 4;
  return 5;
}

/** Trip length from saved itineraries (arrival→departure) and flight picks (earliest→latest per trip). */
async function buildTouristStayDurationChart(sb) {
  const empty = {
    labels: TOURIST_STAY_BUCKET_LABELS.slice(),
    values: [0, 0, 0, 0, 0, 0],
    avgDays: null,
    medianDays: null,
    sampleCount: 0,
    fromItineraries: 0,
    fromHotels: 0,
    fromFlightTrips: 0,
  };
  if (!sb) return empty;

  const durations = [];
  let fromItineraries = 0;
  let fromHotels = 0;
  let fromFlightTrips = 0;

  try {
    const { data, error } = await sb
      .from('itineraries_generated')
      .select('arrival_date, departure_date')
      .limit(8000);
    if (!error && data) {
      data.forEach(function (row) {
        const d = inclusiveStayDays(row.arrival_date, row.departure_date);
        if (d) {
          durations.push(d);
          fromItineraries += 1;
        }
      });
    }
  } catch (e) {
    /* table optional */
  }

  try {
    const { data, error } = await sb
      .from('hotel_selections')
      .select('check_in, check_out')
      .limit(15000);
    if (!error && data) {
      data.forEach(function (row) {
        const d = inclusiveStayDays(row.check_in, row.check_out);
        if (d) {
          durations.push(d);
          fromHotels += 1;
        }
      });
    }
  } catch (e) {
    /* table optional */
  }

  try {
    const { data, error } = await sb
      .from('flight_selections')
      .select('user_id, event_id, flight_date')
      .limit(15000);
    if (!error && data) {
      const groups = {};
      data.forEach(function (row) {
        const fd = String(row.flight_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fd)) return;
        const key = String(row.user_id || '') + '\0' + String(row.event_id || 'trip');
        if (!groups[key]) groups[key] = [];
        groups[key].push(fd);
      });
      Object.keys(groups).forEach(function (key) {
        const dates = groups[key].slice().sort();
        if (dates.length < 2) return;
        const d = inclusiveStayDays(dates[0], dates[dates.length - 1]);
        if (d) {
          durations.push(d);
          fromFlightTrips += 1;
        }
      });
    }
  } catch (e) {
    /* table optional */
  }

  const values = [0, 0, 0, 0, 0, 0];
  durations.forEach(function (d) {
    values[touristStayBucketIndex(d)] += 1;
  });
  const sorted = durations.slice().sort(function (a, b) {
    return a - b;
  });
  const sampleCount = durations.length;
  const avgDays = sampleCount
    ? Math.round(
        (durations.reduce(function (s, x) {
          return s + x;
        }, 0) /
          sampleCount) *
          10,
      ) / 10
    : null;
  const medianDays = sampleCount ? sorted[Math.floor(sorted.length / 2)] : null;

  return {
    labels: TOURIST_STAY_BUCKET_LABELS.slice(),
    values,
    avgDays,
    medianDays,
    sampleCount,
    fromItineraries,
    fromHotels,
    fromFlightTrips,
  };
}

function primaryFanDnaCategoryFromPrefs(prefsRow) {
  const raw = Array.isArray(prefsRow && prefsRow.categories) ? prefsRow.categories : [];
  const cats = raw
    .map(function (c) {
      return String(c || '').trim().toLowerCase();
    })
    .filter(function (c) {
      return FAN_DNA_CATEGORIES.indexOf(c) >= 0;
    });
  return cats.length ? cats[0] : null;
}

/** event_id → Fan DNA category via events catalog, click titles, then user preferences. */
async function buildEventCategoryLookup(sb) {
  const byEventId = {};
  const byUserId = {};
  if (!sb) return { byEventId, byUserId };

  try {
    const { data: evs } = await sb
      .from('events_chatbot')
      .select('id, category, title, venue, description')
      .limit(25000);
    (evs || []).forEach(function (row) {
      const inferred = inferEventCategories(row || {});
      const primary = inferred && inferred.length ? inferred[0] : null;
      if (primary) byEventId[String(row.id)] = primary;
    });
  } catch (e) {
    /* optional */
  }

  try {
    const { data: clicks } = await sb.from('event_clicks').select('event_id, event_name').limit(30000);
    (clicks || []).forEach(function (row) {
      const eid = String(row.event_id || '').trim();
      if (!eid || byEventId[eid]) return;
      const inferred = inferEventCategories({ title: row.event_name, category: '' });
      const primary = inferred && inferred.length ? inferred[0] : null;
      if (primary) byEventId[eid] = primary;
    });
  } catch (e) {
    /* optional */
  }

  try {
    const prefs = await fanDnaStore.fetchAllPreferences(sb);
    (prefs || []).forEach(function (p) {
      if (!p || !p.user_id) return;
      const primary = primaryFanDnaCategoryFromPrefs(p);
      if (primary) byUserId[p.user_id] = primary;
    });
  } catch (e) {
    /* optional */
  }

  return { byEventId, byUserId };
}

function resolveTripFanDnaCategory(eventId, userId, lookup) {
  const eid = String(eventId || '').trim();
  if (eid && lookup.byEventId[eid]) return lookup.byEventId[eid];
  const uid = String(userId || '').trim();
  if (uid && lookup.byUserId[uid]) return lookup.byUserId[uid];
  return null;
}

function pushStayNightByCategory(byCat, category, nights) {
  if (!category || nights == null) return;
  if (!byCat[category]) byCat[category] = [];
  byCat[category].push(nights);
}

/** Average nights per Fan DNA category — itineraries, hotels, and flight trip pairs. */
async function buildStayByEventCategoryChart(sb) {
  const empty = {
    labels: [],
    values: [],
    tripCounts: [],
    sampleCount: 0,
    fromItineraries: 0,
    fromHotels: 0,
    fromFlightTrips: 0,
    unresolvedTrips: 0,
    error: null,
  };
  if (!sb) return empty;

  const lookup = await buildEventCategoryLookup(sb);
  const byCat = {};
  let fromItineraries = 0;
  let fromHotels = 0;
  let fromFlightTrips = 0;
  let unresolvedTrips = 0;

  try {
    const { data, error } = await sb
      .from('itineraries_generated')
      .select('event_id, user_id, arrival_date, departure_date')
      .limit(8000);
    if (!error && data) {
      data.forEach(function (row) {
        const nights = inclusiveStayDays(row.arrival_date, row.departure_date);
        if (!nights) return;
        const cat = resolveTripFanDnaCategory(row.event_id, row.user_id, lookup);
        if (!cat) {
          unresolvedTrips += 1;
          return;
        }
        pushStayNightByCategory(byCat, cat, nights);
        fromItineraries += 1;
      });
    }
  } catch (e) {
    /* table optional */
  }

  try {
    const { data, error } = await sb
      .from('hotel_selections')
      .select('event_id, user_id, check_in, check_out')
      .limit(15000);
    if (!error && data) {
      data.forEach(function (row) {
        const nights = inclusiveStayDays(row.check_in, row.check_out);
        if (!nights) return;
        const cat = resolveTripFanDnaCategory(row.event_id, row.user_id, lookup);
        if (!cat) {
          unresolvedTrips += 1;
          return;
        }
        pushStayNightByCategory(byCat, cat, nights);
        fromHotels += 1;
      });
    }
  } catch (e) {
    /* table optional */
  }

  try {
    const { data, error } = await sb
      .from('flight_selections')
      .select('user_id, event_id, flight_date')
      .limit(15000);
    if (!error && data) {
      const groups = {};
      const meta = {};
      data.forEach(function (row) {
        const fd = String(row.flight_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fd)) return;
        const key = String(row.user_id || '') + '\0' + String(row.event_id || 'trip');
        if (!groups[key]) groups[key] = [];
        groups[key].push(fd);
        meta[key] = { event_id: row.event_id, user_id: row.user_id };
      });
      Object.keys(groups).forEach(function (key) {
        const dates = groups[key].slice().sort();
        if (dates.length < 2) return;
        const nights = inclusiveStayDays(dates[0], dates[dates.length - 1]);
        if (!nights) return;
        const m = meta[key] || {};
        const cat = resolveTripFanDnaCategory(m.event_id, m.user_id, lookup);
        if (!cat) {
          unresolvedTrips += 1;
          return;
        }
        pushStayNightByCategory(byCat, cat, nights);
        fromFlightTrips += 1;
      });
    }
  } catch (e) {
    /* table optional */
  }

  const ranked = FAN_DNA_CATEGORIES.map(function (id) {
    const nights = byCat[id] || [];
    const count = nights.length;
    const avg =
      count > 0
        ? Math.round(
            (nights.reduce(function (s, x) {
              return s + x;
            }, 0) /
              count) *
              10,
          ) / 10
        : null;
    return { id, avg, count };
  })
    .filter(function (x) {
      return x.count > 0 && x.avg != null;
    })
    .sort(function (a, b) {
      return b.avg - a.avg || b.count - a.count;
    });

  const sampleCount = fromItineraries + fromHotels + fromFlightTrips;

  return {
    labels: ranked.map(function (x) {
      return FAN_DNA_CATEGORY_LABELS[x.id] || x.id;
    }),
    values: ranked.map(function (x) {
      return x.avg;
    }),
    tripCounts: ranked.map(function (x) {
      return x.count;
    }),
    sampleCount,
    fromItineraries,
    fromHotels,
    fromFlightTrips,
    unresolvedTrips,
    error: null,
  };
}

const MALAYSIA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const BROWSING_HOUR_LABELS = Array.from({ length: 24 }, function (_, h) {
  return String(h);
});
const DAY_OF_WEEK_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Parse Supabase timestamptz as UTC milliseconds (handles missing Z/offset). */
function parseTimestampUtcMs(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return NaN;
  if (/[zZ]|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(raw)) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : NaN;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    const normalized = raw.replace(' ', 'T');
    const t = Date.parse(normalized.endsWith('Z') ? normalized : normalized + 'Z');
    return Number.isFinite(t) ? t : NaN;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

function malaysiaPartsFromIso(iso) {
  const t = parseTimestampUtcMs(iso);
  if (!Number.isFinite(t)) return null;
  const myt = new Date(t + MALAYSIA_TZ_OFFSET_MS);
  const utcDay = myt.getUTCDay();
  return {
    hour: myt.getUTCHours(),
    dayMondayFirst: utcDay === 0 ? 6 : utcDay - 1,
  };
}

function sumCountArray(arr) {
  return (arr || []).reduce(function (s, x) {
    return s + (Number(x) || 0);
  }, 0);
}

function peakIndexFromCounts(counts) {
  let peakIdx = -1;
  let peakCount = 0;
  (counts || []).forEach(function (c, i) {
    if (c > peakCount) {
      peakCount = c;
      peakIdx = i;
    }
  });
  return { peakIdx, peakCount };
}

async function fetchAllRowsByColumn(sb, table, column) {
  const pageSize = 1000;
  let offset = 0;
  const rows = [];
  if (!sb) return { rows: [], error: 'Supabase not configured' };

  for (;;) {
    const { data, error } = await sb
      .from(table)
      .select(column)
      .order(column, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) return { rows: [], error: error.message };
    const batch = data || [];
    rows.push.apply(rows, batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset > 100000) break;
  }
  return { rows, error: null };
}

/** Chatbot queries by hour of day (0–23, Malaysia time) from chat_history_chatbot.created_at. */
async function buildPeakBrowsingHoursChart(sb) {
  const hourlyData = new Array(24).fill(0);
  if (!sb) {
    return {
      hourlyData,
      hourLabels: BROWSING_HOUR_LABELS.slice(),
      peakHour: null,
      peakCount: 0,
      chatQueryCount: 0,
      error: null,
    };
  }

  const fetched = await fetchAllRowsByColumn(sb, 'chat_history_chatbot', 'created_at');
  if (fetched.error) {
    return {
      hourlyData,
      hourLabels: BROWSING_HOUR_LABELS.slice(),
      peakHour: null,
      peakCount: 0,
      chatQueryCount: 0,
      error: fetched.error,
    };
  }

  fetched.rows.forEach(function (row) {
    const parts = malaysiaPartsFromIso(row.created_at);
    if (!parts || parts.hour < 0 || parts.hour > 23) return;
    hourlyData[parts.hour] += 1;
  });

  const peak = peakIndexFromCounts(hourlyData);
  const chatQueryCount = sumCountArray(hourlyData);

  return {
    hourlyData,
    hourLabels: BROWSING_HOUR_LABELS.slice(),
    peakHour: peak.peakIdx >= 0 ? peak.peakIdx : null,
    peakCount: peak.peakCount,
    chatQueryCount,
    error: null,
  };
}

/** Event clicks by day of week (Mon–Sun, Malaysia time) from event_clicks.clicked_at. */
async function buildMostActiveDaysChart(sb) {
  const weeklyData = [0, 0, 0, 0, 0, 0, 0];
  if (!sb) {
    return {
      weeklyData,
      dayLabels: DAY_OF_WEEK_LABELS.slice(),
      peakDay: null,
      peakCount: 0,
      eventClickCount: 0,
      error: null,
    };
  }

  const fetched = await fetchAllRowsByColumn(sb, 'event_clicks', 'clicked_at');
  if (fetched.error) {
    return {
      weeklyData,
      dayLabels: DAY_OF_WEEK_LABELS.slice(),
      peakDay: null,
      peakCount: 0,
      eventClickCount: 0,
      error: fetched.error,
    };
  }

  fetched.rows.forEach(function (row) {
    const parts = malaysiaPartsFromIso(row.clicked_at);
    if (!parts || parts.dayMondayFirst < 0 || parts.dayMondayFirst > 6) return;
    weeklyData[parts.dayMondayFirst] += 1;
  });

  const peak = peakIndexFromCounts(weeklyData);
  const eventClickCount = sumCountArray(weeklyData);

  return {
    weeklyData,
    dayLabels: DAY_OF_WEEK_LABELS.slice(),
    peakDay: peak.peakIdx >= 0 ? DAY_OF_WEEK_LABELS[peak.peakIdx] : null,
    peakCount: peak.peakCount,
    eventClickCount,
    error: null,
  };
}

async function buildPeakActivityTimeline(sb) {
  const [hours, days] = await Promise.all([
    buildPeakBrowsingHoursChart(sb),
    buildMostActiveDaysChart(sb),
  ]);
  return {
    hourlyData: hours.hourlyData || new Array(24).fill(0),
    weeklyData: days.weeklyData || [0, 0, 0, 0, 0, 0, 0],
    hourLabels: hours.hourLabels || BROWSING_HOUR_LABELS.slice(),
    dayLabels: days.dayLabels || DAY_OF_WEEK_LABELS.slice(),
    peakHour: hours.peakHour,
    peakDay: days.peakDay,
    chatQueryCount: hours.chatQueryCount || 0,
    eventClickCount: days.eventClickCount || 0,
    errors: {
      chat: hours.error || null,
      clicks: days.error || null,
    },
  };
}

async function buildGeographicAnalytics(sb) {
  const empty = {
    travelerCountries: {
      labels: [],
      values: [],
      mapEntries: [],
      mapMax: 0,
      domesticSplit: { domestic: 0, international: 0, domesticPercent: 0, internationalPercent: 0 },
    },
    stateHeatmap: MY_STATE_TILES.map((t) => Object.assign({}, t, { count: 0 })),
    weeklyEngagement: [],
    touristStayDuration: {
      labels: TOURIST_STAY_BUCKET_LABELS.slice(),
      values: [0, 0, 0, 0, 0, 0],
      avgDays: null,
      medianDays: null,
      sampleCount: 0,
      fromItineraries: 0,
      fromHotels: 0,
      fromFlightTrips: 0,
    },
    repeatEngagement: {
      totalActiveUsers: 0,
      repeatEngagers: 0,
      repeatRatePercent: null,
      error: null,
    },
    travelDestinationsByState: { labels: [], values: [], windowDays: 7 },
    totals: { profiles: 0, activeThisWeek: 0, clicksThisWeek: 0, overlayBookClicks: 0, travelPicks: 0, travelFlights: 0, travelHotels: 0 },
  };
  if (!sb) return empty;

  const profRes = await fetchProfilesForGeography(sb);
  const profiles = profRes.rows || [];
  let prefsByUser = {};
  try {
    const prefs = await fanDnaStore.fetchAllPreferences(sb);
    (prefs || []).forEach((p) => {
      if (p && p.user_id) prefsByUser[p.user_id] = p;
    });
  } catch (e) {
    /* optional */
  }

  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - weekMs;
  const originTally = {};
  const countryTally = {};
  const stateTally = {};
  let activeThisWeek = 0;

  profiles.forEach((row) => {
    const country = resolveUserCountry(row, prefsByUser);
    countryTally[country] = (countryTally[country] || 0) + 1;
    const origin = resolveUserOriginLabel(row, prefsByUser);
    const originKey = origin.length > 80 ? origin.slice(0, 80) : origin;
    originTally[originKey] = (originTally[originKey] || 0) + 1;
    const pj = parseProfileJsonGeo(row.profile_json);
    const iata = resolveProfileIata(row, prefsByUser);
    const state =
      stateFromMalaysianIata(iata) ||
      inferMalaysianState(
        origin + ' ' + String(pj.locationCity || '') + ' ' + iataToCityLabel(iata),
        isDomesticCountry(country) ? 'Malaysia' : country,
      );
    stateTally[state] = (stateTally[state] || 0) + 1;
    const t = new Date(row.last_active || '').getTime();
    if (Number.isFinite(t) && t >= cutoff) activeThisWeek += 1;
  });

  const overlayClicksRes = await fetchRecentOverlayBookClicks(sb, 7);
  const overlayClicks = overlayClicksRes.rows || [];
  const weeklyEngagement = buildWeeklyEngagementByCity(overlayClicks);

  const repeatEngagement = await computeRepeatEngagement(sb);

  const stateHeatmap = MY_STATE_TILES.map((tile) => ({
    id: tile.id,
    label: tile.label,
    short: tile.short,
    count: stateTally[tile.label] || 0,
  }));
  const travelDest = await aggregateTravelDestinationsByState(sb, 7);
  const touristStayDuration = await buildTouristStayDurationChart(sb);

  return {
    travelerCountries: buildTravelerCountriesChart(countryTally),
    stateHeatmap,
    weeklyEngagement,
    touristStayDuration,
    repeatEngagement,
    travelDestinationsByState: travelDest,
    totals: {
      profiles: profiles.length,
      activeThisWeek,
      clicksThisWeek: overlayClicks.length,
      overlayBookClicks: overlayClicks.length,
      travelPicks: (travelDest.flightPicks || 0) + (travelDest.hotelPicks || 0),
      travelFlights: travelDest.flightPicks || 0,
      travelHotels: travelDest.hotelPicks || 0,
    },
  };
}

const FAN_DNA_CATEGORY_LABELS = {
  music: 'Music',
  sports: 'Sports',
  food_drink: 'Food & Drink',
  arts_culture: 'Arts & Culture',
  technology: 'Technology',
  nature_outdoors: 'Nature & Outdoors',
  comedy: 'Comedy',
  networking: 'Networking',
};

const FAN_DNA_VIBE_LABELS = {
  chill_relaxed: 'Chill & relaxed',
  high_energy: 'High energy',
  social_meetup: 'Social meetup',
  educational: 'Educational',
  family_friendly: 'Family friendly',
};

const FAN_DNA_TIME_LABELS = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  late_night: 'Late night',
};

const FAN_DNA_BUDGET_LABELS = {
  free: 'Free',
  under_50: 'Under RM50',
  '50_150': 'RM50–150',
  '150_plus': 'RM150+',
};

const FAN_DNA_TRAVEL_LABELS = {
  '5km': 'Within 5 km',
  '10km': 'Within 10 km',
  '25km': 'Within 25 km',
  '50km': 'Within 50 km',
  any: 'Any distance',
};

const TOURIST_SEGMENT_DEFS = [
  {
    id: 'concert_seekers',
    name: 'Concert Seekers',
    color: '#00d4aa',
    rules: {
      categories: ['music'],
      vibes: ['high_energy'],
      times: ['evening'],
      budgets: null,
    },
    predictedNextEvent: 'Live concert or music festival',
    rulesSummary: 'Music · high energy · evening',
  },
  {
    id: 'business_travellers',
    name: 'Business Travellers',
    color: '#3d9e8f',
    rules: {
      categories: ['networking'],
      vibes: ['educational'],
      times: ['morning'],
      budgets: null,
    },
    predictedNextEvent: 'Conference or professional networking summit',
    rulesSummary: 'Networking · educational · morning',
  },
  {
    id: 'family_explorers',
    name: 'Family Explorers',
    color: '#d4a017',
    rules: {
      categories: ['arts_culture'],
      vibes: ['chill_relaxed'],
      times: ['afternoon'],
      budgets: ['free', 'under_50'],
    },
    predictedNextEvent: 'Family museum day or kids cultural workshop',
    rulesSummary: 'Arts & culture · relaxed · afternoon · budget-friendly',
  },
  {
    id: 'wellness_wanderers',
    name: 'Wellness Wanderers',
    color: '#7af0d8',
    rules: {
      categories: ['nature_outdoors'],
      vibes: ['chill_relaxed'],
      times: ['morning'],
      budgets: null,
    },
    predictedNextEvent: 'Nature hike or wellness retreat experience',
    rulesSummary: 'Nature & outdoors · relaxed · morning',
  },
  {
    id: 'culture_enthusiasts',
    name: 'Culture Enthusiasts',
    color: '#e8c547',
    rules: {
      categories: ['arts_culture'],
      vibes: ['social_meetup'],
      times: ['afternoon'],
      budgets: ['50_150'],
    },
    predictedNextEvent: 'Gallery opening or cultural performance',
    rulesSummary: 'Arts & culture · social · afternoon · mid-range budget',
  },
];

function normPrefList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(function (x) {
    return String(x || '').trim().toLowerCase();
  }).filter(Boolean);
}

function segmentStrictMatch(prefsRow, seg) {
  const rules = seg.rules || {};
  const cats = normPrefList(prefsRow && prefsRow.categories);
  const vibes = normPrefList(prefsRow && prefsRow.vibes);
  const times = normPrefList(prefsRow && prefsRow.preferred_time);
  const budget = String((prefsRow && prefsRow.budget) || '').trim().toLowerCase();

  const reqCats = rules.categories || [];
  const reqVibes = rules.vibes || [];
  const reqTimes = rules.times || [];
  const reqBudgets = rules.budgets;

  for (let i = 0; i < reqCats.length; i += 1) {
    if (cats.indexOf(reqCats[i]) < 0) return false;
  }
  for (let j = 0; j < reqVibes.length; j += 1) {
    if (vibes.indexOf(reqVibes[j]) < 0) return false;
  }
  if (reqTimes.length) {
    let timeOk = false;
    for (let k = 0; k < reqTimes.length; k += 1) {
      if (times.indexOf(reqTimes[k]) >= 0) {
        timeOk = true;
        break;
      }
    }
    if (!timeOk) return false;
  }
  if (reqBudgets && reqBudgets.length) {
    if (reqBudgets.indexOf(budget) < 0) return false;
  }
  return true;
}

function segmentMatchScore(prefsRow, seg) {
  const rules = seg.rules || {};
  let matched = 0;
  let total = 0;
  const cats = normPrefList(prefsRow && prefsRow.categories);
  const vibes = normPrefList(prefsRow && prefsRow.vibes);
  const times = normPrefList(prefsRow && prefsRow.preferred_time);
  const budget = String((prefsRow && prefsRow.budget) || '').trim().toLowerCase();

  (rules.categories || []).forEach(function (c) {
    total += 1;
    if (cats.indexOf(c) >= 0) matched += 1;
  });
  (rules.vibes || []).forEach(function (v) {
    total += 1;
    if (vibes.indexOf(v) >= 0) matched += 1;
  });
  (rules.times || []).forEach(function (t) {
    total += 1;
    if (times.indexOf(t) >= 0) matched += 1;
  });
  if (rules.budgets && rules.budgets.length) {
    total += 1;
    if (rules.budgets.indexOf(budget) >= 0) matched += 1;
  }
  return total > 0 ? matched / total : 0;
}

function assignUserToTouristSegment(prefsRow) {
  let best = null;
  let bestScore = 0;
  let strict = null;

  TOURIST_SEGMENT_DEFS.forEach(function (seg) {
    if (segmentStrictMatch(prefsRow, seg)) strict = seg;
    const score = segmentMatchScore(prefsRow, seg);
    if (score > bestScore) {
      bestScore = score;
      best = seg;
    }
  });

  if (strict) return strict.id;
  if (best && bestScore >= 0.5) return best.id;
  return null;
}

function topModesFromSegmentUsers(users, valueFn, labelFn, limit) {
  const counts = {};
  users.forEach(function (p) {
    const vals = valueFn(p) || [];
    vals.forEach(function (v) {
      if (!v) return;
      counts[v] = (counts[v] || 0) + 1;
    });
  });
  return Object.keys(counts)
    .sort(function (a, b) {
      return (counts[b] || 0) - (counts[a] || 0);
    })
    .slice(0, limit || 3)
    .map(function (id) {
      return {
        id: id,
        label: labelFn ? labelFn(id) : id,
        count: counts[id] || 0,
      };
    });
}

function labelModeList(modes, fallback) {
  if (!modes || !modes.length) return fallback || '—';
  return modes.map(function (m) {
    return m.label;
  }).join(', ');
}

/** Tourist segment wheel — classify user_preferences into five Ministry-facing personas. */
function buildTouristSegmentIntelligence(prefsRows) {
  const empty = {
    segments: [],
    totalUsers: 0,
    assignedUsers: 0,
    unassignedUsers: 0,
    error: null,
  };

  const rows = prefsRows || [];
  const bySegment = {};
  TOURIST_SEGMENT_DEFS.forEach(function (seg) {
    bySegment[seg.id] = [];
  });

  let assigned = 0;
  rows.forEach(function (p) {
    const segId = assignUserToTouristSegment(p);
    if (!segId || !bySegment[segId]) return;
    bySegment[segId].push(p);
    assigned += 1;
  });

  const segments = TOURIST_SEGMENT_DEFS.map(function (seg) {
    const users = bySegment[seg.id] || [];
    const topCategories = topModesFromSegmentUsers(
      users,
      function (p) {
        return normPrefList(p.categories);
      },
      function (id) {
        return FAN_DNA_CATEGORY_LABELS[id] || id;
      },
      3
    );
    const topTimes = topModesFromSegmentUsers(
      users,
      function (p) {
        return normPrefList(p.preferred_time);
      },
      function (id) {
        return FAN_DNA_TIME_LABELS[id] || id;
      },
      2
    );
    const topBudgets = topModesFromSegmentUsers(
      users,
      function (p) {
        const b = String(p.budget || '').trim().toLowerCase();
        return b ? [b] : [];
      },
      function (id) {
        return FAN_DNA_BUDGET_LABELS[id] || id;
      },
      2
    );
    const topTravel = topModesFromSegmentUsers(
      users,
      function (p) {
        const t = String(p.travel_distance || '').trim().toLowerCase();
        return t ? [t] : [];
      },
      function (id) {
        return FAN_DNA_TRAVEL_LABELS[id] || id;
      },
      2
    );

    return {
      id: seg.id,
      name: seg.name,
      color: seg.color,
      count: users.length,
      userCount: users.length,
      topCategories: topCategories,
      preferredTime: labelModeList(topTimes, '—'),
      budgetRange: labelModeList(topBudgets, '—'),
      travelDistance: labelModeList(topTravel, '—'),
      predictedNextEvent: seg.predictedNextEvent,
      rulesSummary: seg.rulesSummary,
    };
  });

  return {
    segments: segments,
    totalUsers: rows.length,
    assignedUsers: assigned,
    unassignedUsers: Math.max(0, rows.length - assigned),
    error: null,
  };
}

function resolveClickFanDnaCategory(row, eventCatById) {
  const eid = String((row && row.event_id) || '').trim();
  if (eid && eventCatById[eid]) return eventCatById[eid];
  const inferred = inferEventCategories({
    title: row && row.event_name,
    category: '',
  });
  const primary = inferred && inferred.length ? inferred[0] : null;
  return primary && FAN_DNA_CATEGORIES.indexOf(primary) >= 0 ? primary : null;
}

async function fetchSignedInEventClicks(sb) {
  const pageSize = 1000;
  let offset = 0;
  const rows = [];
  if (!sb) return rows;

  for (;;) {
    const { data, error } = await sb
      .from('event_clicks')
      .select('user_id, event_id, event_name')
      .not('user_id', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    rows.push.apply(rows, batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset > 100000) break;
  }
  return rows;
}

/** Cross-category co-click matrix — signed-in users who clicked events in multiple Fan DNA categories. */
async function buildCategoryAffinityMatrix(sb) {
  const empty = {
    labels: [],
    categoryIds: [],
    matrix: [],
    pairs: [],
    nodes: [],
    links: [],
    categoryClickCounts: [],
    maxCount: 0,
    maxClicks: 0,
    topPair: null,
    multiCategoryUsers: 0,
    totalUsers: 0,
    error: null,
  };
  if (!sb) return empty;

  try {
    const eventCatById = {};
    const { data: evs, error: evErr } = await sb
      .from('events_chatbot')
      .select('id, category, title, venue, description')
      .limit(25000);
    if (evErr) return Object.assign({}, empty, { error: evErr.message });
    (evs || []).forEach(function (row) {
      const inferred = inferEventCategories(row || {});
      const primary = inferred && inferred.length ? inferred[0] : null;
      if (primary) eventCatById[String(row.id)] = primary;
    });

    const clicks = await fetchSignedInEventClicks(sb);
    const catClickCounts = {};
    FAN_DNA_CATEGORIES.forEach(function (id) {
      catClickCounts[id] = 0;
    });
    const userCats = {};
    clicks.forEach(function (row) {
      const uid = String(row.user_id || '').trim();
      if (!uid) return;
      const cat = resolveClickFanDnaCategory(row, eventCatById);
      if (!cat) return;
      catClickCounts[cat] = (catClickCounts[cat] || 0) + 1;
      if (!userCats[uid]) userCats[uid] = {};
      userCats[uid][cat] = true;
    });

    const catUserCounts = {};
    FAN_DNA_CATEGORIES.forEach(function (id) {
      catUserCounts[id] = 0;
    });
    const activeCatSet = {};
    Object.keys(userCats).forEach(function (uid) {
      Object.keys(userCats[uid]).forEach(function (cat) {
        catUserCounts[cat] = (catUserCounts[cat] || 0) + 1;
        activeCatSet[cat] = true;
      });
    });

    const ranked = FAN_DNA_CATEGORIES.filter(function (id) {
      return activeCatSet[id];
    }).sort(function (a, b) {
      return (catUserCounts[b] || 0) - (catUserCounts[a] || 0);
    });

    const n = ranked.length;
    const matrix = Array.from({ length: n }, function () {
      return new Array(n).fill(0);
    });
    let multiCategoryUsers = 0;
    let maxCount = 0;
    const pairs = [];

    Object.keys(userCats).forEach(function (uid) {
      const cats = Object.keys(userCats[uid]);
      if (cats.length < 2) return;
      multiCategoryUsers += 1;
      for (let i = 0; i < cats.length; i += 1) {
        for (let j = i + 1; j < cats.length; j += 1) {
          const idxA = ranked.indexOf(cats[i]);
          const idxB = ranked.indexOf(cats[j]);
          if (idxA < 0 || idxB < 0) continue;
          matrix[idxA][idxB] += 1;
          matrix[idxB][idxA] += 1;
          if (matrix[idxA][idxB] > maxCount) maxCount = matrix[idxA][idxB];
        }
      }
    });

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const count = matrix[i][j] || 0;
        if (!count) continue;
        pairs.push({
          catA: ranked[i],
          catB: ranked[j],
          labelA: FAN_DNA_CATEGORY_LABELS[ranked[i]] || ranked[i],
          labelB: FAN_DNA_CATEGORY_LABELS[ranked[j]] || ranked[j],
          count,
        });
      }
    }
    pairs.sort(function (a, b) {
      return b.count - a.count;
    });

    const nodes = ranked.map(function (id) {
      return {
        id: id,
        label: FAN_DNA_CATEGORY_LABELS[id] || id,
        clicks: catClickCounts[id] || 0,
        users: catUserCounts[id] || 0,
      };
    });
    const links = pairs.map(function (p) {
      return {
        source: p.catA,
        target: p.catB,
        count: p.count,
        labelA: p.labelA,
        labelB: p.labelB,
      };
    });
    let maxClicks = 0;
    nodes.forEach(function (n) {
      if ((n.clicks || 0) > maxClicks) maxClicks = n.clicks;
    });

    return {
      labels: ranked.map(function (id) {
        return FAN_DNA_CATEGORY_LABELS[id] || id;
      }),
      categoryIds: ranked,
      matrix,
      pairs,
      nodes,
      links,
      categoryClickCounts: ranked.map(function (id) {
        return catClickCounts[id] || 0;
      }),
      maxCount,
      maxClicks,
      topPair: pairs.length ? pairs[0] : null,
      multiCategoryUsers,
      totalUsers: Object.keys(userCats).length,
      error: null,
    };
  } catch (e) {
    return Object.assign({}, empty, { error: e.message || String(e) });
  }
}

function buildDemandVsSupplyChart(prefsRows, eventRows) {
  const empty = {
    labels: [],
    demandPct: [],
    supplyPct: [],
    demandUsers: 0,
    supplyEvents: 0,
    error: null,
  };

  const demandByCat = {};
  FAN_DNA_CATEGORIES.forEach(function (id) {
    demandByCat[id] = 0;
  });
  let usersWithPrefs = 0;
  (prefsRows || []).forEach(function (p) {
    const raw = Array.isArray(p && p.categories) ? p.categories : [];
    const cats = raw
      .map(function (c) {
        return String(c || '').trim().toLowerCase();
      })
      .filter(function (c) {
        return FAN_DNA_CATEGORIES.indexOf(c) >= 0;
      });
    if (!cats.length) return;
    usersWithPrefs += 1;
    const seen = {};
    cats.forEach(function (c) {
      if (seen[c]) return;
      seen[c] = true;
      demandByCat[c] = (demandByCat[c] || 0) + 1;
    });
  });

  const supplyByCat = {};
  FAN_DNA_CATEGORIES.forEach(function (id) {
    supplyByCat[id] = 0;
  });
  let totalEvents = 0;
  (eventRows || []).forEach(function (row) {
    totalEvents += 1;
    const inferred = inferEventCategories(row || {});
    const primary =
      inferred && inferred.length
        ? inferred[0]
        : FAN_DNA_CATEGORIES.indexOf('arts_culture') >= 0
          ? 'arts_culture'
          : null;
    if (primary && FAN_DNA_CATEGORIES.indexOf(primary) >= 0) {
      supplyByCat[primary] = (supplyByCat[primary] || 0) + 1;
    }
  });

  const ranked = FAN_DNA_CATEGORIES.map(function (id) {
    return {
      id: id,
      demand: demandByCat[id] || 0,
      supply: supplyByCat[id] || 0,
    };
  })
    .filter(function (x) {
      return x.demand > 0 || x.supply > 0;
    })
    .sort(function (a, b) {
      return b.demand + b.supply - (a.demand + a.supply);
    });

  return {
    labels: ranked.map(function (x) {
      return FAN_DNA_CATEGORY_LABELS[x.id] || x.id;
    }),
    demandPct: ranked.map(function (x) {
      return usersWithPrefs > 0 ? Math.round((x.demand / usersWithPrefs) * 1000) / 10 : 0;
    }),
    supplyPct: ranked.map(function (x) {
      return totalEvents > 0 ? Math.round((x.supply / totalEvents) * 1000) / 10 : 0;
    }),
    demandUsers: usersWithPrefs,
    supplyEvents: totalEvents,
    error: null,
  };
}

async function fetchEventsForSupplyChart(sb) {
  const limit = 25000;
  const { data, error } = await sb
    .from('events_chatbot')
    .select('category, title, venue, description')
    .limit(limit);
  if (error) return { rows: [], error: error.message };
  return { rows: data || [], error: null };
}

async function demandVsSupplyChartData(sb, prefsRows) {
  const empty = {
    labels: [],
    demandPct: [],
    supplyPct: [],
    demandUsers: 0,
    supplyEvents: 0,
    error: null,
  };
  if (!sb) return empty;
  const eventsRes = await fetchEventsForSupplyChart(sb);
  if (eventsRes.error) return Object.assign({}, empty, { error: eventsRes.error });
  return buildDemandVsSupplyChart(prefsRows, eventsRes.rows);
}

async function eventCategoriesChartData(sb, topN) {
  const limit = Math.min(25000, Math.max(500, topN * 50));
  const { data, error } = await sb.from('events_chatbot').select('category').limit(limit);
  if (error || !data || !data.length) {
    return { labels: [], values: [], error: error ? error.message : null };
  }
  const tally = {};
  data.forEach((row) => {
    const k =
      row.category && String(row.category).trim() ? String(row.category).trim() : 'Uncategorized';
    tally[k] = (tally[k] || 0) + 1;
  });
  const sorted = Object.keys(tally)
    .map((k) => ({ label: k, count: tally[k] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(4, topN || 8));
  return {
    labels: sorted.map((x) => x.label),
    values: sorted.map((x) => x.count),
    error: null,
  };
}

async function supabaseTableCount(sb, table) {
  try {
    const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true });
    if (error) return null;
    return count != null ? count : null;
  } catch {
    return null;
  }
}

async function averageHotelStayDays(sb) {
  try {
    const { data, error } = await sb
      .from('hotel_selections')
      .select('check_in, check_out')
      .limit(10000);
    if (error || !data || !data.length) return { avgDays: null, error: error ? error.message : null };
    let sum = 0;
    let n = 0;
    data.forEach((row) => {
      const a = String(row.check_in || '').slice(0, 10);
      const b = String(row.check_out || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return;
      const t0 = new Date(a + 'T12:00:00Z').getTime();
      const t1 = new Date(b + 'T12:00:00Z').getTime();
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
      const days = (t1 - t0) / (24 * 60 * 60 * 1000);
      if (days > 0 && days < 120) {
        sum += days;
        n += 1;
      }
    });
    if (!n) return { avgDays: null, error: null };
    return { avgDays: Math.round((sum / n) * 10) / 10, error: null };
  } catch (e) {
    return { avgDays: null, error: e.message || String(e) };
  }
}

async function averageHotelBudgetFromSelections(sb) {
  try {
    const { data, error } = await sb
      .from('hotel_selections')
      .select('hotel_price_numeric')
      .not('hotel_price_numeric', 'is', null)
      .limit(10000);
    if (error) return { avgMyr: null, sampleSize: 0, error: error.message };
    if (!data || !data.length) return { avgMyr: null, sampleSize: 0 };
    let sum = 0;
    let n = 0;
    data.forEach((row) => {
      const price = Number(row.hotel_price_numeric);
      if (!Number.isFinite(price) || price <= 0) return;
      sum += price;
      n += 1;
    });
    if (!n) return { avgMyr: null, sampleSize: 0 };
    return { avgMyr: Math.round(sum / n), sampleSize: n };
  } catch (e) {
    return { avgMyr: null, sampleSize: 0, error: e.message || String(e) };
  }
}

function fallbackTourismInsights(snapshot) {
  const s = snapshot || {};
  const city = s.popularEventCity || 'key Malaysian cities';
  const users = s.totalRegisteredUsers != null ? s.totalRegisteredUsers : 'registered';
  const clicks = s.totalBookNowClicks != null ? s.totalBookNowClicks : 'measurable';
  return [
    `Event demand is concentrated around ${city}, suggesting targeted campaigns can lift conversion for live experiences in that corridor.`,
    `With ${users} traveler profiles and ${clicks} booking-intent clicks logged, the funnel shows healthy top-of-funnel interest — prioritize hotel and flight selection prompts after event discovery.`,
    'Strengthen cross-sell between itinerary saves and transport stays to convert browsers into multi-day tourism spend across the platform.',
  ];
}

async function generateTourismInsightsWithClaude(snapshot) {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return { insights: fallbackTourismInsights(snapshot), source: 'fallback' };
  }
  const systemPrompt =
    'You are a senior tourism intelligence analyst for Malaysia. Given dashboard JSON metrics, return exactly 3 concise, actionable insights (one sentence each, max 220 chars). Focus on economic impact, traveler behavior, and conversion. Reply with ONLY valid JSON: {"insights":["...","...","..."]}';
  const userBlock =
    'Dashboard metrics:\n' +
    JSON.stringify(snapshot, null, 2) +
    '\n\nReturn 3 tourism intelligence insights as JSON.';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: 'user', content: userBlock }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || data.message || 'Anthropic error');
    }
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('Empty Anthropic response');
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
    const list = Array.isArray(parsed.insights)
      ? parsed.insights.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
      : [];
    if (list.length < 3) throw new Error('Expected 3 insights');
    return { insights: list, source: 'claude' };
  } catch (e) {
    console.warn('[admin overview-insights]', e.message || e);
    return { insights: fallbackTourismInsights(snapshot), source: 'fallback' };
  }
}

async function aggregatePopularEvents(sb, limit) {
  const cap = Math.min(30000, Math.max(1000, limit * 400));
  const { data, error } = await sb.from('event_clicks').select('event_id, event_name').limit(cap);
  if (error || !data) return { rows: [], error: error ? error.message : 'No data' };
  const counts = {};
  data.forEach((c) => {
    const key = String(c.event_id || '').trim() || String(c.event_name || '').trim() || '(unknown)';
    if (!counts[key]) counts[key] = { event_id: c.event_id, event_name: c.event_name, total: 0 };
    counts[key].total += 1;
    if (!counts[key].event_name && c.event_name) counts[key].event_name = c.event_name;
    if (!counts[key].event_id && c.event_id) counts[key].event_id = c.event_id;
  });
  const ranked = Object.values(counts)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  const ids = [...new Set(ranked.map((r) => r.event_id).filter(Boolean))].slice(0, 120);
  const idToMeta = {};
  if (ids.length) {
    const { data: evs } = await sb.from('events_chatbot').select('id, title, source').in('id', ids);
    (evs || []).forEach((e) => {
      idToMeta[String(e.id)] = { title: e.title, source: e.source };
    });
  }
  return {
    rows: ranked.map((r) => {
      const meta = r.event_id && idToMeta[String(r.event_id)];
      const title = meta && meta.title ? meta.title : r.event_name || r.event_id || '—';
      const platform =
        formatPlatformLabel(meta && meta.source) !== '—'
          ? formatPlatformLabel(meta.source)
          : inferPlatformFromClick(r.event_id, r.event_name);
      return {
        eventName: title,
        platform,
        totalClicks: r.total,
      };
    }),
    error: null,
  };
}

function mapEventForScore(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    summary: row.description,
    description: row.description,
    venue: row.venue,
    city: row.city,
    date: row.date,
    price: row.price,
    isFree: row.is_free != null ? row.is_free : row.isFree,
    url: row.event_url || row.url,
    image: row.image_url || row.image,
    source: row.source,
    event_dna: row.event_dna || null,
  };
}

function mapScrapedEventForScore(e) {
  return mapEventForScore({
    id: e.id || e.url,
    title: e.title,
    description: e.summary,
    venue: e.venue,
    city: e.city,
    date: e.date,
    price: e.price,
    is_free: e.isFree,
    event_url: e.url,
    image_url: e.image,
    source: e.source,
    category: e.category,
  });
}

const SUPABASE_TABLE_HINT =
  'Create tables in Supabase: run sql/fan_dna_tables.sql in the SQL editor (user_preferences + event_clicks).';

function mergeProfileDnaIntoPrefs(row, fromProfile) {
  if (!row || !fromProfile || typeof fromProfile !== 'object') return row;
  const profileDna = normalizeDna(fromProfile.user_dna);
  if (!profileDna) return row;
  const dbDna = normalizeDna(row.user_dna);
  const profileCustom = Boolean(fromProfile.user_dna_custom);
  const profileTs = fromProfile.updated_at ? new Date(fromProfile.updated_at).getTime() : 0;
  const dbTs = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  const useProfile =
    profileCustom ||
    !dbDna ||
    (profileTs > 0 && profileTs >= dbTs);
  if (useProfile) {
    row.user_dna = profileDna;
    if (profileCustom) row.user_dna_custom = true;
  }
  return row;
}

function fillCrowdFieldsFromProfile(row, fromProfile) {
  if (!row || !fromProfile || typeof fromProfile !== 'object') return row;
  ['gender', 'profession', 'age_group'].forEach(function (key) {
    if (!row[key] && fromProfile[key]) row[key] = fromProfile[key];
  });
  return row;
}

async function loadUserPreferences(sb, uid) {
  const fromProfile = await authStore.getFanDnaFromProfile(uid);
  try {
    const row = await fanDnaStore.getPreferences(sb, uid);
    if (row) {
      return fillCrowdFieldsFromProfile(mergeProfileDnaIntoPrefs(row, fromProfile), fromProfile);
    }
    return fromProfile;
  } catch (e) {
    if (fanDnaStore.isMissingTableError(e)) {
      return fromProfile;
    }
    throw e;
  }
}

function resolveEffectiveUserDna(prefs) {
  if (!prefs || typeof prefs !== 'object') return null;
  const stored = normalizeDna(prefs.user_dna);
  if (stored) return stored;
  return normalizeDna(convertPreferencesToDNA(prefs));
}

function buildScoredEventsList(prefs, userDna, rows, getMergedScrapedEvents, minScore) {
  let list = rows;
  if (!list.length && typeof getMergedScrapedEvents === 'function') {
    list = (getMergedScrapedEvents() || []).map(mapScrapedEventForScore);
  }
  return list
    .map((row) => {
      const ev = row.event_url != null || row.is_free != null ? mapEventForScore(row) : row;
      const scoredEv = scoreEventForUser(ev, prefs, userDna);
      return Object.assign(ev, {
        summary: ev.summary || ev.description,
        fanDnaScore: scoredEv.fanDnaScore,
        fanDnaPercent: scoredEv.fanDnaPercent,
        matchMethod: scoredEv.matchMethod,
        dnaMatch: scoredEv.dnaMatch,
      });
    })
    .filter((ev) => ev.fanDnaScore != null && ev.fanDnaScore >= minScore)
    .sort((a, b) => b.fanDnaScore - a.fanDnaScore);
}

function scoreEventForUser(ev, prefs, userDna) {
  const eventDna = normalizeDna(ev.event_dna);
  if (userDna && eventDna) {
    const match = calculateDnaMatch(userDna, eventDna);
    return {
      fanDnaScore: match.score,
      fanDnaPercent: match.score != null ? match.score + '%' : '—',
      matchMethod: 'dna',
      dnaMatch: match,
    };
  }
  const legacy = calculateFanDNAScore(ev, prefs);
  return {
    fanDnaScore: legacy,
    fanDnaPercent: legacy + '%',
    matchMethod: 'legacy',
    dnaMatch: null,
  };
}

const EXPLANATION_CACHE_TTL_MS = 30 * 60 * 1000;
const explanationCache = new Map();

function explanationCacheKey(userId, eventId) {
  return String(userId) + ':' + String(eventId);
}

function getCachedExplanation(userId, eventId) {
  if (!userId || !eventId) return null;
  const entry = explanationCache.get(explanationCacheKey(userId, eventId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    explanationCache.delete(explanationCacheKey(userId, eventId));
    return null;
  }
  return entry.text;
}

function setCachedExplanation(userId, eventId, text) {
  if (!userId || !eventId || !text) return;
  explanationCache.set(explanationCacheKey(userId, eventId), {
    text,
    expiresAt: Date.now() + EXPLANATION_CACHE_TTL_MS,
  });
}

function generateFallbackExplanation(matchResult) {
  const overall = matchResult.score != null ? matchResult.score : matchResult.percent;
  const top = (matchResult.traits || [])
    .filter(function (v) {
      return v.percent >= 80;
    })
    .slice(0, 2)
    .map(function (v) {
      return v.label.toLowerCase();
    })
    .join(' and ');

  if (overall >= 80) {
    return (
      'Honestly, this feels like your kind of night' +
      (top ? ' — it plays right into your love of ' + top : '') +
      ". If you've got the evening free, go for it."
    );
  }
  if (overall >= 65) {
    return (
      "There's a lot here you'd enjoy" +
      (top ? ', especially the ' + top + ' side of things' : '') +
      ". Worth grabbing a ticket if the date works for you."
    );
  }
  if (overall >= 50) {
    return "It's a bit of a mixed bag for you — some parts are right up your alley, others less so. Could be fun if you're in the mood to try something a little different.";
  }
  return "This one's a little outside what you usually go for. Might still surprise you, but no pressure if you'd rather hold out for something more your vibe.";
}

async function generateAiMatchExplanation(userDna, eventDna, matchResult, event, userId) {
  const eventId = event.id != null ? String(event.id) : String(event.url || '');
  if (userId && eventId) {
    const cached = getCachedExplanation(userId, eventId);
    if (cached) return cached;
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return generateFallbackExplanation(matchResult);

  const base =
    process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  const model = process.env.DASHSCOPE_MODEL || 'qwen-plus';
  const url = base.replace(/\/$/, '') + '/chat/completions';

  const top3 = (matchResult.traits || [])
    .filter(function (v) {
      return v.percent >= 80;
    })
    .slice(0, 3)
    .map(function (v) {
      return v.label;
    })
    .join(', ');

  const bottom3 = (matchResult.traits || [])
    .filter(function (v) {
      return v.percent < 50;
    })
    .slice(0, 2)
    .map(function (v) {
      return v.label;
    })
    .join(', ');

  const overallMatch = matchResult.score != null ? matchResult.score : matchResult.percent;

  const prompt =
    'You are talking to a friend about whether they\'d enjoy an event. Write a SHORT, warm, personal note (2-3 sentences max, under 55 words) speaking directly to them as "you".\n\n' +
    'Event: ' +
    (event.title || 'Untitled') +
    '\nCategory: ' +
    (event.category || 'General') +
    '\nOverall match: ' +
    overallMatch +
    '%\nThings they tend to love: ' +
    (top3 || 'none') +
    '\nThings that fit less: ' +
    (bottom3 || 'none') +
    '\n\nRules:\n' +
    '- Talk straight to the person using "you" / "your" — never "the user" or "this user"\n' +
    '- Sound like a real friend texting them, casual and genuine — not a marketing blurb or a robot\n' +
    '- Tie it to what THEY personally enjoy (use the strengths above)\n' +
    '- If the match is below 75%, gently mention the trade-off in a human way\n' +
    '- Never use the words "algorithm", "DNA", "profile", "data", "match score", or "based on your preferences"\n' +
    '- No corporate phrases like "highly recommended" or "worth attending based on"\n' +
    '- End with a light, natural nudge (e.g. "go for it", "could be worth a look", "maybe one for another time")\n' +
    '- Max 55 words, no bullet points, no emojis, plain text only';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.6,
      }),
    });
    const data = await response.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

    logApiUsage({
      provider: 'dashscope',
      feature: 'match_explanation',
      model: (data && data.model) || model,
      inputTokens: (data.usage && data.usage.prompt_tokens) || 0,
      outputTokens: (data.usage && data.usage.completion_tokens) || 0,
      success: true,
    }).catch(function () {});

    const explanation = text.trim() || generateFallbackExplanation(matchResult);
    if (userId && eventId) setCachedExplanation(userId, eventId, explanation);
    return explanation;
  } catch (err) {
    return generateFallbackExplanation(matchResult);
  }
}

function attachCachedExplanations(uid, scored) {
  (scored || []).forEach(function (ev) {
    const match = ev.dnaMatch;
    if (!match || !match.complete) return;
    const eventId = ev.id != null ? String(ev.id) : String(ev.url || ev.event_url || '');
    if (!eventId) return;
    const cached = getCachedExplanation(uid, eventId);
    if (cached) match.explanation = cached;
  });
}

function findEventByKey(rows, key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return (
    (rows || []).find(function (ev) {
      const mapped = ev.event_url != null || ev.is_free != null ? mapEventForScore(ev) : ev;
      if (String(mapped.id) === k || String(mapped.url || '') === k || String(mapped.event_url || '') === k) {
        return true;
      }
      return String(ev.id) === k || String(ev.url || ev.event_url || '') === k;
    }) || null
  );
}

async function saveUserPreferences(sb, uid, payload) {
  try {
    return await fanDnaStore.upsertPreferences(sb, uid, payload);
  } catch (e) {
    if (fanDnaStore.isMissingTableError(e)) {
      return authStore.saveFanDnaToProfile(uid, payload);
    }
    throw e;
  }
}

async function resolveEventChatbotByUrl(sb, url) {
  const raw = String(url || '').trim();
  if (!raw || !sb) return null;
  const variants = [raw];
  const noTrail = raw.replace(/\/+$/, '');
  const withTrail = noTrail ? noTrail + '/' : '';
  if (noTrail && noTrail !== raw) variants.push(noTrail);
  if (withTrail && withTrail !== raw) variants.push(withTrail);
  const seen = new Set();
  for (const u of variants) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const { data, error } = await sb
      .from('events_chatbot')
      .select('id, title, source, city, event_url')
      .eq('event_url', u)
      .limit(1);
    if (!error && data && data[0]) return data[0];
  }
  return null;
}

async function fetchEventsForScoring(sb, getMergedScrapedEvents) {
  const { data, error } = await sb
    .from('events_chatbot')
    .select('id, title, description, venue, city, date, price, image_url, event_url, source, category, is_free, event_dna')
    .order('date', { ascending: true })
    .limit(2000);
  if (!error && data && data.length) return data;
  if (error) console.warn('[fan-dna] events_chatbot:', error.message);
  if (typeof getMergedScrapedEvents === 'function') {
    const merged = getMergedScrapedEvents() || [];
    return merged.map(mapScrapedEventForScore);
  }
  return [];
}

async function buildAdminDashboardPayload(sb) {
  const users = (await authStore.listAllUsers()).map((u) => authStore.publicUser(u));
  const prefsList = await fanDnaStore.fetchAllPreferences(sb);
  const prefsByUser = {};
  prefsList.forEach((p) => {
    prefsByUser[p.user_id] = p;
  });
  const clicks = await fanDnaStore.fetchClickStats(sb);
  const clicksByUser = {};
  const clicksByEvent = {};
  clicks.forEach((c) => {
    const uidKey = c.user_id || '(anonymous)';
    if (!clicksByUser[uidKey]) clicksByUser[uidKey] = { total: 0, events: [] };
    clicksByUser[uidKey].total += 1;
    clicksByUser[uidKey].events.push({
      event_id: c.event_id,
      event_name: c.event_name,
      clicked_at: c.clicked_at,
    });
    const eKey = c.event_id || c.event_name || 'unknown';
    clicksByEvent[eKey] = (clicksByEvent[eKey] || 0) + 1;
  });
  const rows = users.map((u) => ({
    user: u,
    preferences: prefsByUser[u.id] || null,
    clickStats: clicksByUser[u.id] || { total: 0, events: [] },
  }));
  return { users: rows, clicksByEvent, totalClicks: clicks.length };
}

async function buildGoliveOverviewData(sb) {
  const usersAll = await authStore.listAllUsers();
  const out = {
    totalRegisteredUsers: usersAll.length,
    totalEventsInDatabase: null,
    totalBookNowClicks: null,
    totalItinerariesGenerated: null,
    mostPopularEventCategory: null,
    mostPopularEventCategoryCount: null,
    activeUsersThisWeek: authStore.countUsersLoggedInWithinDays(usersAll, 7),
    avgTicketBudget: null,
    avgTravelRadiusKm: null,
    popularEventCity: null,
    popularEventCityCount: null,
    supabaseConfigured: Boolean(sb),
  };
  if (sb) {
    const profiles = await fetchProfilesRows(sb);
    if (!profiles.error) {
      out.totalRegisteredUsers = profiles.rows.length;
      out.activeUsersThisWeek = countActiveProfilesWithinDays(profiles.rows, 7);
    } else {
      out.profilesNote = profiles.error;
    }
    const ctEv = await sb.from('events_chatbot').select('id', { count: 'exact', head: true });
    const ctClk = await sb.from('event_clicks').select('id', { count: 'exact', head: true });
    let itinTotal = null;
    try {
      const ctIt = await sb.from('itineraries_generated').select('id', { count: 'exact', head: true });
      if (ctIt.count != null) itinTotal = ctIt.count;
    } catch (e) {
      itinTotal = null;
    }
    out.totalEventsInDatabase = ctEv.count != null ? ctEv.count : null;
    out.totalBookNowClicks = ctClk.count != null ? ctClk.count : null;
    out.totalItinerariesGenerated = itinTotal;
    const cat = await topEventCategoryFromDb(sb);
    out.mostPopularEventCategory = cat.category;
    out.mostPopularEventCategoryCount = cat.category ? cat.count : null;
    if (cat.error) out.categoryNote = cat.error;

    let prefsRows = [];
    try {
      prefsRows = await fanDnaStore.fetchAllPreferences(sb);
      debugPreferenceSamples(prefsRows);
    } catch (e) {
      if (!fanDnaStore.isMissingTableError(e)) out.preferencesNote = e.message || String(e);
      console.log('[admin overview] user_preferences fetch failed:', e.message || String(e));
    }
    const budgetAvg = await averageHotelBudgetFromSelections(sb);
    if (budgetAvg.avgMyr != null) out.avgTicketBudget = 'RM ' + budgetAvg.avgMyr;
    if (budgetAvg.error) out.hotelBudgetNote = budgetAvg.error;
    const travelAvg = averageFanDnaTravelKm(prefsRows);
    if (travelAvg.avgKm != null) out.avgTravelRadiusKm = travelAvg.avgKm + ' km';

    const topCity = await topCityFromEventLocations(sb);
    out.popularEventCity = topCity.city;
    out.popularEventCityCount = topCity.city ? topCity.count : null;
    if (topCity.error) out.popularCityNote = topCity.error;

    const profileRows = !profiles.error ? profiles.rows : [];
    out.economicImpact = {
      eventDrivenTourists: profileRows.length,
      flightSearches: await supabaseTableCount(sb, 'flight_selections'),
      hotelBookings: await supabaseTableCount(sb, 'hotel_selections'),
      avgTouristStayDays: null,
    };
    const stay = await averageHotelStayDays(sb);
    out.economicImpact.avgTouristStayDays = stay.avgDays;
    if (stay.error) out.economicImpact.stayNote = stay.error;

    out.geography = await buildGeographicAnalytics(sb);

    const touristStayDuration = await buildTouristStayDurationChart(sb);
    out.charts = {
      demandVsSupply: await demandVsSupplyChartData(sb, prefsRows),
      eventCategories: await eventCategoriesChartData(sb, 8),
      seasonalArrivals: await buildSeasonalArrivalChart(sb),
      touristStayDuration,
      stayByEventCategory: await buildStayByEventCategoryChart(sb),
      peakActivityTimeline: await buildPeakActivityTimeline(sb),
      categoryAffinity: await buildCategoryAffinityMatrix(sb),
      touristSegments: buildTouristSegmentIntelligence(prefsRows),
      funnel: {
        labels: [
          'Events Browsed',
          'Clicked',
          'Hotel Searched',
          'Flight Searched',
          'Itinerary Saved',
        ],
        values: [
          out.totalEventsInDatabase != null ? out.totalEventsInDatabase : 0,
          out.totalBookNowClicks != null ? out.totalBookNowClicks : 0,
          out.economicImpact.hotelBookings != null ? out.economicImpact.hotelBookings : 0,
          out.economicImpact.flightSearches != null ? out.economicImpact.flightSearches : 0,
          out.totalItinerariesGenerated != null ? out.totalItinerariesGenerated : 0,
        ],
      },
    };
  } else {
    out.economicImpact = {
      eventDrivenTourists: out.totalRegisteredUsers,
      flightSearches: null,
      hotelBookings: null,
      avgTouristStayDays: null,
    };
    out.geography = await buildGeographicAnalytics(null);
    out.charts = {
      demandVsSupply: {
        labels: [],
        demandPct: [],
        supplyPct: [],
        demandUsers: 0,
        supplyEvents: 0,
        error: null,
      },
      eventCategories: { labels: [], values: [] },
      seasonalArrivals: {
        labels: ARRIVAL_MONTH_LABELS.slice(),
        values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        sampleCount: 0,
        peakMonth: null,
        peakCount: 0,
        fromItineraries: 0,
        fromHotels: 0,
        fromFlights: 0,
      },
      touristStayDuration: {
        labels: TOURIST_STAY_BUCKET_LABELS.slice(),
        values: [0, 0, 0, 0, 0, 0],
        avgDays: null,
        medianDays: null,
        sampleCount: 0,
        fromItineraries: 0,
        fromHotels: 0,
        fromFlightTrips: 0,
      },
      stayByEventCategory: {
        labels: [],
        values: [],
        tripCounts: [],
        sampleCount: 0,
        fromItineraries: 0,
        fromHotels: 0,
        fromFlightTrips: 0,
        unresolvedTrips: 0,
        error: null,
      },
      peakActivityTimeline: {
        hourlyData: new Array(24).fill(0),
        weeklyData: [0, 0, 0, 0, 0, 0, 0],
        hourLabels: BROWSING_HOUR_LABELS.slice(),
        dayLabels: DAY_OF_WEEK_LABELS.slice(),
        peakHour: null,
        peakDay: null,
        chatQueryCount: 0,
        eventClickCount: 0,
        errors: { chat: null, clicks: null },
      },
      categoryAffinity: {
        labels: [],
        categoryIds: [],
        matrix: [],
        pairs: [],
        nodes: [],
        links: [],
        categoryClickCounts: [],
        maxCount: 0,
        maxClicks: 0,
        topPair: null,
        multiCategoryUsers: 0,
        totalUsers: 0,
        error: null,
      },
      touristSegments: {
        segments: [],
        totalUsers: 0,
        assignedUsers: 0,
        unassignedUsers: 0,
        error: null,
      },
      funnel: {
        labels: [
          'Events Browsed',
          'Clicked',
          'Hotel Searched',
          'Flight Searched',
          'Itinerary Saved',
        ],
        values: [0, 0, 0, 0, 0],
      },
    };
  }
  return out;
}

async function buildGoliveOverviewInsightsPayload(sb) {
  const usersAll = await authStore.listAllUsers();
  const snapshot = {
    totalRegisteredUsers: usersAll.length,
    totalEventsInDatabase: null,
    totalBookNowClicks: null,
    totalItinerariesGenerated: null,
    activeUsersThisWeek: authStore.countUsersLoggedInWithinDays(usersAll, 7),
    popularEventCity: null,
    avgTicketBudget: null,
    avgTravelRadiusKm: null,
  };
  if (sb) {
    const profiles = await fetchProfilesRows(sb);
    if (!profiles.error) {
      snapshot.totalRegisteredUsers = profiles.rows.length;
      snapshot.activeUsersThisWeek = countActiveProfilesWithinDays(profiles.rows, 7);
    }
    snapshot.totalEventsInDatabase = await supabaseTableCount(sb, 'events_chatbot');
    snapshot.totalBookNowClicks = await supabaseTableCount(sb, 'event_clicks');
    snapshot.totalItinerariesGenerated = await supabaseTableCount(sb, 'itineraries_generated');
    snapshot.flightSearches = await supabaseTableCount(sb, 'flight_selections');
    snapshot.hotelBookings = await supabaseTableCount(sb, 'hotel_selections');
    const topCity = await topCityFromEventLocations(sb);
    snapshot.popularEventCity = topCity.city;
    try {
      const prefsRows = await fanDnaStore.fetchAllPreferences(sb);
      const travelAvg = averageFanDnaTravelKm(prefsRows);
      if (travelAvg.avgKm != null) snapshot.avgTravelRadiusKm = travelAvg.avgKm + ' km';
    } catch (e) {
      /* ignore */
    }
    const budgetAvg = await averageHotelBudgetFromSelections(sb);
    if (budgetAvg.avgMyr != null) snapshot.avgTicketBudget = 'RM ' + budgetAvg.avgMyr;
  }
  return generateTourismInsightsWithClaude(snapshot);
}

async function buildGoliveUsersCachePayload(sb) {
  let rows = [];
  if (sb) {
    const profiles = await fetchProfilesRows(sb);
    if (!profiles.error) {
      rows = profiles.rows.map((p) => ({
        id: p.user_id || '',
        name: String(p.full_name || '').trim(),
        email: p.email || '',
        homeAirport: p.home_airport || null,
        dateJoined: p.created_at || null,
        lastActive: p.last_active || null,
      }));
    } else {
      const rawUsers = await authStore.listAllUsers();
      rows = rawUsers.map((u) => ({
        id: u.id,
        name: ((u.profile && u.profile.displayName) || '').trim(),
        email: u.email || '',
        homeAirport: (u.profile && u.profile.homeIata) || null,
        dateJoined: u.createdAt || null,
        lastActive: ((u.profile && u.profile.updatedAt) || u.createdAt || '').trim() || null,
      }));
    }
  } else {
    const rawUsers = await authStore.listAllUsers();
    rows = rawUsers.map((u) => ({
      id: u.id,
      name: ((u.profile && u.profile.displayName) || '').trim(),
      email: u.email || '',
      homeAirport: (u.profile && u.profile.homeIata) || null,
      dateJoined: u.createdAt || null,
      lastActive: ((u.profile && u.profile.updatedAt) || u.createdAt || '').trim() || null,
    }));
  }
  return { allRows: rows };
}

function paginateGoliveUsers(cached, page, sortKey, sortDir) {
  const rows = (cached.allRows || []).slice();
  const mult = sortDir === 'asc' ? 1 : -1;
  rows.sort(function (a, b) {
    let cmp = 0;
    if (sortKey === 'email') cmp = String(a.email).localeCompare(String(b.email));
    else if (sortKey === 'name') cmp = String(a.name).localeCompare(String(b.name));
    else if (sortKey === 'home') cmp = String(a.homeAirport || '').localeCompare(String(b.homeAirport || ''));
    else if (sortKey === 'joined') cmp = String(a.dateJoined || '').localeCompare(String(b.dateJoined || ''));
    else if (sortKey === 'active') cmp = String(a.lastActive || '').localeCompare(String(b.lastActive || ''));
    else cmp = String(a.email).localeCompare(String(b.email));
    return cmp * mult;
  });
  const total = rows.length;
  const from = (page - 1) * GOLIVE_CONSOLE_PAGE_SIZE;
  return {
    section: 'users',
    page,
    pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / GOLIVE_CONSOLE_PAGE_SIZE)),
    sortKey,
    sortDir,
    rows: rows.slice(from, from + GOLIVE_CONSOLE_PAGE_SIZE),
  };
}

async function buildGoliveFanDnaCachePayload(sb) {
  const prefsList = await fanDnaStore.fetchAllPreferences(sb);
  const idToEmail = {};
  const usersAll = await authStore.listAllUsers();
  usersAll.forEach(function (u) {
    idToEmail[u.id] = u.email || '';
  });
  const allRows = prefsList.map((p) => ({
    email: idToEmail[p.user_id] || p.user_id || '—',
    categories: Array.isArray(p.categories) ? p.categories.join(', ') : '',
    vibes: Array.isArray(p.vibes) ? p.vibes.join(', ') : '',
    budget: p.budget || '—',
    travelDistance: p.travel_distance || '—',
  }));
  allRows.sort(function (a, b) {
    return String(a.email).localeCompare(String(b.email));
  });
  return { allRows };
}

function paginateGoliveFanDna(cached, page) {
  const allRows = cached.allRows || [];
  const total = allRows.length;
  const from = (page - 1) * GOLIVE_CONSOLE_PAGE_SIZE;
  return {
    section: 'fanDna',
    page,
    pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / GOLIVE_CONSOLE_PAGE_SIZE)),
    rows: allRows.slice(from, from + GOLIVE_CONSOLE_PAGE_SIZE),
  };
}

async function buildGoliveClicksCachePayload(sb) {
  const ct = await sb.from('event_clicks').select('*', { count: 'exact', head: true });
  const total = ct.count != null ? ct.count : 0;
  const { data, error } = await sb
    .from('event_clicks')
    .select('*')
    .order('clicked_at', { ascending: false })
    .limit(50000);
  if (error) throw new Error(error.message);
  const userList = await authStore.listAllUsers();
  const idToEmail = {};
  userList.forEach(function (u) {
    idToEmail[u.id] = u.email || '';
  });
  const ids = [...new Set((data || []).map((c) => c.event_id).filter(Boolean))].slice(0, 120);
  const idToSource = {};
  if (ids.length) {
    const { data: evs } = await sb.from('events_chatbot').select('id, source').in('id', ids);
    (evs || []).forEach((e) => {
      idToSource[String(e.id)] = e.source;
    });
  }
  const allRows = (data || []).map((c) => {
    const src = c.event_id && idToSource[String(c.event_id)];
    const platform =
      formatPlatformLabel(src) !== '—' ? formatPlatformLabel(src) : inferPlatformFromClick(c.event_id, c.event_name);
    return {
      userEmail: c.user_id ? idToEmail[c.user_id] || c.user_id : '—',
      eventName: c.event_name || c.event_id || '—',
      platform,
      timestamp: c.clicked_at || null,
    };
  });
  return { total, allRows };
}

function paginateGoliveClicks(cached, page) {
  const allRows = cached.allRows || [];
  const total = cached.total != null ? cached.total : allRows.length;
  const from = (page - 1) * GOLIVE_CONSOLE_PAGE_SIZE;
  return {
    section: 'clicks',
    page,
    pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / GOLIVE_CONSOLE_PAGE_SIZE)),
    rows: allRows.slice(from, from + GOLIVE_CONSOLE_PAGE_SIZE),
  };
}

async function buildGolivePopularCachePayload(sb) {
  const agg = await aggregatePopularEvents(sb, 20);
  if (agg.error) throw new Error(agg.error);
  return { rows: agg.rows };
}

async function buildGoliveItinerariesCachePayload(sb) {
  const usersAll = await authStore.listAllUsers();
  const idToEmail = {};
  usersAll.forEach(function (u) {
    idToEmail[u.id] = u.email || '';
  });

  const probe = await sb.from('itineraries_generated').select('user_id').limit(40000);
  const useUserIdCol = !probe.error && Array.isArray(probe.data);

  let countsByUserAll = [];
  let countsNotice =
    'Add a text column user_id to itineraries_generated and populate it on save to see per-account counts grouped by email.';
  if (!probe.error && Array.isArray(probe.data)) {
    const tally = {};
    probe.data.forEach(function (row) {
      const k = row.user_id != null && String(row.user_id).trim() ? String(row.user_id).trim() : '(anonymous)';
      tally[k] = (tally[k] || 0) + 1;
    });
    countsByUserAll = Object.keys(tally).map(function (key) {
      return {
        userEmail: key === '(anonymous)' ? '(anonymous)' : idToEmail[key] || key,
        itineraryCount: tally[key],
      };
    });
    countsByUserAll.sort(function (a, b) {
      return b.itineraryCount - a.itineraryCount || String(a.userEmail).localeCompare(String(b.userEmail));
    });
    countsNotice = null;
  }

  const head = await sb.from('itineraries_generated').select('id', { count: 'exact', head: true });
  const total = head.count != null ? head.count : 0;
  const sel = useUserIdCol
    ? 'id, user_id, created_at, city, arrival_date, departure_date, payload'
    : 'id, created_at, city, arrival_date, departure_date, payload';
  const { data, error } = await sb
    .from('itineraries_generated')
    .select(sel)
    .order('created_at', { ascending: false })
    .limit(50000);
  if (error) throw new Error(error.message);
  const recentSavesAll = (data || []).map((row) => {
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const ev = p.event && typeof p.event === 'object' ? p.event : {};
    const title = ev.title || ev.name || '—';
    let em = '—';
    if (row.user_id != null && String(row.user_id).trim()) {
      const uid = String(row.user_id).trim();
      em = idToEmail[uid] || uid;
    }
    return {
      userEmail: em,
      savedAt: row.created_at,
      city: row.city || '—',
      arrival: row.arrival_date,
      departure: row.departure_date,
      eventTitle: title,
    };
  });

  return {
    useUserIdCol,
    countsByUserAll,
    countsNotice,
    recentSavesAll,
    total,
    schemaNote:
      'Rows in itineraries_generated are not linked to app user ids today; user email is shown as — until user_id is added to saves.',
  };
}

function paginateGoliveItineraries(cached, userPage, recentPage) {
  const countsAvailable = Array.isArray(cached.countsByUserAll);
  let countsByUser = {
    available: false,
    page: userPage,
    pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    rows: [],
    notice: cached.countsNotice || null,
  };
  if (countsAvailable) {
    const flat = cached.countsByUserAll || [];
    const uTot = flat.length;
    const uFrom = (userPage - 1) * GOLIVE_CONSOLE_PAGE_SIZE;
    countsByUser = {
      available: true,
      page: userPage,
      pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
      total: uTot,
      totalPages: Math.max(1, Math.ceil(uTot / GOLIVE_CONSOLE_PAGE_SIZE)),
      rows: flat.slice(uFrom, uFrom + GOLIVE_CONSOLE_PAGE_SIZE),
      notice: null,
    };
  }
  const total = cached.total != null ? cached.total : (cached.recentSavesAll || []).length;
  const from = (recentPage - 1) * GOLIVE_CONSOLE_PAGE_SIZE;
  return {
    section: 'itineraries',
    userPage,
    recentPage,
    pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
    countsByUser,
    recentSaves: {
      page: recentPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / GOLIVE_CONSOLE_PAGE_SIZE)),
      rows: (cached.recentSavesAll || []).slice(from, from + GOLIVE_CONSOLE_PAGE_SIZE),
    },
    schemaNote: cached.schemaNote || null,
  };
}

async function refreshDashboardCache(sb) {
  const client = sb || createSupabaseForCache();
  if (!client) return { ok: false, error: 'Supabase not configured' };

  const jobs = [
    { section: 'dashboard', run: () => buildAdminDashboardPayload(client) },
    { section: 'overview', run: () => buildGoliveOverviewData(client) },
    { section: 'overview-insights', run: () => buildGoliveOverviewInsightsPayload(client) },
    { section: 'users', run: () => buildGoliveUsersCachePayload(client) },
    { section: 'fandna', run: () => buildGoliveFanDnaCachePayload(client) },
    { section: 'clicks', run: () => buildGoliveClicksCachePayload(client) },
    { section: 'popular', run: () => buildGolivePopularCachePayload(client) },
    { section: 'itineraries', run: () => buildGoliveItinerariesCachePayload(client) },
  ];

  const results = {};
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    try {
      const data = await job.run();
      const saved = await writeDashboardCache(client, job.section, data);
      results[job.section] = saved ? 'ok' : 'save_failed';
    } catch (e) {
      results[job.section] = e.message || String(e);
      console.warn('[admin cache] refresh failed:', job.section, e.message || e);
    }
  }
  return { ok: true, results };
}

// ---- Feature 4: Social Compatibility (Expected Crowd Match) ----
// Minimum distinct interested users (with profile data) before we show real stats.
// Override via CROWD_MIN_SAMPLE in .env (e.g. 1 for local testing).
const CROWD_MIN_SAMPLE = Math.max(1, Number(process.env.CROWD_MIN_SAMPLE) || 5);

function crowdPct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

/** Distinct user_ids who showed interest (clicked) in an event, matched by id/url/name. */
async function fetchInterestedUserIds(sb, keys, eventName) {
  const ids = {};
  async function collect(col, val) {
    if (!val) return;
    const { data, error } = await sb
      .from('event_clicks')
      .select('user_id, click_source, platform')
      .eq(col, val)
      .not('user_id', 'is', null)
      .limit(5000);
    if (error || !data) return;
    data.forEach(function (r) {
      // Book-button only: exclude event opens (hub_open) and other sources.
      if (r.user_id && isOverlayBookClickRow(r)) ids[String(r.user_id)] = true;
    });
  }
  for (let i = 0; i < keys.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await collect('event_id', keys[i]);
  }
  await collect('event_name', eventName);
  return Object.keys(ids);
}

const CROWD_PREF_SELECTS = [
  'user_id, categories, vibes, home_iata, profession, age_group',
  'user_id, categories, vibes, profession, age_group',
  'user_id, categories, vibes',
];

async function fetchPreferencesForUsers(sb, userIds) {
  const rows = [];
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    for (let s = 0; s < CROWD_PREF_SELECTS.length; s += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await sb
        .from('user_preferences')
        .select(CROWD_PREF_SELECTS[s])
        .in('user_id', chunk);
      if (!error) {
        if (data) rows.push.apply(rows, data);
        break;
      }
    }
  }
  return rows;
}

/** Fallback: real users whose Fan DNA lives in profiles.profile_json (not user_preferences). */
async function fetchProfilePrefsForUsers(sb, userIds) {
  const out = [];
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await sb
      .from('profiles')
      .select('user_id, home_airport, profile_json')
      .in('user_id', chunk);
    if (error || !data) continue;
    data.forEach(function (r) {
      const pj = r.profile_json && typeof r.profile_json === 'object' ? r.profile_json : {};
      const fd = pj.fanDna && typeof pj.fanDna === 'object' ? pj.fanDna : {};
      out.push({
        user_id: r.user_id,
        categories: Array.isArray(fd.categories) ? fd.categories : [],
        vibes: Array.isArray(fd.vibes) ? fd.vibes : [],
        home_iata: r.home_airport || fd.home_iata || null,
        profession: fd.profession || null,
        age_group: fd.age_group || null,
      });
    });
  }
  return out;
}

function crowdRowHasSignal(p) {
  if (!p) return false;
  return Boolean(
    p.profession ||
      p.age_group ||
      p.home_iata ||
      (Array.isArray(p.categories) && p.categories.length),
  );
}

function computeCrowdStats(prefsRows, eventCats) {
  const usable = prefsRows.length;
  let students = 0;
  let working = 0;
  let intl = 0;
  let intlDenom = 0;
  let young = 0;
  let ageDenom = 0;
  let similar = 0;
  let similarDenom = 0;

  const catSet = {};
  (eventCats || []).forEach(function (c) {
    catSet[String(c).toLowerCase()] = true;
  });
  const hasEventCats = Object.keys(catSet).length > 0;

  prefsRows.forEach(function (p) {
    const prof = String((p && p.profession) || '').toLowerCase();
    if (prof === 'student') students += 1;
    if (prof === 'working') working += 1;

    const iata = normalizeIataCode(p && p.home_iata);
    if (iata) {
      intlDenom += 1;
      const country = isMalaysianDomesticIata(iata) ? 'Malaysia' : countryFromIata(iata);
      if (country && !/^malaysia$/i.test(country)) intl += 1;
    }

    const age = String((p && p.age_group) || '').toLowerCase();
    if (age) {
      ageDenom += 1;
      if (age === '18_24' || age === '25_34') young += 1;
    }

    if (hasEventCats) {
      similarDenom += 1;
      const cats = Array.isArray(p && p.categories)
        ? p.categories.map(function (c) {
            return String(c).toLowerCase();
          })
        : [];
      if (
        cats.some(function (c) {
          return catSet[c];
        })
      ) {
        similar += 1;
      }
    }
  });

  const stats = [];
  if (similarDenom) stats.push({ id: 'similar', label: 'Similar interests', pct: crowdPct(similar, similarDenom) });
  if (intlDenom) stats.push({ id: 'international', label: 'International visitors', pct: crowdPct(intl, intlDenom) });
  stats.push({ id: 'students', label: 'Students', pct: crowdPct(students, usable) });
  stats.push({ id: 'working', label: 'Working professionals', pct: crowdPct(working, usable) });
  if (ageDenom) stats.push({ id: 'young', label: 'Young crowd (18\u201334)', pct: crowdPct(young, ageDenom) });

  return { usable: usable, stats: stats };
}

function buildCrowdNote(stats, myPrefs) {
  const byId = {};
  (stats || []).forEach(function (s) {
    byId[s.id] = s.pct;
  });
  const myProf = String((myPrefs && myPrefs.profession) || '').toLowerCase();
  if ((byId.similar || 0) >= 60) {
    return 'High probability of meeting people with similar interests.';
  }
  if (myProf === 'student' && (byId.students || 0) >= 40) {
    return 'Lots of students attend \u2014 you\u2019ll fit right in.';
  }
  if ((byId.working || 0) >= 50) {
    return 'Popular with working professionals.';
  }
  if ((byId.international || 0) >= 50) {
    return 'Draws a diverse, international crowd.';
  }
  if ((byId.young || 0) >= 60) {
    return 'Mostly a younger crowd.';
  }
  return 'A mixed crowd from different backgrounds.';
}

function setupFanDnaRoutes(app, deps) {
  const getSessionUserId = deps && deps.getSessionUserId;
  const getMergedScrapedEvents = deps && deps.getMergedScrapedEvents;

  app.get('/api/fan-dna/preferences', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in', preferences: null });
    const sb = db.isConfigured() ? db : null;
    if (!sb) {
      const prefs = await authStore.getFanDnaFromProfile(uid);
      const effectiveUserDna = resolveEffectiveUserDna(prefs);
      return res.json({
        preferences: prefs,
        user_dna: effectiveUserDna,
        complete: fanDnaProfileComplete(prefs),
        storage: 'profile',
      });
    }
    try {
      const prefs = await loadUserPreferences(sb, uid);
      const effectiveUserDna = resolveEffectiveUserDna(prefs);
      return res.json({
        preferences: prefs,
        user_dna: effectiveUserDna,
        complete: fanDnaProfileComplete(prefs),
        storage: prefs && prefs._source === 'profile' ? 'profile' : 'supabase',
      });
    } catch (e) {
      console.error('[fan-dna preferences get]', e.message || e);
      const msg = fanDnaStore.isMissingTableError(e) ? SUPABASE_TABLE_HINT : 'Could not load preferences';
      return res.status(500).json({ error: msg, preferences: null });
    }
  });

  app.post('/api/fan-dna/preferences', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    const sb = db.isConfigured() ? db : null;
    try {
      const me = await authStore.findById(uid);
      const profileHomeIata =
        me && me.profile && typeof me.profile.homeIata === 'string'
          ? String(me.profile.homeIata).trim().toUpperCase().slice(0, 3)
          : '';
      const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
      const payload = fanDnaStore.sanitizeFanDnaPayload(
        Object.assign({}, rawBody, {
          home_iata: Object.prototype.hasOwnProperty.call(rawBody, 'home_iata')
            ? rawBody.home_iata
            : profileHomeIata,
        }),
      );
      fanDnaStore.validateFanDnaPayload(payload);
      const manualDna =
        rawBody.user_dna && typeof rawBody.user_dna === 'object'
          ? normalizeDna(rawBody.user_dna)
          : null;
      const userDnaFinal = manualDna || normalizeDna(convertPreferencesToDNA(payload));
      const payloadWithDna = Object.assign({}, payload, {
        user_dna: userDnaFinal,
        user_dna_custom: Boolean(manualDna),
      });
      if (!sb) {
        const saved = await authStore.saveFanDnaToProfile(uid, payloadWithDna);
        return res.json({
          preferences: saved,
          user_dna: userDnaFinal,
          user_dna_custom: Boolean(manualDna),
          complete: true,
          storage: 'profile',
        });
      }
      let saved;
      try {
        saved = await authStore.saveFanDnaToProfile(uid, payloadWithDna);
      } catch (mirrorErr) {
        console.error('[fan-dna] profile mirror save failed:', mirrorErr.message || mirrorErr);
        throw mirrorErr;
      }
      saved = await saveUserPreferences(sb, uid, payloadWithDna);
      const profileMirror = await authStore.getFanDnaFromProfile(uid);
      saved = mergeProfileDnaIntoPrefs(saved || {}, profileMirror) || saved;
      return res.json({
        preferences: saved,
        user_dna: userDnaFinal,
        user_dna_custom: Boolean(manualDna),
        complete: true,
        storage: saved && saved._source === 'profile' ? 'profile' : 'supabase',
      });
    } catch (e) {
      if (e && e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      console.error('[fan-dna preferences post]', e.message || e);
      const msg = fanDnaStore.isMissingTableError(e) ? SUPABASE_TABLE_HINT : e.message || 'Could not save preferences';
      return res.status(500).json({ error: msg });
    }
  });

  app.get('/api/event/crowd-match', async (req, res) => {
    const sb = db.isConfigured() ? db : null;
    const uid = getSessionUserId(req);
    const eventId = String(req.query.eventId || req.query.id || '').trim();
    const eventUrl = String(req.query.url || '').trim();
    const eventName = String(req.query.name || req.query.title || '').trim();
    const category = String(req.query.category || '').trim();

    if (!eventId && !eventUrl && !eventName) {
      return res.status(400).json({ error: 'Missing event', enoughData: false });
    }
    if (!sb) {
      return res.json({ enoughData: false, interested: 0, sample: 0, stats: [], reason: 'no_db' });
    }

    try {
      const keys = [eventId, eventUrl].filter(Boolean);
      const userIds = await fetchInterestedUserIds(sb, keys, eventName);
      const interested = userIds.length;
      if (interested < CROWD_MIN_SAMPLE) {
        return res.json({ enoughData: false, interested: interested, sample: 0, stats: [], min: CROWD_MIN_SAMPLE });
      }
      const prefsRows = await fetchPreferencesForUsers(sb, userIds);
      const haveIds = {};
      prefsRows.forEach(function (r) {
        if (r && r.user_id) haveIds[String(r.user_id)] = true;
      });
      const missingIds = userIds.filter(function (u) {
        return !haveIds[String(u)];
      });
      let profileRows = [];
      if (missingIds.length) {
        profileRows = await fetchProfilePrefsForUsers(sb, missingIds);
      }
      const mergedRows = prefsRows.concat(profileRows).filter(crowdRowHasSignal);
      if (mergedRows.length < CROWD_MIN_SAMPLE) {
        return res.json({
          enoughData: false,
          interested: interested,
          sample: mergedRows.length,
          stats: [],
          min: CROWD_MIN_SAMPLE,
        });
      }
      let eventCats = [];
      try {
        eventCats = inferEventCategories({ title: eventName, category: category }) || [];
      } catch (e) {
        eventCats = [];
      }
      const computed = computeCrowdStats(mergedRows, eventCats);
      let myPrefs = null;
      if (uid) {
        try {
          myPrefs = await loadUserPreferences(sb, uid);
        } catch (e) {
          myPrefs = null;
        }
      }
      const note = buildCrowdNote(computed.stats, myPrefs);
      res.set('Cache-Control', 'private, max-age=120');
      return res.json({
        enoughData: true,
        interested: interested,
        sample: computed.usable,
        stats: computed.stats,
        note: note,
      });
    } catch (e) {
      console.error('[event crowd-match]', e.message || e);
      if (fanDnaStore.isMissingTableError(e)) {
        return res.json({ enoughData: false, interested: 0, sample: 0, stats: [], reason: 'no_table' });
      }
      return res.status(500).json({ error: 'Could not compute crowd match', enoughData: false });
    }
  });

  // Lightweight update of just the crowd-signal fields (profession + age group).
  app.post('/api/fan-dna/crowd-profile', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    const sb = db.isConfigured() ? db : null;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const clean = fanDnaStore.sanitizeFanDnaPayload({
      profession: body.profession,
      age_group: body.age_group,
    });
    if (!clean.profession && !clean.age_group) {
      return res.status(400).json({ error: 'Pick your profession and age group.' });
    }
    try {
      let existing = sb ? await loadUserPreferences(sb, uid) : await authStore.getFanDnaFromProfile(uid);
      existing = existing && typeof existing === 'object' ? existing : {};
      const payload = Object.assign({}, existing, {
        profession: clean.profession,
        age_group: clean.age_group,
      });
      // Always mirror to profile so answers survive even if Supabase columns are missing.
      try {
        await authStore.saveFanDnaToProfile(uid, payload);
      } catch (mirrorErr) {
        console.warn('[crowd-profile] profile mirror failed:', mirrorErr.message || mirrorErr);
      }
      if (sb) {
        await saveUserPreferences(sb, uid, payload);
      }
      return res.json({ ok: true, profession: clean.profession, age_group: clean.age_group });
    } catch (e) {
      console.error('[crowd-profile]', e.message || e);
      return res.status(500).json({ error: 'Could not save your answers' });
    }
  });

  app.get('/api/fan-dna/scores', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in', scores: {}, events: [] });
    const sb = db.isConfigured() ? db : null;
    try {
      const prefs = sb ? await loadUserPreferences(sb, uid) : await authStore.getFanDnaFromProfile(uid);
      if (!fanDnaProfileComplete(prefs)) {
        return res.json({ complete: false, scores: {}, events: [], preferences: prefs });
      }
      const userDna = resolveEffectiveUserDna(prefs);
      const rows = sb ? await fetchEventsForScoring(sb, getMergedScrapedEvents) : [];
      const scored = buildScoredEventsList(prefs, userDna, rows, getMergedScrapedEvents, 0);
      attachCachedExplanations(uid, scored);
      const scores = {};
      scored.forEach((ev) => {
        const entry = {
          fanDnaScore: ev.fanDnaScore,
          fanDnaPercent: ev.fanDnaPercent,
          matchMethod: ev.matchMethod,
          dnaMatch: ev.dnaMatch,
        };
        if (ev.id != null) scores[String(ev.id)] = entry;
        const u = ev.url || ev.event_url;
        if (u) scores[String(u)] = entry;
      });
      return res.json({ complete: true, scores: scores, events: scored, user_dna: userDna });
    } catch (e) {
      console.error('[fan-dna scores]', e.message || e);
      return res.status(500).json({ error: e.message || 'Could not score events', scores: {}, events: [] });
    }
  });

  app.get('/api/fan-dna/match-explanation', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    const key = String(req.query.eventId || req.query.url || '').trim();
    if (!key) return res.status(400).json({ error: 'eventId or url required' });

    const cached = getCachedExplanation(uid, key);
    if (cached) return res.json({ explanation: cached });

    const sb = db.isConfigured() ? db : null;
    try {
      const prefs = sb ? await loadUserPreferences(sb, uid) : await authStore.getFanDnaFromProfile(uid);
      if (!fanDnaProfileComplete(prefs)) {
        return res.json({ complete: false, explanation: '' });
      }
      const userDna = resolveEffectiveUserDna(prefs);
      const rows = sb ? await fetchEventsForScoring(sb, getMergedScrapedEvents) : [];
      let list = rows.length ? rows : (typeof getMergedScrapedEvents === 'function' ? getMergedScrapedEvents() || [] : []);
      const raw = findEventByKey(list, key);
      if (!raw) return res.status(404).json({ error: 'Event not found' });
      const ev = raw.event_url != null || raw.is_free != null ? mapEventForScore(raw) : raw;
      const scored = scoreEventForUser(ev, prefs, userDna);
      const match = scored.dnaMatch;
      if (!match || !match.complete) {
        return res.json({ complete: false, explanation: '' });
      }
      const eventDna = normalizeDna(ev.event_dna);
      const explanation = await generateAiMatchExplanation(userDna, eventDna, match, ev, uid);
      return res.json({ complete: true, explanation: explanation });
    } catch (e) {
      console.error('[fan-dna match-explanation]', e.message || e);
      return res.status(500).json({ error: e.message || 'Could not generate explanation' });
    }
  });

  app.get('/api/fan-dna/matches', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in', events: [] });
    const sb = db.isConfigured() ? db : null;
    const minScore = Math.max(0, Math.min(100, parseInt(String(req.query.minScore || '60'), 10) || 60));
    try {
      const prefs = sb ? await loadUserPreferences(sb, uid) : await authStore.getFanDnaFromProfile(uid);
      if (!fanDnaProfileComplete(prefs)) {
        return res.json({ complete: false, events: [], preferences: prefs });
      }
      const userDna = resolveEffectiveUserDna(prefs);
      const rows = sb ? await fetchEventsForScoring(sb, getMergedScrapedEvents) : [];
      const scored = buildScoredEventsList(prefs, userDna, rows, getMergedScrapedEvents, minScore);
      return res.json({ complete: true, events: scored, preferences: prefs, user_dna: userDna, minScore });
    } catch (e) {
      console.error('[fan-dna matches]', e.message || e);
      const msg = fanDnaStore.isMissingTableError(e) ? SUPABASE_TABLE_HINT : e.message || 'Could not load matches';
      return res.status(500).json({ error: msg, events: [] });
    }
  });

  app.get('/api/events/resolve-by-url', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url query param required' });
    const sb = db.isConfigured() ? db : null;
    if (!sb) return res.status(503).json({ error: 'Database not configured' });
    try {
      const row = await resolveEventChatbotByUrl(sb, url);
      if (!row) {
        return res.json({ id: null, title: null, city: null, platform: null, source: null });
      }
      const platform = row.source || null;
      return res.json({
        id: row.id,
        title: row.title || null,
        city: row.city || null,
        platform,
        source: platform,
      });
    } catch (e) {
      console.error('[resolve-by-url]', e.message || e);
      return res.status(500).json({ error: 'Could not resolve event' });
    }
  });

  app.post('/api/fan-dna/click', async (req, res) => {
    const uid = getSessionUserId(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sb = db.isConfigured() ? db : null;
    if (!sb) return res.json({ ok: true, skipped: true });
    try {
      await fanDnaStore.logEventClick(sb, {
        user_id: uid || null,
        event_id: String(body.eventId || body.event_id || '').trim() || null,
        event_name: String(body.eventName || body.event_name || '').trim().slice(0, 500) || null,
        city: String(body.city || body.eventCity || '').trim().slice(0, 120) || null,
        platform: String(body.platform || body.source || '').trim().slice(0, 80) || null,
        click_source: String(body.clickSource || body.click_source || '').trim().slice(0, 40) || null,
      });
      return res.json({ ok: true });
    } catch (e) {
      if (fanDnaStore.isMissingClicksTableError(e)) return res.json({ ok: true, skipped: true });
      console.error('[fan-dna click]', e.message || e);
      return res.status(500).json({ error: 'Could not log click' });
    }
  });

  app.post('/api/fan-dna/flight-selection', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.json({ ok: true, skipped: true });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sb = db.isConfigured() ? db : null;
    if (!sb) return res.json({ ok: true, skipped: true });
    try {
      await selectionStore.logFlightSelection(sb, {
        user_id: uid,
        event_id: String(body.eventId || body.event_id || '').trim() || null,
        origin_airport: String(body.originAirport || body.origin_airport || '').trim() || null,
        destination_city: String(body.destinationCity || body.destination_city || body.city || '').trim() || null,
        flight_date: String(body.flightDate || body.flight_date || '').slice(0, 10) || null,
      });
      return res.json({ ok: true });
    } catch (e) {
      if (selectionStore.isMissingTableError(e)) return res.json({ ok: true, skipped: true });
      console.error('[fan-dna flight-selection]', e.message || e);
      return res.status(500).json({ error: 'Could not log flight selection' });
    }
  });

  app.post('/api/fan-dna/hotel-selection', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.json({ ok: true, skipped: true });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sb = db.isConfigured() ? db : null;
    if (!sb) return res.json({ ok: true, skipped: true });
    try {
      await selectionStore.logHotelSelection(sb, {
        user_id: uid,
        event_id: String(body.eventId || body.event_id || '').trim() || null,
        hotel_name: String(body.hotelName || body.hotel_name || body.name || '').trim() || null,
        hotel_price: body.hotelPrice != null ? body.hotelPrice : body.hotel_price != null ? body.hotel_price : body.price,
        hotel_price_numeric:
          body.hotelPriceNumeric != null
            ? body.hotelPriceNumeric
            : body.hotel_price_numeric != null
              ? body.hotel_price_numeric
              : null,
        check_in: String(body.checkIn || body.check_in || '').slice(0, 10) || null,
        check_out: String(body.checkOut || body.check_out || '').slice(0, 10) || null,
        city: String(body.city || '').trim() || null,
      });
      return res.json({ ok: true });
    } catch (e) {
      if (selectionStore.isMissingTableError(e)) return res.json({ ok: true, skipped: true });
      console.error('[fan-dna hotel-selection]', e.message || e);
      return res.status(500).json({ error: 'Could not log hotel selection' });
    }
  });

  app.get('/api/admin/dashboard', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    if (!(await isAdminUser(uid))) return res.status(403).json({ error: 'Admin access required' });
    const sb = db.isConfigured() ? db : null;
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const payload = await getOrComputeDashboardCache(sb, 'dashboard', function () {
        return buildAdminDashboardPayload(sb);
      });
      return res.json(payload);
    } catch (e) {
      console.error('[admin dashboard]', e.message || e);
      return res.status(500).json({ error: e.message || 'Could not load admin data' });
    }
  });

  const COUNTRIES_GEOJSON_UPSTREAM =
    'https://cdn.jsdelivr.net/gh/datasets/geo-countries@master/data/countries.geojson';
  let countriesGeoJsonServerCache = null;
  let countriesGeoJsonServerPromise = null;

  app.get('/api/admin/countries-geojson', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    if (!(await isGoLiveAdminUser(uid))) return res.status(403).json({ error: 'Admin access denied' });
    try {
      if (!countriesGeoJsonServerCache) {
        countriesGeoJsonServerPromise =
          countriesGeoJsonServerPromise ||
          fetch(COUNTRIES_GEOJSON_UPSTREAM).then(async (r) => {
            if (!r.ok) throw new Error('Upstream GeoJSON unavailable (' + r.status + ')');
            return r.json();
          });
        countriesGeoJsonServerCache = await countriesGeoJsonServerPromise;
      }
      res.set('Cache-Control', 'public, max-age=86400');
      return res.json(countriesGeoJsonServerCache);
    } catch (e) {
      console.error('[admin countries-geojson]', e.message || e);
      return res.status(502).json({ error: e.message || 'Could not load countries map data' });
    }
  });

  /**
   * GoLive admin console JSON API (dashboard at /admin.html).
   */
  app.get('/api/admin/golive', async (req, res) => {
    const uid = getSessionUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not signed in' });
    if (!(await isGoLiveAdminUser(uid))) return res.status(403).json({ error: 'Admin access denied' });

    const sb = db.isConfigured() ? db : null;
    const section = String(req.query.section || 'overview').toLowerCase().replace(/\s+/g, '');
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const sortKey = String(req.query.sort || 'email').toLowerCase();
    const sortDir = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

    try {
      if (section === 'overview') {
        const data = await getOrComputeDashboardCache(sb, 'overview', function () {
          return buildGoliveOverviewData(sb);
        });
        return res.json({ section: 'overview', data });
      }

      if (section === 'overview-insights') {
        const generated = await getOrComputeDashboardCache(sb, 'overview-insights', function () {
          return buildGoliveOverviewInsightsPayload(sb);
        });
        return res.json({
          section: 'overview-insights',
          insights: generated.insights,
          source: generated.source,
        });
      }

      if (section === 'users') {
        const cached = await getOrComputeDashboardCache(sb, 'users', function () {
          return buildGoliveUsersCachePayload(sb);
        });
        return res.json(paginateGoliveUsers(cached, page, sortKey, sortDir));
      }

      if (section === 'fandna' || section === 'fan-dna') {
        if (!sb) {
          return res.json({
            section: 'fanDna',
            page,
            pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
            total: 0,
            totalPages: 1,
            rows: [],
            notice: 'Supabase not configured — cannot load user_preferences.',
          });
        }
        try {
          const cached = await getOrComputeDashboardCache(sb, 'fandna', function () {
            return buildGoliveFanDnaCachePayload(sb);
          });
          return res.json(paginateGoliveFanDna(cached, page));
        } catch (err) {
          return res.status(503).json({
            error:
              fanDnaStore.isMissingTableError(err) ? SUPABASE_TABLE_HINT : err.message || 'Could not load preferences',
          });
        }
      }

      if (section === 'clicks') {
        if (!sb) {
          return res.json({
            section: 'clicks',
            page,
            pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
            total: 0,
            rows: [],
            notice: 'Supabase not configured.',
          });
        }
        const cached = await getOrComputeDashboardCache(sb, 'clicks', function () {
          return buildGoliveClicksCachePayload(sb);
        });
        return res.json(paginateGoliveClicks(cached, page));
      }

      if (section === 'popular') {
        if (!sb) {
          return res.json({ section: 'popular', rows: [], notice: 'Supabase not configured.' });
        }
        const cached = await getOrComputeDashboardCache(sb, 'popular', function () {
          return buildGolivePopularCachePayload(sb);
        });
        return res.json({ section: 'popular', rows: cached.rows || [] });
      }

      if (section === 'itineraries') {
        if (!sb) {
          return res.json({
            section: 'itineraries',
            page,
            pageSize: GOLIVE_CONSOLE_PAGE_SIZE,
            total: 0,
            rows: [],
            notice: 'Supabase not configured.',
            schemaNote:
              'Rows in itineraries_generated are not linked to app user ids today; user email is shown as — until user_id is added to saves.',
          });
        }
        const userPage = Math.max(1, parseInt(String(req.query.userPage || page || '1'), 10) || 1);
        const recentPage = Math.max(1, parseInt(String(req.query.recentPage || '1'), 10) || 1);
        const cached = await getOrComputeDashboardCache(sb, 'itineraries', function () {
          return buildGoliveItinerariesCachePayload(sb);
        });
        return res.json(paginateGoliveItineraries(cached, userPage, recentPage));
      }

      if (section === 'api-usage' || section === 'apiusage') {
        if (!sb) {
          return res.json({ section: 'api-usage', data: { empty: true, notice: 'Supabase not configured.' } });
        }
        const data = await buildApiUsagePayload(sb);
        return res.json({ section: 'api-usage', data });
      }

      return res.status(400).json({ error: 'Unknown section' });
    } catch (e) {
      console.error('[admin golive]', e.message || e);
      return res.status(500).json({ error: e.message || 'Console error' });
    }
  });
}

module.exports = {
  setupFanDnaRoutes,
  isAdminUser,
  isGoLiveAdminUser,
  refreshDashboardCache,
};
