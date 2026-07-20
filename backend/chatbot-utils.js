function toDateOnly(dateObj) {
  return new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function todayISO(baseDate = new Date()) {
  return isoDate(toDateOnly(baseDate));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Short single-word signals use word boundaries so "ball" does not match "football". */
function hayContainsPhrase(hay, phrase) {
  const p = String(phrase).toLowerCase();
  if (!p.trim()) return false;
  if (p.length <= 4 && !/\s/.test(p)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(p)}([^a-z0-9]|$)`, 'i').test(hay);
  }
  return hay.includes(p);
}

function calculateNextDate(dayName, baseDate = new Date()) {
  const map = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const target = map[String(dayName || '').toLowerCase()];
  if (target == null) return null;
  const today = toDateOnly(baseDate);
  const todayDay = today.getUTCDay();
  let offset = (target - todayDay + 7) % 7;
  if (offset === 0) offset = 7;
  return isoDate(addDays(today, offset));
}

function parseBudget(messageLower) {
  const maxMatch = messageLower.match(/(?:under|below|max|budget)\s*(?:rm)?\s*(\d+)/i);
  const maxPrice = maxMatch ? Number(maxMatch[1]) : null;

  const imFreeAvailability = /\b(i'?m|i am|im|we are|we're)\s+free\b/i.test(messageLower);
  const wantsFreeEvents =
    /\b(free\s+(event|events|show|shows|concert|concerts|festival|festivals|entry|admission|ticket|tickets))\b/i.test(messageLower) ||
    /\b(event|events|show|shows|ticket|tickets)\s+(that are|are)\s+free\b/i.test(messageLower) ||
    /\b(anything|something)\s+free\b/i.test(messageLower) ||
    /\bno\s+(cost|charge|fee|entry\s+fee)\b/i.test(messageLower) ||
    /\b(rm\s*0|0\s*rm)\b/i.test(messageLower);

  let type = 'any';
  const wantsCheap = messageLower.includes('cheap') || messageLower.includes('affordable');
  const casualFreePhrase = /\bfeel\s+free\b/i.test(messageLower);

  if (imFreeAvailability && !wantsFreeEvents) {
    type = 'any';
  } else if (wantsCheap) {
    type = 'cheap';
  } else if (wantsFreeEvents || (messageLower.includes('free') && !imFreeAvailability && !casualFreePhrase)) {
    type = 'free';
  }

  return { type, maxPrice };
}

function parseSpecificDateReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };

  const directIso = messageLower.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (directIso) {
    const y = Number(directIso[1]), m = Number(directIso[2]) - 1, d = Number(directIso[3]);
    const dt = new Date(Date.UTC(y, m, d));
    if (!Number.isNaN(dt.getTime()) && dt.getUTCMonth() === m && dt.getUTCDate() === d) return isoDate(dt);
  }

  const slashDate = messageLower.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
  if (slashDate) {
    const day = Number(slashDate[1]), month = Number(slashDate[2]) - 1;
    let year = slashDate[3] ? Number(slashDate[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
    if (!slashDate[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    return isoDate(dt);
  }

  // FIX: use global match and return the LAST valid hit so that in combined
  // multi-turn context like "events on 5th\nhow about 8th may" the earlier
  // invalid pair "5th how" is skipped and "8th may" (the most-recent date) wins.
  const dayMonthRe = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?!of\b)([a-z]+)(?:\s+(20\d{2}))?\b/g;
  let dm; let lastDayMonthResult = null;
  while ((dm = dayMonthRe.exec(messageLower)) !== null) {
    const day = Number(dm[1]);
    const month = monthMap[dm[2]];
    if (month == null) continue;
    let year = dm[3] ? Number(dm[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) continue;
    if (!dm[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    lastDayMonthResult = isoDate(dt);
  }
  if (lastDayMonthResult) return lastDayMonthResult;

  const dayOfMonthRe = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([a-z]+)(?:\s+(20\d{2}))?\b/g;
  let dom; let lastDayOfMonthResult = null;
  while ((dom = dayOfMonthRe.exec(messageLower)) !== null) {
    const day = Number(dom[1]);
    const month = monthMap[dom[2]];
    if (month == null) continue;
    let year = dom[3] ? Number(dom[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) continue;
    if (!dom[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    lastDayOfMonthResult = isoDate(dt);
  }
  if (lastDayOfMonthResult) return lastDayOfMonthResult;

  const monthDayRe = /\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(20\d{2}))?\b/g;
  let md; let lastMonthDayResult = null;
  while ((md = monthDayRe.exec(messageLower)) !== null) {
    const month = monthMap[md[1]];
    if (month == null) continue;
    const day = Number(md[2]);
    let year = md[3] ? Number(md[3]) : today.getUTCFullYear();
    let dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) continue;
    if (!md[3] && dt < today) { year += 1; dt = new Date(Date.UTC(year, month, day)); }
    lastMonthDayResult = isoDate(dt);
  }
  if (lastMonthDayResult) return lastMonthDayResult;

  return null;
}

// FIX: "may" as auxiliary verb ("may I", "it may", "that may") must NOT be parsed as
// the month May.  Require a temporal preposition before it, or a 4-digit year after it.
function parseMonthReference(messageLower, baseDate = new Date()) {
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };

  // Non-"may" months: temporal preposition is optional (same as before)
  const nonMayRe =
    /\b(?:in|on|for|during|about|around|this|next)?\s*(january|jan|february|feb|march|mar|april|apr|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i;

  // "may" only qualifies as a month when preceded by a temporal preposition OR followed by a year
  const mayRe =
    /\b(?:(?:in|on|for|during|about|around|this|next)\s+may|may\s+20\d{2})\b/i;

  let monthToken, yearStr;

  const nonMayMatch = nonMayRe.exec(messageLower);
  if (nonMayMatch) {
    monthToken = String(nonMayMatch[1] || '').toLowerCase();
    yearStr = nonMayMatch[2] || null;
  } else if (mayRe.test(messageLower)) {
    monthToken = 'may';
    const mayYearMatch = messageLower.match(/\bmay\s+(20\d{2})\b/i);
    yearStr = mayYearMatch ? mayYearMatch[1] : null;
  } else {
    return null;
  }

  const month = monthMap[monthToken];
  if (month == null) return null;

  const today = toDateOnly(baseDate);
  let year = yearStr ? Number(yearStr) : today.getUTCFullYear();
  if (!yearStr && month < today.getUTCMonth()) year += 1;

  const dates = [];
  const cursor = new Date(Date.UTC(year, month, 1));
  while (cursor.getUTCMonth() === month) {
    dates.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (!dates.length) return null;

  return { type: 'month', label: `${monthToken} ${year}`, dates };
}

/**
 * "Last week of April" = final 7 calendar days of that month (not the whole month, not "past week" retrospect).
 */
function parseLastWeekOfMonthReference(messageLower, baseDate = new Date()) {
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };
  const re =
    /\b(?:the\s+)?last\s+week\s+of\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i;
  const m = messageLower.match(re);
  if (!m) return null;
  const monthToken = String(m[1] || '').toLowerCase();
  const month = monthMap[monthToken];
  if (month == null) return null;

  const today = toDateOnly(baseDate);
  let year = m[2] ? Number(m[2]) : today.getUTCFullYear();
  if (!m[2] && month < today.getUTCMonth()) year += 1;

  const lastDayNum = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = [];
  const startDay = Math.max(1, lastDayNum - 6);
  for (let d = startDay; d <= lastDayNum; d += 1) {
    dates.push(isoDate(new Date(Date.UTC(year, month, d))));
  }
  return { type: 'last_week_of_month', label: `last week of ${monthToken} ${year}`, dates };
}

function weekendSatSunFromOffset(today, satOffsetDays) {
  const sat = addDays(today, satOffsetDays);
  return [isoDate(sat), isoDate(addDays(sat, 1))];
}

function nextSaturdayFrom(today) {
  const day = today.getUTCDay();
  const off = (6 - day + 7) % 7;
  if (off === 0) return today;
  return addDays(today, off);
}

/**
 * Parse a small substring (the part of a sentence after "before"/"after"/"between"/etc.)
 * into a single ISO date.  For period-like anchors ("may", "next week", "next month"),
 * mode='start' returns the FIRST day of the period and mode='end' returns the LAST day.
 *
 * Returns null if the leading word(s) don't look date-like — this prevents false positives
 * for phrases like "after work this weekend" (where "after" is colloquial, not temporal).
 */
function parseAnchorDate(textRaw, baseDate, mode) {
  const text = String(textRaw || '').toLowerCase().trim();
  if (!text) return null;

  // Strip leading qualifier words ("the 5th", "this weekend", "next month")
  const stripped = text.replace(/^(?:the|a|an|that|coming|upcoming|next|this)\s+/g, '').trim();
  if (!stripped) return null;
  // Strip ordinal suffix from first word so "31st" / "5th" pass the opener test.
  // FIX: only strip when preceded by a digit, otherwise "august" → "augu" (eats real letters).
  const firstWordRaw = stripped.split(/[\s,;.!?-]+/)[0] || '';
  const firstWord = firstWordRaw.replace(/(\d)(?:st|nd|rd|th)$/i, '$1');

  // First significant token must look date-like (number, month, weekday, today/tomorrow…)
  const opener =
    /^(?:\d{1,4}|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec|today|tomorrow|tonight|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat|sunday|sun|weekend|week|month|year|20\d{2})$/i;
  if (!opener.test(firstWord)) return null;

  const today = toDateOnly(baseDate);
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };

  // ISO 2026-08-15
  const isoMatch = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const y = Number(isoMatch[1]), m = Number(isoMatch[2]) - 1, d = Number(isoMatch[3]);
    const dt = new Date(Date.UTC(y, m, d));
    if (!Number.isNaN(dt.getTime()) && dt.getUTCMonth() === m && dt.getUTCDate() === d) return isoDate(dt);
  }

  // Day-month or month-day patterns ("31 may", "may 31", "the 5th of August")
  const sp = parseSpecificDateReference(text, baseDate);
  if (sp) return sp;

  if (/\btomorrow\b/.test(text)) return isoDate(addDays(today, 1));
  if (/\b(today|tonight)\b/.test(text)) return isoDate(today);

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const day of weekdays) {
    if (new RegExp(`\\b${day}\\b`, 'i').test(text)) {
      const date = calculateNextDate(day, baseDate);
      if (date) return date;
    }
  }

  if (/\bnext\s+weekend\b/.test(text)) {
    const thisSat = nextSaturdayFrom(today);
    const offToThisSat = Math.round((thisSat - today) / 86400000);
    const nextSatOff = offToThisSat === 0 ? 7 : offToThisSat + 7;
    const sat = addDays(today, nextSatOff);
    return mode === 'end' ? isoDate(addDays(sat, 1)) : isoDate(sat);
  }
  if (/\b(?:this\s+)?weekend\b/.test(text)) {
    const thisSat = nextSaturdayFrom(today);
    return mode === 'end' ? isoDate(addDays(thisSat, 1)) : isoDate(thisSat);
  }

  if (/\bnext\s+week\b/.test(text)) {
    const start = addDays(today, 7);
    return mode === 'end' ? isoDate(addDays(start, 6)) : isoDate(start);
  }
  if (/\bthis\s+week\b/.test(text)) {
    const dow = today.getUTCDay(); // 0=Sun..6=Sat — clamp end to upcoming Sun
    return mode === 'end' ? isoDate(addDays(today, (7 - dow) % 7)) : isoDate(today);
  }

  if (/\bnext\s+month\b/.test(text)) {
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    if (mode === 'end') return isoDate(new Date(Date.UTC(y, m + 2, 0)));
    return isoDate(new Date(Date.UTC(y, m + 1, 1)));
  }
  if (/\bthis\s+month\b/.test(text)) {
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    if (mode === 'end') return isoDate(new Date(Date.UTC(y, m + 1, 0)));
    return isoDate(today);
  }

  // Bare month name (no preposition needed in this anchor context — operator already implies temporal use)
  const monthOnly = text.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i);
  if (monthOnly) {
    const month = monthMap[monthOnly[1].toLowerCase()];
    if (month != null) {
      let year = monthOnly[2] ? Number(monthOnly[2]) : today.getUTCFullYear();
      if (!monthOnly[2] && month < today.getUTCMonth()) year += 1;
      if (mode === 'end') return isoDate(new Date(Date.UTC(year, month + 1, 0)));
      return isoDate(new Date(Date.UTC(year, month, 1)));
    }
  }

  return null;
}

/**
 * Detect range/operator phrasings: before/after/until/by/since/between/from-to.
 * Returns { type:'date_range', label, from, to, dates:[...] } or null.
 *
 * Inclusivity convention:
 *   before X / earlier than X / prior to X        → strictly earlier (X excluded)
 *   by X / until X / no later than X / on/before  → through X (X included)
 *   after X / later than X / past X               → strictly later (X excluded)
 *   since X / starting X / on or after X / from X → from X onwards (X included)
 *   between X and Y / from X to Y                 → inclusive on both ends
 *
 * Lower bound is clamped to today (only future events are shown).
 * Upper bound for open-ended "after"/"since" is clamped to today + 12 months.
 */
function parseDateRangeReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);
  const todayStr = isoDate(today);
  const maxFutureStr = isoDate(addDays(today, 366));

  function makeRange(fromISO, toISO, label) {
    let from = fromISO;
    let to = toISO;
    // FIX: parseSpecificDateReference auto-bumps any past date to next year, which
    // breaks ranges like "from 5 may to 20 may" when today=May 6 (5 may → 2027, 20 may → 2026).
    // Detect inversion and roll `from` back by 1 year — clamp to today afterwards.
    if (from > to) {
      const fromDate = new Date(from + 'T00:00:00Z');
      fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
      const candidate = isoDate(fromDate);
      if (candidate <= to) from = candidate;
    }
    if (from < todayStr) from = todayStr;
    if (to > maxFutureStr) to = maxFutureStr;
    if (from > to) return { type: 'date_range', label, from, to, dates: [] };
    const dates = [];
    let cursor = new Date(from + 'T00:00:00Z');
    const stop = new Date(to + 'T00:00:00Z');
    while (cursor <= stop) {
      dates.push(isoDate(cursor));
      cursor = addDays(cursor, 1);
    }
    return { type: 'date_range', label, from, to, dates };
  }

  // Capture-stop patterns. Stop at punctuation OR a coordinating conjunction so that
  // compound queries like "before X but after Y" don't gobble across operators.
  // STOP_FULL stops at any conjunction (used for single operators like before/after/by/since).
  // STOP_NO_AND keeps "and" allowed (used for between/from-to where "and"/"to" is syntax).
  const STOP_FULL = '(?:\\s*[?.!,;]|\\s+(?:but|and|or|though|however|except|while|whereas)\\b|$)';
  const STOP_NO_AND = '(?:\\s*[?.!,;]|\\s+(?:but|or|though|however|except|while|whereas)\\b|$)';

  // Helper: when first anchor in "between X and Y" / "from X to Y" is a bare number
  // (e.g. "between 5 and 20 august"), inherit the month from the second anchor.
  const monthRe = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\b/i;
  function resolveDualAnchors(rawA, rawB, modeA, modeB) {
    let a = parseAnchorDate(rawA, baseDate, modeA);
    let b = parseAnchorDate(rawB, baseDate, modeB);
    const bareNumRe = /^\s*\d{1,2}(?:st|nd|rd|th)?\s*$/i;
    // First anchor is bare number? Inherit month context from the second anchor.
    if (!a && bareNumRe.test(rawA)) {
      const m = rawB.match(monthRe);
      if (m) a = parseAnchorDate(`${rawA.trim()} ${m[1]}`, baseDate, modeA);
    }
    // Second anchor is bare number? Inherit month context from the first anchor.
    if (!b && bareNumRe.test(rawB)) {
      const m = rawA.match(monthRe);
      if (m) b = parseAnchorDate(`${rawB.trim()} ${m[1]}`, baseDate, modeB);
    }
    return [a, b];
  }

  // "between X and Y"
  const between = messageLower.match(new RegExp(`\\bbetween\\s+(.+?)\\s+and\\s+(.+?)${STOP_NO_AND}`, 'i'));
  if (between) {
    const [start, end] = resolveDualAnchors(between[1], between[2], 'start', 'end');
    if (start && end) return makeRange(start, end, `between ${between[1].trim()} and ${between[2].trim()}`);
  }

  // "from X to/till/until/through Y"
  const fromTo = messageLower.match(new RegExp(`\\bfrom\\s+(.+?)\\s+(?:to|till|until|through|thru)\\s+(.+?)${STOP_NO_AND}`, 'i'));
  if (fromTo) {
    const [start, end] = resolveDualAnchors(fromTo[1], fromTo[2], 'start', 'end');
    if (start && end) return makeRange(start, end, `from ${fromTo[1].trim()} to ${fromTo[2].trim()}`);
  }

  // ── Single-operator pass: collect every operator in the message and combine ──
  // FIX (compound operators): handle "before X but after Y", "after Y and before X",
  // "since X until Y", "from X by Y" etc. Each operator captures only its own anchor
  // (stops at conjunction), then we merge bounds into one range.
  let lowerBound = null;
  let upperBound = null;
  const labelParts = [];

  // before X / earlier than X / prior to X (exclusive upper)
  const beforeRe = new RegExp(`(?<!\\bnot\\s)\\b(?:before|earlier than|prior to)\\s+(.+?)${STOP_FULL}`, 'i');
  const beforeMatch = messageLower.match(beforeRe);
  if (beforeMatch) {
    const anchor = parseAnchorDate(beforeMatch[1], baseDate, 'start');
    if (anchor) {
      const endExcl = isoDate(addDays(new Date(anchor + 'T00:00:00Z'), -1));
      upperBound = endExcl;
      labelParts.push(`before ${beforeMatch[1].trim()}`);
    }
  }

  // by X / until X / no later than X / on or before X (inclusive upper)
  const byRe = new RegExp(`\\b(?:by|until|till|no later than|on or before|not after|up to|up till|up until)\\s+(.+?)${STOP_FULL}`, 'i');
  const byMatch = messageLower.match(byRe);
  if (byMatch && upperBound === null) {
    const anchor = parseAnchorDate(byMatch[1], baseDate, 'end');
    if (anchor) {
      upperBound = anchor;
      labelParts.push(`until ${byMatch[1].trim()}`);
    }
  }

  // since X / starting X / on or after X / not before X (inclusive lower) — before "after"
  const sinceRe = new RegExp(`\\b(?:since|starting(?:\\s+from)?|on or after|not before)\\s+(.+?)${STOP_FULL}`, 'i');
  const sinceMatch = messageLower.match(sinceRe);
  if (sinceMatch) {
    const anchor = parseAnchorDate(sinceMatch[1], baseDate, 'start');
    if (anchor) {
      lowerBound = anchor;
      labelParts.push(`since ${sinceMatch[1].trim()}`);
    }
  }

  // after X / later than X / past X / post X (exclusive lower)
  const afterRe = new RegExp(`(?<!\\b(?:or|no)\\s)\\b(?:after|later than|past|post)\\s+(.+?)${STOP_FULL}`, 'i');
  const afterMatch = messageLower.match(afterRe);
  if (afterMatch && lowerBound === null) {
    const anchor = parseAnchorDate(afterMatch[1], baseDate, 'end');
    if (anchor) {
      const startExcl = isoDate(addDays(new Date(anchor + 'T00:00:00Z'), 1));
      lowerBound = startExcl;
      labelParts.push(`after ${afterMatch[1].trim()}`);
    }
  }

  if (lowerBound !== null || upperBound !== null) {
    const from = lowerBound !== null ? lowerBound : todayStr;
    const to = upperBound !== null ? upperBound : maxFutureStr;
    return makeRange(from, to, labelParts.join(' '));
  }

  return null;
}

function parseDayReference(messageLower, baseDate = new Date()) {
  const today = toDateOnly(baseDate);

  // Detect operator-based ranges first ("before may", "after 31 august", "between A and B")
  const dateRange = parseDateRangeReference(messageLower, baseDate);
  if (dateRange) return dateRange;

  const specificDate = parseSpecificDateReference(messageLower, baseDate);
  if (specificDate) return { type: 'specific_date', label: specificDate, dates: [specificDate] };

  const lastWeekOfMonth = parseLastWeekOfMonthReference(messageLower, baseDate);
  if (lastWeekOfMonth) return lastWeekOfMonth;

  const monthRef = parseMonthReference(messageLower, baseDate);
  if (monthRef) return monthRef;

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const day of weekdays) {
    if (new RegExp(`\\b${day}\\b`, 'i').test(messageLower)) {
      const date = calculateNextDate(day, baseDate);
      return { type: 'weekday', label: day, dates: date ? [date] : [] };
    }
  }

  if (/\b(tomorrow|tommorow|tommorrow)\b/i.test(messageLower))
    return { type: 'tomorrow', label: 'tomorrow', dates: [isoDate(addDays(today, 1))] };
  if (/\btonight\b/i.test(messageLower))
    return { type: 'tonight', label: 'tonight', dates: [isoDate(today)] };
  if (/\btoday\b/i.test(messageLower))
    return { type: 'today', label: 'today', dates: [isoDate(today)] };

  if (/\bnext\s+weekend\b/i.test(messageLower)) {
    const thisSat = nextSaturdayFrom(today);
    const offToThisSat = Math.round((thisSat - today) / 86400000);
    // FIX: "next weekend" = the weekend AFTER the upcoming one (always +7 days beyond this Sat)
    const nextSatOff = offToThisSat === 0 ? 7 : offToThisSat + 7;
    return { type: 'next_weekend', label: 'next weekend', dates: weekendSatSunFromOffset(today, nextSatOff) };
  }

  if (/\b(weekends?|this\s+weekends?|coming\s+weekends?|upcoming\s+weekends?)\b/i.test(messageLower)) {
    const thisSat = nextSaturdayFrom(today);
    const off = Math.round((thisSat - today) / 86400000);
    return { type: 'weekend', label: 'this weekend', dates: weekendSatSunFromOffset(today, off) };
  }

  // ── ISO-week parsing: "this week", "next week", "the week after next" ──
  // Always anchored to MONDAY through SUNDAY (Malaysia/ISO convention),
  // never "today + 7 days".
  //
  // BUG FIX: previously "next week" returned today+7..today+13 which gave
  // arbitrary day-of-week starts (Wed→Wed if asked on Wednesday). The user
  // expects Mon-Sun of the calendar week.
  const weekAfterNext = /\b(?:the\s+)?week\s+after\s+(?:the\s+)?next\b/i.test(messageLower) ||
    /\bnext\s+next\s+week\b/i.test(messageLower) ||
    /\bin\s+(?:two|2)\s+weeks?\b/i.test(messageLower);
  if (weekAfterNext) {
    const dow = today.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
    const daysToNextMonday = ((8 - dow) % 7) || 7;
    const start = addDays(today, daysToNextMonday + 7); // Mon of the week AFTER next
    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(isoDate(addDays(start, i)));
    return { type: 'week_after_next', label: 'the week after next', dates };
  }
  if (/\bnext week\b/i.test(messageLower)) {
    const dow = today.getUTCDay();
    const daysToNextMonday = ((8 - dow) % 7) || 7;
    const start = addDays(today, daysToNextMonday); // Mon of next ISO week
    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(isoDate(addDays(start, i)));
    return { type: 'next_week', label: 'next week', dates };
  }
  if (/\bthis\s+week\b/i.test(messageLower)) {
    // From today through the upcoming Sunday (past days of this week are
    // automatically excluded by filterFutureEvents downstream).
    const dow = today.getUTCDay();
    const daysToSunday = (7 - dow) % 7; // 0 if today is Sunday
    const dates = [];
    for (let i = 0; i <= daysToSunday; i++) dates.push(isoDate(addDays(today, i)));
    return { type: 'this_week', label: 'this week', dates };
  }

  // FIX: handle "next month" and "this month"
  if (/\bnext\s+month\b/i.test(messageLower)) {
    const nm = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const dates = [];
    const cursor = new Date(nm);
    while (cursor.getUTCMonth() === nm.getUTCMonth()) {
      dates.push(isoDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { type: 'next_month', label: 'next month', dates };
  }

  if (/\bthis\s+month\b/i.test(messageLower)) {
    const dates = [];
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const month = cursor.getUTCMonth();
    while (cursor.getUTCMonth() === month) {
      dates.push(isoDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { type: 'this_month', label: 'this month', dates };
  }

  return { type: 'any', label: 'any time', dates: [] };
}

/**
 * Extract a bare day-of-month number from a message that has NO explicit month next to it.
 * e.g. "how about 10th", "what about the 3rd", "try 15" → returns the day number (1–31).
 * Returns null if no bare ordinal found, or if every number already has a month beside it.
 */
function parseBareOrdinal(messageLower) {
  const allMonthNames =
    'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|' +
    'august|aug|september|sep|sept|october|oct|november|nov|december|dec';
  // Matches a 1-2 digit number (with optional ordinal suffix) NOT immediately followed by a month name.
  const re = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:${allMonthNames})\\b)`,
    'ig',
  );
  let m;
  let lastDay = null;
  while ((m = re.exec(messageLower)) !== null) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) lastDay = day;
  }
  return lastDay;
}

/** If user says "5 May or around", widen a single parsed day to ±2 calendar days. */
function expandDayIfApproximate(dayRef, messageLower) {
  if (!dayRef || dayRef.type !== 'specific_date' || !dayRef.dates || dayRef.dates.length !== 1) {
    return dayRef;
  }
  if (!/\b(around|about|roughly|or thereabouts|give or take|or so)\b/i.test(messageLower)) {
    return dayRef;
  }
  const centerStr = dayRef.dates[0];
  const parts = centerStr.split('-').map(Number);
  const y = parts[0];
  const mo = parts[1];
  const da = parts[2];
  const expanded = new Set();
  for (let delta = -2; delta <= 2; delta += 1) {
    const dt = new Date(Date.UTC(y, mo - 1, da + delta));
    expanded.add(isoDate(dt));
  }
  return {
    ...dayRef,
    dates: [...expanded].sort(),
    label: `${centerStr} (±2 days)`,
  };
}

/**
 * Substrings that count as a "match" for a mood token (events rarely use the exact word
 * "romantic" or "kids" in the title; they say "musical", "family", "all ages", etc.).
 */
const MOOD_SIGNALS = {
  romantic: [
    'romantic', 'romance', 'date night', 'couple', 'love', 'valentine', 'candlelight', 'anniversary',
    'wedding', 'gala ball', 'masquerade', 'musical', 'theatre', 'theater', 'broadway', 'disney', 'fairytale',
    'fairy tale', 'princess', 'opera', 'ballet', 'love story',
  ],
  family: [
    'family', 'kid', 'kids', 'child', 'children', 'toddler', 'parent', 'all ages', 'school holiday',
    'fun fair', 'carnival', 'disney', 'junior', 'suitable for children', 'family-friendly',
  ],
  kids: [
    'kid', 'kids', 'child', 'children', 'toddler', 'family', 'all ages', 'junior', 'youth', 'school',
    'disney', 'cartoon', 'storybook', 'puppet', 'belle', 'beast', 'fairytale',
  ],
  comedy: ['comedy', 'comic', 'stand up', 'standup', 'stand-up', 'improv', 'funny', 'humour', 'humor'],
  music: ['music', 'concert', 'band', 'dj', 'gig', 'live band', 'festival', 'symphony', 'orchestra', 'karaoke'],
  art: ['art', 'gallery', 'exhibition', 'museum', 'paint', 'craft', 'illustration'],
  chill: ['chill', 'laid back', 'laid-back', 'acoustic', 'cozy', 'cosy', 'lounge', 'cafe', 'coffee'],
  energetic: ['energetic', 'high energy', 'hype', 'edm', 'rave'],
  hype: ['hype', 'edm', 'rave', 'festival'],
  party: ['party', 'club', 'nightclub', 'celebration', 'gala'],
  workshop: ['workshop', 'masterclass', 'class', 'course', 'training'],
  outdoor: ['outdoor', 'hiking', 'park', 'run', 'marathon', 'cycling'],
  food: ['food', 'dining', 'buffet', 'tasting', 'wine', 'tea', 'culinary', 'gastronomy', 'street food', 'food festival', 'foodie', 'restaurant', 'brunch', 'hawker', 'night market', 'cooking', 'chef', 'bakery', 'cafe', 'coffee', 'eat', 'eatery', 'f&b', 'food fair', 'food expo'],
  networking: ['networking', 'mixer', 'meetup', 'summit', 'conference', 'symposium'],
};

function eventMatchesMoodToken(hay, token) {
  const t = String(token || '').toLowerCase();
  const signals = MOOD_SIGNALS[t];
  if (signals && signals.length) return signals.some((s) => hayContainsPhrase(hay, s));
  return hayContainsPhrase(hay, t);
}

function parseMoodKeywords(messageLower) {
  const known = [
    'chill', 'romantic', 'energetic', 'hype', 'party', 'music', 'concert',
    'comedy', 'family', 'kids', 'workshop', 'art', 'outdoor', 'food', 'networking',
  ];
  const out = new Set(known.filter((m) => messageLower.includes(m)));
  // BUG-FIX: bare "kid" / "baby" / "my kid" must also count as a family
  // signal — previously only multi-word forms ("kid-friendly", "with my kids")
  // matched, so "i wanna take my kid to an event" did not trigger the
  // family/kids mood and the filter went through the unfiltered RAG path.
  if (
    /\b(kids?|child|children|toddler|baby|infant|kid-?friendly|family-?friendly|family\s+with|for kids|for kids?\b|with (my )?kids?|little ones?|my (?:kid|child|baby|son|daughter|boy|girl)|my (?:kids?|children))\b/i.test(
      messageLower,
    )
  ) {
    out.add('family');
    out.add('kids');
  }
  if (/\b(date night|couples?|anniversary|valentine)\b/i.test(messageLower)) {
    out.add('romantic');
  }
  return [...out];
}

function parsePlaceFilter(messageLower) {
  if (/\b(selangor|shah alam|petaling jaya|\bpj\b|subang|puchong|klang|gombak|ampang|rawang|cyberjaya|sepang|seri kembangan|bangi|kajang)\b/i.test(messageLower)) {
    return {
      mode: 'selangor',
      label: 'Selangor area',
      keywords: [
        'selangor', 'shah alam', 'petaling jaya', 'subang jaya', 'subang', 'puchong', 'klang',
        'gombak', 'ampang', 'rawang', 'cyberjaya', 'sepang', 'seri kembangan', 'bangi', 'kajang',
        'setia alam', 'damansara', 'usj', 'putra heights', 'ulu langat', 'kota damansara',
      ],
    };
  }
  if (/\b(kuala lumpur|\bkl\b|klcc|bukit bintang|mont kiara|cheras)\b/i.test(messageLower)) {
    return {
      mode: 'kl',
      label: 'Kuala Lumpur',
      keywords: [
        'kuala lumpur', 'klcc', 'bukit bintang', 'mont kiara', 'cheras',
        'sentul', 'wangsa maju', 'kepong', 'brickfields', 'mid valley', 'trx', 'bukit jalil',
        'titiwangsa', 'setapak',
      ],
    };
  }
  if (/\b(penang|georgetown|george town|butterworth|bayan lepas|bukit mertajam|gurney|pulau pinang)\b/i.test(messageLower)) {
    return {
      mode: 'penang',
      label: 'Penang',
      keywords: [
        'penang', 'georgetown', 'george town', 'butterworth', 'bayan lepas', 'bukit mertajam',
        'gurney', 'pulau pinang', 'tanjung tokong', 'air itam',
      ],
    };
  }
  if (/\b(johor|johor bahru|\bjb\b|iskandar|pasir gudang|kulai|batu pahat|muar|kota tinggi)\b/i.test(messageLower)) {
    return {
      mode: 'johor',
      label: 'Johor',
      keywords: [
        'johor', 'johor bahru', 'iskandar', 'pasir gudang', 'kulai', 'batu pahat', 'muar',
        'kota tinggi', 'senai', 'skudai', 'taman mount austin',
      ],
    };
  }
  if (/\b(melaka|malacca|ayer keroh|bandar hilir|klebang)\b/i.test(messageLower)) {
    return {
      mode: 'melaka',
      label: 'Melaka',
      keywords: ['melaka', 'malacca', 'ayer keroh', 'bandar hilir', 'klebang', 'bukit beruang'],
    };
  }
  if (/\b(ipoh|perak|taiping|teluk intan|kampar)\b/i.test(messageLower)) {
    return {
      mode: 'perak',
      label: 'Perak',
      keywords: ['ipoh', 'perak', 'taiping', 'teluk intan', 'kampar', 'sitiawan'],
    };
  }
  if (/\b(kota kinabalu|\bkk\b|sabah|sandakan|tawau|semporna)\b/i.test(messageLower)) {
    return {
      mode: 'sabah',
      label: 'Sabah',
      keywords: ['kota kinabalu', 'sabah', 'sandakan', 'tawau', 'semporna', 'penampang', 'likas'],
    };
  }
  if (/\b(kuching|sarawak|miri|sibu|bintulu)\b/i.test(messageLower)) {
    return {
      mode: 'sarawak',
      label: 'Sarawak',
      keywords: ['kuching', 'sarawak', 'miri', 'sibu', 'bintulu', 'petra jaya'],
    };
  }
  return { mode: 'any', label: '', keywords: [] };
}

function inferAudience(messageLower) {
  const graduation = /\bgraduation|graduate|convocation\b/i.test(messageLower);
  const friendsFun = /\b(friends?|mates?|squad|crew|buddy|buddies|group|celebrate|celebration)\b/i.test(messageLower);
  const adultSocial =
    /\b(night out|drinks?|bar|clubbing|club|happy hour|mixer|afterparty)\b/i.test(messageLower) ||
    (friendsFun && /\b(fun|party|night|hang)\b/i.test(messageLower));
  const wantsKids = /\b(kids?|children|toddler|baby|family with)\b/i.test(messageLower);
  return { graduation, friendsFun, adultSocial, wantsKids };
}

/**
 * Decide whether the latest message is REFINING the previous query (keep history context)
 * or starting a FRESH new query (drop history context).
 *
 * REFINEMENT examples — user is narrowing/adjusting the same search:
 *   "any under RM100?"         → adds price filter, no new topic
 *   "what about free ones?"    → adds free filter
 *   "how about comedy?"        → changes mood only
 *   "how about Saturday?"      → shifts date (continuation phrase + date, no new place)
 *   "any more?", "what else?"  → asking for more results
 *
 * NEW QUERY examples — user is asking something completely different:
 *   "are there any events on Wednesday?"   → new standalone date, no continuation phrase
 *   "events in Penang"                     → new place (even with "how about")
 *   "show me concerts next month"          → full new query structure
 *   "what about food festivals in KL?"     → new place always = new query
 *
 * Decision rules (in priority order):
 *  1. Message has a NEW PLACE            → always NEW  (place = strong topic reset)
 *  2. Only budget/mood changed           → always REFINE
 *  3. Continuation phrase + new date, no new place → REFINE ("how about Saturday?")
 *  4. New date, no continuation phrase   → NEW (standalone date query)
 *  5. Continuation phrase, no new filters → REFINE ("any more?", "what else?")
 *  6. Nothing new + no continuation      → NEW (fresh general query)
 */
function isRefinementQuery(message, history) {
  // Only meaningful when there's prior context to refine
  const hasHistory = Array.isArray(history) && history.some(
    (h) => h && h.role === 'user' && typeof h.content === 'string' && h.content.trim()
  );
  if (!hasHistory) return false;

  const lower = message.toLowerCase().trim();
  const intent = parseUserIntent(message);

  const hasNewDate  = intent.day?.type !== 'any';
  const hasNewPlace = intent.place?.mode !== 'any';
  const hasNewBudget = intent.budget?.type !== 'any' || Number.isFinite(intent.budget?.maxPrice);
  const hasNewMood  = hasSpecificMood(intent);

  // Rule 1: new place is always a topic reset
  if (hasNewPlace) return false;

  // --- Topic-shift detection (before mood/budget refine rules) ------------
  const newKeywords = pruneGenericTopicKeywords(extractKeywords(message, 5));
  const hasTopicKeyword = newKeywords.length > 0;

  let isTopicShift = false;
  if (hasTopicKeyword) {
    const priorKeywordSet = new Set();
    history
      .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
      .slice(-3)
      .forEach((h) => {
        pruneGenericTopicKeywords(extractKeywords(h.content, 8)).forEach((k) => priorKeywordSet.add(k));
      });
    isTopicShift = !newKeywords.some((k) => priorKeywordSet.has(k));
  }

  const hasStrongContinuation =
    /^(what about|how about|what if|any more|what else|show me (more|cheaper|other|different)|and\s+(what|how)\s+about|also|but\s+what|or\s+what)\b/i.test(lower) ||
    /\b(instead|rather|alternatively|as well|too|also|more options?|other options?|what else|anything else|any more)\b/i.test(lower);

  if (isTopicShift && !hasStrongContinuation) return false;

  // Rule 2: pure budget/mood tweak → refine ("free ones?", "any comedy?")
  if (!hasNewDate && (hasNewBudget || hasNewMood)) return true;

  // Bare "any …" is a continuation ONLY when there's no new topic word.
  // "any more?" / "any cheaper?" → continuation; "any cancer events" → fresh.
  const startsWithAny = /^any\b/i.test(lower);
  const hasContinuationPhrase =
    hasStrongContinuation ||
    (startsWithAny && !hasTopicKeyword);

  // Rule 3: continuation phrase + new date but no new place → refine
  if (hasContinuationPhrase && hasNewDate) return true;

  // Rule 4: new date without continuation phrase → new query
  if (hasNewDate && !hasContinuationPhrase) return false;

  // Rule 5: continuation phrase, no new filters → refine ("any more?", "what else?")
  if (hasContinuationPhrase) return true;

  // Rule 6: no new anything, no continuation → new standalone query
  return false;
}

/** True when the user is explicitly asking about events that already happened (not generic "last chance"). */
function isAskingAboutPast(messageLower) {
  return (
    /\b(past\s+events?|events?\s+in\s+the\s+past|in\s+the\s+past|that (already )?happened)\b/i.test(messageLower) ||
    /\b(recently\s+ended|already\s+happened|what\s+happened|what\s+was|archive|missed|did\s+i\s+miss)\b/i.test(
      messageLower,
    ) ||
    /\b(previous\s+events?|retro|throwback|historic(al)?|nostalgia)\b/i.test(messageLower) ||
    /\blast\s+year\b/i.test(messageLower) ||
    (/\blast\s+month\b/i.test(messageLower) && !/\blast\s+month\s+of\b/i.test(messageLower)) ||
    (/\blast\s+week\b/i.test(messageLower) && !/\blast\s+week\s+of\b/i.test(messageLower)) ||
    (/\blast\s+weekend\b/i.test(messageLower) && !/\blast\s+weekend\s+of\b/i.test(messageLower)) ||
    /\blast\s+night\b/i.test(messageLower) ||
    /\byesterday'?s\b/i.test(messageLower) ||
    /\b(last\s+sun(day)?|last\s+mon(day)?|last\s+tue(sday)?|last\s+wed(nesday)?|last\s+thu(rsday)?|last\s+fri(day)?|last\s+sat(urday)?)\b/i.test(
      messageLower,
    ) ||
    /\bwhat did I miss\b/i.test(messageLower) ||
    /\b(yesterday'?s\s+events?|events?\s+(from\s+)?yesterday|shows?\s+yesterday)\b/i.test(messageLower)
  );
}

function parseUserIntent(message, baseDate = new Date()) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  let dayRef = parseDayReference(lower, baseDate);
  dayRef = expandDayIfApproximate(dayRef, lower);
  const placeRef = parsePlaceFilter(lower);
  const hasDateOrPlace = dayRef.type !== 'any' || placeRef.mode !== 'any';

  const hasExplicitEventWord =
    /\b(events?|shows?|concerts?|gigs?|festivals?|recommend|things to do|what'?s on|happening|plans?|weekend|tonight|tomorrow|suggest|ideas?|something fun|fun things|what to do|celebrate|graduation|birthday|hangout|outing|plan for)\b/i.test(lower);

  // FIX: "in KL" alone (no event keyword) should NOT trigger the expensive event pipeline
  const hasPlaceOnly = placeRef.mode !== 'any' && dayRef.type === 'any' && !hasExplicitEventWord;

  const vibeAsk =
    /\b(suggest|ideas?|something fun|fun things|what to do|celebrate|graduation|birthday|hangout|outing|plan for)\b/i.test(lower);

  const eventDiscovery =
    /\b(events?|shows?|concerts?|gigs?|festivals?|recommend|things to do|what'?s on|happening|plans?|weekend|tonight|tomorrow)\b/i.test(lower) ||
    vibeAsk ||
    (hasDateOrPlace && !hasPlaceOnly);

  const bookingHelp =
    /\b(how (do|to)|what is|explain|help|booking|book|tickets?|refund|payment|checkout|cancel|account|password|this app|the site|website)\b/i.test(lower);

  const isGeneralQuestion = bookingHelp && !eventDiscovery;
  const isEventRequest = !isGeneralQuestion && eventDiscovery;

  const askingAboutPast = isAskingAboutPast(lower);

  return {
    isEventRequest,
    isGeneralQuestion,
    askingAboutPast,
    budget: parseBudget(lower),
    mood: parseMoodKeywords(lower),
    day: dayRef,
    place: placeRef,
    audience: inferAudience(lower),
    query: text,
  };
}

function eventDateISO(event) {
  const raw = String(event?.endDate || event?.date || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// FIX: only compare price numbers when currency is MYR; skip USD/SGD/etc. to avoid
// incorrect currency cross-comparisons (e.g. USD 60 failing an RM 50 filter).
function parsePriceNumber(event) {
  if (event.isFree) return 0;
  const txt = `${event.price || ''}`.toUpperCase();
  if (/\b(USD|SGD|THB|IDR|PHP)\b/.test(txt)) return null; // foreign currency — skip comparison
  const m = txt.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// FIX: treat "0.00 MYR", "0.00 USD", "Free", "RM0" etc. as free even if isFree flag is false
function isEventFree(event) {
  if (event.isFree) return true;
  const txt = `${event.price || ''}`.trim();
  if (!txt) return false;
  if (/^(free|rm\s*0|0\.00(\s*(myr|usd|sgd))?|0\s*(myr|usd)?)$/i.test(txt)) return true;
  const n = parsePriceNumber(event);
  return n === 0;
}

function eventHaystack(event) {
  return `${event.title || ''} ${event.venue || ''} ${event.city || ''} ${event.category || ''} ${event.summary || ''}`.toLowerCase();
}

function matchesPlace(hay, place) {
  if (place.mode === 'any') return true;
  if (place.mode === 'selangor' && /\bpj\b/.test(hay)) return true;
  return place.keywords.some((kw) => {
    const k = kw.trim().toLowerCase();
    return k && hay.includes(k);
  });
}

function audienceScoreAdjust(hay, audience) {
  let adj = 0;
  const kidHeavy = /\b(kids?|children|toddler|baby|cocomelon|playground|kindy|nursery|school trip|family fun day)\b/i.test(hay);
  const adultLean = /\b(concert|comedy|nightclub|club|bar|mixer|networking|festival|dj|live band|stand[- ]?up|party|gala|dinner)\b/i.test(hay);
  if ((audience.adultSocial || audience.graduation || audience.friendsFun) && !audience.wantsKids) {
    if (kidHeavy) adj -= 120;
    if (audience.graduation && adultLean) adj += 25;
    if (audience.friendsFun && adultLean) adj += 20;
    if (audience.graduation && /\b(celebrat|party|dinner|gala|night)\b/i.test(hay)) adj += 15;
  }
  if (audience.wantsKids && kidHeavy) adj += 40;
  return adj;
}

function moodScore(hay, mood) {
  if (!mood.length) return 0;
  let hits = 0;
  for (const m of mood) {
    if (eventMatchesMoodToken(hay, m)) hits += 1;
  }
  return (hits / mood.length) * 40;
}

function eventSourceKey(event) {
  return String(event?.source || event?._source || 'unknown').toLowerCase();
}

function isPlaceholderVenueText(venue) {
  const v = String(venue || '').trim().toLowerCase();
  if (!v) return true;
  if (/^(tba|tbd|tbh|n\/a|none|[?])$/i.test(v)) return true;
  if (/^(to be announced|to be confirmed|venue tba|location tba)\b/i.test(v)) return true;
  if (/\b(tba|tbd|tbh)\b$/i.test(v)) return true;
  return false;
}

/** Legacy DB rows: hide Ticketmelon listings that are clearly not priced in MYR/RM. */
function ticketmelonStrictCatalog(event) {
  if (eventSourceKey(event) !== 'ticketmelon') return true;
  const p = String(event.price || '').trim();
  if (/\b(THB|SGD|PHP|IDR|USD|VND|EUR|AUD|GBP|HKD|TWD|JPY|KRW|CNY)\b/i.test(p)) return false;
  if (isEventFree(event)) return true;
  if (!p) return false;
  if (/^free$/i.test(p) || /\b(myr|rm)\b/i.test(p)) return true;
  return false;
}

/** Slight boost so RAG ordering is not dominated by one platform; Ticketmelon is not boosted (often floods vector hits). */
function sourceDiversityBoost(event) {
  const s = eventSourceKey(event);
  if (s === 'ticket2u' || s === 'goliveasia') return 4;
  if (s === 'peatix') return 3;
  if (s === 'eventbrite') return 2;
  if (s === 'ticketmelon') return 0;
  return 1;
}

function rankEvents(events, intent) {
  const searchKeywords = Array.isArray(intent?.searchKeywords) ? intent.searchKeywords : [];
  return events
    .map((event) => {
      const hay = eventHaystack(event);
      let score = 50 + moodScore(hay, intent.mood || []);
      score += audienceScoreAdjust(hay, intent.audience || {});
      score += keywordMatchScore(event, searchKeywords);
      if (isEventFree(event) && intent.budget?.type === 'free') score += 15;
      score += sourceDiversityBoost(event);
      return { event, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.event);
}

function normalizeUrlForDedupe(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\s+/g, '');
  }
}

/** Drop duplicate listings (same URL, or same source+title+date without URL). */
function dedupeEventsForRecommendations(events) {
  if (!Array.isArray(events) || !events.length) return [];
  const seenUrl = new Set();
  const seenLoose = new Set();
  const out = [];
  for (const e of events) {
    const nu = normalizeUrlForDedupe(e.url || '');
    if (nu) {
      if (seenUrl.has(nu)) continue;
      seenUrl.add(nu);
      out.push(e);
      continue;
    }
    const loose = `${eventSourceKey(e)}|${String(e.title || '')
      .toLowerCase()
      .slice(0, 96)}|${eventDateISO(e) || ''}`;
    if (seenLoose.has(loose)) continue;
    seenLoose.add(loose);
    out.push(e);
  }
  return out;
}

/**
 * Re-order so multiple sources appear in recommendations (round-robin by source),
 * while roughly preserving relevance order inside each source bucket.
 * @param {object} [options] - optional maxPerSource caps, preferredOrder, backfillUncapped
 */
function diversifyBySource(events, limit = 15, options = {}) {
  if (!Array.isArray(events) || !events.length) return [];
  const preferredOrder =
    options.preferredOrder || ['ticket2u', 'goliveasia', 'eventbrite', 'peatix', 'ticketmelon'];
  const maxPerSource = options.maxPerSource && typeof options.maxPerSource === 'object' ? options.maxPerSource : null;
  const buckets = new Map();
  for (const ev of events) {
    const k = eventSourceKey(ev);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(ev);
  }
  const keys = [
    ...preferredOrder.filter((k) => buckets.has(k)),
    ...[...buckets.keys()].filter((k) => !preferredOrder.includes(k)),
  ];
  const out = [];
  const used = new Map();
  let stagnant = 0;
  const capStagnant = maxPerSource ? keys.length + 10 : keys.length + 2;

  while (out.length < limit && stagnant < capStagnant) {
    let progressed = false;
    for (const k of keys) {
      if (maxPerSource && Object.prototype.hasOwnProperty.call(maxPerSource, k)) {
        if ((used.get(k) || 0) >= maxPerSource[k]) continue;
      }
      const arr = buckets.get(k);
      if (arr?.length && out.length < limit) {
        out.push(arr.shift());
        used.set(k, (used.get(k) || 0) + 1);
        progressed = true;
      }
    }
    if (!progressed) stagnant += 1;
    else stagnant = 0;
  }

  if (out.length < limit && maxPerSource) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(maxPerSource, k)) continue;
      const arr = buckets.get(k);
      while (arr?.length && out.length < limit) {
        out.push(arr.shift());
      }
    }
  }

  return out;
}

function eventIdentityKey(e) {
  const u = normalizeUrlForDedupe(e.url || '');
  if (u) return `u:${u}`;
  return `k:${eventSourceKey(e)}|${String(e.title || '')
    .toLowerCase()
    .slice(0, 96)}|${eventDateISO(e) || ''}`;
}

/**
 * Upcoming-only: must have a parseable date on or after today.
 * Undated rows cannot be proven future — excluded from discovery/recommendations.
 */
function filterFutureEvents(events, baseDate = new Date()) {
  if (!Array.isArray(events) || !events.length) return [];
  const todayStr = todayISO(baseDate);
  return events.filter((e) => {
    const ed = eventDateISO(e);
    return ed != null && ed >= todayStr;
  });
}

function countBySourceInList(list) {
  const c = {};
  for (const e of list) {
    const s = eventSourceKey(e);
    c[s] = (c[s] || 0) + 1;
  }
  return c;
}

/**
 * When vector search returns one source only, merge in upcoming events from the full catalog
 * so ranking/diversification has Eventbrite, Ticket2U, etc. to choose from.
 */
function mergeRagPoolForSourceDiversity(ragEvents, catalogFutureDeduped, opts = {}) {
  const maxPool = opts.maxPool ?? 80;
  const floorPerSource = opts.floorPerSource ?? 4;
  const prioritySources = ['eventbrite', 'ticket2u', 'goliveasia', 'peatix', 'ticketmelon'];

  const seen = new Set();
  const out = [];
  function add(e) {
    if (!e) return false;
    const k = eventIdentityKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    out.push(e);
    return true;
  }

  for (const e of ragEvents) {
    add(e);
    if (out.length >= maxPool) return out;
  }

  const catalogBy = new Map();
  for (const s of prioritySources) catalogBy.set(s, []);
  const otherKey = '_other';
  catalogBy.set(otherKey, []);
  for (const e of catalogFutureDeduped) {
    const s = eventSourceKey(e);
    if (catalogBy.has(s)) catalogBy.get(s).push(e);
    else catalogBy.get(otherKey).push(e);
  }

  for (const s of prioritySources) {
    const arr = catalogBy.get(s);
    while (out.length < maxPool && arr.length) {
      const c = countBySourceInList(out);
      if ((c[s] || 0) >= floorPerSource) break;
      add(arr.shift());
    }
  }

  let guard = 0;
  while (out.length < maxPool && guard < prioritySources.length * 400) {
    guard += 1;
    let progressed = false;
    for (const s of prioritySources) {
      if (out.length >= maxPool) break;
      const arr = catalogBy.get(s);
      if (!arr.length) continue;
      if (add(arr.shift())) progressed = true;
    }
    if (!progressed) break;
  }

  const rest = catalogBy.get(otherKey);
  while (out.length < maxPool && rest.length) {
    if (!add(rest.shift())) break;
  }

  return out;
}

function poolNeedsSourceBlend(pool) {
  if (!Array.isArray(pool) || pool.length < 8) return true;
  const c = countBySourceInList(pool);
  const keys = Object.keys(c);
  if (keys.length < 2) return true;
  const maxShare = Math.max(...Object.values(c)) / pool.length;
  return maxShare > 0.42;
}

function selectDiverseRecommendations(pool, intent, limit = 15) {
  if (!Array.isArray(pool) || !pool.length) return [];
  if (!(intent && intent.askingAboutPast === true)) {
    pool = filterFutureEvents(pool);
  }
  pool = pool.filter((e) => {
    if (eventSourceKey(e) !== 'ticketmelon') return true;
    return ticketmelonStrictCatalog(e) && !isPlaceholderVenueText(e.venue);
  });
  if (Array.isArray(intent?.mood) && intent.mood.length) {
    pool = applyMoodHardFilter(pool, intent.mood);
  }
  if (!pool.length) return [];
  const ranked = rankEvents(pool, intent || {});
  const breadth = Math.min(Math.max(limit * 5, 50), ranked.length);
  const slice = ranked.slice(0, breadth);
  const divOpts = {
    maxPerSource: { ticketmelon: 3 },
    preferredOrder: ['ticket2u', 'goliveasia', 'eventbrite', 'peatix', 'ticketmelon'],
  };
  return diversifyBySource(slice, limit, divOpts);
}

function pickWeekendBalanced(ranked, intent, limit) {
  const dates = intent.day?.dates || [];
  if (dates.length < 2) return ranked.slice(0, limit);
  const [sat, sun] = dates;
  const satList = ranked.filter((e) => eventDateISO(e) === sat);
  const sunList = ranked.filter((e) => eventDateISO(e) === sun);
  const out = [];
  let i = 0;
  while (out.length < limit && (satList.length || sunList.length)) {
    if (i % 2 === 0 && satList.length) out.push(satList.shift());
    else if (i % 2 === 1 && sunList.length) out.push(sunList.shift());
    else if (satList.length) out.push(satList.shift());
    else if (sunList.length) out.push(sunList.shift());
    i++;
  }
  return out;
}

function filterEventsByPreferences(events, preferences, baseDate = new Date()) {
  const mood = Array.isArray(preferences?.mood) ? preferences.mood : [];
  const dayDates = new Set(preferences?.day?.dates || []);
  const hasDateFilter = dayDates.size > 0;
  const budget = preferences?.budget || { type: 'any', maxPrice: null };
  const place = preferences?.place || { mode: 'any', keywords: [] };
  const hasPlaceFilter = place.mode !== 'any';

  // FIX: unless the user is specifically asking about past events, filter out events
  // that have already passed (date < today).
  const askingAboutPast = preferences?.askingAboutPast === true;
  const todayStr = todayISO(baseDate);

  let out = events.filter((event) => {
    const ed = eventDateISO(event);

    // --- Past / upcoming filter ---
    if (!askingAboutPast) {
      if (hasDateFilter) {
        if (!ed || !dayDates.has(ed)) return false;
        // Named a calendar day: never return that day if it is already in the past
        if (ed < todayStr) return false;
      } else {
        // Suggestions / open-ended: only events we can date as today or later
        if (!ed || ed < todayStr) return false;
      }
    } else {
      // Asking about past: still apply date filter if present
      if (hasDateFilter && (!ed || !dayDates.has(ed))) return false;
    }

    // FIX: use isEventFree() so "0.00 MYR" events pass the free filter
    if (budget.type === 'free' && !isEventFree(event)) return false;

    // FIX: parsePriceNumber now returns null for foreign currencies, so cross-currency
    // comparisons are skipped cleanly (Number.isFinite(null) === false)
    const eventPrice = parsePriceNumber(event);
    if (Number.isFinite(budget.maxPrice) && Number.isFinite(eventPrice) && eventPrice > budget.maxPrice) {
      return false;
    }

    if (mood.length) {
      if (!eventPassesMoodFilter(event, mood)) return false;
    }

    if (hasPlaceFilter && !matchesPlace(eventHaystack(event), place)) return false;

    if (eventSourceKey(event) === 'ticketmelon' && !ticketmelonStrictCatalog(event)) return false;

    if (eventSourceKey(event) === 'ticketmelon' && isPlaceholderVenueText(event.venue)) return false;

    return true;
  });

  out = dedupeEventsForRecommendations(out);
  const ranked = rankEvents(out, preferences);
  const limit = 15;
  let picked;
  if (preferences?.day?.type === 'weekend' || preferences?.day?.type === 'next_weekend') {
    picked = pickWeekendBalanced(ranked, preferences, limit);
  } else {
    picked = ranked.slice(0, limit);
  }
  if (Array.isArray(preferences?.searchKeywords) && preferences.searchKeywords.length > 0) {
    return picked;
  }
  return diversifyBySource(picked, limit, {
    maxPerSource: { ticketmelon: 3 },
    preferredOrder: ['ticket2u', 'goliveasia', 'eventbrite', 'peatix', 'ticketmelon'],
  });
}

/**
 * Build context string for intent parsing from recent history.
 *
 * FIX (multi-turn context bleed): Reduced history window from 4 → 3 user turns and
 * capped at 2000 chars (was 4000).  This prevents stale filters from early messages
 * contaminating later, unrelated queries after 2-3 conversation turns.
 */
function buildIntentContext(message, history) {
  if (!Array.isArray(history) || !history.length) return message;
  const userLines = history
    .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
    .map((h) => h.content.trim())
    .slice(-3); // was -4; reduced to limit stale-context accumulation
  const combined = [...userLines, message].filter(Boolean).join(' \n ');
  return combined.slice(-2000); // was -4000
}

/**
 * Extract candidate keywords from a user message for SQL ILIKE keyword search.
 * Strips common English stopwords + chatbot-specific filler ("show me", "any", "events"),
 * removes operator/date words (since those go to the date parser), keeps meaningful nouns/adjectives.
 *
 * Returns up to `limit` keywords (3+ chars), de-duplicated, lowercased.
 * Returns [] if no usable keywords (e.g. pure date query like "events tomorrow").
 * Day ordinals like "17th" / "3rd" are skipped — they belong to date parsing only.
 */
const KEYWORD_STOPWORDS = new Set([
  // pronouns / determiners / aux
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours', 'he', 'she', 'it', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'a', 'an', 'the', 'some', 'any', 'all', 'every', 'each', 'no', 'none', 'not',
  'there', 'here', 'also', 'just', 'only', 'still', 'really', 'very', 'much', 'many', 'few', 'more', 'most', 'less',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'have', 'has', 'had',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  // prepositions / conjunctions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about', 'as', 'into', 'like', 'over', 'under',
  'and', 'or', 'but', 'if', 'so', 'than', 'then', 'because', 'while', 'though', 'unless',
  // chatbot fillers / question words
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'show', 'find', 'tell', 'give', 'recommend', 'suggest', 'help', 'looking', 'look', 'want', 'need', 'wanted',
  'please', 'pls', 'plz', 'kindly', 'thanks', 'thank', 'okay', 'ok', 'yes', 'yeah', 'yep', 'sure', 'maybe',
  'hi', 'hey', 'hello', 'yo', 'sup',
  // filler verbs of intent / attendance — these get extracted as "topics"
  // otherwise and pollute the strict filter ("take" matches half the catalog)
  'wanna', 'wanted', 'wants', 'wanting', 'gonna', 'gotta',
  'take', 'taking', 'took', 'bring', 'bringing', 'brought',
  'go', 'going', 'gone', 'come', 'coming', 'came',
  'attend', 'attending', 'attended', 'join', 'joining', 'joined',
  'visit', 'visiting', 'visited', 'see', 'seeing', 'watch', 'watching',
  'check', 'checking', 'checkout',
  // generic event words (these wouldn't help — every row contains them)
  'event', 'events', 'show', 'shows', 'thing', 'things', 'something', 'anything', 'stuff', 'happen', 'happening',
  // audience words — handled by parseMoodKeywords + inferAudience with
  // BROADER synonym matching ("family"/"all ages"/"junior"/"disney"/etc).
  // If we keep them as topic keywords the strict filter requires the
  // literal word "kid" in the title, which most family events don't have.
  'kid', 'kids', 'child', 'children', 'toddler', 'baby', 'infant',
  'family', 'families', 'parent', 'parents', 'mom', 'dad', 'mum',
  'son', 'daughter', 'junior', 'youth',
  // operator/date words — handled by date parser, not keyword search
  'before', 'after', 'until', 'till', 'since', 'between', 'during',
  'today', 'tomorrow', 'tonight', 'yesterday', 'weekend', 'weekday', 'week', 'month', 'year', 'day',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'next', 'last', 'upcoming', 'coming', 'past', 'previous',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // budget/place words — handled by their own parsers
  'free', 'paid', 'cheap', 'cheaper', 'cheapest', 'affordable', 'expensive', 'pricier', 'priciest',
  'rm', 'myr', 'price', 'priced', 'cost', 'costs', 'fee', 'budget',
  'near', 'nearby', 'around',
  // refinement filler nouns ("free ones?", "any options?", "show others")
  'one', 'ones', 'option', 'options', 'kind', 'kinds', 'sort', 'sorts', 'type', 'types',
  'other', 'others', 'different', 'similar',
]);

function extractKeywords(message, limit = 5) {
  if (!message || typeof message !== 'string') return [];
  const cleaned = message
    .toLowerCase()
    .replace(/[^a-z0-9\s\-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(/\s+/);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const word = t.replace(/^['-]+|['-]+$/g, '');
    if (word.length < 3) continue;
    if (/^\d+$/.test(word)) continue;       // pure numbers go to date parser
    // Day ordinals ("17th", "3rd", "21st") — handled by the date parser, not
    // topic search. If we keep them, the strict keyword pre-filter on the
    // date branch shrinks the pool to rows that literally contain "17th" in
    // text, which is almost always empty → "no events" for normal questions.
    if (/^\d{1,2}(st|nd|rd|th)$/i.test(word)) continue;
    if (KEYWORD_STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/** Generic event-type words that should not narrow search when a specific topic is present. */
const GENERIC_TOPIC_KEYWORDS = new Set([
  'concert', 'concerts', 'festival', 'festivals',
  'gig', 'gigs', 'show', 'shows',
  'tour', 'touring', 'performance', 'performances',
  'happening', 'upcoming', 'event', 'events',
]);

/**
 * Drop generic type words (concert, festival, …) when the user also named a specific
 * topic (BTS, cancer, jazz). Prevents "bts concert" from strict-filtering to any
 * row containing "concert" and drowning out the artist match.
 */
function pruneGenericTopicKeywords(keywords) {
  if (!Array.isArray(keywords) || keywords.length <= 1) return keywords || [];
  const specific = keywords.filter((k) => !GENERIC_TOPIC_KEYWORDS.has(String(k).toLowerCase()));
  return specific.length > 0 ? specific : keywords;
}

/** Mood filters that are just generic event types, not real vibe refinements. */
function hasSpecificMood(intent) {
  if (!Array.isArray(intent?.mood) || !intent.mood.length) return false;
  return intent.mood.some((m) => !GENERIC_TOPIC_KEYWORDS.has(String(m).toLowerCase()));
}

/** Remove generic type moods (concert, music, …) when a specific topic keyword is active. */
function stripGenericMoodForTopicSearch(intent) {
  if (!intent || !Array.isArray(intent.mood) || !intent.mood.length) return;
  intent.mood = intent.mood.filter((m) => !GENERIC_TOPIC_KEYWORDS.has(String(m).toLowerCase()));
}

/** Rich text for mood matching (includes description — many food events only mention it there). */
function moodFilterHaystack(event) {
  return `${event.title || ''} ${event.description || ''} ${event.category || ''} ${event.summary || ''} ${
    event.venue || ''
  } ${event.city || ''}`.toLowerCase();
}

function eventPassesMoodFilter(event, mood) {
  if (!Array.isArray(mood) || !mood.length) return true;
  const hay = moodFilterHaystack(event);
  return mood.some((token) => eventMatchesMoodToken(hay, token));
}

function applyMoodHardFilter(events, mood) {
  if (!Array.isArray(events) || !events.length) return [];
  if (!Array.isArray(mood) || !mood.length) return events;
  return events.filter((e) => eventPassesMoodFilter(e, mood));
}

/** Mood tokens used for SQL/vector search when no proper-noun keywords remain. */
function moodSearchTerms(intent) {
  if (!hasSpecificMood(intent)) return [];
  return intent.mood.filter((m) => !GENERIC_TOPIC_KEYWORDS.has(String(m).toLowerCase()));
}

function stripMoodWordsFromTopicKeywords(keywords, mood) {
  if (!Array.isArray(keywords) || !keywords.length || !Array.isArray(mood) || !mood.length) {
    return keywords || [];
  }
  const moodSet = new Set(mood.map((m) => String(m).toLowerCase()));
  return keywords.filter((k) => !moodSet.has(String(k).toLowerCase()));
}

function keywordMatchScore(event, keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return 0;
  const title = String(event.title || '').toLowerCase();
  const hay = eventHaystack(event);
  let score = 0;
  for (const kw of keywords) {
    const k = String(kw).toLowerCase();
    if (!k) continue;
    if (title.includes(k)) score += 90;
    else if (hay.includes(k)) score += 40;
  }
  return score;
}

/** When a place filter is active, drop place tokens from topic keywords (place parser handles location). */
function stripPlaceFromTopicKeywords(keywords, place) {
  if (!Array.isArray(keywords) || !keywords.length) return [];
  if (!place || place.mode === 'any' || !Array.isArray(place.keywords) || !place.keywords.length) {
    return keywords;
  }
  const placeTerms = place.keywords
    .map((k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter((k) => k.length >= 2);
  const filtered = keywords.filter((kw) => {
    const nk = String(kw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!nk) return false;
    return !placeTerms.some((pt) => nk === pt || nk.includes(pt) || pt.includes(nk));
  });
  return filtered.length > 0 ? filtered : keywords;
}

/** Topic-focused picks: rank by keyword/title match — skip source round-robin. */
function selectKeywordFocusedRecommendations(pool, intent, limit = 15) {
  if (!Array.isArray(pool) || !pool.length) return [];
  if (!(intent && intent.askingAboutPast === true)) {
    pool = filterFutureEvents(pool);
  }
  pool = pool.filter((e) => {
    if (eventSourceKey(e) !== 'ticketmelon') return true;
    return ticketmelonStrictCatalog(e) && !isPlaceholderVenueText(e.venue);
  });
  if (Array.isArray(intent?.mood) && intent.mood.length) {
    pool = applyMoodHardFilter(pool, intent.mood);
  }
  if (!pool.length) return [];
  return rankEvents(pool, intent || {}).slice(0, limit);
}

module.exports = {
  calculateNextDate,
  parseUserIntent,
  filterEventsByPreferences,
  buildIntentContext,
  isRefinementQuery,
  isEventFree,
  eventDateISO,
  todayISO,
  dedupeEventsForRecommendations,
  diversifyBySource,
  filterFutureEvents,
  mergeRagPoolForSourceDiversity,
  poolNeedsSourceBlend,
  selectDiverseRecommendations,
  parseBareOrdinal,
  extractKeywords,
  pruneGenericTopicKeywords,
  stripGenericMoodForTopicSearch,
  stripPlaceFromTopicKeywords,
  selectKeywordFocusedRecommendations,
  applyMoodHardFilter,
  stripMoodWordsFromTopicKeywords,
  hasSpecificMood,
  moodSearchTerms,
};