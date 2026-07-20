'use strict';

/**
 * Ticket2U Malaysia — public event listing via /api/api2.ashx (method: eventlisting).
 * Same output shape as eventbrite-scraper: id, title, url, date, time, venue, city,
 * image, isFree, price, category, summary (+ endDate for multi-day / ongoing events).
 *
 * Optional: set TICKET2U_KEYWORD (e.g. "Kuala Lumpur") to narrow results; default is
 * all listings (no keyword filter).
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const BASE = 'https://www.ticket2u.com.my';
const API_URL = `${BASE}/api/api2.ashx`;
const REFERER = `${BASE}/event/list`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUTPUT = path.join(__dirname, 'data', 'ticket2u-events.json');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildFilter(page) {
  return {
    currentpage: page,
    kw: process.env.TICKET2U_KEYWORD || '',
    cc: process.env.TICKET2U_CAT || '',
    scc: process.env.TICKET2U_SUBCAT || '',
    stateid: process.env.TICKET2U_STATE_ID || '',
    areaid: process.env.TICKET2U_AREA_ID || '',
    // ex=true pulls 14k+ expired listings; keep false for the live catalog only.
    ex: process.env.TICKET2U_INCLUDE_EXPIRED === '1',
    sort: process.env.TICKET2U_SORT || '',
  };
}

function absoluteUrl(link) {
  if (!link) return '';
  if (/^https?:\/\//i.test(link)) return link;
  return `${BASE}${link.startsWith('/') ? '' : '/'}${link}`;
}

function parseDateField(value) {
  if (!value) return '';
  const d = String(value);
  const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return d.trim();
}

function parseDateIso(row) {
  if (row.datefrom) return parseDateField(row.datefrom);
  return (row.datefrom106 || '').trim();
}

function parseEndDateIso(row) {
  if (row.dateto) return parseDateField(row.dateto);
  return (row.dateto106 || '').trim();
}

/** Multi-day festivals still running; excludes years-long attraction ticket listings. */
const MAX_IN_PROGRESS_SPAN_DAYS = 60;

function eventSpanDays(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const startMs = Date.parse(`${startIso}T00:00:00Z`);
  const endMs = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / 86400000));
}

function isBoundedInProgress(startIso, endIso, todayStr) {
  if (!startIso || !endIso || startIso >= todayStr) return false;
  if (endIso < todayStr) return false;
  return eventSpanDays(startIso, endIso) <= MAX_IN_PROGRESS_SPAN_DAYS;
}

function pickDisplayDateIso(row, todayStr = todayIso()) {
  const startIso = parseDateIso(row);
  const endIso = parseEndDateIso(row) || startIso;
  if (startIso && startIso >= todayStr) return startIso;
  if (startIso && endIso && isBoundedInProgress(startIso, endIso, todayStr)) return todayStr;
  return startIso || '';
}

function isUpcomingEvent(ev, todayStr = todayIso()) {
  return !ev?.date || ev.date >= todayStr;
}

function isActiveTicket2URow(row, todayStr = todayIso()) {
  if (String(row.active || '1') !== '1') return false;
  const status = String(row.status || '').trim().toLowerCase();
  if (status === 'expired') return false;
  if (String(row.issaleend || '0') === '1') return false;

  const startIso = parseDateIso(row);
  const endIso = parseEndDateIso(row) || startIso;

  if (!startIso && !endIso) return true;
  if (endIso && endIso < todayStr) return false;
  if (startIso && !endIso && startIso < todayStr) return false;
  if (startIso && startIso >= todayStr) return true;
  if (isBoundedInProgress(startIso, endIso, todayStr)) return true;

  return false;
}

function normalizeRow(row, todayStr = todayIso()) {
  const id = String(row.id || '').trim();
  if (!id) return null;

  const pf = parseFloat(String(row.pricefrom || '').replace(/,/g, ''));
  const isFree =
    row.pricefrom == null ||
    row.pricefrom === '' ||
    (Number.isFinite(pf) && pf === 0);

  let price = '';
  if (isFree) price = 'Free';
  else if (row.pricefrom != null && row.pricefrom !== '')
    price = `${row.pricefrom} ${row.basecurrency || 'RM'}`.trim();

  const date = pickDisplayDateIso(row, todayStr);
  const endDate = parseEndDateIso(row);

  return {
    id,
    title: row.titlename || row.name || 'Untitled',
    url: absoluteUrl(row.link),
    date,
    endDate: endDate && endDate !== date ? endDate : endDate || '',
    time: (row.time || '').trim(),
    venue: (row.locname || '').trim() || 'TBA',
    city: (row.statename || '').trim(),
    image: (row.avatar || '').trim(),
    isFree,
    price,
    category: (row.eventcat || '').trim(),
    summary: (row.excerpt || '').toString().slice(0, 4000),
  };
}

async function postEventListing(page) {
  const { data } = await axios.post(
    API_URL,
    { method: 'eventlisting', data: buildFilter(page) },
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: REFERER,
        Origin: BASE,
      },
      timeout: 60000,
    },
  );

  if (data.haserror) {
    const msg = data.message || 'Unknown API error';
    throw new Error(`Ticket2U API: ${msg}`);
  }

  return data;
}

async function scrapeTicket2U() {
  console.log('📡 Ticket2U — api2.ashx eventlisting (paginated)');
  if (process.env.TICKET2U_KEYWORD)
    console.log(`   Keyword filter: "${process.env.TICKET2U_KEYWORD}"`);

  const todayStr = todayIso();
  const byId = new Map();
  let page = 1;
  let rowtotal = null;
  let rowpp = null;
  let skippedInactive = 0;

  while (true) {
    console.log(`   Page ${page}…`);

    const payload = await postEventListing(page);
    const chunks = Array.isArray(payload.data) ? payload.data : [];

    const rows = [];
    for (const item of chunks) {
      if (item && item.row && item.row.id) rows.push(item.row);
    }

    if (!rows.length) {
      console.log('      (no rows)');
      break;
    }

    rowtotal = parseInt(String(rows[0].rowtotal || '0'), 10) || rowtotal;
    rowpp = parseInt(String(rows[0].rowpp || '0'), 10) || rowpp;

    for (const row of rows) {
      if (!isActiveTicket2URow(row, todayStr)) {
        skippedInactive += 1;
        continue;
      }
      const ev = normalizeRow(row, todayStr);
      if (ev && isUpcomingEvent(ev, todayStr)) byId.set(ev.id, ev);
    }

    console.log(
      `      +${rows.length} rows (upcoming total: ${byId.size})  rowtotal=${rowtotal} rowpp=${rowpp}`,
    );

    const maxPage =
      rowtotal && rowpp ? Math.max(1, Math.ceil(rowtotal / rowpp)) : page;
    if (page >= maxPage) break;

    page += 1;
  }

  const events = Array.from(byId.values()).sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );

  if (skippedInactive > 0) {
    console.log(`   Dropped ${skippedInactive} expired / sale-ended / past event(s).`);
  }

  const pastInOutput = events.filter((ev) => !isUpcomingEvent(ev, todayStr)).length;
  if (pastInOutput > 0) {
    console.log(`   Dropped ${pastInOutput} additional past-dated event(s) after normalize.`);
  }

  const upcomingEvents = events.filter((ev) => isUpcomingEvent(ev, todayStr));

  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, upcomingEvents, { spaces: 2 });

  console.log(`\n💾 Saved ${upcomingEvents.length} events → ${OUTPUT}`);
  return upcomingEvents;
}

if (require.main === module) {
  scrapeTicket2U().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  scrapeTicket2U,
  isActiveTicket2URow,
  isUpcomingEvent,
  normalizeRow,
};
