/**
 * Shared client helpers for SerpAPI Google Flights (via GET /api/flights).
 * Loaded before event-hub.js and itinerary-modal.js — exposes window.__serpFlightsHelpers.
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

  function mergeSerpLists(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.all_flights) && data.all_flights.length) {
      return data.all_flights;
    }
    const best = Array.isArray(data.best_flights) ? data.best_flights : [];
    const other = Array.isArray(data.other_flights) ? data.other_flights : [];
    const merged = best.concat(other);
    if (merged.length) return merged;
    if (Array.isArray(data.flights)) return data.flights;
    return [];
  }

  function getFlightCounts(data) {
    const c = data && data._flight_counts;
    if (c && typeof c.total === 'number') return c;
    const rows = mergeSerpLists(data);
    const best = Array.isArray(data && data.best_flights) ? data.best_flights.length : 0;
    const other = Array.isArray(data && data.other_flights) ? data.other_flights.length : 0;
    return { best: best, other: other, total: rows.length };
  }

  function getResponseCurrency(data) {
    const c =
      (data && data.search_parameters && data.search_parameters.currency) ||
      (data && data.search_metadata && data.search_metadata.currency);
    return String(c || 'MYR').trim().toUpperCase() || 'MYR';
  }

  function isDirectFlightOffer(f) {
    if (!f || typeof f !== 'object') return false;
    if (Array.isArray(f.layovers) && f.layovers.length > 0) return false;
    return (f.flights || []).length <= 1;
  }

  const MAX_FLIGHTS_DISPLAY = 30;
  const MAX_FLIGHTS_DISPLAY_BUDGET = 100;

  /** Ticket total from SerpAPI offer (never sum per-leg prices — that skews vs Google). */
  function parseFlightPrice(f) {
    if (!f || typeof f !== 'object') return Infinity;
    const fields = [f.price, f.total_price, f.extracted_price];
    for (let i = 0; i < fields.length; i++) {
      const raw = fields[i];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
      if (typeof raw === 'string' && raw.trim()) {
        const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return Infinity;
  }

  function formatFlightPrice(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === Infinity) return '—';
    const code = String(currency || 'MYR').toUpperCase();
    try {
      return new Intl.NumberFormat('en-MY', {
        style: 'currency',
        currency: code,
        maximumFractionDigits: 0,
      }).format(n);
    } catch (e) {
      return code + ' ' + n.toLocaleString('en-MY', { maximumFractionDigits: 0 });
    }
  }

  function flightOfferKey(f) {
    const legs = f.flights || [];
    const first = legs[0] || {};
    const last = legs[legs.length - 1] || first;
    return [
      parseFlightPrice(f),
      f.total_duration,
      first.departure_airport && first.departure_airport.time,
      last.arrival_airport && last.arrival_airport.time,
      first.airline,
      first.flight_number,
    ].join('|');
  }

  function dedupeFlightOffers(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const key = flightOfferKey(list[i]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(list[i]);
    }
    return out;
  }

  function sortFlightsByPrice(rows, ascending) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    list.sort(function (a, b) {
      const pa = parseFlightPrice(a);
      const pb = parseFlightPrice(b);
      if (pa !== pb) return ascending ? pa - pb : pb - pa;
      return (Number(a.total_duration) || 0) - (Number(b.total_duration) || 0);
    });
    return list;
  }

  /**
   * Merge best + other flights, dedupe, optional direct filter, price sort for budget/luxury.
   */
  function prepareFlightResults(data, opts) {
    opts = opts || {};
    const counts = getFlightCounts(data);
    let rows = mergeSerpLists(data);
    const totalFromApi = rows.length;
    let directFallback = false;
    if (opts.directOnly) {
      const direct = rows.filter(isDirectFlightOffer);
      if (direct.length) {
        rows = direct;
      } else {
        directFallback = true;
      }
    }
    const sortMode = opts.sortMode || 'default';
    if (sortMode === 'budget') {
      rows = sortFlightsByPrice(rows, true);
    } else if (sortMode === 'luxury') {
      rows = sortFlightsByPrice(rows, false);
    }
    const insights = data && data.price_insights;
    return {
      rows: rows,
      currency: getResponseCurrency(data),
      bookUrl: bookUrlFromResponse(data),
      counts: counts,
      totalFromApi: totalFromApi,
      afterFilter: rows.length,
      lowestPrice:
        insights && insights.lowest_price != null ? Number(insights.lowest_price) : null,
      sortMode: sortMode,
      directFallback: directFallback,
    };
  }

  function maxFlightsToShow(sortMode) {
    return sortMode === 'budget' ? MAX_FLIGHTS_DISPLAY_BUDGET : MAX_FLIGHTS_DISPLAY;
  }

  function formatDurationMinutes(min) {
    const m = Math.round(Number(min) || 0);
    if (m <= 0) return '—';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h <= 0) return r + 'm';
    return r ? h + 'h ' + r + 'm' : h + 'h';
  }

  function timeOnly(isoLike) {
    const s = String(isoLike || '').trim();
    const m = /\d{2}:\d{2}/.exec(s);
    return m ? m[0] : '—';
  }

  function layoverSummary(f) {
    const lay = f.layovers;
    if (lay && lay.length) {
      const names = lay
        .map(function (l) {
          return l.id || l.name || '';
        })
        .filter(Boolean);
      return (
        lay.length +
        ' stop' +
        (lay.length === 1 ? '' : 's') +
        (names.length ? ' (' + names.join(', ') + ')' : '')
      );
    }
    const legs = f.flights || [];
    if (legs.length <= 1) return 'Nonstop';
    const n = Math.max(0, legs.length - 1);
    return n + ' stop' + (n === 1 ? '' : 's');
  }

  function combineRoundTripForItinerary(outbound, returnFlight) {
    if (!outbound || typeof outbound !== 'object') return null;
    if (!returnFlight || typeof returnFlight !== 'object') return outbound;
    const obPrice = Number(outbound.price);
    const retPrice = Number(returnFlight.price);
    let total = Infinity;
    if (Number.isFinite(obPrice) && obPrice >= 0 && Number.isFinite(retPrice) && retPrice >= 0) {
      total = obPrice + retPrice;
    } else if (Number.isFinite(obPrice) && obPrice >= 0) {
      total = obPrice;
    } else if (Number.isFinite(retPrice) && retPrice >= 0) {
      total = retPrice;
    }
    return {
      tripType: 'round_trip_split',
      outbound: outbound,
      returnFlight: returnFlight,
      airline: [outbound.airline, returnFlight.airline].filter(Boolean).join(' · '),
      flightNumber: [outbound.flightNumber, returnFlight.flightNumber].filter(Boolean).join(' / '),
      departure: outbound.departure,
      arrival: returnFlight.arrival,
      duration: outbound.duration,
      price: total !== Infinity ? total : outbound.price,
      outboundPrice: Number.isFinite(obPrice) ? obPrice : null,
      returnPrice: Number.isFinite(retPrice) ? retPrice : null,
      stops: (Number(outbound.stops) || 0) + (Number(returnFlight.stops) || 0),
    };
  }

  function serializeForItinerary(f) {
    const legs = f.flights || [];
    const first = legs[0] || {};
    const last = legs[legs.length - 1] || first;
    const depRaw = first.departure_airport || {};
    const arrRaw = last.arrival_airport || {};
    const stops =
      Array.isArray(f.layovers) && f.layovers.length
        ? f.layovers.length
        : Math.max(0, legs.length - 1);
    return {
      airline: String(first.airline || '').trim(),
      flightNumber: String(first.flight_number || '').trim(),
      departure: {
        id: String(depRaw.id || '').trim(),
        name: String(depRaw.name || depRaw.id || '').trim(),
        time: String(depRaw.time || '').trim(),
      },
      arrival: {
        id: String(arrRaw.id || '').trim(),
        name: String(arrRaw.name || arrRaw.id || '').trim(),
        time: String(arrRaw.time || '').trim(),
      },
      duration: f.total_duration,
      price: parseFlightPrice(f) !== Infinity ? parseFlightPrice(f) : f.price,
      stops: stops,
    };
  }

  /**
   * @param {Array<object>} flights
   * @param {string} bookUrl
   * @param {boolean} hubPick
   * @param {string} [currency]
   */
  function renderSerpFlightListItems(flights, bookUrl, hubPick, currency, pickLabel) {
    const href = escapeHtml(bookUrl || 'https://www.google.com/travel/flights');
    const cur = String(currency || 'MYR').toUpperCase();
    const pickText = String(pickLabel || 'Add to my itinerary').trim() || 'Add to my itinerary';
    return flights
      .map(function (f, idx) {
        const legs = f.flights || [];
        const first = legs[0] || {};
        const last = legs[legs.length - 1] || first;
        const logo = escapeHtml(f.airline_logo || first.airline_logo || '');
        const airlines = legs
          .map(function (l) {
            return l.airline;
          })
          .filter(Boolean)
          .filter(function (a, i, arr) {
            return arr.indexOf(a) === i;
          })
          .join(', ') || '—';
        const nums =
          legs
            .map(function (l) {
              return l.flight_number;
            })
            .filter(Boolean)
            .join(' · ') || '—';
        const depName = (first.departure_airport && first.departure_airport.id) || '';
        const arrName = (last.arrival_airport && last.arrival_airport.id) || '';
        const depT = timeOnly(first.departure_airport && first.departure_airport.time);
        const arrT = timeOnly(last.arrival_airport && last.arrival_airport.time);
        const dur = formatDurationMinutes(f.total_duration);
        const stops = layoverSummary(f);
        const priceNum = parseFlightPrice(f);
        const priceStr = formatFlightPrice(priceNum, cur);
        const logoBlock = logo
          ? '<img class="eh-serp-logo" src="' +
            logo +
            '" alt="" width="36" height="36" loading="lazy" decoding="async" />'
          : '<div class="eh-serp-logo eh-serp-logo--ph" aria-hidden="true"></div>';
        return (
          '<li class="eh-flight-row eh-serp-row">' +
          '<div class="eh-serp-left">' +
          logoBlock +
          '<div class="eh-serp-mid">' +
          '<div><strong>' +
          escapeHtml(airlines) +
          '</strong></div>' +
          '<span class="eh-flight-sub">' +
          escapeHtml(nums) +
          '</span>' +
          '<span class="eh-flight-sub"><strong>' +
          escapeHtml(depT) +
          '</strong> → <strong>' +
          escapeHtml(arrT) +
          '</strong> · ' +
          escapeHtml(depName) +
          ' → ' +
          escapeHtml(arrName) +
          '</span>' +
          '<span class="eh-flight-sub">' +
          escapeHtml(dur) +
          ' · ' +
          escapeHtml(stops) +
          '</span>' +
          '</div></div>' +
          '<div class="eh-flight-meta">' +
          '<span class="eh-price">' +
          escapeHtml(priceStr) +
          '</span>' +
          (hubPick
            ? '<button type="button" class="eh-btn eh-btn--gold eh-serp-add-itin" data-eh-add-flight="' +
              idx +
              '">' +
              escapeHtml(pickText) +
              '</button>'
            : '') +
          '<a class="eh-btn eh-btn--ghost eh-serp-book" href="' +
          href +
          '" target="_blank" rel="noopener noreferrer">Verify on Google</a>' +
          '</div></li>'
        );
      })
      .join('');
  }

  function bookUrlFromResponse(data) {
    return (
      (data.search_metadata && data.search_metadata.google_flights_url) ||
      'https://www.google.com/travel/flights'
    );
  }

  function fetchSerpFlights(params, signal) {
    const q = new URLSearchParams({
      from: params.from,
      to: params.to,
      date: params.date,
      passengers: String(params.passengers != null ? params.passengers : 1),
      type: String(params.type != null ? params.type : '2'),
    });
    if (params.returnDate) q.set('returnDate', params.returnDate);
    return fetch('/api/flights?' + q.toString(), { signal: signal }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(String((data && (data.error || data.message))) || 'Flight search failed');
        }
        return data;
      });
    });
  }

  global.__serpFlightsHelpers = {
    escapeHtml: escapeHtml,
    mergeSerpLists: mergeSerpLists,
    getFlightCounts: getFlightCounts,
    getResponseCurrency: getResponseCurrency,
    isDirectFlightOffer: isDirectFlightOffer,
    MAX_FLIGHTS_DISPLAY: MAX_FLIGHTS_DISPLAY,
    MAX_FLIGHTS_DISPLAY_BUDGET: MAX_FLIGHTS_DISPLAY_BUDGET,
    maxFlightsToShow: maxFlightsToShow,
    parseFlightPrice: parseFlightPrice,
    formatFlightPrice: formatFlightPrice,
    dedupeFlightOffers: dedupeFlightOffers,
    sortFlightsByPrice: sortFlightsByPrice,
    prepareFlightResults: prepareFlightResults,
    fetchSerpFlights: fetchSerpFlights,
    renderSerpFlightListItems: renderSerpFlightListItems,
    bookUrlFromResponse: bookUrlFromResponse,
    serializeForItinerary: serializeForItinerary,
    combineRoundTripForItinerary: combineRoundTripForItinerary,
  };
})(typeof window !== 'undefined' ? window : this);
