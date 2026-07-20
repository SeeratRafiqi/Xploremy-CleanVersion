'use strict';

/**
 * Upload scraped event JSON files into Postgres table `events_chatbot`.
 * Uses ./db (DATABASE_URL). Migrated off Supabase.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs-extra');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');

const SOURCES = [
  { file: 'eventbrite-events.json', source: 'eventbrite', label: 'Eventbrite' },
  { file: 'ticket2u-events.json', source: 'ticket2u', label: 'Ticket2U' },
  { file: 'goliveasia-events.json', source: 'goliveasia', label: 'GoLive Asia' },
  { file: 'ticketmelon-events.json', source: 'ticketmelon', label: 'Ticketmelon' },
];

const CHUNK_SIZE = 200;

/** All `events_chatbot.id` values for a source. */
async function fetchEventIdsForSource(dbClient, source) {
  const rows = await dbClient.queryAll('SELECT id FROM events_chatbot WHERE source = $1', [source]);
  return rows.map((r) => r.id).filter((id) => id != null);
}

const VENUE_CITY_KEYWORDS = [
  { re: /\bjohor\b/i, city: 'Johor Bahru' },
  { re: /\bpenang\b|george\s*town|pulau\s*pinang/i, city: 'Pulau Pinang' },
  { re: /\bsabah\b/i, city: 'Kota Kinabalu' },
  { re: /\bsarawak\b/i, city: 'Kuching' },
];

function cityFromVenueKeywords(venue) {
  const v = String(venue || '').trim();
  if (!v) return 'Kuala Lumpur';
  for (let i = 0; i < VENUE_CITY_KEYWORDS.length; i++) {
    if (VENUE_CITY_KEYWORDS[i].re.test(v)) return VENUE_CITY_KEYWORDS[i].city;
  }
  return 'Kuala Lumpur';
}

const ALLOWED_CATEGORIES = [
  'Music',
  'Sports Event',
  'Business & Professional',
  'Science & Technology',
  'Health & Wellness',
  'Arts & Culture',
  'Food & Drink',
  'Entertainment',
  'Education',
  'Networking',
];

/** First match wins — list more specific rules before broader ones. */
const CATEGORY_KEYWORD_RULES = [
  {
    category: 'Music',
    re: /\b(concert|concerts|tour\b|live\s+(show|music|band)|festival|gig\b|gigs\b|dj\b|orchestra|symphony|album|singer|band\b|k-?pop|pop\s+night|music\s+fest)/i,
  },
  {
    category: 'Sports Event',
    re: /\b(marathon|football|soccer|rugby|badminton|tennis|fitness|run\b|running|cycling|triathlon|championship|league|match\b|tournament|futsal|basketball|volleyball|golf\b|swim|sport\b|sports\b)/i,
  },
  {
    category: 'Food & Drink',
    re: /\b(food|culinary|dining|brunch|wine|beer|coffee|baking|cook(ing|ery)|restaurant|tasting|buffet|kopitiam|food\s+fest|foodie)/i,
  },
  {
    category: 'Arts & Culture',
    re: /\b(art\b|exhibition|gallery|museum|theatre|theater|dance\b|ballet|cultural|heritage|craft\b|photography|film\b|cinema|performing\s+arts)/i,
  },
  {
    category: 'Science & Technology',
    re: /\b(tech\b|technology|hackathon|developer|startup|innovation|robotics|data\s+science|digital|cyber|software|engineering|ai\b|artificial\s+intelligence|coding)/i,
  },
  {
    category: 'Health & Wellness',
    re: /\b(health|wellness|yoga|meditation|mental\s+health|nutrition|therapy|clinic|medical|pilates|wellbeing|well-being)/i,
  },
  {
    category: 'Education',
    re: /\b(education|course\b|class\b|training|bootcamp|tutorial|exam|university|school|learning|tuition|masterclass|lecture\b|academic)/i,
  },
  {
    category: 'Networking',
    re: /\b(networking|meetup|mixer|community\s+gathering|biz\s*match|connect\s+with)/i,
  },
  {
    category: 'Business & Professional',
    re: /\b(workshop|seminar|conference|summit|talk\b|forum|corporate|business|professional|entrepreneur|trade\s+(show|fair)|expo\b|career|marketing|sales|leadership|biz\s*day|sme\b)/i,
  },
  {
    category: 'Entertainment',
    re: /\b(entertainment|comedy|stand[- ]?up|magic\b|circus|game\s+show|variety|fun\s+fair|carnival|party\b|club\s+night|nightlife)/i,
  },
];

function normalizeEventCity(city, venue) {
  const raw = String(city || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'wp kuala lumpur') return 'Kuala Lumpur';
  if (lower === 'bukit jalil') return 'Kuala Lumpur';
  if (lower === 'wp putrajaya') return 'Putrajaya';
  if (lower === 'malaysia' || lower === 'outside malaysia') {
    return cityFromVenueKeywords(venue);
  }
  return raw;
}

function inferCategoryFromText(title, venue, description) {
  const blob = [title, venue, description].filter(Boolean).join(' ');
  if (!String(blob).trim()) return null;
  for (let i = 0; i < CATEGORY_KEYWORD_RULES.length; i++) {
    if (CATEGORY_KEYWORD_RULES[i].re.test(blob)) return CATEGORY_KEYWORD_RULES[i].category;
  }
  return null;
}

function normalizeEventCategory(category, title, venue, description) {
  const cat = category != null && String(category).trim() !== '' ? String(category).trim() : null;
  if (cat) return cat;
  const inferred = inferCategoryFromText(title, venue, description);
  if (inferred && ALLOWED_CATEGORIES.includes(inferred)) return inferred;
  return null;
}

/**
 * Normalize scraped event fields before events_chatbot insert (city + category).
 */
function normalizeEventData(event) {
  const e = event && typeof event === 'object' ? { ...event } : {};
  e.city = normalizeEventCity(e.city, e.venue);
  e.category = normalizeEventCategory(e.category, e.title, e.venue, e.summary ?? e.description);
  return e;
}

function mapEventToRow(event, source) {
  const normalized = normalizeEventData(event);
  const city = normalized.city;
  const category = normalized.category;
  return {
    title: normalized.title ?? null,
    description: normalized.summary != null ? String(normalized.summary) : null,
    venue: normalized.venue ?? null,
    city: city != null && String(city).trim() !== '' ? String(city) : null,
    date: normalized.date != null && String(normalized.date).trim() !== '' ? String(normalized.date) : null,
    price: normalized.price != null && String(normalized.price).trim() !== '' ? String(normalized.price) : null,
    image_url: normalized.image != null && String(normalized.image).trim() !== '' ? String(normalized.image) : null,
    event_url: normalized.url != null && String(normalized.url).trim() !== '' ? String(normalized.url) : null,
    source,
    category,
    is_free: Boolean(normalized.isFree),
  };
}

async function fetchExistingDnaForSource(dbClient, source) {
  const dnaMap = {};
  const rows = await dbClient.queryAll(
    'SELECT event_url, event_dna FROM events_chatbot WHERE source = $1',
    [source],
  );
  for (const row of rows) {
    if (
      row.event_url &&
      row.event_dna &&
      typeof row.event_dna === 'object' &&
      Object.keys(row.event_dna).length > 0
    ) {
      dnaMap[row.event_url] = row.event_dna;
    }
  }
  return dnaMap;
}

async function restoreEventDna(dbClient, dnaMap) {
  const toRestore = Object.entries(dnaMap);
  for (const [eventUrl, dna] of toRestore) {
    try {
      await dbClient.query(
        'UPDATE events_chatbot SET event_dna = $1 WHERE event_url = $2',
        [JSON.stringify(dna), eventUrl],
      );
    } catch (error) {
      console.warn(`[DNA] Restore failed for ${eventUrl}:`, error.message);
    }
  }
  if (toRestore.length) {
    console.log(`[DNA] Restored ${toRestore.length} existing event_dna values after scrape`);
  }
}

const EVENT_INSERT_COLUMNS = [
  'title', 'description', 'venue', 'city', 'date',
  'price', 'image_url', 'event_url', 'source', 'category', 'is_free',
];

async function insertRows(dbClient, rows) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    // Build one multi-row parameterized INSERT: VALUES ($1,$2,...), ($12,$13,...), ...
    const tuples = [];
    const params = [];
    let p = 1;
    for (const row of chunk) {
      tuples.push(`(${EVENT_INSERT_COLUMNS.map(() => `$${p++}`).join(', ')})`);
      for (const col of EVENT_INSERT_COLUMNS) params.push(row[col]);
    }
    const sql =
      `INSERT INTO events_chatbot (${EVENT_INSERT_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`;
    await dbClient.query(sql, params);
  }
}

const DELETE_CHUNK = 500;

/**
 * Replace all rows for one source so scheduled re-uploads do not duplicate events.
 * Removes matching embedding rows first (if FK does not cascade).
 */
async function replaceSourceRows(dbClient, source, rows) {
  const dnaMap = await fetchExistingDnaForSource(dbClient, source);
  const ids = await fetchEventIdsForSource(dbClient, source);
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const slice = ids.slice(i, i + DELETE_CHUNK);
    if (!slice.length) continue;
    try {
      await dbClient.query('DELETE FROM event_embeddings_chatbot WHERE event_id = ANY($1::int[])', [slice]);
    } catch (embErr) {
      throw new Error(
        `event_embeddings_chatbot delete (${source}): ${embErr.message}. ` +
          `Fix DB constraints so embeddings can be removed before replacing events.`,
      );
    }
  }
  await dbClient.query('DELETE FROM events_chatbot WHERE source = $1', [source]);
  if (rows.length) await insertRows(dbClient, rows);
  await restoreEventDna(dbClient, dnaMap);
}

async function uploadToSupabase() {
  console.log('Uploading events to Postgres...');
  let total = 0;

  for (const { file, source, label } of SOURCES) {
    const filePath = path.join(DATA_DIR, file);
    if (!(await fs.pathExists(filePath))) {
      console.log(`Skipping missing file: ${file}`);
      continue;
    }

    const raw = await fs.readJson(filePath);
    if (!Array.isArray(raw)) {
      console.log(`Skipping (not a JSON array): ${file}`);
      continue;
    }

    const rows = raw.map((e) => mapEventToRow(e, source));
    await replaceSourceRows(db, source, rows);
    const n = rows.length;
    total += n;
    console.log(`Uploaded ${n} events from ${label}`);
  }

  console.log(`Done! Total ${total} events uploaded`);
  return { total };
}

if (require.main === module) {
  uploadToSupabase().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  uploadToSupabase,
  normalizeEventData,
  normalizeEventCity,
  normalizeEventCategory,
  inferCategoryFromText,
  cityFromVenueKeywords,
};
