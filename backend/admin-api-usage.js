'use strict';

const SERPAPI_MONTHLY_LIMIT = 250;
const KL_TZ = 'Asia/Kuala_Lumpur';
const FEATURE_META = {
  chatbot: { icon: '🤖', label: 'Chatbot' },
  itinerary: { icon: '🗺️', label: 'Itinerary' },
  event_dna: { icon: '🧬', label: 'Event DNA' },
};

function klDateIso(date) {
  return date.toLocaleDateString('en-CA', { timeZone: KL_TZ });
}

function klTodayIso() {
  return klDateIso(new Date());
}

function klMonthKey(isoDate) {
  return String(isoDate || '').slice(0, 7);
}

function isoDaysAgoKL(days) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.now() - days * 86400000));
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function nextMonthRenewLabel() {
  const today = klTodayIso();
  const [y, m] = today.split('-').map(Number);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[nextM - 1]} 1, ${nextY}`;
}

function isMissingTableError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return msg.includes('api_usage_log') && (msg.includes('does not exist') || msg.includes('relation'));
}

async function fetchPagedRows(sb, buildQuery) {
  const PAGE = 1000;
  let offset = 0;
  const all = [];
  while (true) {
    const { data, error } = await buildQuery(offset, PAGE);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

/** Live quota from SerpAPI Account API (free — does not count toward usage). */
async function fetchSerpApiAccountStatus() {
  const apiKey = (process.env.VITE_SERPAPI_KEY || process.env.SERPAPI_KEY || '').trim();
  if (!apiKey) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const url = `https://serpapi.com/account.json?api_key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TicketScraper/1.0 (admin SerpAPI quota)',
      },
      signal: ac.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('[admin api-usage] SerpAPI account:', data.error || response.status);
      return null;
    }

    const used = Number(data.this_month_usage);
    const limit = Number(data.searches_per_month) || SERPAPI_MONTHLY_LIMIT;
    const remaining = Number.isFinite(Number(data.plan_searches_left))
      ? Number(data.plan_searches_left)
      : Math.max(0, limit - (Number.isFinite(used) ? used : 0));

    return {
      used: Number.isFinite(used) ? used : 0,
      limit,
      remaining,
      planName: data.plan_name || null,
      source: 'serpapi_account',
    };
  } catch (err) {
    console.warn('[admin api-usage] SerpAPI account fetch failed:', err.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildApiUsagePayload(sb) {
  const serpLive = await fetchSerpApiAccountStatus();

  if (!sb) {
    if (serpLive) {
      const fillPct = serpLive.limit > 0 ? Math.min(100, (serpLive.used / serpLive.limit) * 100) : 0;
      return {
        empty: false,
        summary: { callsToday: 0, callsThisMonth: 0, costToday: 0, costThisMonth: 0 },
        serpapi: {
          used: serpLive.used,
          remaining: serpLive.remaining,
          limit: serpLive.limit,
          fillPct,
          renewsLabel: nextMonthRenewLabel(),
          hotelsCount: 0,
          flightsCount: 0,
          source: serpLive.source,
          planName: serpLive.planName,
        },
        byFeature: [],
        dailyUsage: Object.keys(
          Object.fromEntries(Array.from({ length: 14 }, (_, i) => [isoDaysAgoKL(13 - i), 0])),
        )
          .sort()
          .map((date) => ({ date, count: 0 })),
        recent: [],
        notice: 'Supabase not configured — showing SerpAPI quota only.',
      };
    }
    return { empty: true, notice: 'Supabase not configured.' };
  }
  let recentRows = [];
  let periodRows = [];
  let dashscopeRows = [];

  try {
    const countRes = await sb.from('api_usage_log').select('*', { count: 'exact', head: true });
    if (countRes.error) throw countRes.error;

    if (countRes.count) {
      const recentRes = await sb
        .from('api_usage_log')
        .select('provider, feature, model, input_tokens, output_tokens, estimated_cost, success, created_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (recentRes.error) throw recentRes.error;
      recentRows = recentRes.data || [];

      const monthStart = klTodayIso().slice(0, 8) + '01';
      const statsSince = isoDaysAgoKL(13) < monthStart ? isoDaysAgoKL(13) : monthStart;
      const statsSinceTs = `${statsSince}T00:00:00+08:00`;

      periodRows = await fetchPagedRows(sb, (offset, pageSize) =>
        sb
          .from('api_usage_log')
          .select('provider, feature, estimated_cost, success, created_at')
          .gte('created_at', statsSinceTs)
          .order('created_at', { ascending: true })
          .range(offset, offset + pageSize - 1),
      );

      dashscopeRows = await fetchPagedRows(sb, (offset, pageSize) =>
        sb
          .from('api_usage_log')
          .select('feature, estimated_cost, success')
          .eq('provider', 'dashscope')
          .order('created_at', { ascending: true })
          .range(offset, offset + pageSize - 1),
      );
    }
  } catch (err) {
    if (isMissingTableError(err)) {
      if (!serpLive) {
        return { empty: true, notice: 'api_usage_log table not found.' };
      }
    } else {
      throw err;
    }
  }

  const hasAnyData =
    recentRows.length > 0 ||
    periodRows.length > 0 ||
    dashscopeRows.length > 0 ||
    serpLive != null;
  if (!hasAnyData) {
    return { empty: true };
  }
  const today = klTodayIso();
  const monthKey = klMonthKey(today);

  let callsToday = 0;
  let callsThisMonth = 0;
  let costToday = 0;
  let costThisMonth = 0;
  let serpapiUsed = 0;
  let serpapiHotels = 0;
  let serpapiFlights = 0;

  const dailyMap = {};
  for (let i = 13; i >= 0; i -= 1) {
    dailyMap[isoDaysAgoKL(i)] = 0;
  }

  for (const row of periodRows) {
    const rowDay = klDateIso(new Date(row.created_at));
    const cost = Number(row.estimated_cost) || 0;

    if (rowDay === today) {
      callsToday += 1;
      costToday += cost;
    }
    if (klMonthKey(rowDay) === monthKey) {
      callsThisMonth += 1;
      costThisMonth += cost;
    }
    if (Object.prototype.hasOwnProperty.call(dailyMap, rowDay)) {
      dailyMap[rowDay] += 1;
    }
    if (row.provider === 'serpapi' && klMonthKey(rowDay) === monthKey) {
      serpapiUsed += 1;
      if (row.feature === 'hotels') serpapiHotels += 1;
      if (row.feature === 'flights') serpapiFlights += 1;
    }
  }

  const featureAgg = {};
  for (const row of dashscopeRows) {
    const key = row.feature || 'unknown';
    if (!featureAgg[key]) {
      featureAgg[key] = { calls: 0, cost: 0, success: 0 };
    }
    featureAgg[key].calls += 1;
    featureAgg[key].cost += Number(row.estimated_cost) || 0;
    if (row.success) featureAgg[key].success += 1;
  }

  const byFeature = Object.keys(featureAgg)
    .map((feature) => {
      const agg = featureAgg[feature];
      const meta = FEATURE_META[feature] || { icon: '⚙️', label: feature };
      return {
        feature,
        icon: meta.icon,
        label: meta.label,
        calls: agg.calls,
        cost: agg.cost,
        successRate: agg.calls > 0 ? Math.round((agg.success / agg.calls) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const serpUsed = serpLive ? serpLive.used : serpapiUsed;
  const serpLimit = serpLive ? serpLive.limit : SERPAPI_MONTHLY_LIMIT;
  const serpRemaining = serpLive
    ? serpLive.remaining
    : Math.max(0, SERPAPI_MONTHLY_LIMIT - serpapiUsed);
  const fillPct = serpLimit > 0 ? Math.min(100, (serpUsed / serpLimit) * 100) : 0;

  return {
    empty: false,
    summary: {
      callsToday,
      callsThisMonth,
      costToday,
      costThisMonth,
    },
    serpapi: {
      used: serpUsed,
      remaining: serpRemaining,
      limit: serpLimit,
      fillPct,
      renewsLabel: nextMonthRenewLabel(),
      hotelsCount: serpapiHotels,
      flightsCount: serpapiFlights,
      source: serpLive ? serpLive.source : 'local_log',
      planName: serpLive ? serpLive.planName : null,
    },
    byFeature,
    dailyUsage: Object.keys(dailyMap)
      .sort()
      .map((date) => ({ date, count: dailyMap[date] })),
    recent: recentRows.map((row) => ({
      timestamp: row.created_at,
      provider: row.provider,
      feature: row.feature,
      model: row.model,
      cost: Number(row.estimated_cost) || 0,
      success: Boolean(row.success),
    })),
  };
}

module.exports = {
  SERPAPI_MONTHLY_LIMIT,
  fetchSerpApiAccountStatus,
  buildApiUsagePayload,
};