'use strict';

/** Shared DNA trait keys (user_dna + event_dna). */
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

const TRAIT_LABELS = {
  social: 'Social',
  entertainment: 'Entertainment',
  educational: 'Educational',
  budget_friendly: 'Budget friendly',
  outdoor: 'Outdoor',
  energy_level: 'Energy level',
  family_friendly: 'Family friendly',
  networking: 'Networking',
};

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(10, Math.max(1, Math.round(x)));
}

/** Normalize a DNA object to 8 traits (1–10), or null if empty/invalid. */
function normalizeDna(dna) {
  if (!dna || typeof dna !== 'object') return null;
  const out = {};
  let hasAny = false;
  for (const key of DNA_KEYS) {
    const v = clampScore(dna[key]);
    if (v != null) {
      out[key] = v;
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

function traitCloseness(userVal, eventVal) {
  return Math.max(0, 10 - Math.abs(userVal - eventVal));
}

function alignmentLabel(closeness) {
  if (closeness >= 9) return 'excellent';
  if (closeness >= 7) return 'strong';
  if (closeness >= 5) return 'moderate';
  if (closeness >= 3) return 'weak';
  return 'poor';
}

function buildTraitReason(trait, userVal, eventVal, closeness) {
  const label = TRAIT_LABELS[trait] || trait;
  const align = alignmentLabel(closeness);
  if (closeness >= 9) {
    return `${label}: Your taste is ${userVal}/10 and this event is ${eventVal}/10 — an ${align} match on ${label.toLowerCase()}.`;
  }
  if (eventVal > userVal + 2) {
    return `${label}: This event leans higher (${eventVal}/10) than your profile (${userVal}/10) — you might enjoy the extra ${label.toLowerCase()}.`;
  }
  if (eventVal < userVal - 2) {
    return `${label}: You prefer around ${userVal}/10 but this event scores ${eventVal}/10 — a weaker fit on ${label.toLowerCase()}.`;
  }
  return `${label}: ${align} fit (you ${userVal}/10, event ${eventVal}/10).`;
}

/**
 * Compare user DNA vs event DNA. Pure math — no I/O.
 * @returns {{ score: number|null, percent: number|null, complete: boolean, traits: object[], summary: string, reasons: string[], topMatches: object[], gaps: object[] }}
 */
function calculateDnaMatch(userDna, eventDna) {
  const user = normalizeDna(userDna);
  const event = normalizeDna(eventDna);
  if (!user || !event) {
    return {
      score: null,
      percent: null,
      complete: false,
      traits: [],
      summary: 'DNA match unavailable — missing user or event profile.',
      reasons: [],
      topMatches: [],
      gaps: [],
    };
  }

  const traits = [];
  let totalCloseness = 0;

  for (const key of DNA_KEYS) {
    const userVal = user[key] != null ? user[key] : 5;
    const eventVal = event[key] != null ? event[key] : 5;
    const closeness = traitCloseness(userVal, eventVal);
    const percent = Math.round((closeness / 10) * 100);
    traits.push({
      trait: key,
      label: TRAIT_LABELS[key],
      userScore: userVal,
      eventScore: eventVal,
      closeness,
      percent,
      alignment: alignmentLabel(closeness),
      reason: buildTraitReason(key, userVal, eventVal, closeness),
    });
    totalCloseness += closeness;
  }

  const score = Math.round((totalCloseness / DNA_KEYS.length) * 10);

  const byCloseness = traits.slice().sort((a, b) => b.closeness - a.closeness);
  const topMatches = byCloseness.filter((t) => t.closeness >= 7).slice(0, 3);
  const gaps = byCloseness
    .filter((t) => t.closeness <= 4)
    .slice(0, 3);

  const reasons = [];
  if (topMatches.length) {
    reasons.push(
      'Why this fits you: strong alignment on ' +
        topMatches.map((t) => `${t.label.toLowerCase()} (${t.percent}%)`).join(', ') +
        '.',
    );
  }
  if (gaps.length) {
    reasons.push(
      'Trade-offs: ' +
        gaps
          .map((t) => `${t.label.toLowerCase()} (you want ~${t.userScore}, event is ${t.eventScore})`)
          .join('; ') +
        '.',
    );
  }
  reasons.push(
    `Overall ${score}% match — we compared your DNA profile to this event across ${DNA_KEYS.length} taste dimensions.`,
  );

  const summary = topMatches.length
    ? `${score}% match — especially strong on ${topMatches.map((t) => t.label.toLowerCase()).join(' and ')}.`
    : `${score}% DNA match based on your profile.`;

  return {
    score,
    percent: score,
    complete: true,
    traits,
    summary,
    reasons,
    topMatches: topMatches.map((t) => ({
      trait: t.trait,
      label: t.label,
      percent: t.percent,
      reason: t.reason,
    })),
    gaps: gaps.map((t) => ({
      trait: t.trait,
      label: t.label,
      userScore: t.userScore,
      eventScore: t.eventScore,
      reason: t.reason,
    })),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DNA_KEYS,
    TRAIT_LABELS,
    normalizeDna,
    calculateDnaMatch,
  };
}
if (typeof window !== 'undefined') {
  window.calculateDnaMatch = calculateDnaMatch;
  window.normalizeDna = normalizeDna;
  window.DNA_MATCH_KEYS = DNA_KEYS;
  window.DNA_TRAIT_LABELS = TRAIT_LABELS;
}
