/**
 * Flight search: Google Flights (SerpAPI via same-origin /api/flights proxy) + AirAsia deep link.
 * API key lives only on the server (VITE_SERPAPI_KEY / SERPAPI_KEY in .env).
 */

const POPULAR_ROUTES = [
  { from: 'KUL', to: 'SIN', label: 'KL → Singapore' },
  { from: 'KUL', to: 'BKK', label: 'KL → Bangkok' },
  { from: 'KUL', to: 'DPS', label: 'KL → Bali' },
  { from: 'KUL', to: 'CGK', label: 'KL → Jakarta' },
  { from: 'KUL', to: 'PEN', label: 'KL → Penang' },
  { from: 'KUL', to: 'LHR', label: 'KL → London' },
];

/** Default origin IATA from ISO country code (rough hub). */
const COUNTRY_TO_FROM_IATA = {
  MY: 'KUL',
  SG: 'SIN',
  TH: 'BKK',
  ID: 'CGK',
  VN: 'SGN',
  PH: 'MNL',
  KH: 'PNH',
  LA: 'VTE',
  BN: 'BWN',
  AU: 'SYD',
  IN: 'DEL',
  JP: 'NRT',
  KR: 'ICN',
  CN: 'CAN',
  TW: 'TPE',
  HK: 'HKG',
};

let serpAbort = null;
/** Merged `best_flights` + `other_flights` from last successful parse. */
let serpMerged = [];
let lastSerpBookUrl = 'https://www.google.com/travel/flights';

function todayMalaysiaISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}

/** Add days to a YYYY-MM-DD string using local calendar (avoids UTC off-by-one). */
function addDaysToIsoDate(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return todayMalaysiaISO();
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  dt.setDate(dt.getDate() + Number(days) || 0);
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** AirAsia expects departDate as DD/MM/YYYY (not ISO). */
function isoDateToDdMmYyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function buildAirAsiaSearchUrl(from, to, dateIso, passengers = 1) {
  const depart = isoDateToDdMmYyyy(dateIso) || isoDateToDdMmYyyy(todayMalaysiaISO());
  const adult = Math.min(9, Math.max(1, Number(passengers) || 1));
  const p = new URLSearchParams();
  p.set('origin', String(from).toUpperCase());
  p.set('destination', String(to).toUpperCase());
  p.set('departDate', depart);
  p.set('tripType', 'O');
  p.set('adult', String(adult));
  p.set('child', '0');
  p.set('infant', '0');
  p.set('locale', 'en-gb');
  p.set('currency', 'MYR');
  p.set('cabinClass', 'economy');
  return `https://www.airasia.com/flights/search/?${p.toString()}`;
}

function airAsiaSearchUrl(from, to, date, passengers = 1) {
  return buildAirAsiaSearchUrl(from, to, date, passengers);
}

function $(id) {
  return document.getElementById(id);
}

function showFsAlert(msg) {
  const el = $('fs-alert');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function openFsModal() {
  const m = $('fs-modal');
  if (!m) return;
  m.classList.add('is-open');
  m.setAttribute('aria-hidden', 'false');
  document.body.classList.add('fs-modal-open');
}

function closeFsModal() {
  const m = $('fs-modal');
  if (!m) return;
  m.classList.remove('is-open');
  m.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('fs-modal-open');
}

async function reverseGeocode(lat, lng) {
  const res = await fetch(
    `/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
  );
  if (!res.ok) throw new Error('Could not resolve location');
  return res.json();
}

function guessFromIataFromNominatim(data) {
  const cc = (data.address && data.address.country_code) || '';
  const upper = String(cc).toUpperCase();
  return COUNTRY_TO_FROM_IATA[upper] || 'KUL';
}

function renderChips() {
  const host = $('fs-chips');
  if (!host) return;
  host.innerHTML = POPULAR_ROUTES.map(
    (r) =>
      `<button type="button" class="fs-chip" data-from="${escapeHtml(r.from)}" data-to="${escapeHtml(r.to)}">${escapeHtml(r.label)}</button>`,
  ).join('');
}

function readTripType() {
  const roundBtn = $('fs-trip-round');
  return roundBtn && roundBtn.classList.contains('is-active') ? '1' : '2';
}

function setTripType(type) {
  const one = $('fs-trip-oneway');
  const round = $('fs-trip-round');
  const wrap = $('fs-return-wrap');
  const retEl = $('fs-return-date');
  const dateEl = $('fs-date');
  const isRound = type === '1';
  if (one) {
    one.classList.toggle('is-active', !isRound);
    one.setAttribute('aria-pressed', String(!isRound));
  }
  if (round) {
    round.classList.toggle('is-active', isRound);
    round.setAttribute('aria-pressed', String(isRound));
  }
  if (wrap) wrap.hidden = !isRound;
  if (isRound && retEl && dateEl && !retEl.value) {
    const base = dateEl.value || todayMalaysiaISO();
    retEl.value = addDaysToIsoDate(base, 3);
  }
  syncReturnDateMin();
}

function syncReturnDateMin() {
  const dateEl = $('fs-date');
  const retEl = $('fs-return-date');
  const minD = (dateEl && dateEl.value) || todayMalaysiaISO();
  if (retEl) {
    retEl.min = minD;
    if (retEl.value && retEl.value < minD) retEl.value = minD;
  }
}

function collectFormIataDatePax() {
  const fromEl = $('fs-from');
  const toEl = $('fs-to');
  const dateEl = $('fs-date');
  const paxEl = $('fs-pax');
  const retEl = $('fs-return-date');
  if (!fromEl || !toEl || !dateEl || !paxEl) return null;
  const from = String(fromEl.value || '')
    .trim()
    .toUpperCase();
  const to = String(toEl.value || '')
    .trim()
    .toUpperCase();
  const date = dateEl.value || todayMalaysiaISO();
  const pax = Math.min(9, Math.max(1, Number(paxEl.value) || 1));
  const returnDate = readTripType() === '1' && retEl ? String(retEl.value || '').trim() : '';
  return { from, to, date, pax, returnDate };
}

function validateIataRoute(form) {
  if (!form) return 'Missing form fields.';
  const { from, to } = form;
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return 'Enter valid 3-letter IATA codes for From and To.';
  }
  if (from === to) return 'From and To must be different.';
  return '';
}

async function searchFlights(from, to, date, passengers, type, returnDate, signal) {
  const q = new URLSearchParams({
    from,
    to,
    date,
    passengers: String(passengers),
    type: String(type || '2'),
  });
  if (returnDate) q.set('returnDate', returnDate);
  const response = await fetch(`/api/flights?${q}`, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = data.error || data.message || `Request failed (${response.status})`;
    throw new Error(String(err));
  }
  return data;
}

function mergeSerpLists(data) {
  const best = Array.isArray(data.best_flights) ? data.best_flights : [];
  const other = Array.isArray(data.other_flights) ? data.other_flights : [];
  return [...best, ...other];
}

function formatDurationMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m <= 0) return '—';
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h <= 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function timeOnly(isoLike) {
  const s = String(isoLike || '').trim();
  const m = /\d{2}:\d{2}/.exec(s);
  return m ? m[0] : s.slice(0, 5) || '—';
}

function firstDepartureSortKey(f) {
  const legs = f.flights || [];
  const t = legs[0] && legs[0].departure_airport && legs[0].departure_airport.time;
  return String(t || '');
}

function isNonstopOffer(f) {
  return (f.flights || []).length <= 1;
}

function layoverSummary(f) {
  const lay = f.layovers;
  if (lay && lay.length) {
    const names = lay.map((l) => l.id || l.name || '').filter(Boolean);
    return `${lay.length} stop${lay.length === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}`;
  }
  if ((f.flights || []).length <= 1) return 'Nonstop';
  return `${Math.max(0, (f.flights || []).length - 1)} stop${(f.flights || []).length === 2 ? '' : 's'}`;
}

function getToolbarFilters() {
  const sortEl = $('fs-sort');
  const nonstopEl = $('fs-filter-nonstop');
  const maxEl = $('fs-filter-maxprice');
  const sort = sortEl ? String(sortEl.value || 'price') : 'price';
  const nonstopOnly = !!(nonstopEl && nonstopEl.checked);
  const maxRaw = maxEl ? String(maxEl.value || '').trim() : '';
  const maxPrice = maxRaw === '' ? null : Number(maxRaw);
  return {
    sort,
    nonstopOnly,
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null,
  };
}

function applySortFilter(list) {
  let out = list.slice();
  const { sort, nonstopOnly, maxPrice } = getToolbarFilters();
  if (nonstopOnly) out = out.filter(isNonstopOffer);
  if (maxPrice != null) out = out.filter((f) => Number(f.price) <= maxPrice);
  if (sort === 'price') {
    out.sort((a, b) => Number(a.price) - Number(b.price));
  } else if (sort === 'duration') {
    out.sort((a, b) => Number(a.total_duration) - Number(b.total_duration));
  } else if (sort === 'departure') {
    out.sort((a, b) => firstDepartureSortKey(a).localeCompare(firstDepartureSortKey(b)));
  }
  return out;
}

function renderSerpSkeleton(count = 4) {
  const results = $('fs-results');
  if (!results) return;
  results.innerHTML = Array.from({ length: count })
    .map(() => '<div class="fs-sk-card" aria-hidden="true"></div>')
    .join('');
}

function renderSerpFlightCards(flights, bookUrl) {
  const results = $('fs-results');
  if (!results) return;
  const href = bookUrl || lastSerpBookUrl || 'https://www.google.com/travel/flights';
  if (!flights.length) {
    results.innerHTML =
      '<div class="fs-empty" role="status">' +
      '<p>No flights match your filters (or the route returned no results). Try different dates, airports, or clear filters.</p>' +
      '</div>';
    return;
  }
  results.innerHTML = flights
    .map((f) => {
      const legs = f.flights || [];
      const first = legs[0] || {};
      const last = legs[legs.length - 1] || first;
      const logo = escapeHtml(f.airline_logo || first.airline_logo || '');
      const airlines = [...new Set(legs.map((l) => l.airline).filter(Boolean))].join(', ') || '—';
      const nums = legs.map((l) => l.flight_number).filter(Boolean).join(' · ') || '—';
      const depName = (first.departure_airport && first.departure_airport.id) || '';
      const arrName = (last.arrival_airport && last.arrival_airport.id) || '';
      const depT = timeOnly(first.departure_airport && first.departure_airport.time);
      const arrT = timeOnly(last.arrival_airport && last.arrival_airport.time);
      const dur = formatDurationMinutes(f.total_duration);
      const stops = layoverSummary(f);
      const priceNum = Number(f.price);
      const priceStr = Number.isFinite(priceNum)
        ? `MYR ${priceNum.toLocaleString('en-MY', { maximumFractionDigits: 0 })}`
        : '—';
      return (
        `<article class="fs-serp-card">` +
        `<div class="fs-serp-card-main">` +
        `<div class="fs-serp-airline">` +
        (logo
          ? `<img class="fs-serp-logo" src="${logo}" alt="" width="40" height="40" loading="lazy" decoding="async" />`
          : `<div class="fs-serp-logo fs-serp-logo--ph" aria-hidden="true"></div>`) +
        `<div class="fs-serp-airline-text">` +
        `<div class="fs-serp-names">${escapeHtml(airlines)}</div>` +
        `<div class="fs-serp-nums">${escapeHtml(nums)}</div>` +
        `</div></div>` +
        `<div class="fs-serp-route">` +
        `<span class="fs-serp-time"><strong>${escapeHtml(depT)}</strong> → <strong>${escapeHtml(arrT)}</strong></span>` +
        `<span class="fs-serp-ap">${escapeHtml(depName)} → ${escapeHtml(arrName)}</span>` +
        `</div>` +
        `<div class="fs-serp-meta">${escapeHtml(dur)} · ${escapeHtml(stops)}</div>` +
        `</div>` +
        `<div class="fs-serp-side">` +
        `<div class="fs-serp-price">${escapeHtml(priceStr)}</div>` +
        `<a class="fs-book-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Book now</a>` +
        `</div></article>`
      );
    })
    .join('');
}

function rerenderSerpFromCache() {
  const sorted = applySortFilter(serpMerged);
  renderSerpFlightCards(sorted, lastSerpBookUrl);
}

async function onSerpSearch() {
  showFsAlert('');
  const loading = $('fs-loading');
  const form = collectFormIataDatePax();
  const err = validateIataRoute(form);
  if (err) {
    showFsAlert(err);
    return;
  }
  const type = readTripType();
  if (type === '1' && !form.returnDate) {
    showFsAlert('Choose a return date for round trip.');
    return;
  }
  if (type === '1' && !/^\d{4}-\d{2}-\d{2}$/.test(form.returnDate)) {
    showFsAlert('Return date must be a valid calendar date.');
    return;
  }

  if (serpAbort) serpAbort.abort();
  serpAbort = new AbortController();

  if (loading) {
    loading.textContent = 'Searching Google Flights…';
    loading.hidden = false;
    loading.removeAttribute('hidden');
  }
  renderSerpSkeleton(4);

  try {
    const data = await searchFlights(
      form.from,
      form.to,
      form.date,
      form.pax,
      type,
      type === '1' ? form.returnDate : '',
      serpAbort.signal,
    );
    lastSerpBookUrl =
      (data.search_metadata && data.search_metadata.google_flights_url) ||
      lastSerpBookUrl ||
      'https://www.google.com/travel/flights';
    serpMerged = mergeSerpLists(data);
    if (!serpMerged.length && !data.error) {
      const results = $('fs-results');
      if (results) {
        results.innerHTML =
          '<div class="fs-empty" role="status"><p>No flights were returned for this search. Try other dates or airports.</p></div>';
      }
    } else {
      rerenderSerpFromCache();
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    serpMerged = [];
    const results = $('fs-results');
    if (results) {
      results.innerHTML =
        '<div class="fs-empty fs-empty--error" role="alert"><p>' +
        escapeHtml(e.message || 'Failed to fetch flights') +
        '</p></div>';
    }
    showFsAlert('');
  } finally {
    if (loading) {
      loading.hidden = true;
      loading.setAttribute('hidden', '');
      loading.textContent = 'Opening AirAsia…';
    }
  }
}

function onSearchAirAsia() {
  showFsAlert('');
  const form = collectFormIataDatePax();
  const err = validateIataRoute(form);
  if (err) {
    showFsAlert(err);
    return;
  }

  const loading = $('fs-loading');
  const results = $('fs-results');
  if (loading) {
    loading.textContent = 'Opening AirAsia…';
    loading.hidden = false;
    loading.removeAttribute('hidden');
  }
  if (results) results.innerHTML = '';

  const deep = airAsiaSearchUrl(form.from, form.to, form.date, form.pax);

  const win = window.open(deep, '_blank', 'noopener');
  if (loading) {
    loading.hidden = true;
    loading.setAttribute('hidden', '');
  }
  if (!win && results) {
    results.innerHTML =
      '<div class="fs-empty">' +
      '<p>Your browser blocked the new tab. Open AirAsia for live flights + prices:</p>' +
      '<a class="fs-deep-link" href="' +
      escapeHtml(deep) +
      '" target="_blank" rel="noopener noreferrer">Open AirAsia search</a>' +
      '</div>';
    return;
  }

  closeFsModal();
}

function onDetectLocation() {
  showFsAlert('');
  const hint = $('fs-detect-hint');
  const fromEl = $('fs-from');
  if (!navigator.geolocation) {
    showFsAlert('Geolocation is not supported in this browser.');
    return;
  }
  if (hint) {
    hint.textContent = 'Locating…';
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const data = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        const guess = guessFromIataFromNominatim(data);
        if (fromEl) fromEl.value = guess;
        const disp =
          data.display_name ||
          [data.address?.city, data.address?.country].filter(Boolean).join(', ');
        if (hint) {
          hint.textContent = disp ? `Near: ${disp} — set From to ${guess}` : `Set From to ${guess}`;
        }
      } catch (e) {
        if (hint) hint.textContent = '';
        showFsAlert(e.message || 'Reverse geocoding failed.');
      }
    },
    () => {
      if (hint) hint.textContent = '';
      showFsAlert('Could not read your location (permission denied or unavailable).');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
  );
}

function init() {
  renderChips();
  const dateEl = $('fs-date');
  const minD = todayMalaysiaISO();
  if (dateEl) {
    dateEl.min = minD;
    if (!dateEl.value) dateEl.value = minD;
    dateEl.addEventListener('change', syncReturnDateMin);
  }
  syncReturnDateMin();

  document.addEventListener('click', (e) => {
    if (e.target.closest('#itin-flight-search-open, [data-open="fs-modal"]')) {
      e.preventDefault();
      openFsModal();
    }
  });

  const chipsHost = $('fs-chips');
  if (chipsHost) {
    chipsHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.fs-chip');
      if (!btn) return;
      const from = btn.getAttribute('data-from');
      const to = btn.getAttribute('data-to');
      const fe = $('fs-from');
      const te = $('fs-to');
      if (fe && from) fe.value = from;
      if (te && to) te.value = to;
    });
  }

  $('fs-trip-oneway')?.addEventListener('click', () => setTripType('2'));
  $('fs-trip-round')?.addEventListener('click', () => setTripType('1'));
  setTripType('2');

  $('fs-modal-close')?.addEventListener('click', closeFsModal);
  $('fs-modal-backdrop')?.addEventListener('click', closeFsModal);
  $('fs-search')?.addEventListener('click', () => {
    void onSearchAirAsia();
  });
  $('fs-search-serp')?.addEventListener('click', () => {
    void onSerpSearch();
  });
  $('fs-sort')?.addEventListener('change', () => {
    if (serpMerged.length) rerenderSerpFromCache();
  });
  $('fs-filter-nonstop')?.addEventListener('change', () => {
    if (serpMerged.length) rerenderSerpFromCache();
  });
  $('fs-filter-maxprice')?.addEventListener('input', () => {
    if (serpMerged.length) rerenderSerpFromCache();
  });

  $('fs-detect')?.addEventListener('click', () => {
    onDetectLocation();
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const m = $('fs-modal');
      if (m && m.classList.contains('is-open')) {
        e.stopPropagation();
        closeFsModal();
      }
    },
    true,
  );

  window.__prefillFlightModal = function (opts) {
    opts = opts || {};
    const fromEl = $('fs-from');
    const toEl = $('fs-to');
    const dateEl = $('fs-date');
    const paxEl = $('fs-pax');
    const retEl = $('fs-return-date');
    if (fromEl && opts.from) fromEl.value = String(opts.from).toUpperCase().slice(0, 3);
    if (toEl && opts.to) toEl.value = String(opts.to).toUpperCase().slice(0, 3);
    if (dateEl && opts.date) dateEl.value = String(opts.date).slice(0, 10);
    if (paxEl && opts.passengers != null) {
      paxEl.value = String(Math.min(9, Math.max(1, Number(opts.passengers) || 1)));
    }
    if (opts.roundTrip === true || opts.tripType === '1' || opts.tripType === 1) {
      setTripType('1');
      if (retEl && opts.returnDate) retEl.value = String(opts.returnDate).slice(0, 10);
    } else if (opts.roundTrip === false || opts.tripType === '2') {
      setTripType('2');
    }
    syncReturnDateMin();
    openFsModal();
  };
}

init();
