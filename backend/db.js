/**
 * PostgreSQL database layer for Exploremy.
 *
 * Replaces the Supabase client with a plain `pg` connection pool driven by
 * DATABASE_URL. Same shape of connection string works for local Postgres now
 * and Alibaba RDS later — only the DATABASE_URL value changes.
 *
 * Usage:
 *   const db = require('./db');
 *   const rows = await db.queryAll('SELECT * FROM profiles WHERE email = $1', [email]);
 *
 * Env:
 *   DATABASE_URL   e.g. postgresql://exploremy_dev:pw@localhost:5433/exploremy
 *   DATABASE_SSL   set to "true" for managed hosts that require SSL (Alibaba RDS, etc.)
 */
'use strict';

const pg = require('pg');
const { Pool } = pg;
const { createQueryClient } = require('./db-query-builder');

// Supabase/PostgREST returned int8 (bigint) columns as JSON *numbers*. node-pg
// defaults to returning them as strings, which breaks id equality checks that
// mix bigint-returning sources (e.g. the RAG function's id) with int4 rows
// (e.g. keyword-search rows). Parse int8 as a number to match the old behavior.
// Safe here: every bigint in this schema is a small serial id well within the
// JS safe-integer range.
pg.types.setTypeParser(20, (val) => (val == null ? null : parseInt(val, 10)));

// Supabase/PostgREST returned DATE columns as plain 'YYYY-MM-DD' strings. node-pg
// defaults to parsing them into JS Date objects in the server's local timezone,
// which (a) breaks code that does String(row.date).slice(0,10) / YYYY-MM-DD regex
// checks (e.g. the admin "seasonal patterns" charts) and (b) can shift the day by
// one across a timezone boundary. Return the raw date string to match Supabase.
pg.types.setTypeParser(1082, (val) => val);

/** @type {import('pg').Pool | null} */
let _pool = null;

/**
 * Lazily create (and reuse) a single connection pool.
 * Lazy init mirrors server.js getSupabase(): a missing DATABASE_URL doesn't
 * crash the process at require-time, it throws only when the DB is actually used.
 * @returns {import('pg').Pool}
 */
function getPool() {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL || '';
  if (!connectionString) {
    const err = new Error(
      'Database not configured (set DATABASE_URL, e.g. postgresql://user:pw@localhost:5433/exploremy)'
    );
    err.code = 'NO_DATABASE';
    throw err;
  }

  _pool = new Pool({
    connectionString,
    // Managed hosts (Alibaba RDS, Supabase, etc.) usually need SSL; local doesn't.
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Surface pool-level errors instead of crashing the process silently.
  _pool.on('error', (err) => {
    console.error('[db] unexpected idle client error:', err.message);
  });

  return _pool;
}

/**
 * Run a parameterized query. Use $1, $2, ... placeholders — never string
 * concatenation (prevents SQL injection).
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(sql, params = []) {
  const pool = getPool();
  return pool.query(sql, params);
}

/**
 * Run a query and return the first row, or null if there are none.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any|null>}
 */
async function queryOne(sql, params = []) {
  const res = await query(sql, params);
  return res.rows.length ? res.rows[0] : null;
}

/**
 * Run a query and return all rows (possibly empty array).
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any[]>}
 */
async function queryAll(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

/**
 * Simple pagination helper — replaces Supabase `.range(from, to)`.
 * @param {string} table          table name (trusted; not user input)
 * @param {object} [opts]
 * @param {string} [opts.columns='*']
 * @param {string} [opts.where]    raw WHERE clause without the "WHERE" keyword, using $N placeholders
 * @param {any[]}  [opts.params=[]] params for the where clause
 * @param {string} [opts.orderBy]  e.g. 'created_at DESC'
 * @param {number} [opts.limit=1000]
 * @param {number} [opts.offset=0]
 * @returns {Promise<any[]>}
 */
async function paginate(table, opts = {}) {
  const {
    columns = '*',
    where = '',
    params = [],
    orderBy = '',
    limit = 1000,
    offset = 0,
  } = opts;

  let sql = `SELECT ${columns} FROM ${table}`;
  if (where) sql += ` WHERE ${where}`;
  if (orderBy) sql += ` ORDER BY ${orderBy}`;
  // limit/offset are appended as bound params after the where params.
  sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  return queryAll(sql, [...params, limit, offset]);
}

/**
 * Vector similarity search — replaces
 *   supabase.rpc('match_events_chatbot_rag', { query_embedding, match_count })
 *
 * pgvector can't accept a raw JS array over the wire, so we format the embedding
 * as a '[0.1,0.2,...]' string and cast it to ::vector inside the query.
 * @param {number[]} embedding   384-dim query embedding
 * @param {number} [matchCount=15]
 * @returns {Promise<any[]>}  rows: id,title,description,venue,city,date,price,image_url,event_url,source,category,is_free,similarity
 */
async function ragSearch(embedding, matchCount = 15) {
  if (!Array.isArray(embedding)) {
    throw new Error('ragSearch: embedding must be an array of numbers');
  }
  const vectorLiteral = `[${embedding.join(',')}]`;
  return queryAll(
    'SELECT * FROM match_events_chatbot_rag($1::vector, $2)',
    [vectorLiteral, matchCount]
  );
}

/**
 * Call a stored function that returns a table, e.g. repeat_engagement_stats().
 * Generic replacement for supabase.rpc('fn_name', args).
 * @param {string} fnName  function name (trusted; not user input)
 * @param {any[]} [args]
 * @returns {Promise<any[]>}
 */
async function callFunction(fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  return queryAll(`SELECT * FROM ${fnName}(${placeholders})`, args);
}

/**
 * Connectivity check — used by a startup ping / the Phase 2 smoke test.
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  const row = await queryOne('SELECT 1 AS ok');
  return !!(row && row.ok === 1);
}

/** Close the pool (for graceful shutdown / scripts that should exit). */
async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** True when a DATABASE_URL is configured (mirrors the old `getSupabase()` truthiness). */
function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

// PostgREST-compatible query builder (`db.from(...).select()...`, `db.rpc(...)`),
// so call sites written against the Supabase client keep working with a plain
// `sb`/`db` swap. All queries funnel through the same pool as `query()`.
const _queryClient = createQueryClient({ query });

module.exports = {
  getPool,
  query,
  queryOne,
  queryAll,
  paginate,
  ragSearch,
  callFunction,
  healthCheck,
  close,
  isConfigured,
  from: (table) => _queryClient.from(table),
  rpc: (fnName, args) => _queryClient.rpc(fnName, args),
};
