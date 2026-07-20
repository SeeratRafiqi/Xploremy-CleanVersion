'use strict';

/**
 * GoLive Asia events via golive-asia.com /api/event/list (+ Playwright fallback).
 * Output shape matches existing scrapers:
 * id, title, url, date, time, venue, city, image, isFree, price, category, summary
 *
 * Images: API returns expiring S3 presigned URLs. We save a fresh map in
 * data/goliveasia-image-map.json and expose stable paths via /api/golive-image/:id
 */

const fs = require('fs-extra');
const path = require('path');
const {
  BASE_WEB,
  extractGoLiveImageUrl,
  proxyImagePathForId,
  fetchGoLiveEventList,
  loadGoLiveImageMap,
  saveGoLiveImageMap,
  refreshGoLiveImageMapViaDetailPages,
} = require('./golive-image-helpers');

const OUTPUT = path.join(__dirname, 'data', 'goliveasia-events.json');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function pickCategory(row) {
  const cats = Array.isArray(row.EventDetailCategories) ? row.EventDetailCategories : [];
  for (const item of cats) {
    const name = item?.EventCategory?.name;
    if (name) return String(name).trim();
  }
  return '';
}

function parseGoLiveDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const dt = new Date(raw.endsWith('Z') ? raw : raw);
  return Number.isNaN(dt.valueOf()) ? null : dt;
}

function lastEventDateIso(row) {
  const dates = Array.isArray(row.EventDates)
    ? row.EventDates.map((d) => d?.event_date).filter(Boolean)
    : [];
  if (dates.length) {
    const parsed = dates.map(parseGoLiveDate).filter(Boolean).sort((a, b) => b - a);
    if (parsed.length) return parsed[0].toISOString().slice(0, 10);
  }
  const fallback = parseGoLiveDate(row.end_date || row.start_date);
  return fallback ? fallback.toISOString().slice(0, 10) : '';
}

function pickDisplayDate(row) {
  const dates = Array.isArray(row.EventDates)
    ? row.EventDates.map((d) => d?.event_date).filter(Boolean)
    : [];
  if (dates.length) {
    const parsed = dates.map(parseGoLiveDate).filter(Boolean).sort((a, b) => a - b);
    if (parsed.length) return parsed[0];
  }
  return parseGoLiveDate(row.start_date);
}

function isUpcomingRow(row, todayStr = todayIso()) {
  const last = lastEventDateIso(row);
  return !last || last >= todayStr;
}

function isUpcomingEvent(ev, todayStr = todayIso()) {
  return !ev?.date || ev.date >= todayStr;
}

function normalizeEvent(row, imageMap) {
  const id = String(row.id || '').trim();
  if (!id) return null;

  const dateObj = pickDisplayDate(row);
  const cheapest = parseFloat(String(row.cheapest_ticket || '').replace(/,/g, ''));
  const isFree = Number.isFinite(cheapest) ? cheapest <= 0 : !row.cheapest_ticket;
  const price = isFree
    ? 'Free'
    : Number.isFinite(cheapest)
      ? `${cheapest.toFixed(2)} MYR`
      : '';

  const directImage = extractGoLiveImageUrl(row);
  if (directImage) imageMap[id] = directImage;

  return {
    id,
    title: row.name || 'Untitled',
    url: `${BASE_WEB}/event-detail/${id}`,
    date: dateObj ? dateObj.toISOString().slice(0, 10) : '',
    time: dateObj ? dateObj.toISOString().slice(11, 16) : '',
    venue: row.Venue?.name || 'TBA',
    city: row.Venue?.city || '',
    image: proxyImagePathForId(id),
    isFree,
    price,
    category: pickCategory(row),
    summary: htmlToText(row.general_information),
  };
}

async function scrapeGoLiveAsia() {
  console.log('📡 GoLive Asia — loading event list…');

  let existing = [];
  if (await fs.pathExists(OUTPUT)) {
    try {
      existing = await fs.readJson(OUTPUT);
      if (!Array.isArray(existing)) existing = [];
    } catch (_) {
      existing = [];
    }
  }

  const existingIds = existing.map((e) => String(e.id || '').trim()).filter(Boolean);
  const todayStr = todayIso();

  let rows = [];
  let source = 'none';
  try {
    const loaded = await fetchGoLiveEventList(existingIds);
    rows = loaded.rows;
    source = loaded.source;
  } catch (err) {
    console.warn('GoLive list:', err.message);
  }

  console.log(`   Loaded ${rows.length} rows (${source})`);

  const imageMap = await loadGoLiveImageMap();
  for (const row of rows) {
    const direct = extractGoLiveImageUrl(row);
    if (direct && row.id != null) imageMap[String(row.id)] = direct;
  }

  let eventsOut = [];

  if (rows.length) {
    const byId = new Map();
    for (const row of rows) {
      if (!isUpcomingRow(row, todayStr)) continue;
      const ev = normalizeEvent(row, imageMap);
      if (ev) byId.set(ev.id, ev);
    }
    eventsOut = Array.from(byId.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    await fs.ensureDir(path.join(__dirname, 'data'));
    await fs.writeJson(OUTPUT, eventsOut, { spaces: 2 });
    const droppedPast = rows.length - eventsOut.length;
    if (droppedPast > 0) {
      console.log(`   Dropped ${droppedPast} past event(s) from live GoLive feed.`);
    }
  } else {
    const pruned = existing.filter((ev) => isUpcomingEvent(ev, todayStr));
    eventsOut = pruned;
    if (existing.length && pruned.length < existing.length) {
      await fs.ensureDir(path.join(__dirname, 'data'));
      await fs.writeJson(OUTPUT, eventsOut, { spaces: 2 });
      console.warn(
        `   GoLive list unavailable — removed ${existing.length - pruned.length} past event(s) from saved file.`,
      );
    } else if (existing.length) {
      console.warn(
        '   GoLive list unavailable — keeping saved upcoming events only; re-run when network/API is reachable.',
      );
    }
  }

  const finalMap = await refreshGoLiveImageMapViaDetailPages(
    eventsOut.map((e) => e.id),
    imageMap,
  );
  await saveGoLiveImageMap(finalMap);

  const withImages = eventsOut.filter((e) => finalMap[e.id]).length;
  console.log(
    `🖼  Image URLs ready: ${withImages}/${eventsOut.length} → data/goliveasia-image-map.json`,
  );
  console.log(`💾 GoLive Asia: ${eventsOut.length} events in ${OUTPUT}`);
  return eventsOut;
}

if (require.main === module) {
  scrapeGoLiveAsia().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeGoLiveAsia };
