# Chatbot Accuracy Issue — HANDOFF / DIAGNOSIS

> Context: this is a follow-up to `SUPABASE_MIGRATION_HANDOFF.md`. During Phase 4 testing the
> user found the chatbot gives wrong answers (e.g. "is there a BTS tour?" → "no", although the
> event exists). This file is the diagnosis so far and how to continue. **The migration is NOT
> the cause** — that was verified. Do not "fix" the DB layer for this.

---

## TL;DR

There are **two separate problems**, neither caused by the Supabase→Postgres migration:

1. **Gemini is dead (quota).** The `GEMINI_API_KEY` returns **HTTP 429 RESOURCE_EXHAUSTED,
   "limit: 0"** for `gemini-2.0-flash` (free tier gives this project zero quota). The key
   authenticates — it's a Google **billing/account** issue, not code. The app falls back to
   **DashScope (qwen)** via `chatLlmWithFallback`, so the bot still answers — every current
   answer is coming from DashScope, not Gemini.
2. **Retrieval/answer accuracy** (the "says no when the event exists" problem). This is
   **pre-existing** and lives in the `server.js` `/api/chat` pipeline (keyword extraction →
   filtering → final LLM answer), NOT in the database. A degraded LLM makes it worse.

---

## What was VERIFIED (facts, not guesses)

- BTS event exists: `events_chatbot` id **442675**, `BTS WORLD TOUR 'ARIRANG' IN KUALA LUMPUR`,
  Kuala Lumpur, 2026-12-12.
- The keyword search **finds it** when given "bts". Ran `db.from('events_chatbot').select(...)
  .or('title.ilike.%bts%,description.ilike.%bts%,category.ilike.%bts%,venue.ilike.%bts%')
  .limit(25)` → returned exactly the BTS event. So the shim's `.or()` + `ilike` work.
- Data is healthy: 711 events / 711 embeddings (1:1). Vector search (`db.ragSearch`) works.
- Gemini failure reproduced directly: POST to `generativelanguage.googleapis.com/.../
  gemini-2.0-flash:generateContent` → 429, `generate_content_free_tier_requests limit: 0`.

Conclusion: the DB and search layers are fine. The miss is **upstream (keyword extraction) or
downstream (post-retrieval filtering / the LLM writing the reply)**.

---

## How the `/api/chat` pipeline works (server.js, ~line 1383–1634)

1. **Keyword extraction** (~1395–1428): `rawKeywords = llmKeywordsOverride (from the LLM context
   resolver) OR extractKeywords(query,5)` (regex stopword fallback). Then each keyword is
   **validated** against the DB (`keywordSearchEvents(..., 1)`) and dropped if it has zero matches.
2. **Two searches in parallel** (~1474–1484): `db.ragSearch(embedding, matchCount)` (vector) +
   `keywordSearchEvents(getSupabase(), keywords, 25)` (ILIKE via the shim). Keyword search exists
   specifically to catch named things the vector model dilutes (comment says "cancer",
   "BBC Mandarin", etc.).
3. **Merge** vector + keyword rows (~1515–1520), `filterFutureEvents`, then **`applyKeywordFilter`**
   (strict: keep only events whose text contains a keyword) ~1531–1545, with a fallback to the raw
   keyword-search rows if the strict filter empties the pool.
4. **Rank/limit**: `selectDiverseRecommendations(pool, intent, 15)` (or `filterEventsByPreferences`
   if an explicit filter) ~1546–1571, then a **safety** `applyKeywordFilter` ~1581.
5. **Answer**: `slim = selectedEvents.map(...)`; `generateRagRecommendation(query, history, slim)`
   calls the LLM (Gemini→DashScope) to write the text `reply`. The **event cards** (`events` in the
   response) come straight from `selectedEvents` — independent of the LLM text.

Key point: the response has **two outputs** — `events` (cards) and `reply` (LLM text). They can
disagree. "Bot said no" could mean (a) no cards were selected [retrieval/filter bug] or (b) cards
were there but the LLM text said no anyway [LLM/prompt bug]. **Find out which.**

---

## THE DIAGNOSTIC TO RUN (do this first)

Start the server WITHOUT triggering scrapes, capture logs, and hit the endpoint:

```bash
# from backend/ — scheduler off + no startup scrape so data stays stable
SCRAPER_RUN_ON_STARTUP=0 ENABLE_SCHEDULER=0 node server.js
```

Then in another shell (check whether /api/chat needs a session cookie first — see auth-routes /
getSessionUserId; if it does, log in and pass the cookie):

```bash
curl -s -X POST http://localhost:3040/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"is there a bts tour coming up?"}'
```

Watch the server console — it prints each stage. Read them in order:
- `Topic keywords (...): [...]`  ← did "bts" survive extraction+validation? If NOT, the bug is in
  extraction (resolver LLM degraded by the Gemini outage, or `extractKeywords`).
- `Found N similar events` (vector) and `Keyword search returned N extra rows` ← is BTS among them?
- `Topic pre-filter (RAG branch): X → Y match [...]` ← did the strict filter drop it?
- `Intent filter: ...; selected N event(s)` ← is BTS in the final `selectedEvents`?
- The returned JSON: is BTS in `events[]`? What does `reply` say?

### Interpreting the result
- **BTS in `events[]` but `reply` says "no"** → the **LLM is contradicting the provided events**.
  Fix in the answer step: the system prompt already says "you MUST mention them" (~line 1013), but
  DashScope may be weaker at honoring it than Gemini was. Options: restore a working primary LLM,
  strengthen the prompt, or make the code trust `selectedEvents` over the LLM's yes/no.
- **BTS NOT in `events[]`** → retrieval/filter bug. Walk back through the stage logs to the first
  stage where it disappears (most likely: keyword "bts" never extracted → keyword search never runs
  for it → vector-only misses it; OR `applyKeywordFilter`/`selectDiverseRecommendations` dropped it).

---

## Strong clue: event-detail Q&A works, chatbot doesn't (same LLM!)

The user observes that the **event-detail Q&A** (`/api/event/ask`, e.g. "what's the dress code?")
answers **accurately**, while the chatbot does not — even though **both use the same fallback LLM
(DashScope)**. This is diagnostic gold:

- `/api/event/ask` hands the LLM **one specific event's full details** directly (no retrieval) and
  asks a question about it → accurate. This **proves the fallback LLM writes correct answers when
  given the right context.**
- `/api/chat` must **retrieve** the right event from 711 first, then answer. It fails.

Therefore the chatbot bug is almost certainly in the **retrieval / event-selection layer** (getting
the right event into `selectedEvents` / `slim`), NOT in the LLM's writing ability and NOT primarily
about Gemini being down. Focus debugging on the pipeline stages, especially **keyword extraction**
and the **filters** (`applyKeywordFilter`, `selectDiverseRecommendations`,
`filterEventsByPreferences`) — find the first stage where the known-good event (BTS id 442675)
disappears. Fixing Gemini is secondary.

## Likely causes (ranked)

1. **Keyword extraction degraded because the LLM context resolver is running on the failing Gemini
   path** → falls to the regex `extractKeywords`, which may not pull the right entity, so the
   keyword search never gets "bts". → Fixing the LLM (below) likely fixes much of this.
2. **The LLM (DashScope) answers "no" from its own knowledge, ignoring the supplied events.**
   Gemini honored the "must mention" instruction better. → prompt hardening / trust selectedEvents.
3. **Entity/spelling mismatches** unrelated to the LLM, e.g. user typed "the weekends concert"
   meaning the artist **"The Weeknd"** — "weekend" won't ILIKE-match "The Weeknd". That's a spelling/
   NER gap, not a retrieval bug. Confirm what the actual event titles are before assuming a bug.

---

## Fixing the Gemini side (USER action — cannot be done in code)

The `GEMINI_API_KEY` project has **zero** free-tier quota for `gemini-2.0-flash`. Pick one:
- **Enable billing** on that key's Google Cloud project (moves it to paid tier), OR
- **Use a different Gemini key** from a project that still has free quota, OR
- **Switch `GEMINI_MODEL`** in `.env` to a model that still has free quota (try `gemini-1.5-flash`).

Interim code option (safe, ~1 line): make **DashScope the primary** in `chatLlmWithFallback`
(gemini-client.js) so the dead Gemini call isn't attempted every message. This won't change answer
quality (answers already come from DashScope) but removes a failing round-trip.

---

## Guardrails
- Do NOT change `db.js` / `db-query-builder.js` for this — retrieval is verified working.
- Keep `ENABLE_SCHEDULER=0` (or `SCRAPER_RUN_ON_STARTUP=0`) while testing so the scraper doesn't
  replace events / drop embeddings mid-debug.
- Data currently: 711 events, 711 embeddings, ~120 events without `event_dna` (self-heals on a
  scheduler run or `node generate-event-dna.js`).
- Nothing committed to git. `SUPABASE_*` still in `.env` for rollback (Phase 5 not done yet).
```
