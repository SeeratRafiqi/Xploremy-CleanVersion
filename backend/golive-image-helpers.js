'use strict';

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const BASE_WEB = 'https://www.golive-asia.com';
const DISCOVER_URL = `${BASE_WEB}/discover`;
const API_LIST_PATH = '/api/event/list';
/** GoLive moved the public list API onto the site origin (was advisoryapps.com). */
const API_URL = `${BASE_WEB}${API_LIST_PATH}`;
const LEGACY_API_URL = 'https://golive-production.advisoryapps.com/api/event/list';
const API_URLS = [API_URL, LEGACY_API_URL];
const REFERER = DISCOVER_URL;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const GOLIVE_API_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: REFERER,
  Origin: BASE_WEB,
  'Accept-Language': 'en-MY,en;q=0.9',
};

const IMAGE_MAP_PATH = path.join(__dirname, 'data', 'goliveasia-image-map.json');

/**
 * Pull a usable HTTPS image URL from a GoLive list row (handles strings or { url } objects).
 */
function extractGoLiveImageUrl(row) {
  if (!row || typeof row !== 'object') return '';

  const candidates = [];

  const push = (val) => {
    if (typeof val === 'string') {
      const s = val.trim();
      if (s) candidates.push(s);
      return;
    }
    if (!val || typeof val !== 'object') return;
    for (const key of [
      'url',
      'URL',
      'src',
      'path',
      'image_url',
      'imageUrl',
      'full_url',
      'fullUrl',
      'original',
      'thumbnail',
    ]) {
      if (typeof val[key] === 'string' && val[key].trim()) candidates.push(val[key].trim());
    }
  };

  const arrays = [
    row.images,
    row.Images,
    row.event_images,
    row.EventImages,
    row.media,
    row.gallery,
  ];
  for (const arr of arrays) {
    if (Array.isArray(arr)) arr.forEach(push);
  }

  push(row.image);
  push(row.banner);
  push(row.poster);
  push(row.thumbnail);
  push(row.image_url);
  push(row.imageUrl);
  push(row.cover_image);
  push(row.coverImage);

  return (
    candidates.find((u) => /^https?:\/\//i.test(u)) ||
    candidates.find((u) => u.startsWith('//') && `https:${u}`) ||
    ''
  );
}

function proxyImagePathForId(id) {
  const sid = String(id || '').trim();
  return sid ? `/api/golive-image/${encodeURIComponent(sid)}` : '';
}

function isGoLiveListResponseUrl(url) {
  const u = String(url || '');
  return u.includes('/api/event/list') || u.includes('advisoryapps.com/api/event/list');
}

function isGoLiveEventApiUrl(url) {
  const u = String(url || '');
  return (u.includes('golive-asia.com') || u.includes('advisoryapps')) && u.includes('/api/event');
}

function parseGoLiveListPayload(data) {
  if (typeof data === 'string' && data.trim().startsWith('<!')) {
    throw new Error('HTML response (bot protection)');
  }
  if (data?.error) throw new Error(String(data.error));
  const block = data?.result;
  const rows = Array.isArray(block?.result) ? block.result : Array.isArray(block) ? block : [];
  if (!Array.isArray(rows)) throw new Error('Unexpected GoLive API response format');
  return {
    rows,
    totalPages: Math.max(1, Number(block?.totalPages) || 1),
    currentPage: Math.max(1, Number(block?.currentPage) || 1),
  };
}

async function fetchEventListPageAxios(apiUrl, page = 1) {
  const { data } = await axios.get(apiUrl, {
    headers: GOLIVE_API_HEADERS,
    params: { page, itemsPerPage: 100 },
    timeout: 60000,
    validateStatus: (s) => s < 500,
  });
  return parseGoLiveListPayload(data);
}

async function fetchEventListAxios() {
  let lastErr;
  for (const apiUrl of API_URLS) {
    try {
      const first = await fetchEventListPageAxios(apiUrl, 1);
      let rows = [...first.rows];
      for (let p = first.currentPage + 1; p <= first.totalPages; p += 1) {
        const next = await fetchEventListPageAxios(apiUrl, p);
        rows = rows.concat(next.rows);
      }
      if (rows.length) {
        console.log(`   GoLive API ok (${apiUrl}): ${rows.length} event(s)`);
        return rows;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`GoLive list API (${apiUrl}):`, err.message);
    }
  }
  throw lastErr || new Error('No GoLive list API available');
}

/**
 * Browser-context fetch when Node axios is blocked or returns an error payload.
 */
async function launchGoLiveBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return null;
  }
  const launchOpts = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launch({ ...launchOpts, channel: 'msedge' });
  } catch (_) {
    return chromium.launch(launchOpts);
  }
}

async function fetchEventListPlaywright() {
  const browser = await launchGoLiveBrowser();
  if (!browser) return [];

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-MY',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let rows = null;

    page.on('response', async (res) => {
      if (!isGoLiveListResponseUrl(res.url()) || res.status() !== 200) return;
      try {
        const j = await res.json();
        const parsed = parseGoLiveListPayload(j);
        if (parsed.rows.length > (rows?.length || 0)) rows = parsed.rows;
      } catch (_) {}
    });

    await page.goto(REFERER, { waitUntil: 'domcontentloaded', timeout: 120000 });

    try {
      await page.waitForFunction(
        () => (document.body && document.body.innerText || '').length > 100,
        { timeout: 45000 },
      );
    } catch (_) {
      console.warn('GoLive Playwright: page did not render event list (SPA may be blocked in this environment).');
    }

    for (let i = 0; i < 25 && !rows; i++) {
      await page.waitForTimeout(1000);
    }

    if (!rows) {
      const evaluated = await page
        .evaluate(
          async (listPath) => {
            try {
              const res = await fetch(`${listPath}?itemsPerPage=100&page=1`, {
                headers: {
                  Accept: 'application/json, text/plain, */*',
                },
                credentials: 'include',
              });
              const data = await res.json();
              if (data?.error) return { error: data.error, rows: [] };
              return { rows: data?.result?.result || data?.result || [] };
            } catch (e) {
              return { error: e.message, rows: [] };
            }
          },
          API_LIST_PATH,
        )
        .catch(() => ({ rows: [] }));

      if (evaluated?.error) {
        console.warn('GoLive in-page fetch:', evaluated.error);
      }
      if (evaluated?.rows?.length) rows = evaluated.rows;
    }

    if (!rows?.length || rows.length < 3) {
      for (let s = 0; s < 10; s++) {
        await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.85)));
        await page.waitForTimeout(1200);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(800);

      const domRows = await page
        .evaluate(() => {
          const seen = new Map();
          document.querySelectorAll('a[href*="event-detail"]').forEach((a) => {
            const m = (a.getAttribute('href') || a.href || '').match(/event-detail\/(\d+)/i);
            if (!m) return;
            const id = m[1];
            const img =
              a.querySelector('img') ||
              a.closest('[class*="card"],[class*="event"]')?.querySelector('img');
            const src = img?.currentSrc || img?.src || img?.getAttribute('data-src') || '';
            const title =
              a.querySelector('h1,h2,h3,h4,.title')?.textContent?.trim() ||
              a.getAttribute('aria-label') ||
              a.textContent?.trim() ||
              '';
            const prev = seen.get(id) || { id, name: title.slice(0, 200), images: [] };
            if (title && (!prev.name || prev.name.length < title.length)) prev.name = title.slice(0, 200);
            if (src && !prev.images.includes(src)) prev.images.push(src);
            seen.set(id, prev);
          });
          return Array.from(seen.values());
        })
        .catch(() => []);

      if (domRows.length) {
        rows = domRows;
      }
    }

    return Array.isArray(rows) ? rows : [];
  } finally {
    await browser.close();
  }
}

/**
 * When /api/event/list fails, try to refresh each known id from event-detail network payloads.
 */
async function fetchEventsViaDetailPages(eventIds) {
  const ids = [...new Set((eventIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) return [];

  const browser = await launchGoLiveBrowser();
  if (!browser) return [];

  const rows = [];
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-MY',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let rowPayload = null;
      const handler = async (res) => {
        if (rowPayload) return;
        const u = res.url();
        if (!isGoLiveEventApiUrl(u) || res.status() !== 200) return;
        try {
          const j = await res.json();
          const candidate = j?.result?.result || j?.result;
          if (candidate && typeof candidate === 'object' && String(candidate.id || id) === id) {
            rowPayload = candidate;
          }
        } catch (_) {}
      };
      page.on('response', handler);
      try {
        await page.goto(`${BASE_WEB}/event-detail/${encodeURIComponent(id)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        });
        await page.waitForTimeout(6000);
      } catch (err) {
        console.warn(`GoLive detail ${id}:`, err.message);
      } finally {
        page.off('response', handler);
      }
      if (rowPayload) rows.push(rowPayload);
    }
  } finally {
    await browser.close();
  }
  return rows;
}

function pickPresignedBannerUrl(url, eventId) {
  const u = String(url || '');
  const id = String(eventId || '').trim();
  if (!u || !id) return '';
  if (u.includes(`eventBanners/${id}/`) && u.includes('X-Amz-')) return u;
  return '';
}

async function captureImageUrlForEventPage(page, eventId) {
  let imageUrl = '';
  const handler = async (res) => {
    if (imageUrl) return;
    const u = res.url();
    if (res.status() !== 200) return;

    const fromBanner = pickPresignedBannerUrl(u, eventId);
    if (fromBanner) {
      imageUrl = fromBanner;
      return;
    }

    if (isGoLiveEventApiUrl(u)) {
      try {
        const j = await res.json();
        const url = extractGoLiveImageUrl(j?.result || j);
        if (url) imageUrl = url;
      } catch (_) {}
    }
  };

  page.on('response', handler);
  try {
    await page.goto(`${BASE_WEB}/event-detail/${encodeURIComponent(eventId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForTimeout(8000);
    if (!imageUrl) {
      await page.waitForTimeout(5000);
    }
  } finally {
    page.off('response', handler);
  }
  return imageUrl;
}

/**
 * When the list API fails, each event-detail page still loads banner URLs over the network.
 */
async function refreshGoLiveImageMapViaDetailPages(eventIds, imageMap = {}) {
  const ids = [...new Set((eventIds || []).map((x) => String(x).trim()).filter(Boolean))];
  const map = { ...(imageMap || {}) };
  const need = ids.filter((id) => !map[id] || !/^https?:\/\//i.test(map[id]));
  if (!need.length) return map;

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.warn('GoLive image backfill: Playwright not installed');
    return map;
  }

  console.log(`🖼  GoLive: loading images for ${need.length} event(s) from event-detail pages…`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-MY',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    for (let i = 0; i < need.length; i++) {
      const id = need[i];
      const url = await captureImageUrlForEventPage(page, id);
      if (url) map[id] = url;
      if ((i + 1) % 4 === 0 || i === need.length - 1) {
        console.log(`   … ${i + 1}/${need.length} image URLs captured`);
      }
    }
  } finally {
    await browser.close();
  }

  return map;
}

async function fetchGoLiveEventList(existingIds = []) {
  try {
    const rows = await fetchEventListAxios();
    if (rows.length) return { rows, source: 'axios' };
  } catch (err) {
    console.warn('GoLive list API (axios):', err.message);
  }

  const pwRows = await fetchEventListPlaywright();
  if (Array.isArray(pwRows) && pwRows.length) {
    return { rows: pwRows, source: 'playwright' };
  }

  if (existingIds.length) {
    console.log(`GoLive: trying ${existingIds.length} saved event-detail page(s)…`);
    const detailRows = await fetchEventsViaDetailPages(existingIds);
    if (detailRows.length) {
      return { rows: detailRows, source: 'detail-pages' };
    }
  }

  return { rows: [], source: 'none' };
}

async function loadGoLiveImageMap() {
  try {
    if (await fs.pathExists(IMAGE_MAP_PATH)) {
      const map = await fs.readJson(IMAGE_MAP_PATH);
      if (map && typeof map === 'object') return map;
    }
  } catch (_) {}
  return {};
}

async function saveGoLiveImageMap(map) {
  await fs.ensureDir(path.dirname(IMAGE_MAP_PATH));
  await fs.writeJson(IMAGE_MAP_PATH, map, { spaces: 2 });
}

async function resolveGoLiveImageUrl(eventId, liveRows) {
  const id = String(eventId || '').trim();
  if (!id) return '';

  const map = await loadGoLiveImageMap();
  if (map[id] && /^https?:\/\//i.test(map[id])) return map[id];

  try {
    const rows = liveRows || (await fetchEventListAxios());
    const row = rows.find((r) => String(r.id) === id);
    const fromRow = extractGoLiveImageUrl(row);
    if (fromRow) {
      map[id] = fromRow;
      await saveGoLiveImageMap(map);
      return fromRow;
    }
  } catch (_) {}

  const updated = await refreshGoLiveImageMapViaDetailPages([id], map);
  if (updated[id]) {
    await saveGoLiveImageMap(updated);
    return updated[id];
  }

  return '';
}

module.exports = {
  BASE_WEB,
  DISCOVER_URL,
  API_URL,
  API_LIST_PATH,
  LEGACY_API_URL,
  REFERER,
  GOLIVE_API_HEADERS,
  IMAGE_MAP_PATH,
  UA,
  extractGoLiveImageUrl,
  proxyImagePathForId,
  fetchEventListAxios,
  fetchEventListPlaywright,
  fetchGoLiveEventList,
  fetchEventsViaDetailPages,
  launchGoLiveBrowser,
  loadGoLiveImageMap,
  saveGoLiveImageMap,
  resolveGoLiveImageUrl,
  refreshGoLiveImageMapViaDetailPages,
};
