'use strict';

/** Canonical Fan DNA option ids (stored in user_preferences). */
const FAN_DNA_CATEGORIES = [
  'music',
  'sports',
  'food_drink',
  'arts_culture',
  'technology',
  'nature_outdoors',
  'comedy',
  'networking',
];

const FAN_DNA_VIBES = [
  'chill_relaxed',
  'high_energy',
  'social_meetup',
  'educational',
  'family_friendly',
];

const FAN_DNA_EVENT_SIZES = ['intimate', 'medium', 'large', 'massive'];

const FAN_DNA_TRAVEL = ['5km', '10km', '25km', '50km', 'any'];

const FAN_DNA_TIMES = ['morning', 'afternoon', 'evening', 'late_night'];

const FAN_DNA_BUDGETS = ['free', 'under_50', '50_150', '150_plus'];

// Crowd-signal fields (Feature 4 — Social Compatibility).
const FAN_DNA_PROFESSIONS = ['working', 'student', 'other'];

const FAN_DNA_AGE_GROUPS = ['under_18', '18_24', '25_34', '35_44', '45_plus'];

const SCORE_WEIGHTS = {
  category: 40,
  vibe: 20,
  size: 15,
  time: 15,
  budget: 10,
};

const CATEGORY_KEYWORDS = {
  music: /\b(music|concert|gig|dj|band|live\s*show|festival|k-pop|jazz|rock|pop|symphony|orchestra)\b/i,
  sports: /\b(sport|football|soccer|marathon|run\b|running|fitness|gym|badminton|futsal|triathlon|cycling|yoga)\b/i,
  food_drink: /\b(food|drink|wine|beer|coffee|brunch|dining|culinary|market|bazaar|ramadan|iftar|tasting)\b/i,
  arts_culture: /\b(art|arts|culture|theatre|theater|gallery|exhibition|museum|dance|ballet|wayang|heritage)\b/i,
  technology: /\b(tech|technology|startup|coding|hackathon|ai\b|digital|innovation|developer|data\s*science)\b/i,
  nature_outdoors: /\b(nature|outdoor|hike|hiking|trail|park|eco|garden|beach|camping|wildlife|green)\b/i,
  comedy: /\b(comedy|stand[- ]?up|comedian|laugh|humou?r)\b/i,
  networking: /\b(network|networking|meetup|business|entrepreneur|professional|conference|summit|seminar)\b/i,
};

const VIBE_KEYWORDS = {
  chill_relaxed: /\b(chill|relaxed|calm|slow|acoustic|sunset|lounge|zen|meditat)\b/i,
  high_energy: /\b(energy|energetic|rave|party|club|nightlife|edm|festival|marathon|competition)\b/i,
  social_meetup: /\b(social|meetup|community|gathering|friends|mixer|connect)\b/i,
  educational: /\b(learn|workshop|class|course|talk|lecture|seminar|training|masterclass)\b/i,
  family_friendly: /\b(family|kids|children|parent|all\s*ages|kid)\b/i,
};

const SIZE_KEYWORDS = {
  intimate: /\b(intimate|small\s*group|workshop|masterclass|private)\b/i,
  medium: /\b(medium|hall|lounge|studio)\b/i,
  large: /\b(large|convention|expo|ballroom|auditorium)\b/i,
  massive: /\b(arena|stadium|mega|massive|thousand|10k|festival\s*grounds)\b/i,
};

function normList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
}

function blob(event) {
  return [
    event && event.title,
    event && event.category,
    event && event.summary,
    event && event.description,
    event && event.venue,
    event && event.city,
  ]
    .filter(Boolean)
    .join(' ');
}

function inferEventCategories(event) {
  const text = blob(event);
  const out = [];
  FAN_DNA_CATEGORIES.forEach((id) => {
    if (CATEGORY_KEYWORDS[id] && CATEGORY_KEYWORDS[id].test(text)) out.push(id);
  });
  const raw = String((event && event.category) || '').toLowerCase();
  if (/music|concert/.test(raw)) pushUnique(out, 'music');
  if (/sport|fitness/.test(raw)) pushUnique(out, 'sports');
  if (/food|market/.test(raw)) pushUnique(out, 'food_drink');
  if (/art|theatre|culture/.test(raw)) pushUnique(out, 'arts_culture');
  if (/tech|talk/.test(raw)) pushUnique(out, 'technology');
  if (/wellness|outdoor|nature/.test(raw)) pushUnique(out, 'nature_outdoors');
  if (/comedy/.test(raw)) pushUnique(out, 'comedy');
  if (/network|business|conference/.test(raw)) pushUnique(out, 'networking');
  if (!out.length) out.push('arts_culture');
  return out;
}

function pushUnique(arr, v) {
  if (arr.indexOf(v) === -1) arr.push(v);
}

function inferEventVibes(event) {
  const text = blob(event);
  const out = [];
  FAN_DNA_VIBES.forEach((id) => {
    if (VIBE_KEYWORDS[id] && VIBE_KEYWORDS[id].test(text)) out.push(id);
  });
  if (!out.length) {
    if (/\b(family|kids)\b/i.test(text)) out.push('family_friendly');
    else if (/\b(party|club|night)\b/i.test(text)) out.push('high_energy');
    else out.push('social_meetup');
  }
  return out;
}

function inferEventSize(event) {
  const text = blob(event);
  if (SIZE_KEYWORDS.massive.test(text)) return 'massive';
  if (SIZE_KEYWORDS.large.test(text)) return 'large';
  if (SIZE_KEYWORDS.intimate.test(text)) return 'intimate';
  if (SIZE_KEYWORDS.medium.test(text)) return 'medium';
  if (/\b(festival|expo|convention)\b/i.test(text)) return 'large';
  return 'medium';
}

function inferEventTimeSlot(event) {
  const text = blob(event);
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[3].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h >= 5 && h < 12) return 'morning';
    if (h >= 12 && h < 17) return 'afternoon';
    if (h >= 17 && h < 22) return 'evening';
    return 'late_night';
  }
  if (/\b(morning|breakfast|brunch)\b/i.test(text)) return 'morning';
  if (/\b(afternoon|lunch)\b/i.test(text)) return 'afternoon';
  if (/\b(late\s*night|midnight|after\s*hours)\b/i.test(text)) return 'late_night';
  if (/\b(evening|night|sunset|dinner)\b/i.test(text)) return 'evening';
  return 'evening';
}

function inferEventBudgetTier(event) {
  if (event && (event.isFree || event.is_free)) return 'free';
  const price = String((event && event.price) || '').toLowerCase();
  if (!price || price === 'free' || price.includes('free')) return 'free';
  const nums = price.match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return '50_150';
  const val = Math.max.apply(
    null,
    nums.map((n) => parseFloat(n)),
  );
  if (!Number.isFinite(val) || val <= 0) return 'free';
  if (val < 50) return 'under_50';
  if (val <= 150) return '50_150';
  return '150_plus';
}

/**
 * @param {object} event scraped/API event row
 * @param {object} userPreferences row from user_preferences
 * @returns {number} 0-100
 */
function calculateFanDNAScore(event, userPreferences) {
  if (!userPreferences || !normList(userPreferences.categories).length) return 0;

  const prefs = {
    categories: normList(userPreferences.categories),
    vibes: normList(userPreferences.vibes),
    event_size: String(userPreferences.event_size || '').toLowerCase(),
    travel_distance: String(userPreferences.travel_distance || '').toLowerCase(),
    preferred_time: normList(userPreferences.preferred_time),
    budget: String(userPreferences.budget || '').toLowerCase(),
  };

  let score = 0;

  const evCats = inferEventCategories(event);
  if (prefs.categories.some((c) => evCats.indexOf(c) >= 0)) score += SCORE_WEIGHTS.category;

  const evVibes = inferEventVibes(event);
  if (prefs.vibes.some((v) => evVibes.indexOf(v) >= 0)) score += SCORE_WEIGHTS.vibe;

  const evSize = inferEventSize(event);
  if (prefs.event_size && prefs.event_size === evSize) score += SCORE_WEIGHTS.size;

  const evTime = inferEventTimeSlot(event);
  if (prefs.preferred_time.length && prefs.preferred_time.indexOf(evTime) >= 0) {
    score += SCORE_WEIGHTS.time;
  }

  const evBudget = inferEventBudgetTier(event);
  if (prefs.budget && prefs.budget === evBudget) score += SCORE_WEIGHTS.budget;

  return Math.min(100, Math.max(0, Math.round(score)));
}

function fanDnaProfileComplete(prefs) {
  if (!prefs) return false;
  return normList(prefs.categories).length > 0 && Boolean(String(prefs.budget || '').trim());
}

module.exports = {
  FAN_DNA_CATEGORIES,
  FAN_DNA_VIBES,
  FAN_DNA_EVENT_SIZES,
  FAN_DNA_TRAVEL,
  FAN_DNA_TIMES,
  FAN_DNA_BUDGETS,
  FAN_DNA_PROFESSIONS,
  FAN_DNA_AGE_GROUPS,
  SCORE_WEIGHTS,
  calculateFanDNAScore,
  fanDnaProfileComplete,
  inferEventCategories,
  inferEventVibes,
  inferEventSize,
  inferEventTimeSlot,
  inferEventBudgetTier,
};
