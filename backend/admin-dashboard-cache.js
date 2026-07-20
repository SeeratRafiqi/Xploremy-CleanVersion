'use strict';

const ADMIN_CACHE_TABLE = 'admin_dashboard_cache';
const ADMIN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function isMissingAdminCacheTable(error) {
  const msg = String((error && error.message) || error || '').toLowerCase();
  return (
    msg.includes('admin_dashboard_cache') &&
    (msg.includes('does not exist') || msg.includes('relation') || msg.includes('schema cache'))
  );
}

async function readDashboardCache(sb, section) {
  if (!sb || !section) return null;
  try {
    const { data, error } = await sb
      .from(ADMIN_CACHE_TABLE)
      .select('data, updated_at')
      .eq('section', section)
      .maybeSingle();
    if (error) {
      if (!isMissingAdminCacheTable(error)) {
        console.warn('[admin cache] read failed:', section, error.message);
      }
      return null;
    }
    if (!data || data.updated_at == null) return null;
    const updatedMs = new Date(data.updated_at).getTime();
    if (!Number.isFinite(updatedMs)) return null;
    if (Date.now() - updatedMs > ADMIN_CACHE_TTL_MS) return null;
    return data.data;
  } catch (e) {
    console.warn('[admin cache] read error:', section, e.message || e);
    return null;
  }
}

async function writeDashboardCache(sb, section, payload) {
  if (!sb || !section) return false;
  try {
    const { error } = await sb.from(ADMIN_CACHE_TABLE).upsert(
      {
        section: String(section),
        data: payload == null ? {} : payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'section' },
    );
    if (error) {
      if (!isMissingAdminCacheTable(error)) {
        console.warn('[admin cache] write failed:', section, error.message);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[admin cache] write error:', section, e.message || e);
    return false;
  }
}

async function getOrComputeDashboardCache(sb, section, computeFn) {
  const cached = await readDashboardCache(sb, section);
  if (cached != null) return cached;
  const fresh = await computeFn();
  if (sb) await writeDashboardCache(sb, section, fresh);
  return fresh;
}

function createSupabaseForCache() {
  const db = require('./db');
  return db.isConfigured() ? db : null;
}

module.exports = {
  ADMIN_CACHE_TABLE,
  ADMIN_CACHE_TTL_MS,
  readDashboardCache,
  writeDashboardCache,
  getOrComputeDashboardCache,
  createSupabaseForCache,
};
