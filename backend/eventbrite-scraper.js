'use strict';

/**
 * Eventbrite Kuala Lumpur discovery via internal /api/v3/destination/search/
 *
 * The public site uses POST with a JSON body (browse_surface + event_search).
 * Plain GET to this path returns 405. Pagination is driven by event_search.page
 * and optional pagination.continuation tokens; we mirror the requested query
 * params (client_continuation, page_size, place.address.city, expand) on each POST.
 */

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');

const SEARCH_URL = 'https://www.eventbrite.com/api/v3/destination/search/';
const REFERER =
  'https://www.eventbrite.com/d/malaysia--kuala-lumpur/events/';
const PLACE_ID_KL = '102023407';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUTPUT = path.join(__dirname, 'data', 'eventbrite-events.json');

function pickCategory(ev) {
  const tags = ev.tags || [];
  const cat = tags.find(
    (t) =>
      t.prefix === 'EventbriteCategory' ||
      (t.tag && String(t.tag).startsWith('EventbriteCategory/'))
  );
  return cat?.display_name || cat?.localized?.display_name || '';
}

function normalizeEvent(ev) {
  const id = String(ev.id || '').trim();
  if (!id) return null;

  const isFree = Boolean(ev.ticket_availability?.is_free);
  let price = ev.ticket_availability?.minimum_ticket_price?.display || '';
  if (!price && isFree) price = 'Free';

  const venueName =
    typeof ev.primary_venue?.name === 'string'
      ? ev.primary_venue.name
      : ev.primary_venue?.name?.text || '';

  return {
    id,
    title: ev.name || 'No title',
    url: ev.url || '',
    date: ev.start_date || '',
    time: ev.start_time || '',
    venue: venueName || 'Online',
    city: ev.primary_venue?.address?.city || '',
    image:
      ev.image?.original?.url ||
      ev.image?.url ||
      '',
    isFree,
    price: price || '',
    category: pickCategory(ev),
    summary: (ev.summary || '').toString().slice(0, 4000),
  };
}

async function createSessionHeaders() {
  const warmup = await axios.get(REFERER, {
    headers: { 'User-Agent': UA },
    maxRedirects: 5,
  });
  const setCookie = warmup.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrftoken = cookie
    .split('; ')
    .find((p) => p.startsWith('csrftoken='))
    ?.split('=')[1];

  return {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: REFERER,
    Origin: 'https://www.eventbrite.com',
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRFToken': csrftoken,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function buildSearchBody(page) {
  return {
    browse_surface: 'search',
    event_search: {
      places: [PLACE_ID_KL],
      online_events_only: false,
      dates: ['current_future'],
      sort: 'quality',
      aggs: {
        organizertagsautocomplete_agg: { size: 50 },
        tags: {},
        dates: {},
      },
      page,
    },
    'expand.destination_event': [
      'primary_venue',
      'image',
      'ticket_availability',
      'saves',
      'event_sales_status',
      'primary_organizer',
    ],
  };
}

function searchQueryParams(clientContinuation) {
  return {
    client_continuation: clientContinuation || '',
    page_size: 50,
    'place.address.city': 'Kuala Lumpur',
    expand: 'event_description,event_ticket_availability',
  };
}

async function fetchEventbriteDescription(page, eventUrl) {
  try {
    await page.goto(eventUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Wait briefly for client-side rendering
    await page.waitForTimeout(1500);

    // Find description using a structural approach:
    // locate the "Overview" or "About this event" heading,
    // then extract text from the content that follows it
    const description = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      const overviewHeading = headings.find((h) =>
        /overview|about this event/i.test(h.textContent || '')
      );

      if (!overviewHeading) return '';

      // Walk forward through siblings collecting paragraph text
      const container = overviewHeading.parentElement;
      const collected = [];
      let node = overviewHeading.nextElementSibling;
      let attempts = 0;

      while (node && attempts < 20) {
        const text = (node.textContent || '').trim();
        if (text.length > 20) collected.push(text);
        node = node.nextElementSibling;
        attempts++;
      }

      // Fallback: if nothing found via siblings, try the
      // parent container's full text
      if (collected.length === 0 && container) {
        const fullText = (container.textContent || '').trim();
        if (fullText.length > 50) collected.push(fullText);
      }

      return collected.join(' ').slice(0, 4000);
    });

    return description || '';
  } catch (err) {
    console.log(
      `[Eventbrite] Failed to fetch description for ${eventUrl}: ${err.message}`
    );
    return '';
  }
}

async function enrichEventbriteDescriptions(events) {
  const eventsToProcess =
    process.env.EVENTBRITE_TEST_MODE === '1' ? events.slice(0, 5) : events;

  console.log(
    `[Eventbrite] Enriching descriptions for ${eventsToProcess.length} events via Playwright...`
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let enriched = 0;
  let failed = 0;

  for (let i = 0; i < eventsToProcess.length; i++) {
    const ev = eventsToProcess[i];

    // Skip if already has a good description
    if (ev.summary && ev.summary.length > 150) continue;

    if (!ev.url) continue;

    console.log(`[Eventbrite] (${i + 1}/${eventsToProcess.length}) ${ev.title || ev.id}`);

    const description = await fetchEventbriteDescription(page, ev.url);

    if (description && description.length > 50) {
      ev.summary = description;
      enriched++;
    } else {
      failed++;
    }

    // Delay between requests to avoid rate limiting
    await page.waitForTimeout(800);
  }

  await browser.close();
  console.log(
    `[Eventbrite] Description enrichment complete — Enriched: ${enriched}, Failed/skipped: ${failed}`
  );

  return events;
}

async function scrapeEventbrite() {
  console.log('📡 Eventbrite KL — axios /destination/search/ (paginated)');

  const headers = await createSessionHeaders();
  const byId = new Map();

  let page = 1;
  let continuation = '';

  while (true) {
    console.log(`   Page ${page}…`);

    const body = buildSearchBody(page);
    const { data } = await axios.post(SEARCH_URL, body, {
      headers,
      params: searchQueryParams(continuation),
    });

    const results = data.events?.results || [];
    const pagination = data.events?.pagination;

    for (const ev of results) {
      const row = normalizeEvent(ev);
      if (row) byId.set(row.id, row);
    }

    console.log(
      `      +${results.length} events (unique total: ${byId.size})  continuation: ${
        pagination?.continuation ? 'yes' : 'no'
      }`
    );

    continuation = pagination?.continuation || '';

    if (!results.length) break;
    if (!continuation) break;

    page += 1;
  }

  let events = Array.from(byId.values());
  await fs.ensureDir(path.join(__dirname, 'data'));

  // Enrich descriptions via detail pages (best effort,
  // never fails the whole scrape)
  try {
    events = await enrichEventbriteDescriptions(events);
  } catch (err) {
    console.log(
      '[Eventbrite] Description enrichment step failed entirely, continuing with what we have:',
      err.message
    );
  }

  await fs.writeJson(OUTPUT, events, { spaces: 2 });

  console.log(`\n💾 Saved ${events.length} events → ${OUTPUT}`);
  return events;
}

if (require.main === module) {
  scrapeEventbrite().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeEventbrite };
