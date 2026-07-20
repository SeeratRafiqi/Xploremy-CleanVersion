/**
 * A small PostgREST-compatible query builder over the `pg` pool.
 *
 * It reproduces the subset of the `@supabase/supabase-js` query API that this
 * codebase actually uses, so existing call sites shaped like
 *
 *   const { data, error } = await sb.from('events_chatbot')
 *     .select('id, title')
 *     .eq('source', 'goliveasia')
 *     .order('date', { ascending: true })
 *     .limit(20);
 *
 * keep working unchanged after `sb` is swapped for the local Postgres `db`.
 *
 * Supported: .select (incl. { count:'exact', head:true }), .insert, .update,
 * .upsert, .delete, .eq/.neq/.gt/.gte/.lt/.lte, .in, .like/.ilike, .is,
 * .not(col,'is',null), .or('col.op.val,...'), .order, .limit, .range,
 * .single(), .maybeSingle(), and db.rpc(fn, args).
 *
 * Design notes:
 * - The builder is a thenable: `await sb.from(...)...` resolves to
 *   `{ data, error, count }`, mirroring supabase-js.
 * - Errors are RETURNED as `{ data:null, error:{ message, code, details } }`
 *   (never thrown), because callers inspect `error.message` for things like
 *   "relation ... does not exist" / missing-column fallbacks.
 * - Column identifiers come from source code (trusted, not user input) and are
 *   inlined; all VALUES are passed as bound `$n` parameters.
 * - jsonb/json columns are serialized with JSON.stringify (objects and arrays);
 *   native array columns (text[]/int[]) receive JS arrays and let `pg` format
 *   them. Column types are looked up once per table via information_schema and
 *   cached.
 */
'use strict';

const OP_SQL = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

function createQueryClient(runner) {
  // runner: { query(sql, params) => Promise<{rows}> }
  const columnTypeCache = new Map();

  async function getColumnTypes(table) {
    if (columnTypeCache.has(table)) return columnTypeCache.get(table);
    const map = {};
    try {
      const res = await runner.query(
        "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [table],
      );
      for (const r of res.rows) map[r.column_name] = r.udt_name;
    } catch (_e) {
      // If we can't introspect (e.g. missing table), fall back to no metadata;
      // the real query below will surface the actual error.
    }
    columnTypeCache.set(table, map);
    return map;
  }

  function serializeValue(value, udt) {
    if (value === undefined) return null;
    if (value === null) return null;
    // jsonb/json: stringify objects AND arrays so they land as JSON, not as a
    // Postgres array literal.
    if ((udt === 'jsonb' || udt === 'json') && typeof value === 'object') {
      return JSON.stringify(value);
    }
    return value;
  }

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.op = 'select';
      this.columns = '*';
      this.countMode = null;
      this.head = false;
      this.filters = [];
      this.orders = [];
      this.limitN = null;
      this.rangeFrom = null;
      this.rangeTo = null;
      this.payload = null;
      this.onConflict = null;
      this.returning = false;
      this.returningCols = '*';
      this.singleMode = null; // 'one' | 'maybe' | null
    }

    select(columns = '*', opts = {}) {
      if (this.op === 'select') {
        this.columns = columns || '*';
        if (opts && opts.count) this.countMode = opts.count;
        if (opts && opts.head) this.head = true;
      } else {
        // .select() chained after a mutation => RETURNING
        this.returning = true;
        this.returningCols = columns || '*';
      }
      return this;
    }

    insert(rows) {
      this.op = 'insert';
      this.payload = rows;
      return this;
    }

    update(obj) {
      this.op = 'update';
      this.payload = obj;
      return this;
    }

    upsert(row, opts = {}) {
      this.op = 'upsert';
      this.payload = row;
      this.onConflict = (opts && opts.onConflict) || null;
      return this;
    }

    delete() {
      this.op = 'delete';
      return this;
    }

    eq(col, val) { this.filters.push({ op: 'eq', col, val }); return this; }
    neq(col, val) { this.filters.push({ op: 'neq', col, val }); return this; }
    gt(col, val) { this.filters.push({ op: 'gt', col, val }); return this; }
    gte(col, val) { this.filters.push({ op: 'gte', col, val }); return this; }
    lt(col, val) { this.filters.push({ op: 'lt', col, val }); return this; }
    lte(col, val) { this.filters.push({ op: 'lte', col, val }); return this; }
    like(col, val) { this.filters.push({ op: 'like', col, val }); return this; }
    ilike(col, val) { this.filters.push({ op: 'ilike', col, val }); return this; }
    in(col, arr) { this.filters.push({ op: 'in', col, val: arr }); return this; }

    is(col, val) { this.filters.push({ op: 'is', col, val }); return this; }

    not(col, operator, val) {
      if (operator === 'is' && val === null) {
        this.filters.push({ op: 'isnotnull', col });
      } else if (OP_SQL[operator]) {
        this.filters.push({ op: 'notcmp', col, operator, val });
      }
      return this;
    }

    or(rawString) { this.filters.push({ op: 'or', raw: rawString }); return this; }

    order(col, opts = {}) {
      this.orders.push({ col, ascending: !(opts && opts.ascending === false) });
      return this;
    }

    limit(n) { this.limitN = n; return this; }

    range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this; }

    single() { this.singleMode = 'one'; return this; }
    maybeSingle() { this.singleMode = 'maybe'; return this; }

    // Thenable: makes `await builder` execute the query.
    then(onFulfilled, onRejected) {
      return this._run().then(onFulfilled, onRejected);
    }

    catch(onRejected) {
      return this._run().catch(onRejected);
    }

    async _run() {
      try {
        switch (this.op) {
          case 'select': return await this._runSelect();
          case 'insert': return await this._runInsert();
          case 'update': return await this._runUpdate();
          case 'upsert': return await this._runUpsert();
          case 'delete': return await this._runDelete();
          default: throw new Error(`Unsupported operation: ${this.op}`);
        }
      } catch (err) {
        return {
          data: null,
          count: null,
          error: {
            message: err.message || String(err),
            code: err.code || null,
            details: err.detail || null,
            hint: err.hint || null,
          },
        };
      }
    }

    _compileWhere(params) {
      if (!this.filters.length) return '';
      const clauses = [];
      for (const f of this.filters) {
        if (f.op === 'in') {
          params.push(f.val);
          clauses.push(`${f.col} = ANY($${params.length})`);
        } else if (f.op === 'is') {
          if (f.val === null) {
            clauses.push(`${f.col} IS NULL`);
          } else {
            params.push(f.val);
            clauses.push(`${f.col} IS $${params.length}`);
          }
        } else if (f.op === 'isnotnull') {
          clauses.push(`${f.col} IS NOT NULL`);
        } else if (f.op === 'notcmp') {
          params.push(f.val);
          clauses.push(`NOT (${f.col} ${OP_SQL[f.operator]} $${params.length})`);
        } else if (f.op === 'or') {
          const orClauses = [];
          for (const cond of String(f.raw).split(',')) {
            const p1 = cond.indexOf('.');
            const p2 = cond.indexOf('.', p1 + 1);
            if (p1 < 0 || p2 < 0) continue;
            const col = cond.slice(0, p1);
            const opName = cond.slice(p1 + 1, p2);
            const val = cond.slice(p2 + 1);
            const sqlOp = OP_SQL[opName];
            if (!sqlOp) continue;
            params.push(val);
            orClauses.push(`${col} ${sqlOp} $${params.length}`);
          }
          if (orClauses.length) clauses.push(`(${orClauses.join(' OR ')})`);
        } else {
          const sqlOp = OP_SQL[f.op];
          if (!sqlOp) continue;
          params.push(f.val);
          clauses.push(`${f.col} ${sqlOp} $${params.length}`);
        }
      }
      return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    }

    _limitOffset() {
      let limit = null;
      let offset = null;
      if (this.rangeFrom != null && this.rangeTo != null) {
        offset = Math.max(0, Math.trunc(this.rangeFrom));
        limit = Math.max(0, Math.trunc(this.rangeTo) - Math.trunc(this.rangeFrom) + 1);
      } else if (this.limitN != null && Number.isFinite(this.limitN)) {
        limit = Math.max(0, Math.trunc(this.limitN));
      }
      return { limit, offset };
    }

    async _runSelect() {
      const params = [];
      const where = this._compileWhere(params);

      if (this.head && this.countMode) {
        const sql = `SELECT count(*)::int AS count FROM ${this.table}${where}`;
        const res = await runner.query(sql, params);
        return { data: null, count: res.rows[0] ? res.rows[0].count : 0, error: null };
      }

      let sql = `SELECT ${this.columns} FROM ${this.table}${where}`;
      if (this.orders.length) {
        sql += ` ORDER BY ${this.orders.map((o) => `${o.col} ${o.ascending ? 'ASC' : 'DESC'}`).join(', ')}`;
      }
      const { limit, offset } = this._limitOffset();
      if (limit != null) sql += ` LIMIT ${limit}`;
      if (offset != null) sql += ` OFFSET ${offset}`;

      const res = await runner.query(sql, params);

      let count = null;
      if (this.countMode && !this.head) {
        const cres = await runner.query(`SELECT count(*)::int AS count FROM ${this.table}${where}`, params);
        count = cres.rows[0] ? cres.rows[0].count : 0;
      }

      if (this.singleMode) {
        return { data: res.rows.length ? res.rows[0] : null, count, error: null };
      }
      return { data: res.rows, count, error: null };
    }

    async _runInsert() {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      if (!rows.length) {
        return this._shapeMutationResult({ rows: [] });
      }
      const colTypes = await getColumnTypes(this.table);
      const cols = Object.keys(rows[0]);
      const params = [];
      const tuples = rows.map((row) => {
        const placeholders = cols.map((c) => {
          params.push(serializeValue(row[c], colTypes[c]));
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      let sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`;
      if (this.returning || this.singleMode) sql += ` RETURNING ${this.returningCols}`;
      const res = await runner.query(sql, params);
      return this._shapeMutationResult(res);
    }

    async _runUpdate() {
      const colTypes = await getColumnTypes(this.table);
      const cols = Object.keys(this.payload);
      const params = [];
      const sets = cols.map((c) => {
        params.push(serializeValue(this.payload[c], colTypes[c]));
        return `${c} = $${params.length}`;
      });
      let sql = `UPDATE ${this.table} SET ${sets.join(', ')}`;
      sql += this._compileWhere(params);
      if (this.returning || this.singleMode) sql += ` RETURNING ${this.returningCols}`;
      const res = await runner.query(sql, params);
      return this._shapeMutationResult(res);
    }

    async _runUpsert() {
      const colTypes = await getColumnTypes(this.table);
      const cols = Object.keys(this.payload);
      const params = [];
      const placeholders = cols.map((c) => {
        params.push(serializeValue(this.payload[c], colTypes[c]));
        return `$${params.length}`;
      });
      const conflictCols = String(this.onConflict || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
      if (conflictCols.length) {
        const updateCols = cols.filter((c) => !conflictCols.includes(c));
        if (updateCols.length) {
          sql += ` ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateCols
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(', ')}`;
        } else {
          sql += ` ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`;
        }
      }
      if (this.returning || this.singleMode) sql += ` RETURNING ${this.returningCols}`;
      const res = await runner.query(sql, params);
      return this._shapeMutationResult(res);
    }

    async _runDelete() {
      const params = [];
      let sql = `DELETE FROM ${this.table}${this._compileWhere(params)}`;
      if (this.returning || this.singleMode) sql += ` RETURNING ${this.returningCols}`;
      const res = await runner.query(sql, params);
      return this._shapeMutationResult(res);
    }

    _shapeMutationResult(res) {
      if (this.singleMode) {
        return { data: res.rows.length ? res.rows[0] : null, error: null };
      }
      if (this.returning) {
        return { data: res.rows, error: null };
      }
      return { data: null, error: null };
    }
  }

  function from(table) {
    return new QueryBuilder(table);
  }

  async function rpc(fnName, args) {
    try {
      let sql;
      let params = [];
      if (!args || (typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0)) {
        sql = `SELECT * FROM ${fnName}()`;
      } else if (Array.isArray(args)) {
        params = args;
        sql = `SELECT * FROM ${fnName}(${args.map((_, i) => `$${i + 1}`).join(', ')})`;
      } else {
        // named args: fn(name := $n)
        const names = Object.keys(args);
        params = names.map((n) => args[n]);
        sql = `SELECT * FROM ${fnName}(${names.map((n, i) => `${n} := $${i + 1}`).join(', ')})`;
      }
      const res = await runner.query(sql, params);
      return { data: res.rows, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message || String(err), code: err.code || null } };
    }
  }

  return { from, rpc };
}

module.exports = { createQueryClient };
