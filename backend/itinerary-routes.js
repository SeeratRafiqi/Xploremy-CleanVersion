'use strict';

const axios = require('axios');
const db = require('./db');
const { logApiUsage } = require('./api-usage-logger');
const { getSessionUserId } = require('./auth-routes');
const {
  applyFlightScheduleToDays,
  extractFlightSchedule,
  flightSchedulePromptBlock,
  flightSelectionValid,
} = require('./flight-schedule-helpers');

/** Wikimedia blocks requests without a descriptive User-Agent (often 403). */
const WIKI_HTTP_HEADERS = {
  'User-Agent': 'TicketScraper-TripPlanner/1.0 (itinerary place images; Node.js)',
};

function tryParseJsonString(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  const attempts = [
    raw,
    raw.replace(/,\s*([}\]])/g, '$1'),
    raw.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'"),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const p = JSON.parse(attempts[i]);
      if (p && typeof p === 'object') return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function tryCloseTruncatedJsonObject(s) {
  let t = String(s || '').trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  t = t.slice(start);
  let braces = 0;
  let brackets = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
  }
  if (inStr) t += '"';
  while (brackets > 0) {
    t += ']';
    brackets--;
  }
  while (braces > 0) {
    t += '}';
    braces--;
  }
  return tryParseJsonString(t);
}

function parseLlmJson(text) {
  const t = String(text || '').trim();
  let p = tryParseJsonString(t);
  if (p) return p;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    p = tryParseJsonString(fence[1].trim());
    if (p) return p;
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    p = tryParseJsonString(t.slice(start, end + 1));
    if (p) return p;
  }
  if (start >= 0) {
    p = tryCloseTruncatedJsonObject(t);
    if (p) return p;
  }
  return null;
}

function collectPlaceIdsFromRawDay(day) {
  if (!day || typeof day !== 'object') return [];
  const out = [];
  for (const slot of ['morning', 'afternoon', 'evening']) {
    const arr = day[slot];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const pid = String(it.placeId || it.id || '').trim();
      if (pid) out.push(pid);
    }
  }
  return out;
}

/** Fill missing `places` from day slots when the model returned days but omitted the catalog. */
function repairItineraryParsed(parsed, city) {
  if (!parsed || typeof parsed !== 'object') return null;
  let places = Array.isArray(parsed.places) ? parsed.places : [];
  places = places
    .map(function (p) {
      if (!p || typeof p !== 'object') return null;
      const id = String(p.id || p.placeId || '').trim();
      if (!id) return null;
      return Object.assign({}, p, { id: id });
    })
    .filter(Boolean);
  if (!places.length && Array.isArray(parsed.days)) {
    const seen = new Set();
    const stubs = [];
    const loc = String(city || 'Malaysia').trim() || 'Malaysia';
    parsed.days.forEach(function (day) {
      collectPlaceIdsFromRawDay(day).forEach(function (pid) {
        if (!pid || seen.has(pid)) return;
        seen.add(pid);
        stubs.push({
          id: pid,
          name: 'Stop ' + pid.replace(/^p/i, ''),
          description: 'A recommended stop on your itinerary.',
          funFact: '',
          duration: '1–2 hours',
          cost: 'Varies',
          category: 'Sightseeing',
          location: loc,
          mapQuery: loc + ' travel',
        });
      });
    });
    places = stubs;
  }
  parsed.places = places;
  const days = Array.isArray(parsed.days) ? parsed.days : [];
  if (!places.length || !days.length) return null;
  return parsed;
}

function itineraryMaxTokens(tripDays, fastGenerate) {
  const d = Math.max(1, Number(tripDays) || 1);
  if (!fastGenerate) return 8192;
  if (d <= 2) return 4096;
  if (d <= 5) return 6144;
  return 8192;
}

function isItineraryParseFailure(parsed) {
  return (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.days) ||
    parsed.days.length === 0 ||
    !Array.isArray(parsed.places) ||
    parsed.places.length === 0
  );
}

const DASHSCOPE_ITINERARY_TIMEOUT_MS = Math.min(
  300000,
  Math.max(60000, Number(process.env.DASHSCOPE_ITINERARY_TIMEOUT_MS) || 180000),
);

async function callDashScopeItinerary(systemPrompt, userBlock, callOpts = {}) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY not configured');
  const base =
    process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  const model =
    callOpts.model ||
    process.env.DASHSCOPE_ITINERARY_MODEL ||
    process.env.DASHSCOPE_MODEL ||
    'qwen-turbo';
  const maxTokens = callOpts.maxTokens != null ? callOpts.maxTokens : 8192;
  const url = `${base.replace(/\/$/, '')}/chat/completions`;

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), DASHSCOPE_ITINERARY_TIMEOUT_MS);
  let response;
  try {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(
          Object.assign(
            {
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userBlock },
              ],
              max_tokens: maxTokens,
            },
            callOpts.jsonMode ? { response_format: { type: 'json_object' } } : {},
          ),
        ),
        signal: ac.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(
          `Itinerary AI request timed out after ${Math.round(DASHSCOPE_ITINERARY_TIMEOUT_MS / 1000)}s — try a shorter trip or increase DASHSCOPE_ITINERARY_TIMEOUT_MS in .env`,
        );
      }
      throw e;
    } finally {
      clearTimeout(to);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg =
        data.error?.message || data.message || data.code || `DashScope error (${response.status})`;
      throw new Error(errMsg);
    }
    const choice = data.choices && data.choices[0] ? data.choices[0] : {};
    const text = choice.message?.content;
    if (!text) throw new Error('Empty response from DashScope');
    logApiUsage({
      provider: 'dashscope',
      feature: 'itinerary',
      model: data.model || model,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      success: true
    }).catch(() => {});
    return {
      text: String(text).trim(),
      finishReason: String(choice.finish_reason || '').trim(),
    };
  } catch (err) {
    logApiUsage({
      provider: 'dashscope',
      feature: 'itinerary',
      model: model,
      success: false
    }).catch(() => {});
    throw err;
  }
}

function todayMalaysiaISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}

function scrapedEventDateOnly(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  const iso = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

function isoDateParts(iso) {
  const s = String(iso || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), s };
}

function enumerateTripDates(arrivalIso, departureIso) {
  const a = isoDateParts(arrivalIso);
  const b = isoDateParts(departureIso);
  if (!a || !b) return [];
  const start = new Date(Date.UTC(a.y, a.mo - 1, a.d));
  const end = new Date(Date.UTC(b.y, b.mo - 1, b.d));
  if (end < start) return [];
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function tripDayCountInclusive(arrivalIso, departureIso) {
  return enumerateTripDates(arrivalIso, departureIso).length;
}

const OPEN_METEO_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_MAX_DAYS = 16;

/** Malaysian hubs — Open-Meteo free, no API key (lat/lon per user spec). */
const MY_CITY_COORDINATES = {
  'kuala lumpur': { lat: 3.139, lon: 101.6869, label: 'Kuala Lumpur, Malaysia' },
  kl: { lat: 3.139, lon: 101.6869, label: 'Kuala Lumpur, Malaysia' },
  'wilayah persekutuan': { lat: 3.139, lon: 101.6869, label: 'Kuala Lumpur, Malaysia' },
  penang: { lat: 5.4141, lon: 100.3288, label: 'Penang, Malaysia' },
  'george town': { lat: 5.4141, lon: 100.3288, label: 'Penang, Malaysia' },
  'pulau pinang': { lat: 5.4141, lon: 100.3288, label: 'Penang, Malaysia' },
  'johor bahru': { lat: 1.4927, lon: 103.7414, label: 'Johor Bahru, Malaysia' },
  jb: { lat: 1.4927, lon: 103.7414, label: 'Johor Bahru, Malaysia' },
  'kota kinabalu': { lat: 5.9749, lon: 116.0724, label: 'Kota Kinabalu, Malaysia' },
  kk: { lat: 5.9749, lon: 116.0724, label: 'Kota Kinabalu, Malaysia' },
  sabah: { lat: 5.9749, lon: 116.0724, label: 'Kota Kinabalu, Malaysia' },
};

function wmoWeatherLabel(code) {
  const c = Number(code);
  const map = {
    0: 'Clear',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    71: 'Snow',
    80: 'Rain showers',
    81: 'Heavy showers',
    82: 'Violent showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm & hail',
    99: 'Severe thunderstorm',
  };
  if (map[c]) return map[c];
  if (c > 80 && c < 85) return 'Showers';
  if (c >= 71 && c <= 77) return 'Snow';
  return 'Mixed';
}

function normalizeCityLookupKey(city) {
  return String(city || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bmalaysia\b/g, '')
    .trim();
}

function resolveMalaysiaCityCoordinates(city) {
  const raw = String(city || '').trim();
  const key = normalizeCityLookupKey(raw);
  if (!key) return null;
  if (MY_CITY_COORDINATES[key]) {
    const hit = MY_CITY_COORDINATES[key];
    return { latitude: hit.lat, longitude: hit.lon, label: hit.label };
  }
  const keys = Object.keys(MY_CITY_COORDINATES).sort(function (a, b) {
    return b.length - a.length;
  });
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (key.includes(k)) {
      const hit = MY_CITY_COORDINATES[k];
      return { latitude: hit.lat, longitude: hit.lon, label: hit.label };
    }
  }
  return null;
}

async function geocodeTripCityOpenMeteo(city) {
  const raw = String(city || '').trim();
  if (raw.length < 2) return null;
  const searchName = /\bmalaysia\b/i.test(raw) ? raw : `${raw}, Malaysia`;
  const { data } = await axios.get(OPEN_METEO_GEOCODE, {
    params: { name: searchName, count: 1, language: 'en', format: 'json' },
    timeout: 12000,
    headers: { Accept: 'application/json' },
  });
  const hit = data && Array.isArray(data.results) ? data.results[0] : null;
  if (!hit || hit.latitude == null || hit.longitude == null) return null;
  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    label: String(hit.name || raw) + (hit.country ? `, ${hit.country}` : ''),
  };
}

async function resolveTripCityGeo(city) {
  const preset = resolveMalaysiaCityCoordinates(city);
  if (preset) return preset;
  const geocoded = await geocodeTripCityOpenMeteo(city);
  if (geocoded) return geocoded;
  const fallback = MY_CITY_COORDINATES['kuala lumpur'];
  return {
    latitude: fallback.lat,
    longitude: fallback.lon,
    label: fallback.label,
    fallback: true,
  };
}

function buildCurrentWeatherSnapshot(currentWeather) {
  const cw = currentWeather && typeof currentWeather === 'object' ? currentWeather : null;
  if (!cw) return null;
  const temp =
    cw.temperature != null && Number.isFinite(Number(cw.temperature))
      ? Math.round(Number(cw.temperature))
      : null;
  const wind =
    cw.windspeed != null && Number.isFinite(Number(cw.windspeed))
      ? Math.round(Number(cw.windspeed))
      : null;
  const condition = wmoWeatherLabel(cw.weathercode != null ? cw.weathercode : 3);
  const tempStr = temp != null ? `${temp}\u00B0C` : '';
  const headline = tempStr ? `${tempStr} \u00b7 ${condition}` : condition;
  return {
    tempMax: temp,
    tempDisplay: tempStr,
    windKmh: wind,
    condition,
    headline,
    chip: headline,
    rainPct: null,
    humidity: null,
    isLive: true,
  };
}

function addDaysIsoServer(iso, delta) {
  const p = isoDateParts(iso);
  if (!p) return '';
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const OPEN_METEO_DAILY_VARS =
  'weathercode,temperature_2m_max,precipitation_probability_max,windspeed_10m_max,relative_humidity_2m_mean';

function openMeteoForecastUrl(lat, lon, extra) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current_weather: 'true',
    daily: OPEN_METEO_DAILY_VARS,
    timezone: 'Asia/Singapore',
    windspeed_unit: 'kmh',
  });
  const extraObj = extra && typeof extra === 'object' ? extra : {};
  Object.keys(extraObj).forEach(function (k) {
    if (extraObj[k] != null && extraObj[k] !== '') params.set(k, String(extraObj[k]));
  });
  return `${OPEN_METEO_FORECAST}?${params.toString()}`;
}

async function fetchOpenMeteoDailyRange(lat, lon, startIso, endIso) {
  const today = todayMalaysiaISO();
  const reqStart = String(startIso || '').slice(0, 10);
  const reqEnd = String(endIso || '').slice(0, 10);
  if (!isoDateParts(reqStart) || !isoDateParts(reqEnd)) {
    return {
      daily: null,
      error: 'Invalid start or end date',
      clipped: false,
      windowStart: reqStart,
      windowEnd: reqEnd,
      useIndexMapping: false,
      beyondHorizon: false,
    };
  }
  let tripStart = reqStart;
  let tripEnd = reqEnd >= tripStart ? reqEnd : reqStart;
  let nDays = enumerateTripDates(tripStart, tripEnd).length;
  if (nDays < 1) nDays = 1;

  const maxForecastEnd = addDaysIsoServer(today, OPEN_METEO_MAX_DAYS - 1);
  const tripBeyondHorizon = !!(maxForecastEnd && tripStart > maxForecastEnd);

  let apiStart = tripStart;
  let apiEnd = tripEnd;
  let useIndexMapping = tripBeyondHorizon;
  let clipped = tripBeyondHorizon;

  if (tripBeyondHorizon) {
    apiStart = today;
    apiEnd = maxForecastEnd || today;
  } else if (apiEnd < today) {
    useIndexMapping = true;
    apiStart = today;
    apiEnd = addDaysIsoServer(apiStart, nDays - 1) || apiStart;
  } else {
    if (apiStart < today) apiStart = today;
    if (apiEnd < apiStart) apiEnd = addDaysIsoServer(apiStart, nDays - 1) || apiStart;
    if (maxForecastEnd && apiEnd > maxForecastEnd) {
      apiEnd = maxForecastEnd;
      clipped = true;
    }
  }
  if (maxForecastEnd && apiEnd > maxForecastEnd) {
    apiEnd = maxForecastEnd;
    clipped = true;
  }
  if (apiEnd < apiStart) apiEnd = apiStart;

  const daySpan = enumerateTripDates(apiStart, apiEnd).length;
  const forecastDays = Math.min(Math.max(1, daySpan || nDays), OPEN_METEO_MAX_DAYS);

  async function pullForecast(extraParams) {
    const url = openMeteoForecastUrl(lat, lon, extraParams);
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
    return data;
  }

  function packResult(data, errText) {
    return {
      daily: data && data.daily ? data.daily : null,
      current: data && data.current_weather ? data.current_weather : null,
      error: errText || (data && data.error ? String(data.error) : ''),
      clipped: clipped || useIndexMapping,
      windowStart: apiStart,
      windowEnd: apiEnd,
      useIndexMapping,
      beyondHorizon: tripBeyondHorizon,
    };
  }

  try {
    const data = await pullForecast({ start_date: apiStart, end_date: apiEnd });
    return packResult(data, '');
  } catch (err) {
    const status = err.response && err.response.status;
    console.warn('[trip-weather] Open-Meteo range', apiStart, apiEnd, status || err.message);
    try {
      const data = await pullForecast({ forecast_days: String(forecastDays) });
      return packResult(data, '');
    } catch (err2) {
      const msg =
        (err2.response && err2.response.data && err2.response.data.reason) ||
        err2.message ||
        'Weather service unavailable';
      return packResult(
        null,
        String(msg).replace(/^Request failed with status code \d+\s*/i, '').trim() ||
          'Weather service unavailable',
      );
    }
  }
}

function nearestTripWeatherEntry(requestedIso, byDate, times) {
  const d = String(requestedIso || '').slice(0, 10);
  if (!d || !times.length) return null;
  if (byDate[d]) return { ...byDate[d], date: d };
  const sorted = times
    .map((t) => String(t || '').slice(0, 10))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
    .sort();
  if (!sorted.length) return null;
  let pick = sorted[sorted.length - 1];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] <= d) {
      pick = sorted[i];
      break;
    }
  }
  if (d < sorted[0]) pick = sorted[0];
  const src = byDate[pick];
  if (!src) return null;
  const approx = pick !== d;
  const est = approx ? ' \u00b7 est.' : '';
  return {
    ...src,
    date: d,
    approxDate: approx,
    headline: (src.headline || src.chip || '') + est,
    chip: (src.chip || src.headline || '') + est,
  };
}

function buildTripWeatherDays(daily, requestedDates, useIndexMapping) {
  const times = daily && Array.isArray(daily.time) ? daily.time : [];
  const byDate = {};
  for (let i = 0; i < times.length; i++) {
    const date = String(times[i] || '').slice(0, 10);
    const code = Array.isArray(daily.weathercode) ? daily.weathercode[i] : null;
    const tmax = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[i] : null;
    const rainP = Array.isArray(daily.precipitation_probability_max)
      ? daily.precipitation_probability_max[i]
      : null;
    const hum = Array.isArray(daily.relative_humidity_2m_mean)
      ? daily.relative_humidity_2m_mean[i]
      : null;
    const windDaily = Array.isArray(daily.windspeed_10m_max) ? daily.windspeed_10m_max[i] : null;
    const wind = windDaily;
    const condition = wmoWeatherLabel(code != null ? code : 3);
    const tempMax = tmax != null && Number.isFinite(Number(tmax)) ? Math.round(Number(tmax)) : null;
    const tempStr = tempMax != null ? `${tempMax}\u00B0C` : '';
    const headline = tempStr ? `${tempStr} \u00b7 ${condition}` : condition;
    const chip = tempStr
      ? `${tempStr} \u00b7 ${condition}${rainP != null ? ` \u00b7 ${Math.round(Number(rainP))}% rain` : ''}`
      : condition;
    byDate[date] = {
      date,
      tempMax,
      tempDisplay: tempStr,
      condition,
      headline,
      chip,
      rainPct: rainP != null ? Math.round(Number(rainP)) : null,
      humidity: hum != null ? Math.round(Number(hum)) : null,
      windKmh: wind != null ? Math.round(Number(wind)) : null,
    };
  }
  const days = (Array.isArray(requestedDates) ? requestedDates : []).map((iso, idx) => {
    const d = String(iso || '').slice(0, 10);
    if (byDate[d]) return { ...byDate[d], date: d };
    const nearest = nearestTripWeatherEntry(d, byDate, times);
    if (nearest) return nearest;
    if (useIndexMapping && times.length) {
      const srcIdx = Math.min(idx, times.length - 1);
      const srcKey = String(times[srcIdx] || '').slice(0, 10);
      const src = byDate[srcKey];
      if (src) {
        return {
          ...src,
          date: d,
          headline: (src.headline || src.chip || '') + ' \u00b7 est.',
          chip: (src.chip || src.headline || '') + ' \u00b7 est.',
          approxDate: true,
        };
      }
    }
    return {
      date: d,
      tempMax: null,
      tempDisplay: '',
      headline: 'Forecast unavailable',
      chip: 'Forecast unavailable',
      unavailable: true,
    };
  });
  // Key by each requested trip date so clients can look up forecast per itinerary day.
  const byTripDate = {};
  days.forEach(function (row) {
    const k = row && String(row.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) byTripDate[k] = row;
  });
  return { byDate: byTripDate, days };
}

function formatDayLabel(dayIndex1, isoDate) {
  const p = isoDateParts(isoDate);
  if (!p) return `Day ${dayIndex1}`;
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(dt);
  const rest = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
  return `Day ${dayIndex1} — ${dow}, ${rest}`;
}

function eventDateOnly(row) {
  const raw = row?.date;
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const iso = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

function rowToEventOut(row) {
  const cityOut =
    row.city != null && String(row.city).trim() ? String(row.city).trim() : extractCityFromRow(row);
  return {
    id: row.id,
    title: row.title || 'Event',
    summary: row.description || '',
    venue: row.venue || '',
    city: cityOut,
    date: row.date || '',
    price: row.price || '',
    image: row.image_url || '',
    url: row.event_url || '',
    source: row.source || '',
    category: row.category || '',
    isFree: Boolean(row.is_free),
  };
}

/** Venue/city text → primary town for itinerary anchor (not always KL). */
function extractCityFromRow(row) {
  const c = row?.city != null && String(row.city).trim() ? String(row.city).trim() : '';
  if (c) return c;
  const v = String(row?.venue || '').toLowerCase();
  const hints = [
    ['kuala lumpur', 'Kuala Lumpur'],
    ['klcc', 'Kuala Lumpur'],
    ['bukit bintang', 'Kuala Lumpur'],
    ['mid valley', 'Kuala Lumpur'],
    ['mvec kl', 'Kuala Lumpur'],
    ['petaling jaya', 'Petaling Jaya'],
    ['subang jaya', 'Subang Jaya'],
    ['cyberjaya', 'Cyberjaya'],
    ['shah alam', 'Shah Alam'],
    ['klang', 'Klang'],
    ['putrajaya', 'Putrajaya'],
    ['genting', 'Genting Highlands'],
    ['cameron highland', 'Cameron Highlands'],
    ['cameron highlands', 'Cameron Highlands'],
    ['penang', 'Penang'],
    ['georgetown', 'George Town'],
    ['pulau pinang', 'Penang'],
    ['butterworth', 'Butterworth'],
    ['bukit mertajam', 'Bukit Mertajam'],
    ['langkawi', 'Langkawi'],
    ['alor setar', 'Alor Setar'],
    ['kedah', 'Alor Setar'],
    ['johor bahru', 'Johor Bahru'],
    ['johor', 'Johor Bahru'],
    ['legoland', 'Johor Bahru'],
    ['ipoh', 'Ipoh'],
    ['taiping', 'Taiping'],
    ['lumut', 'Lumut'],
    ['melaka', 'Melaka'],
    ['malacca', 'Melaka'],
    ['seremban', 'Seremban'],
    ['port dickson', 'Port Dickson'],
    ['kuantan', 'Kuantan'],
    ['kuala terengganu', 'Kuala Terengganu'],
    ['terengganu', 'Kuala Terengganu'],
    ['kota bharu', 'Kota Bharu'],
    ['kelantan', 'Kota Bharu'],
    ['kuching', 'Kuching'],
    ['miri', 'Miri'],
    ['sibu', 'Sibu'],
    ['kota kinabalu', 'Kota Kinabalu'],
    ['sandakan', 'Sandakan'],
    ['tawau', 'Tawau'],
    ['labuan', 'Labuan'],
    ['kota kinabalu convention', 'Kota Kinabalu'],
  ];
  for (const [needle, city] of hints) {
    if (v.includes(needle)) return city;
  }
  return 'Kuala Lumpur';
}

const CITY_TO_STATE = {
  'Kuala Lumpur': 'Wilayah Persekutuan',
  'Petaling Jaya': 'Selangor',
  'Subang Jaya': 'Selangor',
  'Cyberjaya': 'Selangor',
  'Shah Alam': 'Selangor',
  'Klang': 'Selangor',
  'Putrajaya': 'Wilayah Persekutuan',
  'Genting Highlands': 'Pahang',
  'Cameron Highlands': 'Pahang',
  'Penang': 'Pulau Pinang',
  'George Town': 'Pulau Pinang',
  'Butterworth': 'Pulau Pinang',
  'Bukit Mertajam': 'Pulau Pinang',
  'Langkawi': 'Kedah',
  'Alor Setar': 'Kedah',
  'Johor Bahru': 'Johor',
  'Ipoh': 'Perak',
  'Taiping': 'Perak',
  'Lumut': 'Perak',
  'Melaka': 'Melaka',
  'Seremban': 'Negeri Sembilan',
  'Port Dickson': 'Negeri Sembilan',
  'Kuantan': 'Pahang',
  'Kuala Terengganu': 'Terengganu',
  'Kota Bharu': 'Kelantan',
  'Kuching': 'Sarawak',
  'Miri': 'Sarawak',
  'Sibu': 'Sarawak',
  'Kota Kinabalu': 'Sabah',
  'Sandakan': 'Sabah',
  'Tawau': 'Sabah',
  'Labuan': 'Wilayah Persekutuan Labuan',
};

function stateForCity(city) {
  const c = String(city || '').trim();
  return CITY_TO_STATE[c] || '';
}

function geoGuidanceForTrip(tripDays, anchorCity, stateName) {
  const st = stateName ? ` (${stateName})` : '';
  const base = `Primary base: **${anchorCity}**${st}. Almost all sightseeing should be real places in or near this area. Do NOT default to Kuala Lumpur unless the event is there.`;
  if (tripDays <= 3) {
    return `${base}\nTrip length: ${tripDays} day(s) — stay focused on ${anchorCity} and easy half-day radius (no overnight hops to other states unless the event city is already a gateway).`;
  }
  if (tripDays <= 5) {
    return `${base}\nTrip length: ${tripDays} days — mostly ${anchorCity}, but you may add **one** full-day side trip to the nearest major draw in the same state or an adjacent state (realistic drive/bus time). Mention travel time in tips.`;
  }
  if (tripDays <= 9) {
    return `${base}\nTrip length: ${tripDays} days — split time between **${anchorCity}** and **1–2 other Malaysian cities/states** (e.g. if base is Penang, consider Taiping/Langkawi; if Johor, consider Melaka; if KL, consider Melaka or Genting). Reserve at least half the days anchored in ${anchorCity}. Put inter-state moves on dedicated days with lighter evening plans.`;
  }
  return `${base}\nTrip length: ${tripDays} days (long) — build a **multi-state Malaysia arc**: strong coverage in **${anchorCity}**, plus **several days** in **other states** with logical routing (minimize backtracking). Include travel/rest buffers; use subtitles to label days like "Travel to …" or "Melaka stopover". Still keep the **main event day** centred in ${anchorCity} or its immediate area.`;
}

async function fetchEventsDuringTripWindow(supabase, arrivalIso, departureIso, limit) {
  const a = String(arrivalIso || '').slice(0, 10);
  const b = String(departureIso || '').slice(0, 10);
  if (!a || !b || b < a) return [];
  const sel = 'title, date, venue, city, category, source';
  const { data, error } = await supabase
    .from('events_chatbot')
    .select(sel)
    .gte('date', a)
    .lte('date', b)
    .order('date', { ascending: true })
    .limit(Math.min(40, limit));
  if (error) {
    console.warn('[itinerary] trip-window events:', error.message);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function googleMapsUrl(query) {
  const q = String(query || '').trim();
  if (!q) return 'https://www.google.com/maps/search/?api=1&query=Malaysia';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function googleMapsUrlByPlaceId(placeId, query) {
  const pid = String(placeId || '').trim();
  if (!pid) return googleMapsUrl(query);
  const q = String(query || '').trim() || 'Malaysia';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&query_place_id=${encodeURIComponent(pid)}`;
}

function bestMapQueryForPlace(place, city) {
  const name = String(place?.name || '').trim();
  const loc = String(place?.location || '').trim();
  const mq = String(place?.mapQuery || '').trim();
  const c = String(city || '').trim();
  const parts = [name, loc || mq, c, 'Malaysia'].filter(Boolean);
  return parts.join(', ');
}

function travelLinksForCity(city) {
  const c = encodeURIComponent(city || 'Kuala Lumpur');
  return {
    flights: `https://www.google.com/travel/flights?q=flights%20to%20${c}`,
    hotels: `https://www.google.com/travel/hotels?q=hotels%20in%20${c}`,
  };
}

const GENERIC_TRAVEL_IMG =
  'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&w=400&q=70';

/** Stable pseudo-random cover when Wikipedia / Commons / Unsplash all miss (loads reliably in `<img>`). */
function seededPicsumUrl(placeName, city) {
  const seed = String(`${placeName || ''}|${city || ''}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const s = seed || 'malaysia-trip';
  return `https://picsum.photos/seed/${encodeURIComponent(s)}/400/200`;
}

function pickFirstPhotoReference(details, candidate) {
  const det = details || {};
  const c = candidate || {};
  const fromDet = det.photos?.[0]?.photo_reference;
  if (fromDet) return String(fromDet).trim();
  const fromCand = c.photos?.[0]?.photo_reference;
  if (fromCand) return String(fromCand).trim();
  return '';
}

function googlePlacePhotoUrl(photoRef, maxWidth, apiKey) {
  const ref = String(photoRef || '').trim();
  const key = String(apiKey || '').trim();
  if (!ref || !key) return '';
  const w = Math.min(1600, Math.max(200, Number(maxWidth) || 800));
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photo_reference=${encodeURIComponent(ref)}&key=${encodeURIComponent(key)}`;
}

function unsplashClientIdFromEnv() {
  return String(
    process.env.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_API_KEY || '',
  ).trim();
}

async function fetchUnsplashImage(placeName, city, accessKey) {
  if (!accessKey) return null;
  const q = `${placeName} ${city}`.trim().slice(0, 100);
  try {
    const url = `https://api.unsplash.com/search/photos?per_page=1&query=${encodeURIComponent(q)}&client_id=${accessKey}`;
    const { data } = await axios.get(url, { timeout: 4000 });
    const u = data?.results?.[0]?.urls?.small || data?.results?.[0]?.urls?.regular;
    return u || null;
  } catch {
    return null;
  }
}

function scoreWikiThumbnailPage(page, placeName) {
  const title = String(page?.title || '').toLowerCase();
  const src = String(page?.thumbnail?.source || '').toLowerCase();
  let score = 0;
  const q = normalizeSearchText(placeName);
  for (const tok of q.split(' ').filter((t) => t.length >= 3)) {
    if (title.includes(tok)) score += 3;
  }
  if (src.includes('.svg')) score -= 12;
  if (src.includes('logo')) score -= 10;
  if (/\.(jpe?g|webp|png)(\?|$)/i.test(src)) score += 4;
  const w = Number(page?.thumbnail?.width);
  if (Number.isFinite(w) && w >= 400) score += 1;
  return score;
}

function pickBestWikipediaThumbnail(pages, placeName) {
  if (!pages || typeof pages !== 'object') return null;
  const list = Object.values(pages).filter((p) => p && p.pageid != null);
  let best = null;
  let bestScore = -Infinity;
  for (const p of list) {
    const src = p?.thumbnail?.source;
    if (!src || !/^https?:\/\//i.test(String(src))) continue;
    const sc = scoreWikiThumbnailPage(p, placeName);
    if (sc > bestScore) {
      bestScore = sc;
      best = String(src);
    }
  }
  return best;
}

/**
 * English Wikipedia: direct title match, then on-wiki search (place + optional city).
 * Some titles have no PageImages thumbnail; search surfaces related articles with photos.
 */
async function fetchWikipediaImage(placeName, city) {
  const title = String(placeName || '').trim().slice(0, 200);
  if (!title) return null;
  const cityPart = String(city || '').trim().slice(0, 80);
  const opts = { timeout: 4500, headers: WIKI_HTTP_HEADERS };

  const runQuery = async (params) => {
    const url = `https://en.wikipedia.org/w/api.php?${params}&format=json`;
    const { data } = await axios.get(url, opts);
    return data?.query?.pages;
  };

  try {
    const pages1 = await runQuery(
      `action=query&titles=${encodeURIComponent(title)}&prop=pageimages&piprop=thumbnail&pithumbsize=600`,
    );
    const t1 = pickBestWikipediaThumbnail(pages1, title);
    if (t1) return t1;
  } catch {
    // ignore
  }

  const searches = [title, cityPart ? `${title} ${cityPart}`.trim() : ''].filter(Boolean);
  const seen = new Set();
  for (const gsr of searches) {
    const k = gsr.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      const pages2 = await runQuery(
        `action=query&generator=search&gsrsearch=${encodeURIComponent(gsr)}&gsrnamespace=0&gsrlimit=8&prop=pageimages&piprop=thumbnail&pithumbsize=600`,
      );
      const t2 = pickBestWikipediaThumbnail(pages2, title);
      if (t2) return t2;
    } catch {
      // ignore
    }
  }
  return null;
}

async function fetchWikimediaImage(placeName, city) {
  const q = `${placeName} ${city}`.trim().slice(0, 120);
  const api = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900&format=json&origin=*`;
  try {
    const { data } = await axios.get(api, { timeout: 4500, headers: WIKI_HTTP_HEADERS });
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
    for (const p of pages) {
      const ii = Array.isArray(p?.imageinfo) ? p.imageinfo[0] : null;
      const url = ii?.thumburl || ii?.url || '';
      if (url && /^https?:\/\//i.test(url)) return url;
    }
  } catch {
    // ignore and fallback
  }
  return null;
}

/**
 * Prefer Wikipedia (official page image) → Wikimedia Commons → Unsplash.
 * @param {string} [unsplashOverride] optional client id (else env)
 */
async function getPlaceImageHybrid(placeName, city, unsplashOverride) {
  const unsplashKey = String(unsplashOverride || '').trim() || unsplashClientIdFromEnv();
  try {
    const wikiImg = await fetchWikipediaImage(placeName, city);
    if (wikiImg) {
      console.log('[itinerary] image Wikipedia:', placeName);
      return wikiImg;
    }
  } catch (e) {
    console.log('[itinerary] Wikipedia image failed:', placeName, e?.message || e);
  }
  try {
    const wikimedUrl = await fetchWikimediaImage(placeName, city);
    if (wikimedUrl) {
      console.log('[itinerary] image Wikimedia:', placeName);
      return wikimedUrl;
    }
  } catch (e) {
    console.log('[itinerary] Wikimedia image failed:', placeName, e?.message || e);
  }
  try {
    if (unsplashKey) {
      const unsplashUrl = await fetchUnsplashImage(placeName, city, unsplashKey);
      if (unsplashUrl) {
        console.log('[itinerary] image Unsplash:', placeName);
        return unsplashUrl;
      }
    }
  } catch (e) {
    console.log('[itinerary] Unsplash image failed:', placeName, e?.message || e);
  }
  console.log('[itinerary] image fallback (picsum seed):', placeName);
  return seededPicsumUrl(placeName, city);
}

const ARRIVAL_DAY_TIPS = [
  'Arrival day: keep the schedule light, confirm check-in, and rehydrate.',
  'Peak traffic is roughly 7–10am and 5–8pm — plan airport transfers with buffer.',
];

const DEPARTURE_DAY_TIPS = [
  'Departure day: aim to finish any distant spots by early afternoon.',
  'Allow extra time for check-out and the airport (often 2–3h for international).',
];

function mergeUniqueTips(existing, additions) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((t) => String(t).toLowerCase()));
  for (const t of additions) {
    const s = String(t || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function appendLabelSegment(label, segment) {
  const L = String(label || '').trim();
  const S = String(segment || '').trim();
  if (!S) return L;
  if (L.includes(S)) return L;
  return L ? `${L} · ${S}` : S;
}

/**
 * First calendar day: light arrival schedule. Last day: easy departure.
 * Single-day trips combine both constraints.
 */
function adjustItineraryForArrivalDeparture(days) {
  if (!Array.isArray(days) || days.length === 0) return days;

  if (days.length === 1) {
    const d = days[0];
    d.isArrivalDay = true;
    d.isDepartureDay = true;
    d.label = appendLabelSegment(d.label, 'Arrival & departure — light day');
    d.subtitle = 'Travel day — light schedule, check-in/out and airport';
    d.morning = [];
    d.afternoon = [];
    d.evening = Array.isArray(d.evening) ? d.evening.slice(0, 1) : [];
    d.tips = mergeUniqueTips(d.tips, [...ARRIVAL_DAY_TIPS, ...DEPARTURE_DAY_TIPS]);
    return days;
  }

  days[0].isArrivalDay = true;
  days[0].label = appendLabelSegment(days[0].label, 'Arrival day — light schedule');
  days[0].subtitle = 'Arrival day — light schedule, check-in and rest';
  days[0].morning = [];
  days[0].afternoon = [];
  days[0].evening = Array.isArray(days[0].evening) ? days[0].evening.slice(0, 1) : [];
  days[0].tips = mergeUniqueTips(days[0].tips, ARRIVAL_DAY_TIPS);

  const lastIdx = days.length - 1;
  days[lastIdx].isDepartureDay = true;
  days[lastIdx].label = appendLabelSegment(days[lastIdx].label, 'Departure day');
  days[lastIdx].subtitle = 'Departure day — easy morning, travel to airport';
  days[lastIdx].afternoon = [];
  days[lastIdx].evening = [];
  days[lastIdx].tips = mergeUniqueTips(days[lastIdx].tips, DEPARTURE_DAY_TIPS);

  return days;
}

function normalizeOpenNowFromPlaceDetails(details) {
  if (!details || typeof details !== 'object') return null;
  if (typeof details.opening_hours?.open_now === 'boolean') return details.opening_hours.open_now;
  const periods = details.current_opening_hours?.open_now;
  if (typeof periods === 'boolean') return periods;
  return null;
}

function businessStatusLabel(status, openNow) {
  const s = String(status || '').toUpperCase();
  if (s === 'CLOSED_TEMPORARILY') return 'Temporarily closed';
  if (s === 'CLOSED_PERMANENTLY') return 'Permanently closed';
  if (typeof openNow === 'boolean') return openNow ? 'Open now' : 'Closed now';
  if (s === 'OPERATIONAL') return 'Operational';
  return '';
}

function normalizeSearchText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlapScore(a, b) {
  const aa = normalizeSearchText(a)
    .split(' ')
    .filter((x) => x.length >= 3);
  const bb = new Set(
    normalizeSearchText(b)
      .split(' ')
      .filter((x) => x.length >= 3),
  );
  if (!aa.length || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit += 1;
  return hit / Math.max(aa.length, 1);
}

/** Best name match vs LLM name, mapQuery, or substring (cafés / long names). */
function bestGoogleNameMatchScore(place, googleName) {
  const g = String(googleName || '').trim();
  if (!g) return 0;
  const n = String(place?.name || '').trim();
  const mq = String(place?.mapQuery || '').trim();
  const scores = [tokenOverlapScore(n, g)];
  if (mq) {
    scores.push(tokenOverlapScore(mq, g));
    scores.push(tokenOverlapScore(`${n} ${mq}`, g));
  }
  const nNorm = normalizeSearchText(n);
  const gNorm = normalizeSearchText(g);
  if (nNorm.length >= 6 && gNorm.includes(nNorm.slice(0, Math.min(48, nNorm.length)))) {
    scores.push(0.42);
  }
  if (mq) {
    const mqNorm = normalizeSearchText(mq);
    if (mqNorm.length >= 6 && gNorm.includes(mqNorm.slice(0, Math.min(48, mqNorm.length)))) {
      scores.push(0.42);
    }
  }
  return Math.max(...scores, 0);
}

function addressMatchesPlaceHints(addrRaw, place, city, stateName) {
  const addr = normalizeSearchText(addrRaw);
  const tokens = [
    ...normalizeSearchText(city).split(' ').filter((t) => t.length >= 3),
    ...normalizeSearchText(stateName).split(' ').filter((t) => t.length >= 3),
    ...normalizeSearchText(place?.location || '').split(' ').filter((t) => t.length >= 3),
  ];
  return tokens.some((tok) => addr.includes(tok));
}

function buildPlaceQueries(place, city, stateName) {
  const name = String(place?.name || '').trim();
  const area = String(place?.location || '').trim();
  const mq = String(place?.mapQuery || '').trim();
  const state = String(stateName || '').trim();
  const raw = [
    `${name} ${area} ${city} ${state} Malaysia`,
    `${name} ${city} ${state} Malaysia`,
    `${name} ${city} Malaysia`,
    `${name} ${area} Malaysia`,
    mq ? `${mq} ${city} Malaysia` : '',
    mq && area ? `${mq} ${area} Malaysia` : '',
    name ? `${name} Malaysia` : '',
  ];
  const out = [];
  const seen = new Set();
  for (const q of raw) {
    const s = q.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.slice(0, 180));
  }
  return out;
}

function shapeGoogleMeta(candidate, details, fallbackQuery) {
  const det = details || {};
  const c = candidate || {};
  const finalAddress = String(det.formatted_address || c.formatted_address || '').trim();
  const lat = Number(det.geometry?.location?.lat ?? c.geometry?.location?.lat);
  const lng = Number(det.geometry?.location?.lng ?? c.geometry?.location?.lng);
  const openNow = normalizeOpenNowFromPlaceDetails(det);
  const biz = String(det.business_status || c.business_status || '').trim();
  return {
    placeId: String(c.place_id || det.place_id || '').trim(),
    formattedAddress: finalAddress,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    businessStatus: biz,
    openNow,
    statusLabel: businessStatusLabel(biz, openNow),
    googleMapsUrl: String(det.url || '').trim(),
    fallbackQuery: fallbackQuery || '',
    photoReference: pickFirstPhotoReference(det, c),
  };
}

async function fetchPlaceDetailsById(placeId, apiKey) {
  const detailsUrl =
    'https://maps.googleapis.com/maps/api/place/details/json?' +
    `place_id=${encodeURIComponent(placeId)}&fields=place_id,name,formatted_address,geometry,business_status,opening_hours,current_opening_hours,url,photos&key=${encodeURIComponent(apiKey)}`;
  const { data } = await axios.get(detailsUrl, { timeout: 5000 });
  return data?.result || {};
}

async function fetchGooglePlaceMeta(place, city, stateName, apiKey) {
  if (!apiKey) return { meta: null, reason: 'missing_api_key' };
  const queries = buildPlaceQueries(place, city, stateName);
  if (!queries.length) return { meta: null, reason: 'empty_query' };
  const placeName = String(place?.name || '').trim();
  const locality = `${city || ''} ${stateName || ''}`.trim();
  let lastReason = 'no_candidates';

  for (const query of queries) {
    try {
      const bias = locality ? `&locationbias=text:${encodeURIComponent(locality)}` : '';
      const findUrl =
        'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?' +
        `input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address,geometry,business_status,photos&key=${encodeURIComponent(apiKey)}${bias}`;
      const { data: findData } = await axios.get(findUrl, { timeout: 5000 });
      if (String(findData?.status || '').toUpperCase() === 'REQUEST_DENIED') {
        const msg = String(findData?.error_message || '').toLowerCase();
        if (msg.includes('legacy api') && msg.includes('not enabled')) {
          return { meta: null, reason: 'google_legacy_api_not_enabled' };
        }
        return { meta: null, reason: 'google_request_denied' };
      }
      const cands = Array.isArray(findData?.candidates) ? findData.candidates : [];
      if (!cands.length) {
        lastReason = 'findplace_no_candidates';
      } else {
        const sorted = cands
          .map((c) => ({ c, score: bestGoogleNameMatchScore(place, c?.name || '') }))
          .sort((a, b) => b.score - a.score);
        const best = sorted[0];
        const second = sorted[1]?.score ?? 0;
        const gap = best.score - second;
        const acceptFind =
          best &&
          (best.score >= 0.34 ||
            (cands.length === 1 && best.score >= 0.18) ||
            (best.score >= 0.26 && gap >= 0.1) ||
            (best.score >= 0.24 && gap >= 0.14));
        if (acceptFind) {
          const det = await fetchPlaceDetailsById(best.c.place_id, apiKey);
          return { meta: shapeGoogleMeta(best.c, det, query), reason: 'ok_findplace' };
        }
        lastReason = 'findplace_ambiguous';
      }

      const textUrl =
        'https://maps.googleapis.com/maps/api/place/textsearch/json?' +
        `query=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
      const { data: textData } = await axios.get(textUrl, { timeout: 5000 });
      if (String(textData?.status || '').toUpperCase() === 'REQUEST_DENIED') {
        const msg = String(textData?.error_message || '').toLowerCase();
        if (msg.includes('legacy api') && msg.includes('not enabled')) {
          return { meta: null, reason: 'google_legacy_api_not_enabled' };
        }
        return { meta: null, reason: 'google_request_denied' };
      }
      const results = Array.isArray(textData?.results) ? textData.results : [];
      if (!results.length) {
        lastReason = 'textsearch_no_results';
        continue;
      }
      const ranked = results
        .map((r) => ({ r, score: bestGoogleNameMatchScore(place, r?.name || '') }))
        .sort((a, b) => b.score - a.score);
      const top = ranked[0];
      if (top && top.score >= 0.28) {
        const det = await fetchPlaceDetailsById(top.r.place_id, apiKey);
        return { meta: shapeGoogleMeta(top.r, det, query), reason: 'ok_textsearch' };
      }
      if (top && top.score >= 0.18) {
        const addr = String(top.r?.formatted_address || '');
        if (addressMatchesPlaceHints(addr, place, city, stateName)) {
          const det = await fetchPlaceDetailsById(top.r.place_id, apiKey);
          return { meta: shapeGoogleMeta(top.r, det, query), reason: 'ok_textsearch_location' };
        }
      }
      {
        // Last-chance fallback for real places with messy names:
        // accept top textsearch result if it is in the target locality.
        const topR = results[0];
        const addr = String(topR?.formatted_address || '');
        const localityHit = addressMatchesPlaceHints(addr, place, city, stateName);
        const hasPhoto = Array.isArray(topR?.photos) && topR.photos.length > 0;
        if (topR?.place_id && (localityHit || hasPhoto)) {
          const det = await fetchPlaceDetailsById(topR.place_id, apiKey);
          return { meta: shapeGoogleMeta(topR, det, query), reason: 'ok_textsearch_relaxed' };
        }
        lastReason = 'textsearch_low_confidence';
        continue;
      }
    } catch {
      lastReason = 'google_api_error';
    }
  }
  return { meta: null, reason: lastReason };
}

async function fetchContextEvents(supabase, city, opts = {}) {
  const c = String(city || '').trim();
  if (!c) return [];
  const lim = Math.min(20, Math.max(4, Number(opts.limit) || 12));
  const esc = c.replace(/%/g, '').replace(/[,()]/g, ' ').trim();
  const pattern = `%${esc}%`;
  const sel = 'title, date, venue, city, category, source';
  const [cRes, vRes] = await Promise.all([
    supabase.from('events_chatbot').select(sel).ilike('city', pattern).limit(lim),
    supabase.from('events_chatbot').select(sel).ilike('venue', pattern).limit(lim),
  ]);
  if (cRes.error) console.warn('[itinerary] context city:', cRes.error.message);
  if (vRes.error) console.warn('[itinerary] context venue:', vRes.error.message);
  const key = (r) => `${r.title || ''}|${r.date || ''}|${r.venue || ''}`;
  const seen = new Set();
  const out = [];
  for (const r of [...(cRes.data || []), ...(vRes.data || [])]) {
    if (!r) continue;
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= 45) break;
  }
  return out;
}

const ITIN_SYSTEM_FAST = `You are an expert Malaysia travel guide. Output ONE JSON itinerary only.
Rules:
- Output ONLY one JSON object. No markdown.
- Follow GEO STRATEGY, flight arrival/departure constraints, and ACCENT in the user message.
- Use place ids p1, p2, … each place once. No image field on places.
- Keep descriptions to 1–2 short sentences; funFact one line; concise meals/tips.
- "days" length must match the date list exactly.`;

const ITIN_SYSTEM = `You are an expert Malaysia travel guide. You plan realistic day-by-day itineraries using real-style venue names.
Rules:
- Output ONLY one JSON object. No markdown fences, no commentary.
- **Geography:** Follow the GEO STRATEGY in the user message exactly. The traveller's main event sets the home base city — do NOT assume Kuala Lumpur unless that is the base given.
- For each place, "location" and "mapQuery" must name the real town/state (e.g. "George Town, Penang" not generic "Malaysia" only).
- Every place must appear at most once across all days (no duplicate place ids).
- Use stable place ids like "p1", "p2", ... in order.
- "morning", "afternoon", "evening" are arrays of objects: {"placeId":"p1","area":"neighbourhood or area"} (1–3 items each slot is fine; respect travel pace).
- "places" must list every placeId you reference with full fields (do **not** include an "image" field — the server attaches photos).
- Align exactly one "days" entry per calendar date provided (same order).
- Keep text concise; funFact one sentence; description 2–4 sentences.
- Costs in MYR when applicable (e.g. "RM 35" or "Free").
- On travel-heavy days, use "tips" for transport (bus/ETS/car time, booking hints).
- First trip date is arrival: respect CONFIRMED FLIGHT SCHEDULE landing time — never schedule tours or meals before the traveller lands (+ buffer). Late-night landings = check-in/rest only that day.
- Last trip date is departure: respect return flight departure time — all activities must end before airport buffer; no plans after latest leave-by time.
- Warnings array: use objects {"type":"overlap","severity":"info","message":"..."} when needed; can be empty.
- If an ACCENT paragraph is given in the user message, bias the route mix toward it while still respecting geography, pacing, arrival/departure rules, and the main event date.
- If a TRAVELLER PROFILE or CONFIRMED FLIGHT SCHEDULE / SELECTED PREFERRED HOTEL block appears in the user message, follow budget tier for realistic MYR costs, meal tiers, and hotel suggestions; treat flight times as hard constraints (do not invent flight numbers).`;

function profileQuestionnaireBlock(profile, selectedFlight, selectedHotel) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const lvlRaw = Number(p.budgetLevel);
  const lvl = Number.isFinite(lvlRaw) ? Math.min(4, Math.max(1, Math.round(lvlRaw))) : 2;
  const budgetGuide = {
    1: 'Tier 1 — keep suggestions cheap: street food, hawker centres, hostels/budget stays, public transport, many free walks and parks. Quote modest MYR.',
    2: 'Tier 2 — balanced spend: mix local cafes and mid restaurants, 3-star style hotels, Grab/taxis sometimes, paid tickets where worth it.',
    3: 'Tier 3 — comfortable: nicer restaurants, 4-star style stays, more paid attractions, occasional splurge meal.',
    4: 'Tier 4 — luxury-leaning: fine dining options, 5-star class stays where realistic, private transfers when sensible, exclusive experiences.',
  };
  const lines = [
    'TRAVELLER PROFILE (saved questionnaire — follow closely):',
    `- Home airport IATA: ${String(p.homeIata || '').trim() || 'unknown'}`,
    `- Based near: ${String(p.locationCity || '').trim() || '—'}, ${String(p.locationCountry || '').trim() || '—'}`,
    `- Event genres they like: ${JSON.stringify(Array.isArray(p.genres) ? p.genres : [])}`,
    `- Trip interests: ${JSON.stringify(Array.isArray(p.activityInterests) ? p.activityInterests : [])}`,
    `- Adventure style (activity boldness, not money): ${String(p.adventureLevel || 'medium')}`,
    `- Trip pace: ${String(p.pacePreference || 'balanced')}`,
    `- Spending tier (1–4, separate from adventure): ${lvl} — ${budgetGuide[lvl]}`,
    `- Preferred language: ${String(p.language || '').trim() || 'not specified'}`,
    `- Extra notes: ${String(p.notes || '').trim() || '(none)'}`,
    '',
    'INTEREST-SPECIFIC HINTS:',
    '- If they like Food: name specific dishes where possible.',
    '- Nature: parks, trails, beaches, gardens.',
    '- Culture / History: museums, heritage walks, craft quarters.',
    '- Shopping: markets, boutiques, malls.',
    '- Adventure: active/outdoor blocks with realistic recovery time.',
    '- Religious sites: only where appropriate to destination; be respectful.',
    '',
    'PACE HINTS:',
    '- slow: max 2–3 meaningful stops per day, longer dwell time, rest breaks.',
    '- balanced: 3–4 stops typical.',
    '- packed: denser days but still respect first/last day arrival rules.',
  ];
  const schedule = extractFlightSchedule(selectedFlight);
  const flightBlock = flightSchedulePromptBlock(schedule);
  if (flightBlock) {
    lines.push(flightBlock);
    lines.push('Flight record (reference): ' + JSON.stringify(selectedFlight));
  } else if (selectedFlight && typeof selectedFlight === 'object' && Object.keys(selectedFlight).length) {
    lines.push('');
    lines.push('SELECTED FLIGHT (respect departure/arrival times; never invent new flight numbers):');
    lines.push(JSON.stringify(selectedFlight));
  }
  if (selectedHotel && typeof selectedHotel === 'object' && String(selectedHotel.name || '').trim()) {
    lines.push('');
    lines.push(
      'SELECTED PREFERRED HOTEL (traveller chose this listing — use as primary stay anchor for check-in rhythm and area; still diversify daily stops; do not rename or substitute a different property):',
    );
    lines.push(JSON.stringify(selectedHotel));
  }
  return lines.join('\n');
}

function buildUserPrompt({
  city,
  stateName,
  tripDays,
  geoGuidance,
  dates,
  mainEvent,
  contextEvents,
  contextEventsNational,
  prefs,
  variantAccent,
  densityInstruction = '',
  profileBlock = '',
  compact = false,
}) {
  const ctxLimit = compact ? 10 : 32;
  const nationalLimit = compact ? 0 : 28;
  const nationalSlice = Array.isArray(contextEventsNational)
    ? contextEventsNational.slice(0, nationalLimit)
    : [];
  return [
    `PRIMARY CITY (event anchor): ${city}${stateName ? ` — State/region: ${stateName}` : ''}`,
    densityInstruction
      ? `ACTIVITY DENSITY (CRITICAL — follow exactly on each full day; arrival/departure days may be lighter):\n${densityInstruction}`
      : '',
    `Trip length: ${tripDays} calendar day(s). This count is determined ONLY by arrival and departure dates — activity density does NOT change the number of days.`,
    `GEO STRATEGY:\n${geoGuidance}`,
    `Trip dates (inclusive, in order): ${JSON.stringify(dates)}`,
    `Main event the traveller attends (schedule around this): ${JSON.stringify(mainEvent)}`,
    `Other events in/near **${city}** (context only): ${JSON.stringify(contextEvents.slice(0, ctxLimit))}`,
    nationalSlice.length
      ? `Other events **anywhere in Malaysia** during their trip dates (ideas for multi-state days; optional): ${JSON.stringify(nationalSlice)}`
      : '',
    `User form selections (this request): adventureLevel=${prefs.adventureLevel}, interests=${JSON.stringify(prefs.interests)}, travelPace=${prefs.travelPace}, budgetTier=${prefs.budgetLevel != null ? prefs.budgetLevel : 'n/a'}`,
    profileBlock ? String(profileBlock) : '',
    ...(variantAccent
      ? [
          '',
          'ACCENT (make this itinerary **noticeably** different from a generic evenly-balanced baseline):',
          String(variantAccent),
        ]
      : []),
    '',
    'Return JSON with this shape:',
    `{`,
    `  "guideSummary": "string",`,
    `  "warnings": [{"type":"string","severity":"info|warn","message":"string"}],`,
    `  "days": [`,
    `    {`,
    `      "date": "YYYY-MM-DD",`,
    `      "subtitle": "short mood line for the day",`,
    `      "morning": [{"placeId":"p1","area":"..."}],`,
    `      "afternoon": [{"placeId":"p2","area":"..."}],`,
    `      "evening": [{"placeId":"p3","area":"..."}],`,
    `      "meals": [{"time":"12:30","type":"lunch","suggestion":"restaurant or area","dish":"dish name"}],`,
    `      "tips": ["string"]`,
    `    }`,
    `  ],`,
    `  "places": [`,
    `    {`,
    `      "id":"p1",`,
    `      "name":"string",`,
    `      "description":"string",`,
    `      "funFact":"string",`,
    `      "duration":"string",`,
    `      "cost":"string",`,
    `      "category":"string",`,
    `      "location":"string",`,
    `      "mapQuery":"string for Google Maps search"`,
    `    }`,
    `  ]`,
    `}`,
    '',
    `You MUST output exactly ${dates.length} objects in "days", with "date" fields exactly: ${dates.join(', ')}.`,
    compact
      ? 'SPEED: Keep each place description to 1–2 short sentences and funFact to one line. Omit verbose tips arrays when not needed.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeSlot(slot, placesById) {
  if (!slot) return [];
  const arr = Array.isArray(slot) ? slot : [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const pid = item.placeId || item.id;
    const p = pid != null ? placesById[String(pid)] : null;
    if (!p) continue;
    out.push({
      id: p.id,
      name: p.name,
      area: String(item.area || p.location || '').trim(),
      image: p.image,
    });
  }
  return out;
}

function buildPlacesById(placesArr) {
  const map = {};
  if (!Array.isArray(placesArr)) return map;
  for (const p of placesArr) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '').trim();
    if (!id) continue;
    map[id] = {
      id,
      name: String(p.name || 'Place').trim(),
      description: String(p.description || '').trim(),
      funFact: String(p.funFact || p.fun_fact || '').trim(),
      image: String(p.image || '').trim(),
      duration: String(p.duration || '').trim(),
      cost: String(p.cost || '').trim(),
      category: String(p.category || '').trim(),
      location: String(p.location || '').trim(),
      mapUrl: '',
      mapQuery: String(p.mapQuery || p.map_query || '').trim(),
      mapsPlaceId: String(p.mapsPlaceId || '').trim(),
      businessStatus: String(p.businessStatus || '').trim(),
      liveStatus: String(p.liveStatus || '').trim(),
      openNow: typeof p.openNow === 'boolean' ? p.openNow : null,
      latitude: Number.isFinite(Number(p.latitude)) ? Number(p.latitude) : null,
      longitude: Number.isFinite(Number(p.longitude)) ? Number(p.longitude) : null,
      matchReason: String(p.matchReason || '').trim(),
    };
  }
  return map;
}

/** Fast path: no Wikipedia/Unsplash/Google — instant seeded covers (used on initial generate). */
function hydratePlaceImagesFast(places, city) {
  return places.map((p) => {
    const mapQuery = bestMapQueryForPlace(p, city);
    return {
      ...p,
      image: seededPicsumUrl(p.name, city),
      mapQuery,
      mapUrl: googleMapsUrl(mapQuery),
    };
  });
}

async function hydratePlaceImages(places, city, unsplashKey) {
  const key = String(unsplashKey || '').trim() || unsplashClientIdFromEnv();
  const tasks = places.map(async (p) => {
    // Ignore model-supplied "image" URLs: models often repeat one generic stock URL for every place,
    // which skips Wikipedia/Wikimedia/Unsplash and makes all cards look identical.
    const geoHint = String(p.location || '').trim() || city;
    let img = (await getPlaceImageHybrid(p.name, geoHint, key)) || '';
    if (!img) img = GENERIC_TRAVEL_IMG;
    const mapQuery = bestMapQueryForPlace(p, city);
    return {
      ...p,
      image: img,
      mapQuery,
      mapUrl: googleMapsUrl(mapQuery),
    };
  });
  return Promise.all(tasks);
}

async function enrichPlacesWithGooglePlaces(places, city, stateName, googleApiKey) {
  if (!googleApiKey || !Array.isArray(places) || places.length === 0) {
    return { places, matched: 0, reasons: {} };
  }
  const reasons = {};
  const tasks = places.map(async (p) => {
    const result = await fetchGooglePlaceMeta(p, city, stateName, googleApiKey);
    const meta = result.meta;
    const reason = result.reason || '';
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (!meta) return { ...p, matchReason: reason };
    const mapQuery = bestMapQueryForPlace(p, city);
    const officialMaps = String(meta.googleMapsUrl || '').trim();
    const mapUrl = officialMaps || googleMapsUrlByPlaceId(meta.placeId, mapQuery);
    const googlePhoto =
      meta.photoReference && googleApiKey
        ? googlePlacePhotoUrl(meta.photoReference, 900, googleApiKey)
        : '';
    /** Prefer official Place Photo when Google matched — usually loads where hotlinked wiki thumbs fail. */
    const image = googlePhoto || String(p.image || '').trim() || GENERIC_TRAVEL_IMG;
    return {
      ...p,
      location: meta.formattedAddress || p.location,
      mapsPlaceId: meta.placeId || '',
      businessStatus: meta.businessStatus || '',
      liveStatus: meta.statusLabel || '',
      openNow: typeof meta.openNow === 'boolean' ? meta.openNow : null,
      latitude: meta.lat,
      longitude: meta.lng,
      mapQuery,
      mapUrl,
      matchReason: reason,
      image,
    };
  });
  const out = await Promise.all(tasks);
  const matched = out.filter((p) => String(p.mapsPlaceId || '').trim()).length;
  return { places: out, matched, reasons };
}

/** Warnings from Google-enriched place rows (closures, weak map pins). */
function appendPlacesLiveAlerts(warnings, places, googleEnabled) {
  if (!Array.isArray(warnings) || !Array.isArray(places) || !places.length) return;
  const perm = [];
  const temp = [];
  let noPin = 0;
  for (const p of places) {
    const n = String(p?.name || '').trim();
    if (googleEnabled && !String(p?.mapsPlaceId || '').trim()) noPin += 1;
    const biz = String(p?.businessStatus || '').toUpperCase();
    if (biz === 'CLOSED_PERMANENTLY' && n) perm.push(n);
    else if (biz === 'CLOSED_TEMPORARILY' && n) temp.push(n);
  }
  if (perm.length) {
    warnings.push({
      type: 'place_closed_permanent',
      severity: 'warn',
      message: `Google lists ${perm.length} stop(s) as permanently closed — remove or replace before you go: ${perm.slice(0, 4).join('; ')}${perm.length > 4 ? '…' : ''}.`,
    });
  }
  if (temp.length) {
    warnings.push({
      type: 'place_closed_temporary',
      severity: 'warn',
      message: `Some stops may be temporarily closed — confirm on Maps: ${temp.slice(0, 4).join('; ')}${temp.length > 4 ? '…' : ''}.`,
    });
  }
  if (googleEnabled) {
    const weakThreshold = Math.max(2, Math.ceil(places.length * 0.35));
    if (noPin >= weakThreshold) {
      warnings.push({
        type: 'map_search_fallback',
        severity: 'info',
        message: `${noPin}/${places.length} stops could not be tied to a single Google listing. "View on map" may show a search list — choose the row that matches the venue name or address.`,
      });
    }
  }
  if (googleEnabled || perm.length || temp.length) {
    warnings.push({
      type: 'hours_crowds',
      severity: 'info',
      message:
        'Opening hours and how busy a place feels can change. Double-check in Google Maps before you travel (weekends and evenings are often busier).',
    });
  }
}

/**
 * @returns {Promise<{ ok: true, id: string } | { ok: false, error: string }>}
 */
async function trySaveItinerary(supabase, row) {
  try {
    const { data, error } = await supabase.from('itineraries_generated').insert(row).select('id').single();
    if (error) {
      console.warn('[itinerary] save failed:', error.message);
      return { ok: false, error: error.message || 'Insert failed' };
    }
    const id = data && data.id != null ? String(data.id) : '';
    if (!id) {
      return { ok: false, error: 'Insert returned no row id' };
    }
    return { ok: true, id };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    console.warn('[itinerary] save exception:', msg);
    return { ok: false, error: msg };
  }
}

/** User-selected vibe + day density (one generation per request). */
const ITINERARY_VIBE_PRESETS = {
  chill: {
    key: 'chill',
    title: 'Chill',
    tagline: 'Relaxed & easygoing',
    accent:
      'Prioritise relaxed pacing: scenic strolls, cafés, parks, low-key neighbourhoods, spa or pool time, and unhurried meals. Avoid cramming or adrenaline-heavy blocks.',
  },
  adventurous: {
    key: 'adventurous',
    title: 'Adventurous',
    tagline: 'Active & bold',
    accent:
      'Prioritise active and bold experiences: hikes, water sports, adventure parks, street exploration, and energetic districts — still respect arrival/departure flight windows.',
  },
  foodie: {
    key: 'foodie',
    title: 'Foodie',
    tagline: 'Eat & discover',
    accent:
      'Prioritise food discovery: hawker centres, specialty coffee, bakeries, night markets, acclaimed restaurants, and dish-specific stops. Name real dishes where possible.',
  },
  cultural: {
    key: 'cultural',
    title: 'Cultural',
    tagline: 'Heritage & arts',
    accent:
      'Prioritise museums, heritage quarters, temples, galleries, craft districts, performances, and history-rich walks.',
  },
  party: {
    key: 'party',
    title: 'Party',
    tagline: 'Nightlife & social',
    accent:
      'Prioritise nightlife and social energy: bars, clubs, live music, late markets, and evening districts — schedule later slots on appropriate days.',
  },
};

const ITINERARY_PACE_HINTS = {
  light: 'DAY DENSITY — LIGHT: plan at most 2–3 meaningful activities per day plus meals; generous downtime and short transfers.',
  balanced:
    'DAY DENSITY — BALANCED: plan about 4–5 activities per day with sensible transitions and meal breaks.',
  full_on:
    'DAY DENSITY — FULL ON: plan 6 or more activities or experiences per day while still obeying arrival/departure flight constraints.',
};

const ITINERARY_VIBE_ORDER = ['chill', 'adventurous', 'foodie', 'cultural', 'party'];

function resolveItineraryVibeKeys(body) {
  const b = body && typeof body === 'object' ? body : {};
  let keys = [];
  if (Array.isArray(b.itineraryVibes)) {
    keys = b.itineraryVibes.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(b.itinerary_vibes)) {
    keys = b.itinerary_vibes.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  } else {
    const raw = String(b.itineraryVibe || b.itinerary_vibe || '')
      .trim()
      .toLowerCase();
    if (raw.includes(',')) {
      keys = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (raw) {
      keys = [raw];
    }
  }
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    if (!ITINERARY_VIBE_PRESETS[k] || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const k of ITINERARY_VIBE_ORDER) {
    if (out.length >= 5) break;
    if (seen.has(k)) continue;
  }
  if (!out.length) out.push('foodie');
  out.sort(
    (a, b) =>
      (ITINERARY_VIBE_ORDER.indexOf(a) === -1 ? 99 : ITINERARY_VIBE_ORDER.indexOf(a)) -
      (ITINERARY_VIBE_ORDER.indexOf(b) === -1 ? 99 : ITINERARY_VIBE_ORDER.indexOf(b)),
  );
  return out;
}

function resolveItineraryVibeKey(body) {
  const keys = resolveItineraryVibeKeys(body);
  return keys[0] || 'foodie';
}

function resolveItineraryPaceKey(body) {
  const raw = String((body && body.itineraryPace) || (body && body.itinerary_pace) || '')
    .trim()
    .toLowerCase();
  if (raw === 'light' || raw === 'balanced' || raw === 'full_on' || raw === 'fullon') {
    return raw === 'fullon' ? 'full_on' : raw;
  }
  return 'balanced';
}

function travelPaceFromItineraryPace(paceKey) {
  if (paceKey === 'light') return 'slow';
  if (paceKey === 'full_on') return 'packed';
  return 'balanced';
}

function normalizeItineraryPaceForDensity(paceKey) {
  const raw = String(paceKey || '')
    .trim()
    .toLowerCase();
  if (raw === 'full_on' || raw === 'fullon') return 'full';
  if (raw === 'light' || raw === 'balanced') return raw;
  return 'balanced';
}

function buildDensityInstruction(paceKey) {
  const pace = normalizeItineraryPaceForDensity(paceKey);
  return pace === 'light'
    ? 'Include EXACTLY 2 to 3 activities per day. Keep the schedule relaxed with lots of free time.'
    : pace === 'balanced'
      ? 'Include EXACTLY 4 to 5 activities per day. Mix sightseeing, food, and leisure.'
      : pace === 'full'
        ? 'Include EXACTLY 6 or more activities per day. Pack the schedule with diverse experiences.'
        : 'Include 4 to 5 activities per day.';
}

function buildItineraryAccent(vibeKeys) {
  const keys = Array.isArray(vibeKeys) && vibeKeys.length ? vibeKeys : ['foodie'];
  const vibeLines = keys.map((k) => {
    const vibe = ITINERARY_VIBE_PRESETS[k] || ITINERARY_VIBE_PRESETS.foodie;
    return `- ${vibe.title}: ${vibe.accent}`;
  });
  return [`Blend ALL of these vibes evenly across the trip (mix stops from each theme):`, ...vibeLines].join(
    '\n',
  );
}

function buildVariantMetaFromVibes(vibeKeys) {
  const keys = Array.isArray(vibeKeys) && vibeKeys.length ? vibeKeys : ['foodie'];
  const titles = keys.map((k) => (ITINERARY_VIBE_PRESETS[k] || ITINERARY_VIBE_PRESETS.foodie).title);
  return {
    key: keys.join('_'),
    title: titles.length > 1 ? titles.join(' · ') : titles[0] || 'Your trip',
    tagline:
      titles.length > 1
        ? `A mix of ${titles.join(', ')}`
        : (ITINERARY_VIBE_PRESETS[keys[0]] || ITINERARY_VIBE_PRESETS.foodie).tagline,
  };
}

/**
 * ONE itinerary per request — driven by vibe + pace (replaces the old ITIN_VARIANT_PRESETS × Promise.all loop).
 */
async function requestItineraryLlmParse(opts) {
  const {
    systemPrompt,
    userBlock,
    callOpts,
    city,
    tripDays,
    label,
  } = opts;
  const t0 = Date.now();
  const res = await callDashScopeItinerary(systemPrompt, userBlock, callOpts);
  const elapsed = Date.now() - t0;
  let parsed = parseLlmJson(res.text);
  parsed = repairItineraryParsed(parsed, city);
  console.log(
    '[itinerary]',
    label,
    'ms:',
    elapsed,
    'finish:',
    res.finishReason || '—',
    'places:',
    parsed && parsed.places ? parsed.places.length : 0,
    'days:',
    parsed && parsed.days ? parsed.days.length : 0,
  );
  return { parsed, finishReason: res.finishReason, elapsed };
}

async function generateSingleItineraryVariant(opts) {
  const {
    promptCtx,
    vibeKeys,
    itineraryPaceKey,
    dates,
    city,
    stateName,
    tripDays,
    selectedFlight,
    fastGenerate = true,
  } = opts;
  const keys = Array.isArray(vibeKeys) && vibeKeys.length ? vibeKeys : ['foodie'];
  const variantMeta = buildVariantMetaFromVibes(keys);
  const itineraryAccent = buildItineraryAccent(keys);
  const pace = normalizeItineraryPaceForDensity(itineraryPaceKey);
  const densityInstruction = buildDensityInstruction(itineraryPaceKey);
  const numDays = tripDays;
  console.log('[itinerary] building prompt — itineraryPaceKey:', itineraryPaceKey, 'pace:', pace);
  const userBlock = buildUserPrompt({
    ...promptCtx,
    variantAccent: itineraryAccent,
    densityInstruction,
    compact: fastGenerate,
  });
  console.log('[Itinerary] Pace:', pace, '| Days:', numDays, '| Density instruction:', densityInstruction);

  const attempts = [
    {
      label: 'fast',
      system: ITIN_SYSTEM_FAST,
      callOpts: { maxTokens: itineraryMaxTokens(tripDays, true) },
    },
    {
      label: 'fast-max',
      system: ITIN_SYSTEM_FAST,
      callOpts: { maxTokens: 8192 },
    },
    {
      label: 'full',
      system: ITIN_SYSTEM,
      callOpts: { maxTokens: 8192 },
    },
  ];

  let p = null;
  let lastFinish = '';
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    try {
      const got = await requestItineraryLlmParse({
        systemPrompt: att.system,
        userBlock: userBlock,
        callOpts: att.callOpts,
        city,
        tripDays,
        label: 'generate/' + att.label + (i ? '#retry' + i : ''),
      });
      lastFinish = got.finishReason || '';
      if (!isItineraryParseFailure(got.parsed)) {
        p = got.parsed;
        break;
      }
      if (got.finishReason === 'length') {
        console.warn('[itinerary] response truncated (length); retrying with more capacity');
      }
    } catch (e) {
      console.warn('[itinerary] generate attempt failed:', att.label, e.message || e);
      if (i === attempts.length - 1) throw e;
    }
  }

  if (isItineraryParseFailure(p)) {
    throw new Error(
      'Could not parse itinerary from AI' +
        (lastFinish === 'length'
          ? ' (response was cut off — try fewer trip days)'
          : ' — try again in a moment'),
    );
  }
  console.log('[itinerary] LLM ok, places pending hydrate');
  const fin = await finalizeItineraryFromParsed(p, {
    dates,
    city,
    stateName,
    tripDays,
    prependWarnings: [],
    suppressMultiState: true,
    selectedFlight,
    fastGenerate,
  });
  return {
    key: variantMeta.key,
    title: variantMeta.title,
    tagline: variantMeta.tagline,
    guideSummary: fin.guideSummary,
    warnings: fin.warnings || [],
    days: fin.days,
    places: fin.places,
    travelLinks: fin.travelLinks,
  };
}

const DAY_REGEN_SYSTEM = `You are an expert Malaysia travel guide. MODE: SINGLE-DAY REGENERATION.
Rules:
- Output ONLY one JSON object. No markdown, no prose.
- The user keeps the rest of the trip unchanged. You REPLACE exactly ONE calendar day.
- "replacementDay" must match the given calendar date exactly.
- "newPlaces": only places referenced by replacementDay slots that do NOT reuse existing IDs from retainedIds (if retainedIds is empty, all ids in replacementDay must be listed in newPlaces).
- If you reuse any existing retained place IDs in replacementDay slots, omit those names from newPlaces entirely.
- **Prefer fresh stops:** use NEW place ids prefixed with \`rp\` (rp1,rp2…) for brand-new stops introduced this day — easier for the server to merge.
- Keep arrival/departure logic in mind when dayIndex corresponds to first or last day.
- Respect GEO STRATEGY and the traveller's main event in the prompt.
- Optional top-level "guideSummary": one short clause if this day materially reframes the trip story.
`;

/**
 * Hydrate slot references, geo-enrich places, reshape days to match calendar.
 * @returns {Promise<{guideSummary:string,warnings:any[],days:any[],places:any[],travelLinks:{flights:string,hotels:string},placesLive?:object}>}
 */
async function finalizeItineraryFromParsed(parsed, ctx) {
  const {
    dates,
    city,
    stateName,
    tripDays,
    prependWarnings = [],
    suppressMultiState = false,
    suppressLivePlacesEcho = false,
    selectedFlight = null,
    fastGenerate = false,
  } = ctx;

  const warnings = prependWarnings.slice();

  let placesArr = Array.isArray(parsed.places) ? parsed.places : [];
  placesArr = placesArr
    .map((p) => ({
      id: String(p.id || '').trim(),
      name: p.name,
      description: p.description,
      funFact: p.funFact,
      duration: p.duration,
      cost: p.cost,
      category: p.category,
      location: p.location,
      mapQuery: p.mapQuery,
      image: p.image,
    }))
    .filter((p) => p.id);

  if (!placesArr.length) {
    throw new Error('No places in parsed itinerary');
  }

  let placesFull;
  let googlePlacesKey = '';
  let placesLive = null;
  if (fastGenerate) {
    placesFull = hydratePlaceImagesFast(placesArr, city);
  } else {
    placesFull = await hydratePlaceImages(placesArr, city, unsplashClientIdFromEnv());
    googlePlacesKey = process.env.GOOGLE_PLACES_API_KEY || '';
    placesLive = await enrichPlacesWithGooglePlaces(placesFull, city, stateName, googlePlacesKey);
    placesFull = placesLive.places;
  }

  let daysIn = Array.isArray(parsed.days) ? parsed.days : [];
  if (daysIn.length !== dates.length) {
    warnings.push({
      type: 'llm_days',
      severity: 'info',
      message: 'Adjusted day layout to match your trip dates.',
    });
    daysIn = dates.map((d, idx) => {
      const existing = daysIn[idx] && typeof daysIn[idx] === 'object' ? daysIn[idx] : {};
      return { ...existing, date: d };
    });
  }

  const placesByIdForSlots = buildPlacesById(placesFull);
  let daysOut = dates.map((d, idx) => {
    const src = daysIn[idx] && typeof daysIn[idx] === 'object' ? daysIn[idx] : {};
    const label = formatDayLabel(idx + 1, d);
    return {
      date: d,
      label,
      subtitle: String(src.subtitle || '').trim(),
      morning: normalizeSlot(src.morning, placesByIdForSlots),
      afternoon: normalizeSlot(src.afternoon, placesByIdForSlots),
      evening: normalizeSlot(src.evening, placesByIdForSlots),
      meals: Array.isArray(src.meals) ? src.meals : [],
      tips: Array.isArray(src.tips) ? src.tips.map((t) => String(t)) : [],
    };
  });

  adjustItineraryForArrivalDeparture(daysOut);
  const flightApplied = applyFlightScheduleToDays(daysOut, extractFlightSchedule(selectedFlight));
  if (flightApplied.warnings && flightApplied.warnings.length) {
    warnings.push(...flightApplied.warnings);
  }

  if (Array.isArray(parsed.warnings)) {
    for (const w of parsed.warnings) {
      if (w && typeof w === 'object' && w.message) warnings.push(w);
    }
  }

  if (!suppressLivePlacesEcho) {
    if (fastGenerate) {
      warnings.push({
        type: 'fast_generate',
        severity: 'info',
        message:
          'Generated in quick mode for speed. Place photos use instant previews; regenerate a day later for richer images and live venue checks.',
      });
    } else if (googlePlacesKey && placesLive) {
      const reasonPairs = Object.entries(placesLive.reasons || {}).sort((a, b) => b[1] - a[1]);
      const reasonHint = reasonPairs.length
        ? ` Breakdown: ${reasonPairs.map(([k, v]) => `${k}=${v}`).join(', ')}.`
        : '';
      warnings.push({
        type: 'live_places',
        severity: 'info',
        message:
          placesLive.matched > 0
            ? `Live Google Places checks matched ${placesLive.matched}/${placesFull.length} places (status/address may change).${reasonHint}`
            : `Google Places key is set, but no strong place matches were found for this plan.${reasonHint}`,
      });
      appendPlacesLiveAlerts(warnings, placesFull, true);
    } else if (!fastGenerate) {
      warnings.push({
        type: 'live_places',
        severity: 'info',
        message: 'Live open/closed status is unavailable because GOOGLE_PLACES_API_KEY is not configured.',
      });
      appendPlacesLiveAlerts(warnings, placesFull, false);
    }
  }

  if (!suppressMultiState && tripDays >= 6) {
    warnings.unshift({
      type: 'multi_state',
      severity: 'info',
      message: `Long trip (${tripDays} days): suggestions may span several states — confirm buses, ETS, or flights and booking sites before you travel.`,
    });
  }

  const guideSummary = String(parsed.guideSummary || '').trim() || `Your ${city} plan is ready.`;
  const travelLinks = travelLinksForCity(city);

  return {
    guideSummary,
    warnings,
    days: daysOut,
    places: placesFull,
    travelLinks,
    _placesLiveReasons: placesLive ? placesLive.reasons || {} : {},
    _matched: placesLive ? placesLive.matched : 0,
    _placesFullLen: placesFull.length,
    _googleKey: googlePlacesKey,
  };
}

function collectPlaceIdsFromDaySlots(day) {
  if (!day || typeof day !== 'object') return [];
  const out = [];
  for (const slot of ['morning', 'afternoon', 'evening']) {
    const arr = day[slot];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (it && it.id != null) out.push(String(it.id));
    }
  }
  return out;
}

function collectPlaceIdsFromAllDaysExcept(days, skipIdx) {
  const set = new Set();
  if (!Array.isArray(days)) return set;
  days.forEach((d, i) => {
    if (i === skipIdx || !d) return;
    collectPlaceIdsFromDaySlots(d).forEach((id) => set.add(id));
  });
  return set;
}

function summarizeOtherDaysForRegen(days, skipIdx) {
  if (!Array.isArray(days)) return '';
  return days
    .map((d, i) => {
      if (i === skipIdx || !d) return '';
      const slotNames = ['morning', 'afternoon', 'evening']
        .flatMap((k) => (Array.isArray(d[k]) ? d[k].map((x) => x.name || '') : []))
        .filter(Boolean);
      return `Day ${i + 1} (${d.date || ''}): ${(d.label || '').replace(/\s+/g, ' ').trim()} — stops: ${slotNames.slice(0, 8).join(', ')}${slotNames.length > 8 ? '…' : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildDayRegenUserPrompt({
  city,
  stateName,
  tripDays,
  geoGuidance,
  dates,
  mainEvent,
  dayIndex,
  targetDate,
  prefs,
  variantSnapshot,
  retainedPlaceIds,
}) {
  const other = summarizeOtherDaysForRegen(variantSnapshot.days, dayIndex);
  const oldDay = variantSnapshot.days[dayIndex] || {};
  const oldNames = ['morning', 'afternoon', 'evening']
    .flatMap((k) => (Array.isArray(oldDay[k]) ? oldDay[k].map((x) => x.name || '') : []))
    .filter(Boolean)
    .join('; ');

  return [
    `PRIMARY CITY: ${city}${stateName ? ` — ${stateName}` : ''}`,
    `Trip length: ${tripDays} day(s).`,
    `GEO STRATEGY:\n${geoGuidance}`,
    `All trip dates: ${JSON.stringify(dates)}`,
    `REGENERATE day index (0-based): ${dayIndex} — calendar date MUST be **${targetDate}**.`,
    `Main event: ${JSON.stringify(mainEvent)}`,
    `User preferences: adventureLevel=${prefs.adventureLevel}, interests=${JSON.stringify(prefs.interests)}, travelPace=${prefs.travelPace}`,
    '',
    'Other days (keep consistent — do NOT copy their stops verbatim; avoid repeating the exact same venues unless necessary):',
    other || '(none)',
    '',
    `Current day's stops to replace creatively: ${oldNames || '(empty)'}`,
    '',
    `Place IDs already used elsewhere in this itinerary — if you reuse one, omit it from "newPlaces" and reference that id:`,
    JSON.stringify([...retainedPlaceIds]),
    '',
    'Return JSON:',
    `{`,
    `"replacementDay": {`,
    `"date": "${targetDate}",`,
    `"subtitle": "string",`,
    `"morning": [{"placeId":"rp1","area":"..."}],`,
    `"afternoon": [...],`,
    `"evening": [...],`,
    `"meals": [],`,
    `"tips": ["string"]`,
    `},`,
    `"newPlaces": [`,
    `{ "id":"rp1","name":"...","description":"...","funFact":"...","duration":"...","cost":"...","category":"...","location":"...","mapQuery":"..." }`,
    `],`,
    `"guideSummary": "(optional) one short sentence to refine the trip summary if the new day changes the storyline"`,
    `}`,
    '',
    'replacementDay.slot objects use placeId (string). Every rp* id MUST appear exactly once in newPlaces.',
  ].join('\n');
}

async function regenerateSingleDay(sb, opts) {
  const {
    row,
    arrivalDate,
    departureDate,
    adventureLevel,
    travelPace,
    interests,
    dayIndex,
    variantSnapshot,
  } = opts;

  const city = extractCityFromRow(row);
  const stateName = stateForCity(city);
  const mainEvent = rowToEventOut(row);
  const dates = enumerateTripDates(arrivalDate, departureDate);
  const tripDays = dates.length;
  const geoGuidance = geoGuidanceForTrip(tripDays, city, stateName);

  if (!variantSnapshot?.days?.[dayIndex]) {
    throw new Error('Invalid day index');
  }
  const targetDate = variantSnapshot.days[dayIndex].date || dates[dayIndex];
  if (!targetDate) throw new Error('Missing target date');

  const retainedElsewhere = collectPlaceIdsFromAllDaysExcept(variantSnapshot.days, dayIndex);

  const userBlock = buildDayRegenUserPrompt({
    city,
    stateName,
    tripDays,
    geoGuidance,
    dates,
    mainEvent,
    dayIndex,
    targetDate,
    prefs: { adventureLevel, interests, travelPace },
    variantSnapshot,
    retainedPlaceIds: retainedElsewhere,
  });

  const llmRes = await callDashScopeItinerary(DAY_REGEN_SYSTEM, userBlock, {
    maxTokens: 4096,
  });
  const raw = llmRes.text;

  const parsed = parseLlmJson(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.replacementDay) {
    throw new Error('Invalid day regeneration response');
  }

  let newPlaces = Array.isArray(parsed.newPlaces) ? parsed.newPlaces : [];
  /** @type {Record<string,string>} remap old rp* → server unique id */
  const idRemap = {};
  let pi = 0;
  const existingIds = new Set((variantSnapshot.places || []).map((p) => String(p.id)));
  for (const p of newPlaces) {
    const oldId = String(p.id || '').trim();
    if (!oldId) continue;
    let nid = `_r_${dayIndex}_${pi}`;
    pi += 1;
    while (existingIds.has(nid)) {
      nid = `_r_${dayIndex}_${pi}`;
      pi += 1;
    }
    idRemap[oldId] = nid;
    existingIds.add(nid);
  }

  const rd = parsed.replacementDay;

  function remapSlots(sl) {
    const arr = Array.isArray(sl) ? sl : [];
    return arr.map((item) => {
      if (!item || typeof item !== 'object') return { placeId: '', area: '' };
      const pid = String(item.placeId || item.id || '').trim();
      const newPid = idRemap[pid] || pid;
      return { placeId: newPid, area: String(item.area || '').trim() };
    }).filter((x) => x.placeId);
  }

  const rawDayForNorm = {
    subtitle: String(rd.subtitle || '').trim(),
    morning: remapSlots(rd.morning),
    afternoon: remapSlots(rd.afternoon),
    evening: remapSlots(rd.evening),
    meals: Array.isArray(rd.meals) ? rd.meals : [],
    tips: Array.isArray(rd.tips) ? rd.tips.map((t) => String(t)) : [],
  };

  const mappedNewPlaces = [];
  for (const p of newPlaces) {
    const oldId = String(p.id || '').trim();
    const nid = idRemap[oldId];
    if (!nid) continue;
    mappedNewPlaces.push({
      id: nid,
      name: p.name,
      description: p.description,
      funFact: p.funFact,
      duration: p.duration,
      cost: p.cost,
      category: p.category,
      location: p.location,
      mapQuery: p.mapQuery,
    });
  }

  const hydratedFresh = mappedNewPlaces.length
    ? await hydratePlaceImages(mappedNewPlaces, city, unsplashClientIdFromEnv())
    : [];

  const gpKey = process.env.GOOGLE_PLACES_API_KEY || '';
  const enriched = await enrichPlacesWithGooglePlaces(hydratedFresh, city, stateName, gpKey);

  const mergedPlaces = [...(variantSnapshot.places || []), ...enriched.places];
  const placesById = buildPlacesById(mergedPlaces);

  const label = formatDayLabel(dayIndex + 1, targetDate);
  const dayObj = {
    date: targetDate,
    label,
    subtitle: rawDayForNorm.subtitle,
    morning: normalizeSlot(rawDayForNorm.morning, placesById),
    afternoon: normalizeSlot(rawDayForNorm.afternoon, placesById),
    evening: normalizeSlot(rawDayForNorm.evening, placesById),
    meals: rawDayForNorm.meals,
    tips: rawDayForNorm.tips,
  };

  const newDays = variantSnapshot.days.map((d, i) => (i === dayIndex ? dayObj : JSON.parse(JSON.stringify(d))));
  adjustItineraryForArrivalDeparture(newDays);
  applyFlightScheduleToDays(newDays, extractFlightSchedule(opts.selectedFlight));

  return {
    variant: {
      ...variantSnapshot,
      places: mergedPlaces,
      days: newDays,
      guideSummary:
        String(parsed.guideSummary || '').trim() || variantSnapshot.guideSummary || 'Day refreshed.',
    },
  };
}

function registerItineraryRoutes(app, deps) {
  // Migrated to local/Alibaba Postgres: source the DB client from ./db (a
  // Supabase-shaped query builder) instead of the injected Supabase getter.
  const getSupabase = () => (db.isConfigured() ? db : null);
  const getMergedScrapedEvents = deps && deps.getMergedScrapedEvents;
  const getSessionUserId = deps && deps.getSessionUserId;
  const authStoreDep = deps && deps.authStore;

  /** Trip weather — Open-Meteo (free, no API key): current_weather + daily per trip day. */
  app.get('/api/trip-weather', async (req, res) => {
    const city = String(req.query.city || '').trim();
    const start = String(req.query.start || req.query.start_date || '').slice(0, 10);
    const end = String(req.query.end || req.query.end_date || '').slice(0, 10);
    if (city.length < 2) {
      return res.status(400).json({ error: 'city is required', days: [] });
    }
    if (!isoDateParts(start) || !isoDateParts(end)) {
      return res.status(400).json({ error: 'Invalid start or end date (YYYY-MM-DD)', days: [] });
    }
    try {
      const geo = await resolveTripCityGeo(city);
      const requestedDates = enumerateTripDates(start, end);
      const wx = await fetchOpenMeteoDailyRange(geo.latitude, geo.longitude, start, end);
      const live = buildCurrentWeatherSnapshot(wx.current);
      if (!wx.daily || !Array.isArray(wx.daily.time) || !wx.daily.time.length) {
        if (live) {
          const span = requestedDates.length ? requestedDates : [start];
          const byDate = {};
          const days = span.map(function (iso) {
            const row = Object.assign({}, live, { date: iso });
            byDate[iso] = row;
            return row;
          });
          res.set('Cache-Control', 'public, max-age=900');
          return res.json({
            locale: geo.label,
            latitude: geo.latitude,
            longitude: geo.longitude,
            source: 'open-meteo',
            current: live,
            windowStart: start,
            windowEnd: end,
            note: 'Daily forecast unavailable; showing live conditions for each day.',
            days,
            byDate,
          });
        }
        return res.status(502).json({
          error: wx.error || 'Forecast unavailable from Open-Meteo',
          days: [],
        });
      }
      const built = buildTripWeatherDays(wx.daily, requestedDates, wx.useIndexMapping);
      let note = '';
      const hasEst = built.days.some((d) => d && d.approxDate);
      if (wx.error) note = wx.error;
      else if (geo.fallback) note = 'Using Kuala Lumpur coordinates for this destination.';
      else if (wx.useIndexMapping && wx.beyondHorizon) {
        note = `Trip starts more than ${OPEN_METEO_MAX_DAYS} days ahead; showing the nearest ${OPEN_METEO_MAX_DAYS}-day outlook by day order (est.).`;
      } else if (wx.useIndexMapping) {
        note = 'Trip dates are in the past; showing the next few days of forecast by day order.';
      } else if (hasEst && wx.clipped) {
        note = `Some days are just outside the ${OPEN_METEO_MAX_DAYS}-day forecast window — nearest day shown (est.).`;
      } else if (wx.clipped) {
        note = `Open-Meteo provides up to ${OPEN_METEO_MAX_DAYS} days ahead.`;
      }
      if (live) {
        note = (note ? note + ' ' : '') + `Live now: ${live.tempDisplay || '—'}, wind ${live.windKmh != null ? live.windKmh + ' km/h' : '—'}.`;
      }
      res.set('Cache-Control', 'public, max-age=900');
      return res.json({
        locale: geo.label,
        latitude: geo.latitude,
        longitude: geo.longitude,
        source: 'open-meteo',
        current: live,
        windowStart: wx.windowStart,
        windowEnd: wx.windowEnd,
        note,
        days: built.days,
        byDate: built.byDate,
      });
    } catch (e) {
      console.error('[trip-weather]', e.message || e);
      let errMsg = e.message || 'Weather fetch failed';
      errMsg = String(errMsg).replace(/^Request failed with status code \d+\s*/i, '').trim();
      return res.status(502).json({ error: errMsg || 'Weather fetch failed', days: [] });
    }
  });

  /** Same merged JSON as GET /api/events — upcoming dates only, for Trip Planner search. */
  app.get('/api/itinerary/events', (req, res) => {
    if (typeof getMergedScrapedEvents !== 'function') {
      return res.status(503).json({
        events: [],
        error: 'Event catalog unavailable. Restart the server with the latest code.',
      });
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) {
      return res.json({ events: [] });
    }
    const today = todayMalaysiaISO();
    let merged;
    try {
      merged = getMergedScrapedEvents();
    } catch (e) {
      return res.status(500).json({ events: [], error: e.message || 'Could not load events' });
    }
    if (!Array.isArray(merged)) {
      return res.json({ events: [] });
    }
    const matches = merged.filter((e) => {
      const iso = scrapedEventDateOnly(e.date);
      if (!iso || iso < today) return false;
      const hay = `${e.title || ''} ${e.venue || ''} ${e.city || ''} ${e.summary || ''}`.toLowerCase();
      return hay.includes(q);
    });
    const events = matches.slice(0, 30).map((e) => ({
      id: e.id,
      title: e.title,
      date: e.date,
      venue: e.venue,
      city: e.city,
      image: e.image || '',
      url: e.url || '',
      source: e._source || e.source || 'unknown',
    }));
    return res.json({ events });
  });

  app.post('/api/itinerary/generate', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    if (!process.env.DASHSCOPE_API_KEY) {
      return res.status(503).json({ error: 'DASHSCOPE_API_KEY not configured' });
    }

    const body = req.body || {};
    const eventId = body.eventId != null ? String(body.eventId).trim() : '';
    const eventUrl = String(body.eventUrl || body.event_url || '').trim();
    const arrivalDate = String(body.arrivalDate || '').slice(0, 10);
    const departureDate = String(body.departureDate || '').slice(0, 10);
    const adventureLevel = ['easy', 'medium', 'hard'].includes(String(body.adventureLevel))
      ? String(body.adventureLevel)
      : 'medium';
    const itineraryPaceKey = resolveItineraryPaceKey(body);
    const travelPace = travelPaceFromItineraryPace(itineraryPaceKey);
    const interests = Array.isArray(body.interests)
      ? body.interests.map((x) => String(x)).filter(Boolean).slice(0, 12)
      : [];

    const selectedFlight =
      body.selectedFlight && typeof body.selectedFlight === 'object' ? body.selectedFlight : null;
    const flightOk = flightSelectionValid(selectedFlight);
    if (!flightOk) {
      return res.status(400).json({
        error:
          'Pick an outbound flight first — open the event card, use the Flights tab, search, then tap “Add to my itinerary”.',
      });
    }

    const selectedHotel =
      body.selectedHotel && typeof body.selectedHotel === 'object' ? body.selectedHotel : null;
    const hotelOk = selectedHotel && String(selectedHotel.name || '').trim().length >= 2;
    if (!hotelOk) {
      return res.status(400).json({
        error:
          'Pick a hotel first — open the Hotels tab, search under Pick your stay, then tap “Add to my itinerary” beside a property.',
      });
    }

    let accountProfile = null;
    if (typeof getSessionUserId === 'function' && authStoreDep && typeof authStoreDep.findById === 'function') {
      const uid = getSessionUserId(req);
      if (uid) {
        const u = await authStoreDep.findById(uid);
        if (u && u.profile) {
          accountProfile = { ...u.profile };
          delete accountProfile.fanDna;
        }
      }
    }
    let budgetTier = 2;
    if (accountProfile && Number.isFinite(Number(accountProfile.budgetLevel))) {
      budgetTier = Math.min(4, Math.max(1, Math.round(Number(accountProfile.budgetLevel))));
    }
    const profileBlock = profileQuestionnaireBlock(accountProfile, selectedFlight, selectedHotel);

    const warnings = [];

    if (!eventId && !eventUrl) {
      return res.status(400).json({ error: 'Missing event — pick one from the search list.' });
    }
    if (!isoDateParts(arrivalDate) || !isoDateParts(departureDate)) {
      return res.status(400).json({ error: 'Invalid arrivalDate or departureDate' });
    }
    const today = todayMalaysiaISO();
    if (arrivalDate < today || departureDate < today) {
      return res.status(400).json({ error: 'Departure and return dates must be today or later' });
    }
    if (departureDate < arrivalDate) {
      return res.status(400).json({ error: 'Return date must be after departure date' });
    }
    const dayCount = tripDayCountInclusive(arrivalDate, departureDate);
    if (dayCount === 0) {
      return res.status(400).json({ error: 'Invalid date range' });
    }
    if (dayCount > 14) {
      return res.status(400).json({ error: 'Trip length is capped at 14 days' });
    }

    const eventSelect =
      'id, title, description, venue, city, date, price, image_url, event_url, source, category, is_free';

    let row = null;
    let fetchErr = null;
    if (eventUrl) {
      const r = await sb.from('events_chatbot').select(eventSelect).eq('event_url', eventUrl).limit(3);
      fetchErr = r.error;
      const rows = Array.isArray(r.data) ? r.data : [];
      if (rows.length > 1) {
        warnings.push({
          type: 'event_duplicate',
          severity: 'info',
          message: `Multiple events matched this URL (${rows.length}). Using the first match.`,
        });
      }
      row = rows[0] || null;
    }
    if (!row && eventId) {
      const r = await sb.from('events_chatbot').select(eventSelect).eq('id', eventId).limit(2);
      fetchErr = fetchErr || r.error;
      const rows = Array.isArray(r.data) ? r.data : [];
      if (rows.length > 1) {
        warnings.push({
          type: 'event_duplicate_id',
          severity: 'warn',
          message: `Multiple events share id ${eventId}; using the first match.`,
        });
      }
      row = rows[0] || null;
    }

    if (fetchErr) {
      return res.status(500).json({ error: fetchErr.message });
    }
    if (!row) {
      return res.status(404).json({
        error:
          'Event not found in the planner database. Sync scraped events to Supabase (upload script), or choose another listing that has been uploaded.',
      });
    }

    const eventIso = eventDateOnly(row);
    if (!eventIso) {
      warnings.push({
        type: 'event_date',
        severity: 'warn',
        message: 'Selected event has no clear date in the database; double-check timing.',
      });
    } else if (eventIso < arrivalDate || eventIso > departureDate) {
      return res.status(400).json({
        error: `Event is on ${eventIso}, but your trip is ${arrivalDate} to ${departureDate}. Update your dates so the event falls within your trip.`,
      });
    }

    const city = extractCityFromRow(row);
    const stateName = stateForCity(city);
    const mainEvent = rowToEventOut(row);
    const dates = enumerateTripDates(arrivalDate, departureDate);
    const tripDays = dates.length;
    const geoGuidance = geoGuidanceForTrip(tripDays, city, stateName);
    const tGen0 = Date.now();
    const contextEvents = await fetchContextEvents(sb, city, { limit: 8 });
    let contextEventsNational = [];
    if (tripDays >= 8) {
      contextEventsNational = await fetchEventsDuringTripWindow(sb, arrivalDate, departureDate, 12);
    }

    /** Shared reminders only once — per-variant hydrate adds its own map/closure prompts. */
    if (tripDays >= 6) {
      warnings.push({
        type: 'multi_state',
        severity: 'info',
        message: `Long trip (${tripDays} days): routes may span several states — confirm buses, ETS, or flights before you travel.`,
      });
    }

    const vibeKeys = resolveItineraryVibeKeys(body);

    const promptCtx = {
      city,
      stateName,
      tripDays,
      geoGuidance,
      dates,
      mainEvent,
      contextEvents,
      contextEventsNational,
      prefs: { adventureLevel, interests, travelPace, budgetLevel: budgetTier },
      profileBlock,
    };

    let variant = null;
    try {
      variant = await generateSingleItineraryVariant({
        promptCtx,
        vibeKeys,
        itineraryPaceKey,
        dates,
        city,
        stateName,
        tripDays,
        selectedFlight,
        fastGenerate: true,
      });
    } catch (e) {
      console.warn(
        `[itinerary] generate (${vibeKeys.join('+')}/${itineraryPaceKey}) failed:`,
        e.message || e,
      );
      return res.status(502).json({
        error:
          e.message ||
          'Could not generate your itinerary. Try again, shorten the trip window, or check DASHSCOPE_ITINERARY_TIMEOUT_MS.',
      });
    }

    const variants = [variant];
    console.log('[itinerary] generate total ms:', Date.now() - tGen0, 'vibes:', vibeKeys.join('+'));

    return res.json({
      schemaVersion: 2,
      itineraryVibe: vibeKeys[0],
      itineraryVibes: vibeKeys,
      itineraryPace: itineraryPaceKey,
      event: mainEvent,
      city,
      warnings,
      variants,
      selectedFlight,
      selectedHotel,
      guideSummary: variant.guideSummary,
      travelLinks: travelLinksForCity(city),
      days: variant.days,
      places: variant.places,
    });
  });

  /** User-confirmed archive (generation no longer autosaves). */
  app.post('/api/itinerary/save', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      return res.status(503).json({ ok: false, error: 'Supabase not configured' });
    }
    const body = req.body || {};
    const arrivalDate = String(body.arrivalDate || '').slice(0, 10);
    const departureDate = String(body.departureDate || '').slice(0, 10);
    const cityIn = String(body.city || '').trim();
    const eventId = body.eventId != null ? String(body.eventId).trim() : '';
    const selectedVariantKey = String(body.selectedVariantKey || '').trim();
    const selectedVariantIndex =
      typeof body.selectedVariantIndex === 'number' && Number.isFinite(body.selectedVariantIndex)
        ? body.selectedVariantIndex
        : null;
    if (!isoDateParts(arrivalDate) || !isoDateParts(departureDate)) {
      return res.status(400).json({ ok: false, error: 'Invalid arrival or departure dates' });
    }

    const payload = {
      schemaVersion: 2,
      savedAt: new Date().toISOString(),
      selectedVariantKey: selectedVariantKey || null,
      selectedVariantIndex,
      event: body.event || null,
      city: cityIn,
      variants: Array.isArray(body.variants) ? body.variants : [],
      selectedFlight: body.selectedFlight && typeof body.selectedFlight === 'object' ? body.selectedFlight : null,
      selectedHotel: body.selectedHotel && typeof body.selectedHotel === 'object' ? body.selectedHotel : null,
    };

    if (!payload.variants.length) {
      return res.status(400).json({
        ok: false,
        error: 'Nothing to save — generate a trip and open a journey first (variants were empty).',
      });
    }

    const sessionUid =
      typeof getSessionUserId === 'function' ? getSessionUserId(req) : null;

    const insertRow = {
      event_id: eventId || null,
      arrival_date: arrivalDate,
      departure_date: departureDate,
      city: cityIn || payload.city || null,
      payload,
    };
    if (sessionUid) insertRow.user_id = sessionUid;

    const saved = await trySaveItinerary(sb, insertRow);
    if (!saved.ok) {
      return res.status(500).json({
        ok: false,
        error:
          saved.error +
          ' — confirm table public.itineraries_generated exists (run sql/itineraries_generated.sql in Supabase) and the server uses SUPABASE_SERVICE_ROLE_KEY or a key allowed to insert.',
      });
    }

    return res.json({
      ok: true,
      id: saved.id,
      message: 'Itinerary saved to your planner history.',
    });
  });

  /** Regenerate a single calendar day inside the user's chosen variant snapshot. */
  app.post('/api/itinerary/regenerate-day', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    if (!process.env.DASHSCOPE_API_KEY) {
      return res.status(503).json({ error: 'DASHSCOPE_API_KEY not configured' });
    }

    const body = req.body || {};
    const eventId = body.eventId != null ? String(body.eventId).trim() : '';
    const eventUrl = String(body.eventUrl || '').trim();
    const arrivalDate = String(body.arrivalDate || '').slice(0, 10);
    const departureDate = String(body.departureDate || '').slice(0, 10);
    const adventureLevel = ['easy', 'medium', 'hard'].includes(String(body.adventureLevel))
      ? String(body.adventureLevel)
      : 'medium';
    const travelPace = ['slow', 'balanced', 'packed'].includes(String(body.travelPace))
      ? String(body.travelPace)
      : 'balanced';
    const interests = Array.isArray(body.interests)
      ? body.interests.map((x) => String(x)).filter(Boolean).slice(0, 12)
      : [];

    let dayIndex = Number(body.dayIndex);
    if (!Number.isInteger(dayIndex) || dayIndex < 0) {
      return res.status(400).json({ error: 'Invalid dayIndex' });
    }

    const variantSnapshot = body.variant;
    if (!variantSnapshot || !Array.isArray(variantSnapshot.days) || !Array.isArray(variantSnapshot.places)) {
      return res.status(400).json({ error: 'Missing variant snapshot (days + places).' });
    }
    const datesTrip = enumerateTripDates(arrivalDate, departureDate);
    if (!datesTrip.length || dayIndex >= datesTrip.length) {
      return res.status(400).json({ error: 'dayIndex out of range for trip dates' });
    }

    const eventSelect =
      'id, title, description, venue, city, date, price, image_url, event_url, source, category, is_free';
    let row = null;
    if (eventUrl) {
      const r = await sb.from('events_chatbot').select(eventSelect).eq('event_url', eventUrl).limit(1);
      row = Array.isArray(r.data) ? r.data[0] : null;
    }
    if (!row && eventId) {
      const r = await sb.from('events_chatbot').select(eventSelect).eq('id', eventId).limit(1);
      row = Array.isArray(r.data) ? r.data[0] : null;
    }
    if (!row) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    try {
      const selectedFlight =
        body.selectedFlight && typeof body.selectedFlight === 'object' ? body.selectedFlight : null;
      const out = await regenerateSingleDay(sb, {
        row,
        arrivalDate,
        departureDate,
        adventureLevel,
        travelPace,
        interests,
        dayIndex,
        variantSnapshot,
        selectedFlight,
      });
      return res.json(out);
    } catch (e) {
      console.error('[itinerary] regenerate-day:', e.message || e);
      return res.status(502).json({ error: e.message || 'Could not regenerate this day.' });
    }
  });

  /** Recent rows from itineraries_generated — list only. */
  app.get('/api/itinerary/history', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      return res.status(503).json({ items: [], error: 'Supabase not configured' });
    }
    const lim = Math.min(50, Math.max(1, Number(req.query.limit) || 24));
    const { data, error } = await sb
      .from('itineraries_generated')
      .select('id, created_at, arrival_date, departure_date, city, payload')
      .order('created_at', { ascending: false })
      .limit(lim);
    if (error) {
      return res.status(500).json({ items: [], error: error.message });
    }
    const rows = Array.isArray(data) ? data : [];
    const items = rows.map((row) => {
      const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const ev = p.event || {};
      const vkey = String(p.selectedVariantKey || '').trim();
      const nVar = Array.isArray(p.variants) ? p.variants.length : 0;
      return {
        id: row.id,
        createdAt: row.created_at,
        arrivalDate: row.arrival_date,
        departureDate: row.departure_date,
        city: String(row.city || p.city || '').trim(),
        eventTitle: String(ev.title || '').trim(),
        variantsCount: nVar || 1,
        selectedVariantKey: vkey || null,
      };
    });
    return res.json({ items });
  });

  /** Full saved planner payload — reopen in the Trip Planner modal. */
  app.get('/api/itinerary/saved/:id', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: 'Missing id' });
    }
    const { data, error } = await sb.from('itineraries_generated').select('*').eq('id', id).maybeSingle();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'Saved itinerary not found' });
    }
    const p = data.payload && typeof data.payload === 'object' ? data.payload : {};
    return res.json({
      id: data.id,
      createdAt: data.created_at,
      arrival_date: String(data.arrival_date || '').slice(0, 10),
      departure_date: String(data.departure_date || '').slice(0, 10),
      city: String(data.city || p.city || '').trim(),
      payload: p,
    });
  });
}

module.exports = { registerItineraryRoutes };
