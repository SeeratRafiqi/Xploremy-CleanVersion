'use strict';

/**
 * One-off migration: add crowd-signal columns to user_preferences (Postgres).
 * Run once:  node scripts/add-crowd-columns.js
 */

require('dotenv').config();
const db = require('../db');

const STATEMENTS = [
  'ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS home_iata text',
  'ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS gender text',
  'ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS profession text',
  'ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS age_group text',
];

(async () => {
  if (!db.isConfigured()) {
    console.error('DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }
  for (let i = 0; i < STATEMENTS.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(STATEMENTS[i]);
    console.log('OK:', STATEMENTS[i]);
  }
  console.log('Done — crowd columns are present.');
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err.message || err);
  process.exit(1);
});
