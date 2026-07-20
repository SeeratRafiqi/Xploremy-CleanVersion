# Supabase → Local PostgreSQL Migration — HANDOFF

> Read this top to bottom before doing anything. It is the single source of truth for
> where this migration is. Everything here has been done and tested. Do NOT redo
> completed steps. Continue from **"WHAT TO DO NEXT"**.

---

## 0. The goal (one line)

Move the Exploremy backend off Supabase onto a **local PostgreSQL** database now, and
onto **Alibaba RDS** later — where only the `DATABASE_URL` value changes between them.
The frontend never talks to Supabase directly, so this is a **backend-only** migration.

Project root: `C:\Users\User\ticket-scraper\Xploremy\Rizal_event_2.0`
All work happens in the `backend/` folder. App runs on **port 3040**.

---

## 1. Environment that is ALREADY set up (do not redo)

**Local database — running in Docker:**
- Container name: `exploremy-postgres`
- Image: `pgvector/pgvector:pg17` (PostgreSQL 17 + pgvector 0.8.5)
- Host port **5433** → container 5432 (5433 chosen because another local project uses 5432)
- Database: `exploremy` | User: `exploremy_dev` | Password: `exploremy_local_pw`
- pgvector extension: enabled

**If Docker "Resource Saver" paused it / after a reboot**, the container stops. Bring it back with:
```powershell
docker start exploremy-postgres
```
Data survives restarts — it is NOT lost. Verify it is up:
```powershell
docker ps --filter name=exploremy-postgres
```

**Data already copied from Supabase (Phase 1 done):**
Full `pg_dump` was taken from Supabase and restored into the local DB. Verified row counts:
| table | rows |
|---|---|
| events_chatbot | 712 |
| event_embeddings_chatbot | 712 |
| profiles | 166 |
| user_preferences | 143 |
| chat_history_chatbot | 145 |
| event_clicks | 138 |
| itineraries_generated | 10 |

DB functions present: `match_events_chatbot_rag`, `repeat_engagement_stats`.
(The dump file is at `/tmp/supabase_dump.sql` INSIDE the container if a re-restore is ever needed.)

**Note on re-dumping from Supabase if ever needed:** the Supabase **direct connection**
host (`db.<ref>.supabase.co`) is IPv6-only and unreachable on this network. Use the
**Session pooler** host instead: `aws-1-ap-southeast-1.pooler.supabase.com:5432`,
username `postgres.wsafsswgghmgoaisoihc`. Run `pg_dump` via `docker exec exploremy-postgres`
so tool versions match.

**`backend/.env`** already has:
```
DATABASE_URL=postgresql://exploremy_dev:exploremy_local_pw@localhost:5433/exploremy
```
The `SUPABASE_*` keys are STILL in `.env` on purpose — un-migrated files still use them,
and they are the rollback path. Do NOT remove them until Phase 5.

**`pg` npm package** is installed (`npm install pg` already run).

---

## 2. ⚠️ CRITICAL SCHEMA FACT (memorize this)

The real schema uses **integer** IDs, NOT uuids:
- `events_chatbot.id` = **integer** (auto-increments — never provide `id` on insert)
- `event_embeddings_chatbot.event_id` = **integer**
- `profiles.user_id` = **text** (holds uuid-like strings; fine as-is)

The `id uuid` line in `sql/match_events_chatbot_rag.sql` is **outdated documentation** —
the real restored function returns integer. **Never cast event ids to `::uuid[]`. Use `::int[]`.**

---

## 3. The database layer: `backend/db.js` (already created)

New file, the single gateway to Postgres. Exports:
- `query(sql, params)` — raw parameterized query
- `queryOne(sql, params)` — first row or `null`
- `queryAll(sql, params)` — array of rows
- `paginate(table, {columns, where, params, orderBy, limit, offset})`
- `ragSearch(embedding, matchCount=15)` — vector search; formats the 384-number array as
  a `'[...]'::vector` literal and calls `match_events_chatbot_rag`. **Use this in server.js.**
- `callFunction(fnName, args)` — calls a table-returning function (e.g. `repeat_engagement_stats`)
- `healthCheck()` / `getPool()` / `close()`
- Reads `DATABASE_URL`. `DATABASE_SSL=true` toggles SSL (for Alibaba later; off for local).

---

## 4. Files ALREADY migrated and tested (do NOT touch again)

Migration pattern used everywhere: replace `@supabase/supabase-js` calls with `db.js` calls.
`SUPABASE_*` stays in `.env` so un-migrated files keep working during the transition.

**1. `auth-store.js`** ✅ (tested: live browser register + login work on local DB)
- Injected getter renamed: `setSupabase`→`setDb`, internal `sb()`→`db()`.
- Reads → `db().queryOne('SELECT ${PROFILE_COLUMNS} FROM profiles WHERE ... = $1', [x])`.
- `persistUser` upsert → `INSERT INTO profiles (...) VALUES (...) ON CONFLICT (user_id) DO UPDATE SET ... password_hash = COALESCE(EXCLUDED.password_hash, profiles.password_hash) ... RETURNING ${PROFILE_COLUMNS}`. `profile_json` passed via `JSON.stringify`.
- Export `setSupabase`→`setDb`.
- **Wiring updated in two callers:**
  - `server.js` (~line 198): `const db = require('./db'); const authStore = require('./auth-store'); authStore.setDb(() => db);`
  - `scheduler.js` (~line 6): `const db = require('./db'); ... authStore.setDb(() => db);` (removed the old `createSupabaseForCache` wiring).

**2. `api-usage-logger.js`** ✅ (tested)
- Had its OWN internal `getSupabase()`; removed it, added `const db = require('./db')`.
- Single insert → `db.query('INSERT INTO api_usage_log (provider, feature, model, input_tokens, output_tokens, estimated_cost, success) VALUES ($1..$7)', [...])`.
- No callers changed (public `logApiUsage` signature unchanged).

**3. `create-embeddings.js`** ✅ (tested: safe no-op run = 0 to create; vector cast = 384 dims OK)
- Removed own client; `const db = require('./db')`.
- `fetchAllRows` now single `db.queryAll('SELECT ${cols} FROM ${table}')` (dropped `.range()` paging — local pg has no 1000-row cap).
- force-delete → `db.query('DELETE FROM event_embeddings_chatbot')`.
- insert → `db.query('INSERT INTO event_embeddings_chatbot (event_id, embedding) VALUES ($1, $2::vector)', [ev.id, '[' + embedding.join(',') + ']'])`.

**4. `upload-to-supabase.js`** ✅ (tested via fake source `__migration_test__`; real 712 events untouched)
- Filename KEPT for now (rename to `upload-to-db.js` is a deferred cosmetic pass — would also need `package.json` script `upload:supabase`→`upload:db` and the `scheduler.js` require updated). Function name `uploadToSupabase` also kept.
- Removed own client; `const db = require('./db')`.
- `insertRows` → multi-row parameterized `INSERT INTO events_chatbot (cols) VALUES ($1..),($12..)...` chunked by 200 (id auto-generated, so `id` is NOT in the column list).
- `replaceSourceRows`: embeddings delete → `DELETE FROM event_embeddings_chatbot WHERE event_id = ANY($1::int[])`; events delete → `WHERE source = $1`.
- `restoreEventDna` → `UPDATE events_chatbot SET event_dna = $1 WHERE event_url = $2` with `JSON.stringify(dna)`.
- Dropped `.range()` paging in the fetch helpers.
- ⚠️ Do NOT run the full `uploadToSupabase()` against real data to "test" it — it deletes and
  re-inserts events and drops their embeddings until `create-embeddings` reruns. Test with a
  fake `source` value instead.

---

## 5. WHAT TO DO NEXT (remaining 11 files)

**Golden rule: migrate ONE file, test it, then move on. Migrate by how ISOLATED a file is,
NOT by any old numbered list.** Two file shapes exist:
- **Isolated** (own client OR injected getter, no caller passes it a client) → easy, do these first.
- **Coupled** (functions receive the DB client as a parameter, passed in by a routes file) →
  must be migrated TOGETHER with the routes file that calls them.

### Next up — isolated files:
1. **`generate-event-dna.js`** — computes event DNA scores. Check its client setup; migrate reads/writes on `events_chatbot`. Test safely (read-only or fake row).
2. **`user-dna-converter.js`** — batch tool. Same approach.

### Then the coupled ADMIN / FAN-DNA subsystem (migrate these as ONE unit):
These all flow through `fan-dna-routes.js`, which gets `sb` per-handler via an injected
`deps.getSupabase` (~11 sites) and passes `sb` to helper modules:
- `fan-dna-store.js` — 5 functions `getPreferences/upsertPreferences/logEventClick/fetchAllPreferences/fetchClickStats`, all take `sb` as 1st arg; called from `fan-dna-routes.js` at ~10 sites (lines ~1344, 1736, 2664, 2903, 2951, 2956, 3022, 3202, 3280, 3730).
- `admin-dashboard-cache.js` — `readDashboardCache/writeDashboardCache/getOrComputeDashboardCache` take `sb`; also exports `createSupabaseForCache` factory.
- `admin-api-usage.js` — `buildApiUsagePayload(sb)` (uses count `head:true`, `.range()` paging, `.gte/.eq`).

**Recipe for the coupled unit:**
- Add `const db = require('./db')` to `fan-dna-routes.js`.
- At each call site, change `store.fn(sb, ...)` → `store.fn(db, ...)`.
- Migrate each helper's body to `db.*` (integer event ids → `::int[]`).
- Special cases in `fan-dna-routes.js`:
  - `~line 158` uses `sb.auth.admin.listUsers()` (Supabase-Auth-only, does NOT exist in plain
    Postgres) → rewrite as a query counting `profiles` where `last_active` within 7 days.
  - `~line 968` `sb.rpc('repeat_engagement_stats')` → `db.callFunction('repeat_engagement_stats')`.

### Then:
3. **`selection-store.js`** (+ its routes caller) — check its shape first (likely coupled).
4. **`server.js`** — events API + chatbot RAG (the big one). Key change:
   `getSupabase().rpc('match_events_chatbot_rag', { query_embedding, match_count })`
   → `db.ragSearch(queryEmbedding, matchCount)` (returns the rows array directly).
   Also `keywordSearchEvents(getSupabase(), ...)` and the chat-history helper (global `supabase`)
   need migrating. Remember event ids are integers.
5. **`itinerary-routes.js`** — trip planner.
6. **`scripts/migrate-users-json-to-supabase.js`** (line ~30 still calls the OLD
   `authStore.setSupabase`) — optional legacy one-off importer. Either fix its wiring to
   `setDb(() => db)` or retire the script. It is NOT loaded at server startup, so it does not
   block anything.

---

## 6. How to test after each file

- Quick node test (no server): `node -e "require('dotenv').config(); const db=require('./db'); ...(async()=>{ ... await db.close(); })()"`
- Full app: `npm start` in `backend/`, then browse `http://localhost:3040`.
- Always clean up any test rows you insert. Use a fake `source`/email so you never touch real data.
- If a test errors with a type mismatch, re-check the CRITICAL SCHEMA FACT (section 2).

---

## 7. Phases remaining (big picture)

- **Phase 3** (in progress): migrate the 11 remaining files (above). 4/15 done.
- **Phase 4**: run the full manual test checklist (events load, login, fan DNA, event hub,
  chatbot RAG with e.g. "jazz concerts in Kuala Lumpur", itinerary save, admin dashboard,
  `npm run upload:supabase`, `npm run embeddings`).
- **Phase 5**: comment out `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_KEY` in
  `.env`; confirm the app runs on `DATABASE_URL` only. Keep the Supabase project alive (read-only
  backup) for ~1–2 weeks. Rollback = un-comment those lines.
- **Phase 6** (later, with Erik): Alibaba RDS. `pg_dump` local → restore to RDS → change only
  `DATABASE_URL` (and set `DATABASE_SSL=true`). No code changes.

---

## 8. Git / safety status

- **Nothing has been committed or pushed.** No branches created. All changes are local file edits.
- When you DO commit: make a branch (don't commit to `main`), and **never commit `.env`** — it
  holds live secrets (Supabase keys, Gemini key, SMTP password, etc.). Confirm `.env` is in
  `.gitignore` first.
- BettaJobs (the sibling project) is untouched. Supabase (the cloud project) is untouched — this
  migration only ever READ from it.

---

## 9. One-paragraph summary to say back to the user

"Your local Postgres (Docker, port 5433) is running with a full copy of your Supabase data
(712 events, 166 users, etc.). `db.js` is the new database layer. 4 of 15 backend files are
migrated and tested: auth-store (login verified in the browser), api-usage-logger,
create-embeddings, and upload-to-supabase. Your app still runs on Supabase for the other files
because we kept the `SUPABASE_*` keys — nothing is broken, nothing is deleted, Supabase is a safe
backup. Next isolated file to do is `generate-event-dna.js`. Remember event IDs are integers, and
run `docker start exploremy-postgres` if Docker went to sleep."
