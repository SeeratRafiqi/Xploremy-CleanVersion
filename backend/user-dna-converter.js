'use strict';

require('dotenv').config();

const db = require('./db');

function convertPreferencesToDNA(prefs) {
  const categories = prefs.categories || [];
  const vibes = prefs.vibes || [];
  const budget = prefs.budget || '';
  const distance = prefs.travel_distance || '';
  const eventSize = (prefs.event_size || '').toLowerCase();
  const preferredTime = prefs.preferred_time || [];

  // SOCIAL score
  let social = 5;
  if (vibes.includes('social_meetup')) social += 3;
  if (eventSize === 'large' || eventSize === 'massive' || eventSize === 'festival mode') social += 2;
  if (eventSize === 'intimate' || eventSize === 'just us') social -= 2;
  if (categories.includes('networking')) social += 2;
  social = Math.min(10, Math.max(1, social));

  // ENTERTAINMENT score
  let entertainment = 5;
  if (categories.includes('music')) entertainment += 3;
  if (categories.includes('comedy')) entertainment += 2;
  if (vibes.includes('high_energy')) entertainment += 2;
  if (categories.includes('arts_culture')) entertainment += 1;
  if (preferredTime.includes('late_night')) entertainment += 1;
  entertainment = Math.min(10, Math.max(1, entertainment));

  // EDUCATIONAL score
  let educational = 5;
  if (categories.includes('technology')) educational += 3;
  if (categories.includes('networking')) educational += 2;
  if (vibes.includes('educational')) educational += 3;
  if (categories.includes('arts_culture')) educational += 1;
  educational = Math.min(10, Math.max(1, educational));

  // BUDGET FRIENDLY score
  let budget_friendly = 5;
  if (budget === 'free') budget_friendly = 10;
  else if (budget === 'under_50') budget_friendly = 8;
  else if (budget === '50_150') budget_friendly = 5;
  else if (budget === '150_plus') budget_friendly = 2;
  budget_friendly = Math.min(10, Math.max(1, budget_friendly));

  // OUTDOOR score
  let outdoor = 5;
  if (categories.includes('nature_outdoors')) outdoor += 4;
  if (categories.includes('sports')) outdoor += 2;
  if (distance === 'any' || distance === '50km') outdoor += 2;
  if (distance === '5km' || distance === 'walking') outdoor -= 2;
  if (preferredTime.includes('morning')) outdoor += 1;
  outdoor = Math.min(10, Math.max(1, outdoor));

  // ENERGY LEVEL score
  let energy_level = 5;
  if (vibes.includes('high_energy')) energy_level += 3;
  if (vibes.includes('chill')) energy_level -= 2;
  if (categories.includes('sports')) energy_level += 2;
  if (preferredTime.includes('late_night') || preferredTime.includes('night')) energy_level += 2;
  if (preferredTime.includes('morning')) energy_level += 1;
  energy_level = Math.min(10, Math.max(1, energy_level));

  // FAMILY FRIENDLY score
  let family_friendly = 5;
  if (eventSize === 'intimate' || eventSize === 'just us') family_friendly += 2;
  if (eventSize === 'massive' || eventSize === 'festival mode') family_friendly -= 2;
  if (preferredTime.includes('morning') || preferredTime.includes('afternoon')) family_friendly += 2;
  if (preferredTime.includes('late_night') || preferredTime.includes('night')) family_friendly -= 3;
  if (categories.includes('family_kids')) family_friendly += 4;
  if (vibes.includes('family_friendly')) family_friendly += 2;
  family_friendly = Math.min(10, Math.max(1, family_friendly));

  // NETWORKING score
  let networking = 5;
  if (categories.includes('networking')) networking += 4;
  if (vibes.includes('social_meetup')) networking += 2;
  if (categories.includes('technology')) networking += 1;
  if (eventSize === 'large' || eventSize === 'massive') networking += 1;
  networking = Math.min(10, Math.max(1, networking));

  return {
    social,
    entertainment,
    educational,
    budget_friendly,
    outdoor,
    energy_level,
    family_friendly,
    networking,
  };
}

async function generateAllUserDNA() {
  console.log('[UserDNA] Starting conversion for all users...');

  let allPrefs = [];
  try {
    allPrefs = await db.queryAll('SELECT * FROM user_preferences');
  } catch (err) {
    console.error('[UserDNA] Failed to fetch preferences:', err.message || err);
    return;
  }

  console.log(`[UserDNA] Found ${allPrefs.length} users to process`);

  let success = 0;
  let failed = 0;

  for (const prefs of allPrefs) {
    try {
      const dna = convertPreferencesToDNA(prefs);

      await db.query(
        'UPDATE user_preferences SET user_dna = $1 WHERE user_id = $2',
        [JSON.stringify(dna), prefs.user_id],
      );

      console.log(`[UserDNA] ✅ Done: ${prefs.user_id}`, dna);
      success++;
    } catch (err) {
      console.log(`[UserDNA] ❌ Failed: ${prefs.user_id}`, err.message);
      failed++;
    }
  }

  console.log(`[UserDNA] Complete — Success: ${success}, Failed: ${failed}`);
}

module.exports = { convertPreferencesToDNA };

if (require.main === module) {
  generateAllUserDNA()
    .catch((err) => {
      console.error(err.message || err);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
