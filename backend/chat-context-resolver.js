'use strict';

const {
  parseUserIntent,
  buildIntentContext,
  isRefinementQuery,
  extractKeywords,
} = require('./chatbot-utils');

const CONTEXT_RESOLVER_SYSTEM_PROMPT = `You are the conversation brain for Eve, an event-discovery assistant in Malaysia.

Read the recent chat and the user's LATEST message. Decide whether they are continuing the same search or starting a new topic, then output ONE JSON object (no markdown, no commentary).

Output schema:
{
  "isFollowUp": true or false,
  "isTopicReset": true or false,
  "isEventRequest": true or false,
  "standaloneQuery": "full self-contained search phrase",
  "keywords": ["specific topic words only"],
  "dateRange": {
    "from": "YYYY-MM-DD" or null,
    "to": "YYYY-MM-DD" or null,
    "label": "short human label"
  }
}

CONVERSATION RULES:
- isFollowUp=true when the latest message depends on prior turns (pronouns, "cheaper ones", "what about Saturday", "any more", "in Penang instead" while still same topic).
- isTopicReset=true when the user clearly switches topic (concerts → food festivals, jazz → tech meetups). On reset, standaloneQuery should ONLY reflect the new topic — drop old topic keywords unless the user repeats them.
- If isTopicReset=true, isFollowUp should be false.
- standaloneQuery must read like a complete sentence someone could search with, merging prior context when isFollowUp=true.
  Examples:
    prior: "concerts this weekend" + latest: "cheaper ones?" → standaloneQuery: "cheap concerts this weekend"
    prior: "jazz in KL" + latest: "what about next month?" → standaloneQuery: "jazz events in KL next month"
    prior: "concerts" + latest: "any food festivals?" → isTopicReset=true, standaloneQuery: "food festivals"
- Greetings/thanks/small talk → isEventRequest=false, standaloneQuery can echo the greeting.

DATE RULES (use TODAY from CALENDAR block):
- Merge dates from conversation when follow-up omits them.
- "before X" → from=today, to=day before X
- "after X" → from=day after X, to=today+12 months
- "this weekend" → upcoming Sat–Sun
- "next month" → 1st to last day of next month
- No date constraint → from=null, to=null

KEYWORD RULES:
- Specific topics only: jazz, cancer, K-pop, comedy, marathon, anime
- NOT generic: events, shows, fun, things, concert, festival
- NOT cities (KL, Penang) — those go in standaloneQuery text
- NOT budget words (free, cheap) — those go in standaloneQuery text
- Carry topic keywords forward on follow-ups unless topic reset.

isEventRequest:
- true for event/show/festival/plan/idea requests
- false for hi/thanks/unrelated chat`;

function stripMarkdownFences(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return s.trim();
}

function parseResolverJson(raw) {
  const t = stripMarkdownFences(raw);
  try {
    const p = JSON.parse(t);
    if (p && typeof p === 'object') return p;
  } catch (_) {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

function normalizeKeywords(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 2 && k.length <= 40)
    .slice(0, 6);
}

function normalizeDateRange(dr) {
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const src = dr && typeof dr === 'object' ? dr : {};
  const from = typeof src.from === 'string' && isoRe.test(src.from) ? src.from : null;
  const to = typeof src.to === 'string' && isoRe.test(src.to) ? src.to : null;
  const label = typeof src.label === 'string' ? src.label.slice(0, 120) : '';
  return { from, to, label };
}

function buildResolverUserBlock({ message, history, calendarBlock }) {
  const hist = Array.isArray(history) ? history : [];
  const lines = hist
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .slice(-8)
    .map((h) => `${h.role}: ${String(h.content).slice(0, 600)}`);

  return [
    calendarBlock || '',
    lines.length ? `Recent conversation:\n${lines.join('\n')}\n` : '',
    `Latest user message: "${String(message).slice(0, 500)}"`,
    'Return ONLY the JSON object described in the system prompt.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Rule-based fallback when the LLM resolver is unavailable.
 */
function resolveChatContextFallback(message, history) {
  const trimmed = String(message || '').trim();
  const isFollowUp = isRefinementQuery(trimmed, history);
  const intentContext = isFollowUp ? buildIntentContext(trimmed, history) : trimmed;
  const parsed = parseUserIntent(intentContext);
  const latest = parseUserIntent(trimmed);

  return {
    source: 'rules',
    isFollowUp,
    isTopicReset: !isFollowUp && Array.isArray(history) && history.some((h) => h && h.role === 'user'),
    isEventRequest: latest.isEventRequest || parsed.isEventRequest,
    standaloneQuery: intentContext,
    keywords: extractKeywords(intentContext, 5),
    dateRange: { from: null, to: null, label: '' },
    askingAboutPast: latest.askingAboutPast === true,
  };
}

/**
 * Call LLM to resolve multi-turn context. Returns null on failure (caller should fallback).
 */
async function resolveChatContextViaLlm({ message, history, calendarBlock, callLlm }) {
  if (typeof callLlm !== 'function') return null;
  const userBlock = buildResolverUserBlock({ message, history, calendarBlock });
  let raw;
  try {
    raw = await callLlm(userBlock, CONTEXT_RESOLVER_SYSTEM_PROMPT);
  } catch (err) {
    console.warn('[chat-context] LLM resolver failed:', err.message);
    return null;
  }

  const parsed = parseResolverJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[chat-context] JSON parse failed:', String(raw).slice(0, 200));
    return null;
  }

  const dateRange = normalizeDateRange(parsed.dateRange);
  const standaloneQuery = String(parsed.standaloneQuery || message).trim() || String(message).trim();
  const isTopicReset = parsed.isTopicReset === true;
  const isFollowUp = parsed.isFollowUp === true && !isTopicReset;

  return {
    source: 'llm',
    isFollowUp,
    isTopicReset,
    isEventRequest: parsed.isEventRequest !== false,
    standaloneQuery,
    keywords: normalizeKeywords(parsed.keywords),
    dateRange,
    askingAboutPast: parseUserIntent(standaloneQuery).askingAboutPast === true,
  };
}

/**
 * Primary entry: LLM resolver with rule fallback.
 */
async function resolveChatContext({ message, history, calendarBlock, callLlm }) {
  const trimmed = String(message || '').trim();
  if (!trimmed) {
    return resolveChatContextFallback('', history);
  }

  const hasPrior = Array.isArray(history) && history.some((h) => h && h.role === 'user' && h.content);
  if (!hasPrior) {
    const intent = parseUserIntent(trimmed);
    return {
      source: 'rules',
      isFollowUp: false,
      isTopicReset: false,
      isEventRequest: intent.isEventRequest,
      standaloneQuery: trimmed,
      keywords: extractKeywords(trimmed, 5),
      dateRange: { from: null, to: null, label: '' },
      askingAboutPast: intent.askingAboutPast === true,
    };
  }

  const llmResolved = await resolveChatContextViaLlm({ message: trimmed, history, calendarBlock, callLlm });
  if (llmResolved) return llmResolved;

  console.log('[chat-context] falling back to rule-based resolver');
  return resolveChatContextFallback(trimmed, history);
}

module.exports = {
  CONTEXT_RESOLVER_SYSTEM_PROMPT,
  resolveChatContext,
  resolveChatContextFallback,
  resolveChatContextViaLlm,
  parseResolverJson,
};
