/**
 * SerpAPI Google Hotels (via GET /api/hotels) — same-origin proxy as flights.
 * Loaded after serp-flights-helpers.js — exposes window.__serpHotelsHelpers.
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeSerpHotelRow(p) {
    if (!p || typeof p !== 'object') return null;
    const name = String(p.name || '').trim();
    if (!name) return null;
    return p;
  }

  /** SerpAPI google_hotels: merge `properties` + sponsored `ads` into one list. */
  function mergeHotelProperties(data) {
    const out = [];
    const seen = {};
    function push(row) {
      const n = normalizeSerpHotelRow(row);
      if (!n) return;
      const key = String(n.name || '').toLowerCase() + '|' + String(n.link || '');
      if (seen[key]) return;
      seen[key] = true;
      out.push(n);
    }
    const props = data && Array.isArray(data.properties) ? data.properties : [];
    const ads = data && Array.isArray(data.ads) ? data.ads : [];
    props.forEach(push);
    ads.forEach(push);
    return out;
  }

  function validHotelIsoDate(s) {
    const d = String(s || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }

  function hotelNightsBetween(checkIn, checkOut) {
    const a = validHotelIsoDate(checkIn);
    const b = validHotelIsoDate(checkOut);
    if (!a || !b) return 1;
    const p1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
    const p2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
    if (!p1 || !p2) return 1;
    const d1 = Date.UTC(Number(p1[1]), Number(p1[2]) - 1, Number(p1[3]));
    const d2 = Date.UTC(Number(p2[1]), Number(p2[2]) - 1, Number(p2[3]));
    if (!Number.isFinite(d1) || !Number.isFinite(d2) || d2 <= d1) return 1;
    return Math.round((d2 - d1) / 86400000);
  }

  function formatPerNightPriceLabel(extracted, rawLabel) {
    const ex = Number(extracted);
    if (!Number.isFinite(ex) || !(ex > 0)) return '—';
    let label = String(rawLabel || '').trim();
    if (label) {
      if (label.indexOf('night') < 0 && label.indexOf('total') < 0) label += ' /night';
      return label;
    }
    return 'MYR ' + Math.round(ex).toLocaleString('en-MY') + ' /night';
  }

  function parseOfferPerNight(offer) {
    if (!offer || typeof offer !== 'object') return null;
    const rn = offer.rate_per_night;
    if (rn && Number.isFinite(Number(rn.extracted_lowest))) {
      return { extracted: Number(rn.extracted_lowest), label: rn.lowest ? String(rn.lowest) : '' };
    }
    if (offer.extracted_price != null && Number.isFinite(Number(offer.extracted_price))) {
      return {
        extracted: Number(offer.extracted_price),
        label: offer.price != null ? String(offer.price) : '',
      };
    }
    if (rn && rn.lowest) {
      const n = parseFloat(String(rn.lowest).replace(/[^0-9.]/g, '')) || 0;
      if (n > 0) return { extracted: n, label: String(rn.lowest) };
    }
    return null;
  }

  /**
   * Lowest per-night offer — matches Google Hotels list (min across OTAs + headline).
   * @param {object} data Serp list row or /api/hotels/property payload
   */
  function resolveHotelDisplayPrice(data, checkIn, checkOut) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [];
    function add(entry) {
      if (entry && Number.isFinite(entry.extracted) && entry.extracted > 0) candidates.push(entry);
    }
    const rn = data.rate_per_night;
    if (rn && Number.isFinite(Number(rn.extracted_lowest))) {
      add({ extracted: Number(rn.extracted_lowest), label: rn.lowest ? String(rn.lowest) : '' });
    }
    if (Number.isFinite(Number(data.lowest_price)) && Number(data.lowest_price) > 0) {
      add({ extracted: Number(data.lowest_price), label: '' });
    }
    if (Number.isFinite(Number(data.lowest_featured)) && Number(data.lowest_featured) > 0) {
      add({ extracted: Number(data.lowest_featured), label: '' });
    }
    if (data.display_per_night != null && Number.isFinite(Number(data.display_per_night))) {
      add({
        extracted: Number(data.display_per_night),
        label: data.display_label ? String(data.display_label) : '',
      });
    }
    ['featured_prices', 'prices'].forEach(function (key) {
      const arr = Array.isArray(data[key]) ? data[key] : [];
      arr.forEach(function (offer) {
        const o = parseOfferPerNight(offer);
        if (o) add(o);
      });
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      return a.extracted - b.extracted;
    });
    const best = candidates[0];
    return {
      extracted: best.extracted,
      label: formatPerNightPriceLabel(best.extracted, best.label),
    };
  }

  /** Google list cards quote per-night rates; label them so they match Google Hotels UI. */
  function hotelPriceLabel(p, opts) {
    if (p == null || typeof p !== 'object') return '—';
    if (p.ehDisplayLabel) return String(p.ehDisplayLabel);
    const resolved = resolveHotelDisplayPrice(p, opts && opts.checkIn, opts && opts.checkOut);
    if (resolved && resolved.label) return resolved.label;
    const o = opts && typeof opts === 'object' ? opts : {};
    const nights = hotelNightsBetween(o.checkIn, o.checkOut);
    const rn = p.rate_per_night;
    const tr = p.total_rate;
    const raw = p.price != null ? String(p.price).trim() : '';
    if (raw) return raw.indexOf('night') >= 0 ? raw : raw + ' /night';
    if (rn && rn.lowest) {
      const s = String(rn.lowest);
      return s.indexOf('night') >= 0 ? s : s + ' /night';
    }
    const rnEx = rn && rn.extracted_lowest;
    if (rnEx != null && Number.isFinite(Number(rnEx))) {
      return 'MYR ' + Math.round(Number(rnEx)).toLocaleString('en-MY') + ' /night';
    }
    if (p.extracted_price != null && Number.isFinite(Number(p.extracted_price))) {
      return 'MYR ' + Math.round(Number(p.extracted_price)).toLocaleString('en-MY') + ' /night';
    }
    if (tr && tr.lowest) {
      const s = String(tr.lowest);
      return nights > 1 ? s + ' total' : s;
    }
    const trEx = tr && tr.extracted_lowest;
    if (trEx != null && Number.isFinite(Number(trEx))) {
      const label = 'MYR ' + Math.round(Number(trEx)).toLocaleString('en-MY');
      return nights > 1 ? label + ' total' : label;
    }
    return '—';
  }

  /** Sort key: lowest per-night (same basis as Google list sort). */
  function hotelExtractedPrice(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.ehDisplayPrice != null && Number.isFinite(Number(p.ehDisplayPrice))) {
      return Number(p.ehDisplayPrice);
    }
    const resolved = resolveHotelDisplayPrice(p);
    if (resolved && resolved.extracted != null) return resolved.extracted;
    const rn = p.rate_per_night;
    if (rn && rn.extracted_lowest != null && Number.isFinite(Number(rn.extracted_lowest))) {
      return Number(rn.extracted_lowest);
    }
    if (p.extracted_price != null && Number.isFinite(Number(p.extracted_price))) {
      return Number(p.extracted_price);
    }
    const tr = p.total_rate;
    if (tr && tr.extracted_lowest != null && Number.isFinite(Number(tr.extracted_lowest))) {
      return Number(tr.extracted_lowest);
    }
    const raw = (rn && rn.lowest) || p.price || (tr && tr.lowest);
    if (raw != null) {
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
      if (n > 0) return n;
    }
    return null;
  }

  /**
   * Shape sent to POST /api/itinerary/generate and shown in hub summary.
   * @param {object} p Serp property row
   * @param {string} checkIn YYYY-MM-DD
   * @param {string} checkOut YYYY-MM-DD
   */
  function serializeForItinerary(p, checkIn, checkOut) {
    const name = String((p && p.name) || '').trim();
    const r = p && p.overall_rating != null && Number.isFinite(Number(p.overall_rating)) ? Number(p.overall_rating) : null;
    const rev = p && p.reviews != null && Number.isFinite(Number(p.reviews)) ? Math.round(Number(p.reviews)) : null;
    return {
      name: name,
      type: String((p && p.type) || '').trim(),
      overallRating: r,
      reviewsCount: rev,
      priceLabel: hotelPriceLabel(p, { checkIn: checkIn, checkOut: checkOut }),
      checkIn: String(checkIn || '').trim().slice(0, 10),
      checkOut: String(checkOut || '').trim().slice(0, 10),
      link: String((p && p.link) || '').trim(),
    };
  }

  // Google Hotels /travel/search reads dates + guests from base64 `ts` only.
  // Adults: one `0a020803` slot per adult (not a single count byte). Verified via Playwright.
  function tsYearVarintBytes(year) {
    const out = [];
    let v = year >>> 0;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v & 0x7f);
    return out;
  }
  function tsBytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try {
      return btoa(s);
    } catch (e) {
      return '';
    }
  }
  /**
   * @param {string} checkIn YYYY-MM-DD
   * @param {string} checkOut YYYY-MM-DD
   * @param {number} adults 1–9
   * @returns {string} base64 `ts` for Google Travel hotel search
   */
  function buildGoogleHotelsTs(checkIn, checkOut, adults, rooms) {
    const ci = String(checkIn || '').split('-').map(function (x) { return parseInt(x, 10); });
    const co = String(checkOut || '').split('-').map(function (x) { return parseInt(x, 10); });
    if (ci.length !== 3 || co.length !== 3 || ci.some(isNaN) || co.some(isNaN)) return '';
    const adultsN = Math.max(1, Math.min(9, parseInt(adults, 10) || 1));
    const roomsN = Math.max(1, Math.min(9, parseInt(rooms, 10) || 1));
    const nights = hotelNightsBetween(checkIn, checkOut);

    const guestBody = [];
    for (let i = 0; i < adultsN; i++) guestBody.push(0x0a, 0x02, 0x08, 0x03);
    guestBody.push(0x10, roomsN);

    const arr = [0x08].concat(tsYearVarintBytes(ci[0]), [0x10, ci[1], 0x18, ci[2]]);
    const dep = [0x08].concat(tsYearVarintBytes(co[0]), [0x10, co[1], 0x18, co[2]]);
    const dateCore = [0x12, 0x1a, 0x12, 0x14, 0x0a, 0x07]
      .concat(arr, [0x12, 0x07])
      .concat(dep, [0x18, nights], [0x32, 0x02, 0x08, 0x01]);
    const dateWrapped = [0x0a, 0x02, 0x1a, 0x00].concat(dateCore);
    const currency = [0x2a, 0x09, 0x0a, 0x05, 0x3a, 0x03, 0x4d, 0x59, 0x52, 0x1a, 0x00];

    const bytes = [0x08, 0x01, 0x12, guestBody.length]
      .concat(guestBody, [0x1a, dateWrapped.length])
      .concat(dateWrapped, currency);
    return tsBytesToBase64(bytes);
  }

  /** Append Serp search dates to Google Travel URL (same dates as /api/hotels). */
  function appendHotelDatesToGoogleUrl(urlStr, checkIn, checkOut, searchQ) {
    const ci = validHotelIsoDate(checkIn);
    const co = validHotelIsoDate(checkOut);
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr);
      if (searchQ) u.searchParams.set('q', searchQ);
      if (ci && co) {
        // Google Hotels reads `checkin`/`checkout` on search pages; `brd_dates`
        // is what SerpAPI-generated search URLs embed. Set both so whichever
        // surface Google routes us into honors our trip window.
        u.searchParams.set('brd_dates', ci + ',' + co);
        u.searchParams.set('checkin', ci);
        u.searchParams.set('checkout', co);
      }
      if (!u.searchParams.has('hl')) u.searchParams.set('hl', 'en');
      if (!u.searchParams.has('gl')) u.searchParams.set('gl', 'my');
      return u.toString();
    } catch (e) {
      return urlStr;
    }
  }

  /**
   * Book context saved after a Serp search — must match list query + Serp check-in/out (not raw trip dates when clamped).
   * @param {object} data Serp /api/hotels JSON
   * @param {string} q Query sent to Serp
   * @param {string} checkIn YYYY-MM-DD used for Serp
   * @param {string} checkOut YYYY-MM-DD used for Serp
   * @param {object} [tripCtx] Optional { city, arrival_date, departure_date } from itinerary
   */
  function hotelBookContextFromSerpSearch(data, q, checkIn, checkOut, tripCtx) {
    const trip = tripCtx && typeof tripCtx === 'object' ? tripCtx : {};
    const sp = data && data.search_parameters;
    const serpIn = validHotelIsoDate(
      (data && data.serp_check_in_date) || (sp && sp.check_in_date) || checkIn,
    );
    const serpOut = validHotelIsoDate(
      (data && data.serp_check_out_date) || (sp && sp.check_out_date) || checkOut,
    );
    const searchQ = String((sp && sp.q) || q || trip.city || '').trim() || 'Kuala Lumpur, Malaysia';
    const metaUrl =
      data && data.search_metadata && data.search_metadata.google_hotels_url
        ? String(data.search_metadata.google_hotels_url).trim()
        : '';
    // Adults: prefer the count SerpAPI echoes back (proves what the displayed
    // prices reflect), fall back to whatever the trip context carries.
    const adults = Math.max(
      1,
      Math.min(
        9,
        parseInt((sp && sp.adults) || trip.adults || 1, 10) || 1,
      ),
    );
    return {
      q: searchQ,
      city: String(trip.city || '').trim(),
      arrival_date: serpIn,
      departure_date: serpOut,
      trip_arrival_date: validHotelIsoDate(trip.arrival_date),
      trip_departure_date: validHotelIsoDate(trip.departure_date),
      google_hotels_url: metaUrl,
      adults: adults,
    };
  }

  /**
   * Google Hotels book link — same search as Serp list (q + dates). Per row opens that property on Google when possible.
   * @param {{ itinerary?: object, hotel?: object, q?: string, arrival_date?: string, departure_date?: string, google_hotels_url?: string }} ctx
   */
  function buildGoogleHotelsCityBookUrl(ctx) {
    const o = ctx && typeof ctx === 'object' ? ctx : {};
    const itinerary = o.itinerary && typeof o.itinerary === 'object' ? o.itinerary : o;
    const hotel = o.hotel && typeof o.hotel === 'object' ? o.hotel : {};

    const cityRaw =
      String(itinerary.city || o.city || hotel.city || 'Kuala Lumpur').trim() || 'Kuala Lumpur';
    const cityQ = cityRaw.indexOf('Malaysia') >= 0 ? cityRaw : cityRaw + ', Malaysia';
    const baseQ = String(itinerary.q || o.q || '').trim() || cityQ;

    // Compose query so Google's listing filters to the clicked hotel within
    // the trip city. Google treats "<hotel name> <city>" as a narrowed hotel
    // search and renders the listing focused on that property.
    const hotelName = String((hotel && hotel.name) || '').trim();
    const searchQ = hotelName ? hotelName + ' ' + cityQ : baseQ;

    const checkIn = validHotelIsoDate(itinerary.arrival_date || o.arrival_date);
    const checkOut = validHotelIsoDate(itinerary.departure_date || o.departure_date);
    const adults = Math.max(
      1,
      Math.min(9, parseInt(itinerary.adults || o.adults || hotel.adults || 1, 10) || 1),
    );

    // Build the listing URL with a hand-encoded `ts` protobuf carrying our
    // dates, guest count, and currency. Plain ?checkin=/?checkout=/?adults=
    // query params are dropped by Google's /travel/search handler — only
    // `ts` survives. Without `ts` Google fills in today / today+2 nights / 2
    // adults defaults, which is exactly the symptom we were seeing.
    const u = new URL('https://www.google.com/travel/search');
    u.searchParams.set('q', searchQ);
    u.searchParams.set('qs', 'CAE4AA');
    u.searchParams.set('ap', 'MAE');
    u.searchParams.set('hl', 'en');
    u.searchParams.set('gl', 'my');
    if (checkIn && checkOut) {
      const ts = buildGoogleHotelsTs(checkIn, checkOut, adults, 1);
      if (ts) u.searchParams.set('ts', ts);
      // Belt-and-suspenders for any older Google surfaces that still read
      // the legacy query params (search-results card, mobile fallbacks).
      u.searchParams.set('checkin', checkIn);
      u.searchParams.set('checkout', checkOut);
      u.searchParams.set('brd_dates', checkIn + ',' + checkOut);
    }
    return u.toString();
  }

  function openGoogleHotelsCityBook(ctx) {
    window.open(buildGoogleHotelsCityBookUrl(ctx), '_blank', 'noopener,noreferrer');
  }

  /**
   * @param {Array<object>} rows
   * @param {object} bookContext { city, arrival_date, departure_date } from itineraries_generated trip dates
   * @param {boolean} hubPick When true, append “Add to my itinerary” per row (event hub).
   * @returns {string}
   */
  function renderSerpHotelListItems(rows, bookContext, hubPick) {
    const tripCtx = bookContext && typeof bookContext === 'object' ? bookContext : {};
    return rows
      .map(function (p, idx) {
        const bookHref = escapeHtml(
          buildGoogleHotelsCityBookUrl({ hotel: p, itinerary: tripCtx }),
        );
        const name = escapeHtml(p.name || 'Property');
        const rating =
          p.overall_rating != null && Number.isFinite(Number(p.overall_rating))
            ? Number(p.overall_rating).toFixed(1)
            : '—';
        const reviews = p.reviews != null ? String(p.reviews) : '';
        const revStr = reviews ? escapeHtml(reviews) + ' reviews' : '';
        const price = escapeHtml(
          hotelPriceLabel(p, {
            checkIn: tripCtx.arrival_date,
            checkOut: tripCtx.departure_date,
          }),
        );
        const priceClass = p.ehDisplayLabel ? ' eh-price--live' : ' eh-price--pending';
        const src =
          (p.thumbnail && String(p.thumbnail).trim()) ||
          (p.images &&
            p.images[0] &&
            (String(p.images[0].thumbnail || '').trim() ||
              String(p.images[0].original_image || '').trim())) ||
          '';
        const logoBlock = src
          ? '<img class="eh-serp-logo eh-serp-logo--hotel" src="' +
            escapeHtml(src) +
            '" alt="" width="36" height="36" loading="lazy" decoding="async" />'
          : '<div class="eh-serp-logo eh-serp-logo--ph" aria-hidden="true"></div>';
        const propToken = escapeHtml(String((p && p.property_token) || '').trim());
        return (
          '<li class="eh-hotel-row eh-serp-row">' +
          '<div class="eh-serp-left">' +
          logoBlock +
          '<div class="eh-serp-mid">' +
          '<div><strong>' +
          name +
          '</strong></div>' +
          (p.type ? '<span class="eh-flight-sub">' + escapeHtml(String(p.type)) + '</span>' : '') +
          '<span class="eh-flight-sub">Rating ' +
          escapeHtml(rating) +
          (revStr ? ' · ' + revStr : '') +
          '</span>' +
          '</div></div>' +
          '<div class="eh-flight-meta">' +
          '<span class="eh-price' +
          priceClass +
          '" data-eh-price-token="' +
          propToken +
          '">' +
          price +
          '</span>' +
          (hubPick
            ? '<button type="button" class="eh-btn eh-btn--gold eh-serp-add-itin" data-eh-add-hotel="' +
              idx +
              '">Select & build itinerary</button>'
            : '') +
          '<a class="eh-btn eh-btn--ghost eh-serp-book" href="' +
          bookHref +
          '" target="_blank" rel="noopener noreferrer">Book</a>' +
          '</div></li>'
        );
      })
      .join('');
  }

  function hotelsBookUrlFromResponse(data, bookContext) {
    const sp = data && data.search_parameters;
    const ctx =
      bookContext && typeof bookContext === 'object'
        ? bookContext
        : hotelBookContextFromSerpSearch(
            data,
            sp && sp.q,
            sp && sp.check_in_date,
            sp && sp.check_out_date,
            null,
          );
    return buildGoogleHotelsCityBookUrl({ itinerary: ctx });
  }

  /**
   * Live single-property price (occupancy-correct) via /api/hotels/property.
   * Resolves to { label, extracted } or null if nothing usable came back.
   * Never throws — pricing is best-effort; the cached list price stays as fallback.
   * @param {{ propertyToken:string, q?:string, checkIn:string, checkOut:string, adults?:number }} params
   */
  function fetchSerpHotelLivePrice(params, signal) {
    const token = String((params && params.propertyToken) || '').trim();
    if (!token) return Promise.resolve(null);
    const qs = new URLSearchParams({
      property_token: token,
      check_in_date: String(params.checkIn || '').trim().slice(0, 10),
      check_out_date: String(params.checkOut || '').trim().slice(0, 10),
      adults: String(params.adults != null ? params.adults : 1),
    });
    if (params.q) qs.set('q', String(params.q).trim().slice(0, 200));
    return fetch('/api/hotels/property?' + qs.toString(), { signal: signal })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || data.error) return null;
        const display = resolveHotelDisplayPrice(
          data,
          params.checkIn,
          params.checkOut,
        );
        if (!display) return null;
        return {
          extracted: display.extracted,
          label: display.label,
          adults: data.adults,
        };
      })
      .catch(function () {
        return null;
      });
  }

  /**
   * Update list prices in the DOM without blocking the initial render (fast path).
   * @param {HTMLElement} host Results container
   * @param {Array<object>} rows Rendered rows (for token lookup)
   * @param {{ q:string, checkIn:string, checkOut:string, adults:number, maxRows?:number, concurrency?:number, isStale?:function, onPrice?:function }} opts
   * @returns {Promise<void>}
   */
  function refreshLiveHotelPricesInDom(host, rows, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const maxRows = Math.max(1, Math.min(16, parseInt(o.maxRows, 10) || 10));
    const concurrency = Math.max(1, Math.min(10, parseInt(o.concurrency, 10) || 8));
    const list = (Array.isArray(rows) ? rows : []).slice(0, maxRows);
    if (!host || !list.length) return Promise.resolve();

    const cssEsc =
      window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape
        : function (s) {
            return String(s).replace(/["\\\]]/g, '\\$&');
          };

    const jobs = [];
    list.forEach(function (row, rowIndex) {
      const token = String((row && row.property_token) || '').trim();
      if (!token) return;
      const el = host.querySelector('[data-eh-price-token="' + cssEsc(token) + '"]');
      if (!el) return;
      jobs.push({ token: token, el: el, rowIndex: rowIndex, row: row });
    });
    if (!jobs.length) return Promise.resolve();

    return new Promise(function (resolve) {
      let next = 0;
      let running = 0;

      function finish() {
        if (running === 0 && next >= jobs.length) resolve();
      }

      function pump() {
        if (typeof o.isStale === 'function' && o.isStale()) {
          resolve();
          return;
        }
        while (running < concurrency && next < jobs.length) {
          const job = jobs[next++];
          running++;
          fetchSerpHotelLivePrice({
            propertyToken: job.token,
            q: o.q,
            checkIn: o.checkIn,
            checkOut: o.checkOut,
            adults: o.adults,
          })
            .then(function (live) {
              if (typeof o.isStale === 'function' && o.isStale()) return;
              if (!live || !live.label || !job.el.isConnected) return;
              job.el.textContent = live.label;
              job.el.classList.remove('eh-price--pending');
              job.el.classList.add('eh-price--live');
              if (typeof o.onPrice === 'function') {
                o.onPrice(job.rowIndex, job.row, live);
              }
            })
            .finally(function () {
              running--;
              pump();
              finish();
            });
        }
        finish();
      }

      pump();
    });
  }

  /**
   * Fetch per-property live rates before rendering (slower — waits for all rows).
   * @param {Array<object>} rows
   * @param {{ q:string, checkIn:string, checkOut:string, adults:number, maxRows?:number, concurrency?:number, isStale?:function }} opts
   */
  function enrichHotelRowsWithLivePrices(rows, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const maxRows = Math.max(1, Math.min(24, parseInt(o.maxRows, 10) || 18));
    const concurrency = Math.max(1, Math.min(6, parseInt(o.concurrency, 10) || 4));
    const list = (Array.isArray(rows) ? rows : []).slice(0, maxRows);
    if (!list.length) return Promise.resolve([]);

    const out = list.map(function (row) {
      return Object.assign({}, row);
    });

    return new Promise(function (resolve) {
      let next = 0;
      let running = 0;

      function finish() {
        if (running === 0 && next >= list.length) resolve(out);
      }

      function pump() {
        if (typeof o.isStale === 'function' && o.isStale()) {
          resolve(out);
          return;
        }
        while (running < concurrency && next < list.length) {
          const i = next++;
          running++;
          const row = out[i];
          const token = String((row && row.property_token) || '').trim();
          if (!token) {
            running--;
            continue;
          }
          fetchSerpHotelLivePrice({
            propertyToken: token,
            q: o.q,
            checkIn: o.checkIn,
            checkOut: o.checkOut,
            adults: o.adults,
          })
            .then(function (live) {
              if (typeof o.isStale === 'function' && o.isStale()) return;
              if (live && live.extracted != null) {
                out[i] = Object.assign({}, row, {
                  ehDisplayPrice: live.extracted,
                  ehDisplayLabel: live.label,
                });
              }
            })
            .finally(function () {
              running--;
              pump();
              finish();
            });
        }
        finish();
      }

      pump();
    });
  }

  function fetchSerpHotels(params, signal) {
    const q = new URLSearchParams({
      q: String(params.q || '').trim(),
      check_in_date: String(params.checkIn || '').trim().slice(0, 10),
      check_out_date: String(params.checkOut || '').trim().slice(0, 10),
      adults: String(params.adults != null ? params.adults : 1),
    });
    return fetch('/api/hotels?' + q.toString(), { signal: signal }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          let errText = (data && (data.error || data.message)) || 'Hotel search failed';
          errText = String(errText).replace(/^Google Hotels engine has been temporarily disabled\.?\s*/i, '').trim();
          throw new Error(errText || 'Hotel search failed');
        }
        return data;
      });
    });
  }

  global.__serpHotelsHelpers = {
    escapeHtml: escapeHtml,
    mergeHotelProperties: mergeHotelProperties,
    hotelExtractedPrice: hotelExtractedPrice,
    fetchSerpHotels: fetchSerpHotels,
    fetchSerpHotelLivePrice: fetchSerpHotelLivePrice,
    enrichHotelRowsWithLivePrices: enrichHotelRowsWithLivePrices,
    refreshLiveHotelPricesInDom: refreshLiveHotelPricesInDom,
    resolveHotelDisplayPrice: resolveHotelDisplayPrice,
    hotelBookContextFromSerpSearch: hotelBookContextFromSerpSearch,
    buildGoogleHotelsCityBookUrl: buildGoogleHotelsCityBookUrl,
    openGoogleHotelsCityBook: openGoogleHotelsCityBook,
    renderSerpHotelListItems: renderSerpHotelListItems,
    hotelsBookUrlFromResponse: hotelsBookUrlFromResponse,
    serializeForItinerary: serializeForItinerary,
  };
})(typeof window !== 'undefined' ? window : this);
