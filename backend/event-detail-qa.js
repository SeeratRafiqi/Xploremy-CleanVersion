'use strict';

const EVENT_DETAIL_SYSTEM_PROMPT = `You are a warm, helpful assistant answering questions about ONE specific event in Malaysia.

STRICT RULES — verified facts (date, time, venue, city, price, ticket URL, category):
- Use ONLY the verified_event_data JSON in the user message.
- If a field is missing, null, or empty, say clearly that the detail is not listed — do NOT invent it.
- Never guess dates, start times, venues, addresses, or prices.

GENERAL KNOWLEDGE (artist background, genre, typical vibe, what to expect):
- You MAY add helpful context from general knowledge.
- Prefix such content with "From general knowledge:" so the user knows it is not from our listing.

Style: concise, friendly, natural plain text — like a helpful friend texting back. Do NOT use markdown: no asterisks for bold/italics, no bullet points or dashes for lists, no headings. Write in flowing sentences.`;

const DETAIL_SIGNAL_RE =
  /\b(tell me (?:more )?about|more (?:info|information|details)|what(?:'s| is) (?:it|this|that) about|describe|details? (?:for|of|on|about)|who (?:is|are) (?:playing|performing)|lineup|dress code|age limit|how (?:long|much)|what time|when (?:does|do|is|are)|where (?:is|are)|start(?:s|ing)?|venue|location|price|ticket)\b/i;

const PRONOUN_RE =
  /\b(it|this one|that one|this event|that event|the event)\b/i;

const PRONOUN_THIS_THAT_RE = /\b(this|that)\b/i;

const TEMPORAL_THIS_THAT_RE =
  /\b(this|that)\s+(weekend|week|month|year|morning|afternoon|evening|saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/i;

function hasEventPronoun(lower) {
  if (PRONOUN_RE.test(lower)) return true;
  if (!PRONOUN_THIS_THAT_RE.test(lower)) return false;
  if (TEMPORAL_THIS_THAT_RE.test(lower)) return false;
  return true;
}

const SEARCH_SIGNAL_RE =
  /\b(events?|shows?|gigs?|festivals?|recommend(?:ation)?s?|suggest|find me|show me|what(?:'s| is) on|happening|any (?:good )?events?|looking for)\b/i;

const NEW_SEARCH_DATE_RE =
  /\b(today|tonight|tomorrow|this weekend|next week|next month|on \d{1,2}(?:st|nd|rd|th)?|in (?:kl|kuala lumpur|penang|jb))\b/i;

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeTitle(title) {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'at', 'in', 'on', 'for', 'of', 'with', 'live', 'show', 'event', 'malaysia',
  ]);
  return normalizeText(title)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.has(w));
}

/**
 * Detect follow-up questions about a specific event vs new event search.
 */
function isEventDetailQuestion(message, recentEvents) {
  const msg = String(message || '').trim();
  if (!msg) return false;
  const lower = msg.toLowerCase();

  const hasRecent = Array.isArray(recentEvents) && recentEvents.length > 0;
  const hasDetailSignal = DETAIL_SIGNAL_RE.test(lower);
  const hasPronoun = hasEventPronoun(lower);
  const looksLikeSearch =
    SEARCH_SIGNAL_RE.test(lower) &&
    (NEW_SEARCH_DATE_RE.test(lower) || /\b(under|below|free|cheap|comedy|music|jazz|food)\b/i.test(lower));

  if (looksLikeSearch && !hasDetailSignal) return false;

  if (hasDetailSignal) return true;

  if (hasPronoun && /\?|when|where|how|what|who|price|time|start|venue|tell|describe/i.test(lower)) {
    return hasRecent;
  }

  if (hasRecent) {
    const tokens = tokenizeTitle(msg);
    if (tokens.length >= 2) {
      for (const ev of recentEvents) {
        const titleTokens = tokenizeTitle(ev.title);
        if (!titleTokens.length) continue;
        const overlap = tokens.filter((t) => titleTokens.includes(t)).length;
        if (overlap >= Math.min(2, titleTokens.length)) return true;
      }
    }
  }

  return false;
}

function slimEventForContext(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return {
    id: ev.id != null ? String(ev.id) : '',
    title: ev.title || '',
    url: ev.url || ev.event_url || '',
    date: ev.date || '',
    time: ev.time || '',
    venue: ev.venue || '',
    city: ev.city || '',
    price: ev.isFree ? 'Free' : ev.price || '',
    category: ev.category || '',
    source: ev.source || ev._source || '',
    description: String(ev.description || ev.summary || '').slice(0, 4000),
  };
}

function buildVerifiedEventPayload(ev) {
  const s = slimEventForContext(ev);
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    date: s.date || null,
    time: s.time || null,
    venue: s.venue || null,
    city: s.city || null,
    price: s.price || null,
    category: s.category || null,
    ticket_url: s.url || null,
    source: s.source || null,
    description: s.description || null,
  };
}

function scoreTitleMatch(message, title) {
  const msg = normalizeText(message);
  const t = normalizeText(title);
  if (!t || t.length < 3) return 0;
  if (msg.includes(t)) return t.length + 100;
  const titleTokens = tokenizeTitle(title);
  if (!titleTokens.length) return 0;
  let score = 0;
  for (const tok of titleTokens) {
    if (msg.includes(tok)) score += tok.length;
  }
  return score;
}

function pickBestEventMatch(message, events) {
  if (!Array.isArray(events) || !events.length) return null;
  let best = null;
  let bestScore = 0;
  for (const ev of events) {
    const score = scoreTitleMatch(message, ev.title);
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }
  return bestScore >= 6 ? best : null;
}

function resolveEventFromRecent(message, recentEvents) {
  const recent = Array.isArray(recentEvents) ? recentEvents : [];
  if (!recent.length) return null;

  const lower = String(message || '').toLowerCase();
  const byTitle = pickBestEventMatch(message, recent);
  if (byTitle) return byTitle;

  if (hasEventPronoun(lower)) return recent[0];

  return null;
}

function findEventInListById(id, list) {
  const needle = String(id || '').trim();
  if (!needle || !Array.isArray(list)) return null;
  return list.find((e) => String(e.id) === needle) || null;
}

function findEventInListByTitle(message, list) {
  if (!Array.isArray(list) || !list.length) return null;
  return pickBestEventMatch(message, list);
}

function buildEventDetailUserBlock({ event, question, history, calendarBlock }) {
  const verified = buildVerifiedEventPayload(event);
  const hist = Array.isArray(history) ? history : [];
  const histText = hist
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .slice(-6)
    .map((h) => `${h.role}: ${String(h.content).slice(0, 800)}`)
    .join('\n');

  return [
    calendarBlock || '',
    histText ? `Prior Q&A:\n${histText}\n` : '',
    `verified_event_data:\n${JSON.stringify(verified, null, 2)}\n`,
    `User question:\n${String(question).slice(0, 1200)}`,
    'Answer the question following the system rules.',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  EVENT_DETAIL_SYSTEM_PROMPT,
  isEventDetailQuestion,
  slimEventForContext,
  buildVerifiedEventPayload,
  resolveEventFromRecent,
  pickBestEventMatch,
  findEventInListById,
  findEventInListByTitle,
  buildEventDetailUserBlock,
};
