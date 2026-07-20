#!/usr/bin/env node
/**
 * One-time: import local data/users.json into public.profiles (Postgres via ./db).
 * Run locally: node scripts/migrate-users-json-to-supabase.js
 * Requires .env with DATABASE_URL.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const db = require('../db');
const authStore = require('../auth-store');

const USERS_PATH = path.join(__dirname, '..', 'data', 'users.json');

async function main() {
  const sb = db.isConfigured() ? db : null;
  if (!sb) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }
  authStore.setDb(() => db);

  let raw;
  try {
    raw = await fs.readJson(USERS_PATH);
  } catch (e) {
    console.error('No data/users.json found:', e.message);
    process.exit(1);
  }
  const users = raw && Array.isArray(raw.users) ? raw.users : [];
  if (!users.length) {
    console.log('No users in file.');
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  for (const legacy of users) {
    const profile = Object.assign({}, legacy.profile || {}, {
      displayName: (legacy.profile && legacy.profile.displayName) || '',
      onboardingComplete: Boolean(legacy.profile && legacy.profile.onboardingComplete),
      updatedAt: (legacy.profile && legacy.profile.updatedAt) || legacy.createdAt,
      lastLoginAt: (legacy.profile && legacy.profile.lastLoginAt) || legacy.last_active,
    });
    const user = {
      id: legacy.id,
      email: legacy.email,
      passwordHash: legacy.passwordHash,
      createdAt: legacy.createdAt || new Date().toISOString(),
      last_active: legacy.last_active || legacy.createdAt,
      profile,
    };
    try {
      const row = authStore.rowFromUser(user);
      const { error } = await sb.from('profiles').upsert(row, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
      ok += 1;
      console.log('OK', legacy.email);
    } catch (e) {
      fail += 1;
      console.warn('FAIL', legacy.email, e.message || e);
    }
  }
  console.log('Done.', ok, 'imported,', fail, 'failed.');
}

main()
  .catch(function (e) {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(function () {
    return db.close();
  });
