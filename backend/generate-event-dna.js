'use strict';

require('dotenv').config();

const db = require('./db');
const { logApiUsage } = require('./api-usage-logger');

const DNA_KEYS = [
  'social',
  'entertainment',
  'educational',
  'budget_friendly',
  'outdoor',
  'energy_level',
  'family_friendly',
  'networking',
];

function getDashScopeConfig() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const base =
    process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  const model = process.env.DASHSCOPE_MODEL || 'qwen-plus';
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  return { apiKey, model, url };
}

function buildEventDnaPrompt(event) {
  return `You are an event analyst. Score this event on exactly these 8 variables from 1-10 based on its title, description, category and price.

Event title: ${event.title}
Event description: ${(event.description || '').slice(0, 500)}
Event category: ${event.category}
Event price: ${event.price}
Event venue: ${event.venue}

Score these 8 variables from 1 (very low) to 10 (very high):
- social: how much social interaction / meeting people
- entertainment: how fun and enjoyable vs dry/educational
- educational: how much learning/knowledge is gained
- budget_friendly: affordability (10=free, 1=very expensive)
- outdoor: how outdoor the experience is (10=fully outdoor, 1=fully indoor)
- energy_level: how high-energy/active vs relaxed/chill (10=very active)
- family_friendly: suitable for all ages (10=great for families, 1=adults only)
- networking: professional networking value (10=high, 1=none)

Respond with ONLY a raw JSON object, no markdown, no backticks, no explanation. Example format:
{"social":7,"entertainment":6,"educational":4,"budget_friendly":9,"outdoor":2,"energy_level":5,"family_friendly":6,"networking":7}`;
}

function stripMarkdownFences(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return s.trim();
}

function validateDnaScores(parsed) {
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  const out = {};
  for (const key of DNA_KEYS) {
    const n = Number(src[key]);
    out[key] = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5;
  }
  return out;
}

function parseDnaFromModelText(rawText) {
  const cleaned = stripMarkdownFences(rawText);
  const parsed = JSON.parse(cleaned);
  return validateDnaScores(parsed);
}

async function fetchUnprocessedEvents() {
  const allEvents = await db.queryAll(
    'SELECT id, title, description, category, price, venue, event_dna FROM events_chatbot',
  );

  const events = allEvents.filter(
    (e) => !e.event_dna || Object.keys(e.event_dna).length === 0,
  );

  console.log(`[EventDNA] Found ${events.length} events to process out of ${allEvents.length} total`);

  return events.map(({ event_dna: _dna, ...rest }) => rest);
}

async function callDashScopeForEvent(event, dash) {
  const prompt = buildEventDnaPrompt(event);
  const response = await fetch(dash.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dash.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: dash.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error)) ||
      `DashScope HTTP ${response.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  const rawText = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!rawText) throw new Error('Empty model response');
  logApiUsage({
    provider: 'dashscope',
    feature: 'event_dna',
    model: data.model || dash.model,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    success: true
  }).catch(() => {});
  return parseDnaFromModelText(rawText);
}

async function generateAllEventDNA() {
  const dash = getDashScopeConfig();
  if (!dash.apiKey) {
    throw new Error('[EventDNA] Missing DASHSCOPE_API_KEY.');
  }

  let events = [];
  try {
    events = await fetchUnprocessedEvents();
  } catch (err) {
    throw new Error(`[EventDNA] Failed to fetch events: ${err.message || err}`);
  }

  const total = events.length;
  console.log(`[EventDNA] Found ${total} unprocessed event(s).`);

  let success = 0;
  let failed = 0;

  for (const event of events) {
    console.log(`[EventDNA] Processing ${event.id}: ${event.title}`);
    try {
      const dnaScores = await callDashScopeForEvent(event, dash);

      await db.query(
        'UPDATE events_chatbot SET event_dna = $1 WHERE id = $2',
        [JSON.stringify(dnaScores), event.id],
      );

      console.log(`[EventDNA] ✅ Done ${event.id}:`, dnaScores);
      success++;
    } catch (err) {
      logApiUsage({
        provider: 'dashscope',
        feature: 'event_dna',
        model: dash.model,
        success: false
      }).catch(() => {});
      console.log(`[EventDNA] ❌ Failed ${event.id}:`, err.message || String(err));
      failed++;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`[EventDNA] Complete — Success: ${success}, Failed: ${failed}, Total: ${total}`);
  return { success, failed, total };
}

if (require.main === module) {
  generateAllEventDNA()
    .catch((err) => {
      console.error(err.message || err);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { generateAllEventDNA };
