/* Trip Planner UI — standalone from chatbot (viewer.html). */
(function () {
  'use strict';

  const DAY_ORDINALS = [
    'One','Two','Three','Four','Five','Six','Seven',
    'Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen',
  ];

  /** Last-resort image if remote URLs 403 / expire (matches server GENERIC_TRAVEL_IMG). */
  const ITIN_IMG_STATIC_FALLBACK =
    'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&w=400&q=70';

  /** Same hints as event-hub.js — prefill flight “To” from event city / venue. */
  const CITY_HINT_TO_IATA = [
    [/kuala\s*lumpur|kl\b/i, 'KUL'],
    [/penang|george\s*town|pulau\s*pinang/i, 'PEN'],
    [/johor|jb\b|johor\s*bahru/i, 'JHB'],
    [/kota\s*kinabalu|sabah/i, 'BKI'],
    [/kuching|sarawak/i, 'KCH'],
    [/langkawi/i, 'LGK'],
    [/melaka|malacca/i, 'MKZ'],
    [/ipoh/i, 'IPH'],
    [/kota\s*bharu|kelantan/i, 'KBR'],
    [/terengganu|kuala\s*terengganu/i, 'TGG'],
    [/miri/i, 'MYY'],
    [/singapore/i, 'SIN'],
  ];

  function guessDestIata(city, venue) {
    const blob = `${city || ''} ${venue || ''}`;
    for (let i = 0; i < CITY_HINT_TO_IATA.length; i++) {
      if (CITY_HINT_TO_IATA[i][0].test(blob)) return CITY_HINT_TO_IATA[i][1];
    }
    return 'KUL';
  }

  let selectedEvent = null;
  /** Full API envelope (multi-variant trips). */
  let tripEnvelope = null;
  let chosenVariantIdx = 0;
  /** Once false, picker hidden and plan detail visible */
  let planDetailVisible = false;
  let lastPayload = null;
  let lastAcEvents = [];
  let tripWeatherByDate = {};
  let tripWeatherCurrent = null;
  let tripWeatherLocale = '';
  let tripWeatherNote = '';
  let lastWeatherScopeKey = '';
  let activeTripDayIdx = 0;
  let tripWeatherLoadSeq = 0;
  let acTimer = null;
  let itineraryGenerating = false;
  let itinReadyToastTimer = null;
  let plannerSelectedFlight = null;
  let plannerSelectedHotel = null;
  let plannerItineraryVibes = [];
  let plannerItineraryPace = null;
  let lastPlannerFlightRows = [];
  let plannerFlightSearchSerial = 0;
  let plannerPreflightTimer = null;
  let lastPreflightSearchKey = '';

  /** Stashed planner UI when opening History — restored by Back. */
  let stashBeforeHistory = null;
  let itinHistoryVisible = false;

  function $(id) {
    return document.getElementById(id);
  }

  function scrollMotionBehavior() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return 'auto';
      }
    } catch (e) {
      /* ignore */
    }
    return 'smooth';
  }

  function scrollItinModalMainToTop() {
    const modal = $('itin-modal');
    if (!modal) return;
    const sc = modal.querySelector('.itin-modal-scroll');
    if (sc && typeof sc.scrollTo === 'function') {
      sc.scrollTo({ top: 0, behavior: scrollMotionBehavior() });
    }
  }

  function updateItinModalScrollHint() {
    const modal = $('itin-modal');
    if (!modal || !modal.classList.contains('itin-modal--trip-view')) return;
    const sc = modal.querySelector('.itin-modal-scroll');
    const hint = $('itin-modal-scroll-hint');
    if (!sc || !hint) return;
    const canScroll = sc.scrollHeight > sc.clientHeight + 8;
    const nearBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 28;
    hint.classList.toggle('is-dismissed', !canScroll || nearBottom || sc.scrollTop > 20);
  }

  function getActiveVariant() {
    if (
      !tripEnvelope ||
      !Array.isArray(tripEnvelope.variants) ||
      !tripEnvelope.variants[chosenVariantIdx]
    )
      return null;
    return tripEnvelope.variants[chosenVariantIdx];
  }

  /** Legacy API responses may include 3 variants — keep exactly one for display. */
  function pickSingleVariantList(raw) {
    const vs = Array.isArray(raw && raw.variants) ? raw.variants : [];
    if (vs.length <= 1) return vs;
    const vibeList = Array.isArray(raw.itineraryVibes)
      ? raw.itineraryVibes.map(function (x) {
          return String(x).trim().toLowerCase();
        })
      : [];
    const vibeSingle = String(raw.itineraryVibe || '')
      .trim()
      .toLowerCase();
    if (vibeSingle && !vibeList.length) vibeList.push(vibeSingle);
    if (vibeList.length) {
      const match = vs.find(function (v) {
        const k = String(v.key || '').trim().toLowerCase();
        return vibeList.some(function (id) {
          return k === id || k.includes(id);
        });
      });
      if (match) return [match];
    }
    return [vs[0]];
  }

  function normalizeTripEnvelope(raw) {
    if (raw && raw.schemaVersion === 2 && Array.isArray(raw.variants) && raw.variants.length) {
      const singleVariants = pickSingleVariantList(raw);
      const active = singleVariants[0] || raw.variants[0];
      return Object.assign({}, raw, {
        variants: singleVariants,
        warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
        selectedFlight: raw.selectedFlight != null ? raw.selectedFlight : null,
        selectedHotel: raw.selectedHotel != null ? raw.selectedHotel : null,
        guideSummary: active && active.guideSummary != null ? active.guideSummary : raw.guideSummary,
        days: active && active.days ? active.days : raw.days,
        places: active && active.places ? active.places : raw.places,
      });
    }
    return {
      schemaVersion: 2,
      event: raw.event,
      city: raw.city,
      warnings: raw.warnings || [],
      selectedFlight: raw.selectedFlight != null ? raw.selectedFlight : null,
      selectedHotel: raw.selectedHotel != null ? raw.selectedHotel : null,
      variants: [
        {
          key: 'classic',
          title: 'Your itinerary',
          tagline: 'Generated route',
          guideSummary: raw.guideSummary || '',
          warnings: [],
          days: raw.days || [],
          places: raw.places || [],
          travelLinks: raw.travelLinks || {},
        },
      ],
    };
  }

  function mergeEnvelopeWarnings(extra) {
    const top = (tripEnvelope && tripEnvelope.warnings) || [];
    const v = Array.isArray(extra) ? extra : [];
    return top.concat(v);
  }

  /**
   * Place overlay expects `lastPayload.event`, `places`, `city`.
   */
  function syncOverlayPayload(active) {
    if (!tripEnvelope || !active) {
      lastPayload = null;
      return;
    }
    lastPayload = {
      event: tripEnvelope.event,
      city: tripEnvelope.city,
      places: active.places || [],
    };
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toIsoDate(d) {
    if (!d) return '';
    const s = String(d).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toISOString().slice(0, 10);
  }

  function addDaysIso(iso, delta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  function suggestHotelQueryFromEvent(ev, cityFallback) {
    if (!ev || typeof ev !== 'object') {
      const fb = String(cityFallback || '').trim() || 'Kuala Lumpur';
      return fb.indexOf('Malaysia') >= 0 ? fb : fb + ', Malaysia';
    }
    const city = String(ev.city || cityFallback || '').trim() || 'Kuala Lumpur';
    return city.indexOf('Malaysia') >= 0 ? city : city + ', Malaysia';
  }

  function tripInclusiveDays(startIso, endIso) {
    if (!startIso || !endIso || endIso < startIso) return 0;
    const a = new Date(startIso + 'T12:00:00Z');
    const b = new Date(endIso + 'T12:00:00Z');
    return Math.round((b - a) / 86400000) + 1;
  }

  function todayMalaysiaISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
  }

  function formatOneDateLine(iso) {
    const s = String(iso || '').slice(0, 10);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(iso);
    if (Number.isNaN(d.getTime())) return s || '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatSideDates(dep, ret) {
    const a = String(dep || '').slice(0, 10);
    const b = String(ret || '').slice(0, 10);
    if (!a && !b) return '—';
    if (a && !b) return formatOneDateLine(a);
    if (!a && b) return formatOneDateLine(b);
    if (a === b) return formatOneDateLine(a);
    return formatOneDateLine(a) + ' – ' + formatOneDateLine(b);
  }

  function setTripTab() {
    const panel = $('itin-panel-trip-itin');
    if (panel) {
      panel.hidden = false;
      panel.removeAttribute('hidden');
    }
    scrollItinModalMainToTop();
    requestAnimationFrame(updateItinModalScrollHint);
  }

  function populateTripHero(act) {
    const ev = (tripEnvelope && tripEnvelope.event) || {};
    const city = String(ev.city || tripEnvelope.city || '').trim();
    const venue = String(ev.venue || '').trim();
    const cat = String(ev.category || '').trim();
    const title = String(ev.title || (act && act.title) || 'Your trip').trim();
    const eventD = toIsoDate(ev.date);
    const eyebrow = (cat ? cat.toUpperCase() + ' · ' : '') + (city ? city.toUpperCase() : 'YOUR TRIP');
    const metaParts = [];
    if (venue) metaParts.push(venue);
    if (city && venue.toLowerCase().indexOf(city.toLowerCase()) === -1) metaParts.push(city);
    if (eventD) metaParts.push(eventD);
    const eb = $('itin-trip-eyebrow');
    if (eb) eb.textContent = eyebrow || 'YOUR TRIP';
    const ti = $('itin-trip-title');
    if (ti) ti.textContent = title;
    const me = $('itin-trip-meta');
    if (me) me.textContent = metaParts.join(' · ') || '';
    const blurb = $('itin-trip-blurb');
    if (blurb) {
      const gs = (act && act.guideSummary) || '';
      blurb.textContent = gs;
      if (gs) {
        blurb.hidden = false;
        blurb.removeAttribute('hidden');
      } else {
        blurb.hidden = true;
        blurb.setAttribute('hidden', '');
      }
    }
    const book = $('itin-trip-book');
    const ticketUrl = String(ev.url || '').trim();
    if (book) {
      if (ticketUrl) {
        book.href = ticketUrl;
        book.setAttribute('data-track-book', '1');
        book.setAttribute('data-event-id', ticketUrl);
        book.setAttribute('data-event-name', String(ev.title || ''));
        if (ev.city) book.setAttribute('data-event-city', String(ev.city));
        else book.removeAttribute('data-event-city');
        book.hidden = false;
        book.removeAttribute('hidden');
      } else {
        book.hidden = true;
        book.setAttribute('hidden', '');
      }
    }
    const ph = $('itin-trip-price-hint');
    if (ph) {
      const priceStr = String(ev.price || '').trim();
      if (priceStr) {
        ph.textContent = priceStr;
        ph.hidden = false;
        ph.removeAttribute('hidden');
      } else if (ev.is_free) {
        ph.textContent = 'Free event';
        ph.hidden = false;
        ph.removeAttribute('hidden');
      } else {
        ph.hidden = true;
        ph.setAttribute('hidden', '');
      }
    }
    const sc = $('itin-weather-locale');
    if (sc) {
      const parts = [];
      if (city) parts.push(city);
      if (venue && (!city || venue.toLowerCase().indexOf(city.toLowerCase()) === -1)) parts.push(venue);
      sc.textContent = parts.length ? parts.join(' · ') : '—';
    }
  }

  function tripWeatherFootHtml(note) {
    const base =
      'Open‑Meteo (free, no API key) — daily forecast per trip day; live wind from <code>current_weather</code> when shown.';
    const n = String(note || '').trim();
    return n ? base + ' ' + escapeHtml(n) : base;
  }

  function cityKeyForWeather(city) {
    return String(city || '')
      .trim()
      .toLowerCase()
      .replace(/,/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\bmalaysia\b/g, '')
      .trim();
  }

  function weatherScopeKey(city, range) {
    const ck = cityKeyForWeather(city);
    const start = range && range.start ? String(range.start).slice(0, 10) : '';
    const end = range && range.end ? String(range.end).slice(0, 10) : '';
    return ck + '|' + start + '|' + end;
  }

  function resetTripWeatherUiLoading() {
    if ($('itin-weather-temp')) $('itin-weather-temp').textContent = '…';
    if ($('itin-weather-cond')) $('itin-weather-cond').textContent = 'Loading';
    const grid = $('itin-weather-grid');
    if (grid) {
      grid.hidden = true;
      grid.setAttribute('hidden', '');
    }
    document.querySelectorAll('.itin-tl-day-wx').forEach(function (el) {
      el.textContent = 'Loading…';
      el.classList.remove('is-unavailable');
    });
  }

  function enumerateTripDatesClient(startIso, endIso) {
    const a = String(startIso || '').slice(0, 10);
    const b = String(endIso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b) || b < a) return [];
    const out = [];
    const cur = new Date(a + 'T12:00:00Z');
    const end = new Date(b + 'T12:00:00Z');
    for (let t = cur.getTime(); t <= end.getTime(); t += 86400000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  function getTripCityForWeather() {
    const ev = (tripEnvelope && tripEnvelope.event) || {};
    const evCity = ev && ev.city ? String(ev.city).trim() : '';
    const pickCity = selectedEvent && selectedEvent.city ? String(selectedEvent.city).trim() : '';
    const envCity = tripEnvelope && tripEnvelope.city ? String(tripEnvelope.city).trim() : '';
    // Event / picker city wins — envelope.city can lag after switching events or history rows.
    return String(evCity || pickCity || envCity || (ev && ev.venue) || '').trim();
  }

  function getTripDateRangeFromDays(days) {
    const isos = (Array.isArray(days) ? days : [])
      .map(function (d) {
        return String((d && d.date) || '').slice(0, 10);
      })
      .filter(function (x) {
        return /^\d{4}-\d{2}-\d{2}$/.test(x);
      })
      .sort();
    if (isos.length) {
      return { start: isos[0], end: isos[isos.length - 1] };
    }
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dep) && /^\d{4}-\d{2}-\d{2}$/.test(ret) && ret >= dep) {
      return { start: dep, end: ret };
    }
    return null;
  }

  function weatherTempLabel(wx) {
    if (!wx || wx.unavailable) return '';
    if (wx.tempDisplay) return String(wx.tempDisplay);
    if (wx.tempMax != null && Number.isFinite(Number(wx.tempMax))) {
      return Math.round(Number(wx.tempMax)) + '\u00B0C';
    }
    if (wx.temperature != null && Number.isFinite(Number(wx.temperature))) {
      return Math.round(Number(wx.temperature)) + '\u00B0C';
    }
    return '';
  }

  function weatherWindKmh(wx) {
    if (!wx) return tripWeatherCurrent && tripWeatherCurrent.windKmh != null ? tripWeatherCurrent.windKmh : null;
    if (wx.windKmh != null && Number.isFinite(Number(wx.windKmh))) return Math.round(Number(wx.windKmh));
    if (wx.windspeed != null && Number.isFinite(Number(wx.windspeed))) return Math.round(Number(wx.windspeed));
    return tripWeatherCurrent && tripWeatherCurrent.windKmh != null ? tripWeatherCurrent.windKmh : null;
  }

  function formatDayWeatherChipHtml(wx) {
    if (!wx || wx.unavailable) {
      return escapeHtml(wx && wx.chip ? wx.chip : 'Forecast unavailable');
    }
    const temp = weatherTempLabel(wx);
    const cond = String(wx.condition || '').trim();
    const rain =
      wx.rainPct != null && Number.isFinite(Number(wx.rainPct))
        ? Math.round(Number(wx.rainPct)) + '% rain'
        : '';
    let html = '';
    if (temp) {
      html += '<span class="itin-tl-day-wx-temp">' + escapeHtml(temp) + '</span>';
    }
    if (cond) {
      html += (html ? ' \u00b7 ' : '') + escapeHtml(cond);
    }
    if (rain) {
      html += ' \u00b7 ' + escapeHtml(rain);
    }
    return html || escapeHtml(wx.chip || '—');
  }

  function mergeTripWeatherFromResponse(data, range) {
    const byDate = {};
    const span = enumerateTripDatesClient(range.start, range.end);
    const fromMap = data && data.byDate && typeof data.byDate === 'object' ? data.byDate : {};
    const list = Array.isArray(data && data.days) ? data.days : [];
    const listByDate = {};
    list.forEach(function (d) {
      const k = d && String(d.date || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) listByDate[k] = d;
    });
    span.forEach(function (iso, i) {
      // Prefer server rows keyed to each requested trip date (not a single reused snapshot).
      let entry = listByDate[iso] || fromMap[iso] || null;
      if ((!entry || entry.unavailable) && list[i]) {
        const rowDate = String(list[i].date || '').slice(0, 10);
        if (!rowDate || rowDate === iso) entry = list[i];
      }
      byDate[iso] = entry
        ? Object.assign({}, entry, { date: iso })
        : {
            date: iso,
            tempMax: null,
            tempDisplay: '',
            condition: '',
            headline: 'Forecast unavailable',
            chip: 'Forecast unavailable',
            unavailable: true,
          };
    });
    return byDate;
  }

  function resolveDayIso(day, dayIdx, range) {
    if (range) {
      const span = enumerateTripDatesClient(range.start, range.end);
      if (span.length && dayIdx >= 0 && dayIdx < span.length) return span[dayIdx];
    }
    const fromDay = String((day && day.date) || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) return fromDay;
    return '';
  }

  function updateSidebarWeatherForDate(dateIso) {
    const headline = $('itin-weather-headline');
    const tempEl = $('itin-weather-temp');
    const condEl = $('itin-weather-cond');
    const grid = $('itin-weather-grid');
    const rainEl = $('itin-wx-rain');
    const humEl = $('itin-wx-hum');
    const windEl = $('itin-wx-wind');
    const loc = $('itin-weather-locale');
    const footEl = $('itin-weather-foot');
    if (!headline && !tempEl) return;
    const iso = String(dateIso || '').slice(0, 10);
    const wx = iso && tripWeatherByDate[iso] ? tripWeatherByDate[iso] : null;
    if (loc) {
      const parts = [];
      if (tripWeatherLocale) parts.push(tripWeatherLocale);
      if (iso) parts.push(iso);
      loc.textContent = parts.join(' · ') || '—';
    }
    if (footEl) footEl.innerHTML = tripWeatherFootHtml(tripWeatherNote);
    if (!wx || wx.unavailable) {
      if (tempEl) tempEl.textContent = '—';
      if (condEl) condEl.textContent = wx && wx.headline ? wx.headline : 'Unavailable';
      if (grid) {
        grid.hidden = true;
        grid.setAttribute('hidden', '');
      }
      return;
    }
    const temp = weatherTempLabel(wx);
    const cond = String(wx.condition || '').trim();
    if (tempEl) tempEl.textContent = temp || '—';
    if (condEl) condEl.textContent = cond ? '\u00b7 ' + cond : '';
    if (rainEl) rainEl.textContent = wx.rainPct != null ? wx.rainPct + '%' : '—';
    if (humEl) humEl.textContent = wx.humidity != null ? wx.humidity + '%' : '—';
    const windVal = weatherWindKmh(wx);
    if (windEl) windEl.textContent = windVal != null ? windVal + ' km/h' : '—';
    if (grid) {
      grid.hidden = false;
      grid.removeAttribute('hidden');
    }
  }

  function applyWeatherToDayHeaders(days, range) {
    (Array.isArray(days) ? days : []).forEach(function (day, idx) {
      const iso = resolveDayIso(day, idx, range);
      const el =
        document.querySelector('.itin-tl-day-wx[data-wx-day-idx="' + idx + '"]') ||
        (iso ? document.querySelector('.itin-tl-day-wx[data-wx-date="' + iso + '"]') : null);
      if (!el) return;
      const wx = iso && tripWeatherByDate[iso] ? tripWeatherByDate[iso] : null;
      el.innerHTML = formatDayWeatherChipHtml(wx);
      el.classList.toggle('is-unavailable', !!(wx && wx.unavailable));
    });
  }

  async function loadTripWeatherForDays(days) {
    const headline = $('itin-weather-headline');
    if (!headline) return;
    const city = getTripCityForWeather();
    const range = getTripDateRangeFromDays(days);
    if (!city || !range) {
      tripWeatherByDate = {};
      tripWeatherCurrent = null;
      lastWeatherScopeKey = '';
      if ($('itin-weather-temp')) $('itin-weather-temp').textContent = '—';
      if ($('itin-weather-cond')) $('itin-weather-cond').textContent = 'Set trip dates';
      return;
    }
    const scopeKey = weatherScopeKey(city, range);
    if (scopeKey !== lastWeatherScopeKey) {
      tripWeatherByDate = {};
      tripWeatherCurrent = null;
      tripWeatherLocale = '';
      tripWeatherNote = '';
    }
    const seq = ++tripWeatherLoadSeq;
    resetTripWeatherUiLoading();
    try {
      const url =
        '/api/trip-weather?city=' +
        encodeURIComponent(city) +
        '&start=' +
        encodeURIComponent(range.start) +
        '&end=' +
        encodeURIComponent(range.end) +
        '&_=' +
        encodeURIComponent(String(Date.now()));
      const res = await fetch(url, { credentials: 'same-origin' });
      const data = await res.json().catch(function () {
        return {};
      });
      if (seq !== tripWeatherLoadSeq) return;
      if (!res.ok) {
        tripWeatherByDate = {};
        tripWeatherCurrent = null;
        lastWeatherScopeKey = '';
        if ($('itin-weather-temp')) $('itin-weather-temp').textContent = '—';
        if ($('itin-weather-cond')) {
          let errText = data.error || 'Forecast unavailable';
          errText = String(errText).replace(/^Request failed with status code \d+\s*/i, '').trim();
          $('itin-weather-cond').textContent = errText || 'Forecast unavailable';
        }
        applyWeatherToDayHeaders(days, range);
        return;
      }
      tripWeatherByDate = mergeTripWeatherFromResponse(data, range);
      tripWeatherCurrent = data.current && typeof data.current === 'object' ? data.current : null;
      tripWeatherLocale = String(data.locale || '').trim();
      tripWeatherNote = String(data.note || '').trim();
      lastWeatherScopeKey = scopeKey;
      const loc = $('itin-weather-locale');
      if (loc && tripWeatherLocale) loc.textContent = tripWeatherLocale;
      applyWeatherToDayHeaders(days, range);
      activateTripDay(Math.min(Math.max(0, activeTripDayIdx), Math.max(0, days.length - 1)));
    } catch (e) {
      if (seq !== tripWeatherLoadSeq) return;
      tripWeatherByDate = {};
      tripWeatherCurrent = null;
      lastWeatherScopeKey = '';
      if ($('itin-weather-temp')) $('itin-weather-temp').textContent = '—';
      if ($('itin-weather-cond')) $('itin-weather-cond').textContent = 'Weather offline';
      applyWeatherToDayHeaders(days, range);
    }
  }

  function refreshTripWeather() {
    const act = getActiveVariant();
    if (act && Array.isArray(act.days) && act.days.length) {
      void loadTripWeatherForDays(act.days);
      return;
    }
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dep) && /^\d{4}-\d{2}-\d{2}$/.test(ret)) {
      void loadTripWeatherForDays([{ date: dep }, { date: ret }]);
    }
  }

  function updateTripFlightPanel() {
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    const tf = $('itin-trip-from');
    const tt = $('itin-trip-to');
    const ev = tripEnvelope && tripEnvelope.event;
    const home =
      typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
    if (tf && !String(tf.value || '').trim()) tf.value = home;
    if (tt && !String(tt.value || '').trim() && ev) {
      const origin = String((tf && tf.value) || home)
        .trim()
        .toUpperCase()
        .slice(0, 3);
      let g = guessDestIata(ev.city, ev.venue);
      if (!g || g === origin) g = '';
      tt.value = g;
    }
    const from = String((tf && tf.value) || '')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const to = String((tt && tt.value) || '')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const line = $('itin-eh-route-line');
    if (line) {
      if (dep) {
        line.textContent = 'Outbound flight date: ' + dep;
      } else {
        line.textContent = 'Set trip dates (Edit trip → planner form) or open an event from listings.';
      }
    }
    const datesEl = $('itin-eh-route-dates');
    if (datesEl) {
      datesEl.textContent =
        dep && ret ? 'Arrive ' + dep + ' · Depart ' + ret : '—';
    }
  }

  function formatFlightRm(price) {
    const n = Number(price);
    if (n !== n) return '—';
    return 'RM ' + n.toLocaleString('en-MY', { maximumFractionDigits: 0 });
  }

  function scrollToGenerateButton() {
    const btn = $('itin-generate');
    if (btn && btn.scrollIntoView) {
      btn.scrollIntoView({ behavior: scrollMotionBehavior(), block: 'nearest' });
    }
  }

  function updateGenerateButtonState() {
    const btn = $('itin-generate');
    if (!btn) return;
    const formSec = $('itin-form-section');
    if (formSec && formSec.hidden) {
      btn.disabled = false;
      btn.removeAttribute('title');
      btn.textContent = 'Generate My Itinerary 🚀';
      btn.classList.remove('itin-primary--disabled');
      return;
    }
    const ok = !!plannerSelectedFlight;
    btn.disabled = !ok;
    btn.title = ok
      ? ''
      : 'Please select a flight first so we can plan around your travel times';
    btn.textContent = ok ? 'Generate My Itinerary 🚀' : 'Select a flight first ✈️';
    btn.classList.toggle('itin-primary--disabled', !ok);
  }

  function updateSelectedFlightCard() {
    const card = $('itin-selected-flight-card');
    if (!card) return;
    const sf = plannerSelectedFlight;
    if (!sf || typeof sf !== 'object') {
      card.hidden = true;
      card.setAttribute('hidden', '');
      card.innerHTML = '';
      return;
    }
    const depName = (sf.departure && (sf.departure.name || sf.departure.id)) || '—';
    const arrName = (sf.arrival && (sf.arrival.name || sf.arrival.id)) || '—';
    const depT = (sf.departure && sf.departure.time) || '—';
    const line1 =
      'Your flight: ' +
      escapeHtml(String(sf.airline || '').trim()) +
      ' ' +
      escapeHtml(String(sf.flightNumber || '').trim());
    const line2 = escapeHtml(depName) + ' → ' + escapeHtml(arrName);
    const line3 =
      'Departs: ' +
      escapeHtml(String(depT).slice(0, 24)) +
      ' · Price: ' +
      escapeHtml(formatFlightRm(sf.price));
    card.innerHTML =
      '<button type="button" class="itin-sf-remove" data-itin-clear-flight="1" aria-label="Remove flight">&times;</button>' +
      '<div class="itin-sf-body">' +
      '<span class="itin-sf-k">Selected outbound</span>' +
      '<p class="itin-sf-line">' +
      line1 +
      '</p>' +
      '<p class="itin-sf-line">' +
      line2 +
      '</p>' +
      '<p class="itin-sf-meta">' +
      line3 +
      '</p></div>';
    card.hidden = false;
    card.removeAttribute('hidden');
  }

  function clearSelectedPlannerFlight() {
    plannerSelectedFlight = null;
    updateSelectedFlightCard();
    updateGenerateButtonState();
  }

  function serializeSerpFlightForApi(f) {
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
      price: f.price,
      stops: stops,
    };
  }

  function formatDurationSerp(min) {
    const m = Math.round(Number(min) || 0);
    if (m <= 0) return '—';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h <= 0) return r + 'm';
    return r ? h + 'h ' + r + 'm' : h + 'h';
  }

  function timeOnlySerp(isoLike) {
    const s = String(isoLike || '').trim();
    const m = /\d{2}:\d{2}/.exec(s);
    return m ? m[0] : '—';
  }

  function layoverSummarySerp(f) {
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
    var n = Math.max(0, legs.length - 1);
    return n + ' stop' + (n === 1 ? '' : 's');
  }

  function renderPlannerFormFlightRows(rows, bookUrl) {
    const H = window.__serpFlightsHelpers;
    const esc = H && H.escapeHtml ? H.escapeHtml : escapeHtml;
    const href = esc(bookUrl || 'https://www.google.com/travel/flights');
    return rows
      .map(function (f, idx) {
        const legs = f.flights || [];
        const first = legs[0] || {};
        const last = legs[legs.length - 1] || first;
        const logo = esc(f.airline_logo || first.airline_logo || '');
        const airlines =
          legs
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
        const depT = timeOnlySerp(first.departure_airport && first.departure_airport.time);
        const arrT = timeOnlySerp(last.arrival_airport && last.arrival_airport.time);
        const dur = formatDurationSerp(f.total_duration);
        const stops = layoverSummarySerp(f);
        const priceStr = formatFlightRm(f.price);
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
          esc(airlines) +
          '</strong></div>' +
          '<span class="eh-flight-sub">' +
          esc(nums) +
          '</span>' +
          '<span class="eh-flight-sub"><strong>' +
          esc(depT) +
          '</strong> → <strong>' +
          esc(arrT) +
          '</strong> · ' +
          esc(depName) +
          ' → ' +
          esc(arrName) +
          '</span>' +
          '<span class="eh-flight-sub">' +
          esc(dur) +
          ' · ' +
          esc(stops) +
          '</span>' +
          '</div></div>' +
          '<div class="eh-flight-meta">' +
          '<span class="eh-price">' +
          esc(priceStr) +
          '</span>' +
          '<button type="button" class="eh-btn eh-btn--gold itin-add-flight-btn" data-itin-add-flight="' +
          idx +
          '">Add to my itinerary</button>' +
          '<a class="eh-btn eh-btn--ghost eh-serp-book" href="' +
          href +
          '" target="_blank" rel="noopener noreferrer">Book</a>' +
          '</div></li>'
        );
      })
      .join('');
  }

  function renderTripFlightBannerFromEnvelope() {
    const ban = $('itin-trip-flight-banner');
    if (!ban) return;
    const sf = tripEnvelope && tripEnvelope.selectedFlight;
    if (!sf || typeof sf !== 'object') {
      ban.hidden = true;
      ban.setAttribute('hidden', '');
      ban.innerHTML = '';
      return;
    }
    const ob = sf.outbound;
    const ret = sf.returnFlight;
    const isSplit =
      sf.tripType === 'round_trip_split' && ob && typeof ob === 'object' && ret && typeof ret === 'object';
    let body = '<div class="itin-sf-body">';
    if (isSplit) {
      function legLine(leg, label) {
        const depName = (leg.departure && (leg.departure.name || leg.departure.id)) || '—';
        const arrName = (leg.arrival && (leg.arrival.name || leg.arrival.id)) || '—';
        const depT = (leg.departure && leg.departure.time) || '—';
        return (
          '<p class="itin-sf-line"><strong>' +
          escapeHtml(label) +
          '</strong> · ' +
          escapeHtml(String(leg.airline || '').trim() + ' ' + String(leg.flightNumber || '').trim()) +
          '<br />' +
          escapeHtml(depName) +
          ' → ' +
          escapeHtml(arrName) +
          ' · Departs ' +
          escapeHtml(String(depT).slice(0, 24)) +
          ' · ' +
          escapeHtml(formatFlightRm(leg.price)) +
          '</p>'
        );
      }
      body +=
        '<span class="itin-sf-k">Your flights</span>' +
        legLine(ob, 'Outbound') +
        legLine(ret, 'Return') +
        '<p class="itin-sf-meta">Estimated total: ' +
        escapeHtml(formatFlightRm(sf.price)) +
        '</p>';
    } else {
      const depName = (sf.departure && (sf.departure.name || sf.departure.id)) || '—';
      const arrName = (sf.arrival && (sf.arrival.name || sf.arrival.id)) || '—';
      const depT = (sf.departure && sf.departure.time) || '—';
      body +=
        '<span class="itin-sf-k">Your flight</span>' +
        '<p class="itin-sf-line">' +
        escapeHtml(String(sf.airline || '').trim() + ' ' + String(sf.flightNumber || '').trim()) +
        '</p>' +
        '<p class="itin-sf-line">' +
        escapeHtml(depName) +
        ' → ' +
        escapeHtml(arrName) +
        '</p>' +
        '<p class="itin-sf-meta">Departs: ' +
        escapeHtml(String(depT).slice(0, 24)) +
        ' · Price: ' +
        escapeHtml(formatFlightRm(sf.price)) +
        '</p>';
    }
    body += '</div>';
    ban.innerHTML = body;
    ban.hidden = false;
    ban.removeAttribute('hidden');
  }

  function plannerPreflightBaseValid() {
    if (!selectedEvent) return false;
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    const today = todayMalaysiaISO();
    if (!dep || !ret || dep < today || ret < today || ret < dep) return false;
    if (tripInclusiveDays(dep, ret) > 14) return false;
    const evIso = toIsoDate(selectedEvent.date);
    if (evIso && (evIso < dep || evIso > ret)) return false;
    return true;
  }

  async function searchPlannerFormFlights() {
    const host = $('itin-form-flights-host');
    const H = window.__serpFlightsHelpers;
    if (!host || !H) return;
    const serial = ++plannerFlightSearchSerial;
    const home =
      typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
    const dest = guessDestIata(selectedEvent.city, selectedEvent.venue);
    const date = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    if (!/^[A-Z]{3}$/.test(home) || !/^[A-Z]{3}$/.test(dest) || home === dest || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      host.innerHTML = '<p class="eh-muted">Set dates and pick an event so we can infer airports.</p>';
      return;
    }
    clearSelectedPlannerFlight();
    lastPlannerFlightRows = [];
    host.innerHTML = '<p class="eh-loading">Searching Google Flights…</p>';
    try {
      const data = await H.fetchSerpFlights(
        { from: home, to: dest, date: date, passengers: 1, type: '2' },
        undefined,
      );
      if (serial !== plannerFlightSearchSerial) return;
      const rows = H.mergeSerpLists(data);
      const book = H.bookUrlFromResponse(data);
      lastPlannerFlightRows = rows;
      if (!rows.length) {
        host.innerHTML =
          '<p class="eh-muted">No flights returned for this route and date. Try other dates.</p>';
        return;
      }
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        renderPlannerFormFlightRows(rows, book) +
        '</ul>' +
        '<p class="eh-footnote">Results from Google Flights (SerpAPI). Confirm times and prices before booking.</p>';
    } catch (e) {
      if (serial !== plannerFlightSearchSerial) return;
      host.innerHTML = '<p class="eh-muted">' + escapeHtml(e.message || 'Flight search failed') + '</p>';
    }
  }

  function schedulePlannerPreflightSearch() {
    if (plannerPreflightTimer) clearTimeout(plannerPreflightTimer);
    plannerPreflightTimer = setTimeout(function () {
      plannerPreflightTimer = null;
      void searchPlannerFormFlights();
    }, 280);
  }

  function refreshPlannerPreflightVisibility() {
    const formSec = $('itin-form-section');
    if (formSec && formSec.hidden) return;
    const wrap = $('itin-preflight-block');
    const host = $('itin-form-flights-host');
    if (!wrap || !host) return;
    if (!plannerPreflightBaseValid()) {
      wrap.hidden = true;
      wrap.setAttribute('hidden', '');
      host.innerHTML = '';
      lastPlannerFlightRows = [];
      plannerFlightSearchSerial += 1;
      lastPreflightSearchKey = '';
      clearSelectedPlannerFlight();
      return;
    }
    const home =
      typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
    const dest = guessDestIata(selectedEvent.city, selectedEvent.venue);
    const date = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const evId = selectedEvent && selectedEvent.id != null ? String(selectedEvent.id) : '';
    const key = [home, dest, date, evId].join('|');
    wrap.hidden = false;
    wrap.removeAttribute('hidden');
    if (key !== lastPreflightSearchKey) {
      lastPreflightSearchKey = key;
      clearSelectedPlannerFlight();
      schedulePlannerPreflightSearch();
    }
  }

  function onPlannerFormFlightAdd(idx) {
    const rows = lastPlannerFlightRows;
    const f = rows && rows[idx];
    if (!f) return;
    plannerSelectedFlight = serializeSerpFlightForApi(f);
    if (typeof window.__logFlightSelection === 'function') {
      const ev = selectedEvent || (tripEnvelope && tripEnvelope.event);
      const depIso = ($('itin-date-depart') && $('itin-date-depart').value) || '';
      const ser = serializeSerpFlightForApi(f);
      window.__logFlightSelection({
        eventId: ev && (ev.id || ev.url) ? String(ev.id || ev.url) : '',
        originAirport: (ser.departure && ser.departure.id) || '',
        destinationCity: (ser.arrival && ser.arrival.id) || guessDestIata(ev && ev.city, ev && ev.venue),
        flightDate: depIso,
      });
    }
    updateSelectedFlightCard();
    updateGenerateButtonState();
    showAlert('Flight added! Now generate your itinerary ✈️');
    setTimeout(function () {
      clearAlert();
    }, 4200);
    scrollToGenerateButton();
  }

  function renderTripTips(days) {
    const tips = [];
    (Array.isArray(days) ? days : []).forEach(function (day) {
      (Array.isArray(day.tips) ? day.tips : []).forEach(function (t) {
        if (tips.length >= 6) return;
        const s = String(t || '').trim();
        if (s) tips.push(s);
      });
    });
    const ul = $('itin-side-tips');
    const card = $('itin-side-tips-card');
    if (!ul || !card) return;
    if (!tips.length) {
      ul.innerHTML = '';
      card.hidden = true;
      card.setAttribute('hidden', '');
      return;
    }
    ul.innerHTML = tips.map(function (t) {
      return '<li>' + escapeHtml(t) + '</li>';
    }).join('');
    card.hidden = false;
    card.removeAttribute('hidden');
  }

  function activateTripDay(di) {
    activeTripDayIdx = di;
    document.querySelectorAll('.itin-day-pill').forEach(function (p) {
      const j = parseInt(p.getAttribute('data-go-day'), 10);
      p.classList.toggle('itin-day-pill--active', j === di);
    });
    document.querySelectorAll('.itin-tl-day').forEach(function (sec) {
      const j = parseInt(sec.getAttribute('data-tl-day'), 10);
      sec.classList.toggle('is-active', j === di);
    });
    const act = getActiveVariant();
    const dayList = act && Array.isArray(act.days) ? act.days : [];
    const day = dayList[di];
    const range = getTripDateRangeFromDays(dayList);
    const iso = day ? resolveDayIso(day, di, range) : '';
    if (iso) updateSidebarWeatherForDate(iso);
  }

  async function searchTripGoogleFlights() {
    const host = $('itin-trip-flights-inline');
    const H = window.__serpFlightsHelpers;
    if (!host) return;
    if (!H) {
      host.innerHTML =
        '<p class="eh-muted">Flight search script failed to load. Refresh the page and try again.</p>';
      return;
    }
    const from = String($('itin-trip-from')?.value || '')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const to = String($('itin-trip-to')?.value || '')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const date = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) {
      host.innerHTML =
        '<p class="eh-muted">Enter two different 3-letter airport codes in From and To.</p>';
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      host.innerHTML =
        '<p class="eh-muted">Pick trip dates in the Itinerary tab first (arrival / departure).</p>';
      return;
    }
    host.innerHTML = '<p class="eh-loading">Searching Google Flights…</p>';
    try {
      const data = await H.fetchSerpFlights(
        { from: from, to: to, date: date, passengers: 1, type: '2' },
        undefined,
      );
      const rows = H.mergeSerpLists(data);
      const book = H.bookUrlFromResponse(data);
      if (!rows.length) {
        host.innerHTML =
          '<p class="eh-muted">No flights returned for this route and date. Try other dates or airports.</p>';
        return;
      }
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        H.renderSerpFlightListItems(rows, book) +
        '</ul>' +
        '<p class="eh-footnote">Results from Google Flights (SerpAPI). Confirm times and prices before booking.</p>';
    } catch (e) {
      host.innerHTML =
        '<p class="eh-muted">' + escapeHtml(e.message || 'Flight search failed') + '</p>';
    }
  }

  function updateTripHotelPanel() {
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    const hq = $('itin-hotel-q');
    const ev = tripEnvelope && tripEnvelope.event;
    const cityFb = (tripEnvelope && tripEnvelope.city) || '';
    if (hq && !String(hq.value || '').trim() && ev) {
      hq.value = suggestHotelQueryFromEvent(ev, cityFb);
    }
    const line = $('itin-hotel-route-line');
    if (line) {
      if (dep) {
        line.textContent = 'Check-in: ' + dep;
      } else {
        line.textContent = 'Set trip dates (Edit trip → planner form).';
      }
    }
    const datesEl = $('itin-hotel-route-dates');
    if (datesEl) {
      datesEl.textContent =
        dep && ret ? 'Check-in ' + dep + ' · Check-out ' + ret : '—';
    }
  }

  /** Hotel Book URL dates — itineraries_generated arrival_date / departure_date (planner form fields). */
  function itinHotelBookContext() {
    const arrival_date = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    let departure_date = ($('itin-date-return') && $('itin-date-return').value) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival_date)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departure_date) || departure_date <= arrival_date) {
      departure_date = addDaysIso(arrival_date, 1);
    }
    const ev = (tripEnvelope && tripEnvelope.event) || {};
    const city =
      String((tripEnvelope && tripEnvelope.city) || (ev && ev.city) || '').trim() || 'Kuala Lumpur';
    return { city: city, arrival_date: arrival_date, departure_date: departure_date };
  }

  async function searchTripGoogleHotels() {
    const host = $('itin-hotels-inline');
    const H = window.__serpHotelsHelpers;
    if (!host) return;
    if (!H) {
      host.innerHTML =
        '<p class="eh-muted">Hotel search script failed to load. Refresh the page and try again.</p>';
      return;
    }
    const tripIn = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const tripOut = ($('itin-date-return') && $('itin-date-return').value) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tripIn)) {
      host.innerHTML =
        '<p class="eh-muted">Pick trip dates in the Itinerary tab first (arrival / departure).</p>';
      return;
    }
    const today = todayMalaysiaISO();
    let checkIn = tripIn;
    let checkOut = tripOut;
    let dateNote = '';
    if (checkIn < today) {
      checkIn = today;
      dateNote =
        ' Showing availability from today (SerpAPI requires future dates; your trip is still ' +
        tripIn +
        ' – ' +
        tripOut +
        ').';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) {
      checkOut = addDaysIso(checkIn, 1);
    }
    const ev = (tripEnvelope && tripEnvelope.event) || {};
    const cityFb = (tripEnvelope && tripEnvelope.city) || '';
    let q = String($('itin-hotel-q')?.value || '').trim();
    if (q.length < 2) {
      q = suggestHotelQueryFromEvent(ev, cityFb);
      const hq = $('itin-hotel-q');
      if (hq) hq.value = q;
    }
    host.innerHTML = '<p class="eh-loading">Searching Google Hotels…</p>';
    try {
      const data = await H.fetchSerpHotels(
        { q: q, checkIn: checkIn, checkOut: checkOut, adults: 1 },
        undefined,
      );
      const rows = H.mergeHotelProperties(data);
      const tripCtx = itinHotelBookContext();
      const bookCtx = H.hotelBookContextFromSerpSearch(data, q, checkIn, checkOut, tripCtx);
      if (!rows.length) {
        host.innerHTML =
          '<p class="eh-muted">No hotels returned for this search. Try another destination or dates.</p>';
        return;
      }
      if (data && data.serp_dates_adjusted) {
        dateNote =
          ' Dates adjusted to ' +
          (data.serp_check_in_date || checkIn) +
          ' – ' +
          (data.serp_check_out_date || checkOut) +
          ' for SerpAPI.';
      }
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        H.renderSerpHotelListItems(rows, bookCtx || { city: 'Kuala Lumpur' }) +
        '</ul>' +
        '<p class="eh-footnote">Results from Google Hotels (SerpAPI). Confirm prices and policies before booking.' +
        escapeHtml(dateNote) +
        '</p>';
    } catch (e) {
      host.innerHTML =
        '<p class="eh-muted">' + escapeHtml(e.message || 'Hotel search failed') + '</p>';
    }
  }

  function tripShareText() {
    if (!tripEnvelope) return 'Your trip';
    const act = getActiveVariant();
    const ev = (tripEnvelope && tripEnvelope.event) || {};
    const title = String(ev.title || 'My trip').trim();
    const bits = [title];
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    if (dep || ret) bits.push('Dates: ' + formatSideDates(dep, ret));
    if (act && act.guideSummary) bits.push(String(act.guideSummary).replace(/\s+/g, ' ').trim().slice(0, 400));
    return bits.join('\n\n');
  }

  function refreshHeaderBack() {
    const btn = $('itin-back-btn');
    if (!btn) return;
    const resSec = $('itin-result-section');
    const resVis = resSec && !resSec.hidden;
    const show = itinHistoryVisible || resVis;
    btn.hidden = !show;
    btn.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function formatHistoryDateLabel(iso) {
    if (!iso) return '';
    const s = String(iso).trim().slice(0, 10);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(iso);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function normalizeSavedEvent(ev, fallbackCity) {
    if (!ev || typeof ev !== 'object') return null;
    return {
      id: ev.id != null ? ev.id : '',
      title: ev.title || 'Event',
      date: ev.date || '',
      city: String(ev.city || fallbackCity || '').trim(),
      url: String(ev.url || '').trim(),
    };
  }

  /** When leaving History by Back, optionally restore planner state captured at open time. */
  function hideHistoryPanel(restoreFromStash) {
    const hs = $('itin-history-section');
    if (hs) {
      hs.hidden = true;
    }
    itinHistoryVisible = false;
    const s = stashBeforeHistory;
    if (restoreFromStash && s) {
      const formSec = $('itin-form-section');
      const resSec = $('itin-result-section');
      if (formSec) formSec.hidden = s.formHidden;
      if (resSec) resSec.hidden = s.resultsHidden;
      tripEnvelope = s.envelope;
      chosenVariantIdx = s.chosenVariantIdx;
      planDetailVisible = s.planDetailVisible;
      stashBeforeHistory = null;
      if (!s.resultsHidden && tripEnvelope) {
        if (planDetailVisible) {
          renderChosenPlan();
        } else {
          hidePlanSkeleton();
          renderVariantStage();
          renderToolbar();
        }
      }
    } else if (!restoreFromStash) {
      stashBeforeHistory = null;
    }
    refreshHeaderBack();
  }

  function openHistoryPanel() {
    stashBeforeHistory = {
      formHidden: $('itin-form-section') ? $('itin-form-section').hidden : false,
      resultsHidden: $('itin-result-section') ? $('itin-result-section').hidden : true,
      envelope: tripEnvelope ? JSON.parse(JSON.stringify(tripEnvelope)) : null,
      chosenVariantIdx,
      planDetailVisible,
    };
    itinHistoryVisible = true;
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) {
      formSec.hidden = true;
      formSec.setAttribute('hidden', '');
    }
    if (resSec) resSec.hidden = true;
    const hs = $('itin-history-section');
    if (hs) hs.hidden = false;
    fetchHistoryList();
    refreshHeaderBack();
  }

  function fetchHistoryList() {
    const st = $('itin-history-status');
    const empty = $('itin-history-empty');
    const ul = $('itin-history-ul');
    if (st) {
      st.hidden = false;
      st.removeAttribute('hidden');
    }
    if (empty) empty.hidden = true;
    if (ul) {
      ul.innerHTML = '';
      ul.hidden = true;
    }
    fetch('/api/itinerary/history?limit=30')
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (data) {
        if (st) {
          st.hidden = true;
          st.setAttribute('hidden', '');
        }
        const items = Array.isArray(data.items) ? data.items : [];
        if (data.error && !items.length) {
          showAlert(String(data.error));
        }
        if (!items.length) {
          if (empty) {
            empty.hidden = false;
            empty.removeAttribute('hidden');
          }
          return;
        }
        if (empty) empty.hidden = true;
        if (ul) {
          ul.hidden = false;
          ul.removeAttribute('hidden');
          ul.innerHTML = items
            .map(function (it) {
              const title = escapeHtml(it.eventTitle || 'Saved trip');
              const city = escapeHtml(String(it.city || '').trim());
              const created = formatHistoryDateLabel(it.createdAt);
              const range =
                it.arrivalDate && it.departureDate
                  ? formatHistoryDateLabel(it.arrivalDate) + ' – ' + formatHistoryDateLabel(it.departureDate)
                  : '';
              const nVar = Number(it.variantsCount) || 1;
              const meta =
                [city, range, created ? 'Saved ' + created : '', nVar > 1 ? nVar + ' journeys' : ''].filter(Boolean)
                  .join(' · ') || '';
              return (
                '<li><button type="button" class="itin-history-row" data-history-id="' +
                escapeHtml(String(it.id)) +
                '">' +
                '<span class="itin-history-row-title">' +
                title +
                '</span><span class="itin-history-row-meta">' +
                escapeHtml(meta) +
                '</span></button></li>'
              );
            })
            .join('');
        }
      })
      .catch(function () {
        if (st) {
          st.hidden = true;
          st.setAttribute('hidden', '');
        }
        showAlert('Could not load planner history.');
        if (empty) {
          empty.hidden = false;
          empty.removeAttribute('hidden');
        }
      });
  }

  async function loadSavedItinerary(id) {
    const sid = String(id || '').trim();
    if (!sid) return;
    clearAlert();
    showLoadingMsg('Loading saved itinerary…');
    stashBeforeHistory = null;
    itinHistoryVisible = false;
    const hs = $('itin-history-section');
    if (hs) hs.hidden = true;
    try {
      const res = await fetch('/api/itinerary/saved/' + encodeURIComponent(sid));
      const row = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(row.error || 'Could not open this saved trip.');
        return;
      }
      const depEl = $('itin-date-depart');
      const retEl = $('itin-date-return');
      if (depEl && row.arrival_date) depEl.value = String(row.arrival_date).slice(0, 10);
      if (retEl && row.departure_date) retEl.value = String(row.departure_date).slice(0, 10);
      const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const evNorm = normalizeSavedEvent(p.event, row.city || p.city);
      if (evNorm) setSelectedEvent(evNorm);
      const formSec = $('itin-form-section');
      const resSec = $('itin-result-section');
      if (formSec) {
        formSec.hidden = true;
        formSec.setAttribute('hidden', '');
      }
      if (resSec) resSec.hidden = false;
      const vPref =
        typeof p.selectedVariantIndex === 'number' && Number.isFinite(p.selectedVariantIndex)
          ? p.selectedVariantIndex
          : 0;
      const cityForTrip = String(row.city || p.city || (evNorm && evNorm.city) || '').trim();
      renderResults(
        Object.assign({}, p, {
          city: cityForTrip || p.city,
          event: p.event || evNorm,
        }),
        {
          skipPicker: true,
          variantIndex: vPref,
        },
      );
    } catch (e) {
      showAlert('Could not reach the server.');
    } finally {
      hideLoadingMsg();
      refreshHeaderBack();
    }
  }

  function canCloseTripModal() {
    return !itineraryGenerating;
  }

  function setItineraryGenerating(active) {
    itineraryGenerating = !!active;
    const modal = $('itin-modal');
    const closeBtn = $('itin-modal-close');
    const backdrop = $('itin-modal-backdrop');
    if (modal) modal.classList.toggle('itin-modal--generating', itineraryGenerating);
    if (closeBtn) {
      closeBtn.disabled = itineraryGenerating;
      closeBtn.setAttribute('aria-disabled', itineraryGenerating ? 'true' : 'false');
      if (itineraryGenerating) {
        closeBtn.hidden = true;
        closeBtn.setAttribute('hidden', '');
      } else {
        closeBtn.hidden = false;
        closeBtn.removeAttribute('hidden');
      }
    }
    if (backdrop) {
      backdrop.classList.toggle('itin-modal-backdrop--locked', itineraryGenerating);
    }
  }

  function dismissItinReadyToast() {
    const toast = $('itin-ready-toast');
    if (!toast) return;
    toast.classList.remove('is-visible');
    toast.hidden = true;
    toast.setAttribute('hidden', '');
    if (itinReadyToastTimer) {
      clearTimeout(itinReadyToastTimer);
      itinReadyToastTimer = null;
    }
  }

  function showItinReadyToast() {
    const toast = $('itin-ready-toast');
    if (!toast) return;
    toast.hidden = false;
    toast.removeAttribute('hidden');
    toast.classList.add('is-visible');
    if (itinReadyToastTimer) clearTimeout(itinReadyToastTimer);
    itinReadyToastTimer = setTimeout(dismissItinReadyToast, 12000);
  }

  function focusItineraryFromToast() {
    dismissItinReadyToast();
    openTripModal();
    scrollItinModalMainToTop();
    const panel = document.querySelector('#itin-modal .itin-modal-panel');
    if (panel && typeof panel.focus === 'function') panel.focus();
  }

  function showItinReadyToastIfNeeded() {
    const modal = $('itin-modal');
    if (!modal || !modal.classList.contains('is-open')) {
      showItinReadyToast();
      return;
    }
    const scroll = modal.querySelector('.itin-modal-scroll');
    const scrolledAway = scroll && scroll.scrollTop > 120;
    const focusOutside = !modal.contains(document.activeElement);
    const tabBlur = typeof document.hasFocus === 'function' && !document.hasFocus();
    if (scrolledAway || focusOutside || tabBlur) {
      showItinReadyToast();
    }
  }

  function performTripBack() {
    if (!canCloseTripModal()) return;
    clearAlert();
    if (itinHistoryVisible) {
      hideHistoryPanel(true);
      return;
    }
    if (!tripEnvelope) {
      clearPlannerSession();
      closeTripModal();
      return;
    }
    if (planDetailVisible && tripEnvelope.variants.length > 1) {
      planDetailVisible = false;
      hidePlanSkeleton();
      renderVariantStage();
      renderToolbar();
      refreshHeaderBack();
      return;
    }
    clearPlannerSession();
    closeTripModal();
  }

  function showAlert(msg) {
    const el = $('itin-alert');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    if (msg) el.classList.add('itin-alert--visible');
    else el.classList.remove('itin-alert--visible');
  }

  function clearAlert() {
    showAlert('');
  }

  function showLoadingMsg(text) {
    const el = $('itin-loading-msg');
    if (!el) return;
    const label = String(text || 'Crafting your perfect day').trim();
    const textEl = el.querySelector('.itin-loading-text');
    if (textEl) {
      textEl.innerHTML =
        escapeHtml(label) + '<span class="itin-loading-dots" aria-hidden="true"></span>';
    } else {
      el.textContent = label + '…';
    }
    el.classList.add('itin-loading-screen');
    el.removeAttribute('hidden');
    el.hidden = false;
  }

  function hideLoadingMsg() {
    const el = $('itin-loading-msg');
    if (!el) return;
    el.hidden = true;
    el.setAttribute('hidden', '');
  }

  function openTripModal() {
    const m = $('itin-modal');
    if (!m) return;
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('itin-modal-open');
    scrollItinModalMainToTop();
    requestAnimationFrame(updateItinModalScrollHint);
    refreshHeaderBack();
    refreshPlannerPreflightVisibility();
  }

  function closeTripModal() {
    if (!canCloseTripModal()) return;
    dismissItinReadyToast();
    const m = $('itin-modal');
    if (!m) return;
    if (itinHistoryVisible) {
      hideHistoryPanel(true);
    } else {
      stashBeforeHistory = null;
    }
    const hs = $('itin-history-section');
    if (hs) hs.hidden = true;
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('itin-modal-open');
    closePlaceOverlay();
    refreshHeaderBack();
  }

  function closePlaceOverlay() {
    const o = $('itin-place-overlay');
    if (!o) return;
    o.classList.remove('is-open');
    o.setAttribute('aria-hidden', 'true');
  }

  function openPlaceOverlay(placeId) {
    if (!lastPayload || !Array.isArray(lastPayload.places)) return;
    const p = lastPayload.places.find(function (x) {
      return String(x.id) === String(placeId);
    });
    if (!p) return;
    const img = $('itin-place-img');
    const title = $('itin-place-title');
    const loc = $('itin-place-loc');
    const desc = $('itin-place-desc');
    const fact = $('itin-place-fact');
    const meta = $('itin-place-meta');
    const mapBtn = $('itin-place-map');
    if (img) {
      img.referrerPolicy = 'no-referrer';
      img.removeAttribute('data-itin-img-fallback');
      img.src = p.image || '';
      img.alt = p.name || '';
      img.onerror = function () {
        if (img.dataset.itinImgFallback === '1') {
          img.dataset.itinImgFallback = '2';
          img.src =
            'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&w=800&q=70';
          return;
        }
        if (img.dataset.itinImgFallback === '2') {
          img.onerror = null;
          return;
        }
        img.dataset.itinImgFallback = '1';
        img.src =
          'https://picsum.photos/seed/' +
          encodeURIComponent('itin-overlay-' + String(placeId)) +
          '/800/500';
      };
    }
    if (title) title.textContent = p.name || 'Place';
    if (loc) loc.textContent = p.location || lastPayload.city || '';
    if (desc) desc.textContent = p.description || '';
    if (fact) fact.textContent = p.funFact || '—';
    if (meta) {
      var live = p.liveStatus ? '<span><strong>Status</strong> ' + escapeHtml(p.liveStatus) + '</span>' : '';
      meta.innerHTML =
        live +
        '<span><strong>Duration</strong> ' +
        escapeHtml(p.duration || '—') +
        '</span><span><strong>Cost</strong> ' +
        escapeHtml(p.cost || '—') +
        '</span>';
    }
    if (mapBtn) {
      mapBtn.href = p.mapUrl || '#';
      mapBtn.target = '_blank';
      mapBtn.rel = 'noopener noreferrer';
    }
    const o = $('itin-place-overlay');
    if (o) {
      o.classList.add('is-open');
      o.setAttribute('aria-hidden', 'false');
    }
  }

  function getCheckedInterests() {
    const boxes = document.querySelectorAll('.itin-interest:checked');
    return Array.prototype.map.call(boxes, function (b) {
      return b.value;
    });
  }

  function validateBeforeSubmit() {
    clearAlert();
    const dep = $('itin-date-depart') && $('itin-date-depart').value;
    const ret = $('itin-date-return') && $('itin-date-return').value;
    const today = todayMalaysiaISO();
    if (!selectedEvent) {
      showAlert('Please select an event');
      return false;
    }
    if (!dep || !ret) {
      showAlert('Please choose trip start and return dates');
      return false;
    }
    if (dep < today || ret < today) {
      showAlert('Departure and return dates must be today or later');
      return false;
    }
    if (ret < dep) {
      showAlert('Return date must be after departure date');
      return false;
    }
    const len = tripInclusiveDays(dep, ret);
    if (len > 14) {
      showAlert('Trip length is capped at 14 days');
      return false;
    }
    const evIso = toIsoDate(selectedEvent.date);
    if (evIso && (evIso < dep || evIso > ret)) {
      showAlert(
        'Event is on ' +
          evIso +
          ', but your trip is ' +
          dep +
          ' to ' +
          ret +
          '. Update your dates so the event falls within your trip.',
      );
      return false;
    }
    const f = plannerSelectedFlight;
    if (!f || typeof f !== 'object' || !f.departure || !f.arrival) {
      showAlert('Pick an inbound flight first (event card → Flights tab → Add to my itinerary).');
      return false;
    }
    const h = plannerSelectedHotel;
    if (!h || typeof h !== 'object' || !String(h.name || '').trim()) {
      showAlert(
        'Pick a hotel first (event card → Hotels tab → search → Add to my itinerary beside your preferred property).',
      );
      return false;
    }
    return true;
  }

  function syncFormFromProfile() {
    const u = window.__authUser;
    const p = u && u.profile && typeof u.profile === 'object' ? u.profile : {};
    const adv = $('itin-adventure');
    if (adv && ['easy', 'medium', 'hard'].indexOf(String(p.adventureLevel)) >= 0) {
      adv.value = String(p.adventureLevel);
    }
    const pace = $('itin-pace');
    if (pace && ['slow', 'balanced', 'packed'].indexOf(String(p.pacePreference)) >= 0) {
      pace.value = String(p.pacePreference);
    }
    const interests = Array.isArray(p.activityInterests) ? p.activityInterests : [];
    document.querySelectorAll('.itin-interest').forEach(function (cb) {
      cb.checked = interests.indexOf(cb.value) >= 0;
    });
    if (!document.querySelector('.itin-interest:checked')) {
      document.querySelectorAll('.itin-interest').forEach(function (cb) {
        if (cb.value === 'food' || cb.value === 'culture') cb.checked = true;
      });
    }
  }

  function renderAutocomplete(events) {
    const list = $('itin-ac-list');
    if (!list) return;
    lastAcEvents = Array.isArray(events) ? events.slice() : [];
    if (!lastAcEvents.length) {
      list.innerHTML = '';
      list.hidden = true;
      return;
    }
    list.hidden = false;
    list.innerHTML = lastAcEvents
      .map(function (e) {
        const label = escapeHtml(e.title || 'Event');
        const when = escapeHtml(toIsoDate(e.date) || 'Date TBA');
        const city = escapeHtml(e.city || '');
        return (
          '<button type="button" class="itin-ac-item" data-id="' +
          escapeHtml(String(e.id)) +
          '">' +
          '<strong>' +
          label +
          '</strong><span>' +
          when +
          (city ? ' · ' + city : '') +
          '</span></button>'
        );
      })
      .join('');
  }

  function fetchAutocomplete(q) {
    const list = $('itin-ac-list');
    if (!q || q.length < 2) {
      if (list) {
        list.innerHTML = '';
        list.hidden = true;
      }
      return;
    }
    fetch('/api/itinerary/events?q=' + encodeURIComponent(q))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        renderAutocomplete(data.events || []);
      })
      .catch(function () {
        renderAutocomplete([]);
      });
  }

  function setSelectedEvent(ev) {
    selectedEvent = ev;
    const hid = $('itin-event-id');
    const label = $('itin-selected-label');
    if (hid) hid.value = ev && ev.id != null ? String(ev.id) : '';
    if (label) {
      if (!ev) label.textContent = 'No event selected';
      else {
        label.textContent =
          (ev.title || 'Event') + ' · ' + (toIsoDate(ev.date) || '?');
      }
    }
    const ac = $('itin-ac-list');
    if (ac) {
      ac.innerHTML = '';
      ac.hidden = true;
    }
    const inp = $('itin-event-search');
    if (inp) inp.value = '';
    refreshPlannerPreflightVisibility();
    if (planDetailVisible && tripEnvelope) {
      refreshTripWeather();
    }
  }

  function renderToolbar() {
    const tb = $('itin-plan-toolbar');
    if (!tb) return;
    if (!tripEnvelope || tripEnvelope.variants.length <= 1 || !planDetailVisible) {
      tb.innerHTML = '';
      tb.hidden = true;
      return;
    }
    tb.hidden = false;
    tb.innerHTML =
      '<span class="itin-plan-toolbar-label">Compare drafts</span>' +
      tripEnvelope.variants
        .map(function (v, i) {
          var active = i === chosenVariantIdx ? ' is-active' : '';
          return (
            '<button type="button" class="itin-plan-tab' +
            active +
            '" data-switch-variant="' +
            i +
            '">' +
            escapeHtml(v.title || 'Plan ' + (i + 1)) +
            '</button>'
          );
        })
        .join('');
  }

  function renderVariantStage() {
    const st = $('itin-variant-stage');
    if (!st) return;
    if (
      planDetailVisible ||
      !tripEnvelope ||
      !Array.isArray(tripEnvelope.variants) ||
      tripEnvelope.variants.length <= 1
    ) {
      st.hidden = true;
      st.innerHTML = '';
      return;
    }
    st.hidden = false;
    var vs = tripEnvelope.variants;
    var cards = vs
      .map(function (v, i) {
        var blurbSource = String(v.guideSummary || '').replace(/\s+/g, ' ').trim().slice(0, 420);
        var nPlaces = Array.isArray(v.places) ? v.places.length : 0;
        var nDays = Array.isArray(v.days) ? v.days.length : 0;
        return (
          '<button type="button" class="itin-variant-card" data-pick-variant="' +
          i +
          '">' +
          '<span class="itin-variant-card-num">Curated journey ' +
          String(i + 1) +
          ' / ' +
          vs.length +
          '</span>' +
          '<h3>' +
          escapeHtml(v.title || 'Route ' + (i + 1)) +
          '</h3>' +
          (v.tagline
            ? '<p class="itin-variant-tagline">' + escapeHtml(v.tagline) + '</p>'
            : '') +
          '<p class="itin-variant-blurb">' +
          escapeHtml(blurbSource) +
          '</p>' +
          '<span class="itin-meta-inline" style="font-size:11px;color:#887b6f;margin-bottom:12px;display:block;">' +
          nDays +
          ' days · ' +
          nPlaces +
          ' stops</span>' +
          '<span class="itin-variant-select-pill">Select this journey&nbsp;→</span>' +
          '</button>'
        );
      })
      .join('');
    st.innerHTML =
      '<p class="itin-variant-stage-intro">Choose your journey</p>' +
      '<p class="itin-variant-stage-meta">Pick the route you want to open. You can refresh any single day after you select.</p>' +
      '<div class="itin-variant-grid">' +
      cards +
      '</div>';
  }

  function hidePlanSkeleton() {
    const modal = $('itin-modal');
    if (modal) modal.classList.remove('itin-modal--trip-view');
    const surf = $('itin-trip-surface');
    if (surf) {
      surf.hidden = true;
      surf.setAttribute('hidden', '');
    }
    setTripTab();
    const pills = $('itin-day-pills');
    if (pills) pills.innerHTML = '';
    const inf = $('itin-trip-flights-inline');
    if (inf) inf.innerHTML = '';
    const wtemp = $('itin-weather-temp');
    if (wtemp) wtemp.textContent = '—';
    const wcond = $('itin-weather-cond');
    if (wcond) wcond.textContent = '';
    const wloc = $('itin-weather-locale');
    if (wloc) wloc.textContent = '';
    const wg = $('itin-weather-grid');
    if (wg) {
      wg.hidden = true;
      wg.setAttribute('hidden', '');
    }
    const wf = $('itin-weather-foot');
    if (wf) wf.innerHTML = tripWeatherFootHtml('');
    const g = $('itin-guide-summary');
    if (g) {
      g.textContent = '';
      g.hidden = true;
      g.setAttribute('hidden', '');
    }
    const sw = $('itin-summary-row-wrap');
    if (sw) {
      sw.hidden = true;
      sw.setAttribute('hidden', '');
    }
    const w = $('itin-warnings');
    if (w) {
      w.innerHTML = '';
      w.hidden = true;
      w.setAttribute('hidden', '');
    }
    const pa = $('itin-plan-actions');
    if (pa) {
      pa.hidden = true;
      pa.setAttribute('hidden', '');
    }
    const daysHost = $('itin-days-container');
    if (daysHost) daysHost.innerHTML = '';
    const tl = $('itin-trip-flights-links');
    if (tl) tl.innerHTML = '';
    const tl2 = $('itin-travel-links');
    if (tl2) tl2.innerHTML = '';
    const hi = $('itin-hotels-inline');
    if (hi) hi.innerHTML = '';
    const fb = $('itin-trip-flight-banner');
    if (fb) {
      fb.hidden = true;
      fb.setAttribute('hidden', '');
      fb.innerHTML = '';
    }
  }

  function renderChosenPlan() {
    if (!tripEnvelope) return;
    const act = getActiveVariant();
    if (!act) return;
    syncOverlayPayload(act);
    planDetailVisible = true;
    const modal = $('itin-modal');
    if (modal) modal.classList.add('itin-modal--trip-view');
    const surf = $('itin-trip-surface');
    if (surf) {
      surf.hidden = false;
      surf.removeAttribute('hidden');
    }
    populateTripHero(act);
    renderSummary({
      days: act.days,
      places: act.places,
      event: tripEnvelope.event,
    });
    renderTripTips(act.days);
    renderTripFlightBannerFromEnvelope();
    const flightWarn = flightScheduleWarningsForUi();
    const mergedWarn = mergeEnvelopeWarnings(act.warnings).concat(flightWarn);
    renderWarnings(mergedWarn);
    renderTravelLinks();
    renderDays(act, true);
    renderToolbar();
    renderVariantStage();
    setTripTab();
    scrollItinModalMainToTop();
    requestAnimationFrame(updateItinModalScrollHint);
    activeTripDayIdx = 0;
    void loadTripWeatherForDays(act.days);
  }

  function renderSummary(payload) {
    const days = Array.isArray(payload.days) ? payload.days.length : 0;
    const nPlaces = Array.isArray(payload.places) ? payload.places.length : 0;
    const mainD = payload.event && toIsoDate(payload.event.date);
    const dStr = days ? String(days) + (days === 1 ? ' day' : ' days') : '—';
    const pStr = String(nPlaces);
    const eStr = mainD || '—';
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';
    const datesLabel = formatSideDates(dep, ret);
    const dEl = $('itin-summary-duration');
    const pEl = $('itin-summary-places');
    const eEl = $('itin-summary-eventdate');
    if (dEl) dEl.textContent = dStr;
    if (pEl) pEl.textContent = pStr;
    if (eEl) eEl.textContent = eStr;
    const sd = $('itin-side-dates');
    const sdu = $('itin-side-duration');
    const sp = $('itin-side-places');
    const se = $('itin-side-eventdate');
    if (sd) sd.textContent = datesLabel;
    if (sdu) sdu.textContent = dStr;
    if (sp) sp.textContent = pStr;
    if (se) se.textContent = eStr;
  }

  function getActiveFlightSelection() {
    return (
      (tripEnvelope && tripEnvelope.selectedFlight) ||
      plannerSelectedFlight ||
      null
    );
  }

  function getFlightScheduleHelpers() {
    return typeof window !== 'undefined' ? window.__flightScheduleHelpers : null;
  }

  function prepareDaysForFlightDisplay(days) {
    const list = Array.isArray(days) ? days : [];
    const F = getFlightScheduleHelpers();
    const sf = getActiveFlightSelection();
    if (!F || !sf || typeof F.applyFlightScheduleToDays !== 'function') {
      return list;
    }
    try {
      const copied = JSON.parse(JSON.stringify(list));
      return F.applyFlightScheduleToDays(copied, F.extractFlightSchedule(sf)).days || copied;
    } catch (e) {
      return list;
    }
  }

  function flightScheduleWarningsForUi() {
    const F = getFlightScheduleHelpers();
    const sf = getActiveFlightSelection();
    if (!F || !sf || typeof F.applyFlightScheduleToDays !== 'function') return [];
    const act = getActiveVariant();
    const days = act && Array.isArray(act.days) ? act.days : [];
    if (!days.length) return [];
    try {
      const copied = JSON.parse(JSON.stringify(days));
      return F.applyFlightScheduleToDays(copied, F.extractFlightSchedule(sf)).warnings || [];
    } catch (e) {
      return [];
    }
  }

  function slotTimesForPeriod(period, indexInPeriod, day, dayIdx, totalDays) {
    const F = getFlightScheduleHelpers();
    const sf = getActiveFlightSelection();
    if (F && typeof F.slotTimeForPeriod === 'function') {
      return F.slotTimeForPeriod(period, indexInPeriod, day, dayIdx, totalDays, sf);
    }
    const baseH = { morning: 9, afternoon: 14, evening: 19 }[period] || 12;
    let totalMin = baseH * 60 + indexInPeriod * 40;
    totalMin = Math.min(23 * 60 + 30, totalMin);
    const h24 = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + String(mm).padStart(2, '0') + ' ' + ampm;
  }

  function shouldRenderTimelinePeriod(day, period, dayIdx, totalDays) {
    const F = getFlightScheduleHelpers();
    const sf = getActiveFlightSelection();
    if (F && typeof F.shouldRenderPeriod === 'function') {
      return F.shouldRenderPeriod(day, period, dayIdx, totalDays, sf);
    }
    return true;
  }

  function periodCategory(period) {
    if (period === 'morning') return 'Explore';
    if (period === 'afternoon') return 'Food & culture';
    if (period === 'evening') return 'Evening';
    return 'Experience';
  }

  function shortSlotDesc(slot) {
    let d = String(slot.description || '').trim();
    if (d.length > 100) d = d.slice(0, 97) + '\u2026';
    return d;
  }

  function mergeSlotFromPlaces(slot, placesArr) {
    if (!slot || typeof slot !== 'object') return slot;
    const pid = String(slot.id != null ? slot.id : '');
    const p = (Array.isArray(placesArr) ? placesArr : []).find(function (x) {
      return String(x.id) === pid;
    });
    let mergedImg = String(slot.image || '').trim();
    if (!mergedImg && p && p.image) mergedImg = String(p.image).trim();
    const desc = String(slot.description || (p && p.description) || '').trim();
    return {
      id: slot.id,
      name: slot.name,
      area: slot.area,
      image: mergedImg,
      description: desc,
    };
  }

  function timelineRowMarkup(slot, timeStr, category, placesArr) {
    const m = mergeSlotFromPlaces(slot, placesArr || []);
    const pid = escapeHtml(m.id);
    const name = escapeHtml(m.name);
    const area = escapeHtml(m.area || '');
    const imgRaw = String(m.image || '').trim() || ITIN_IMG_STATIC_FALLBACK;
    const imgUrl = escapeHtml(imgRaw);
    const desc = escapeHtml(shortSlotDesc(m));
    return (
      '<div class="itin-tl-row itin-tl-row--click" role="button" tabindex="0" data-place-id="' +
      pid +
      '">' +
      '<div class="itin-tl-thumb">' +
      '<img src="' +
      imgUrl +
      '" alt="" loading="lazy" decoding="async" />' +
      '</div>' +
      '<div class="itin-tl-time">' +
      escapeHtml(timeStr) +
      '</div>' +
      '<div class="itin-tl-body">' +
      '<p class="itin-tl-name">' +
      name +
      '</p>' +
      (area ? '<p class="itin-tl-area">' + area + '</p>' : '') +
      (desc ? '<p class="itin-tl-desc">' + desc + '</p>' : '') +
      '<span class="itin-tl-cat">' +
      escapeHtml(category) +
      '</span>' +
      '</div></div>'
    );
  }

  function renderDays(payload, showDayRegenerate) {
    const host = $('itin-days-container');
    const pillsHost = $('itin-day-pills');
    if (!host || !pillsHost) return;
    const days = prepareDaysForFlightDisplay(payload.days || []);
    const totalDays = days.length;
    pillsHost.innerHTML = days
      .map(function (day, idx) {
        const label = day.label || 'Day ' + (idx + 1);
        const isFirst = idx === 0;
        return (
          '<button type="button" class="itin-day-pill' +
          (isFirst ? ' itin-day-pill--active' : '') +
          '" data-go-day="' +
          idx +
          '">Day ' +
          (idx + 1) +
          ' — ' +
          escapeHtml(label) +
          '</button>'
        );
      })
      .join('');

    host.innerHTML = days
      .map(function (day, idx) {
        const ordinal = DAY_ORDINALS[idx] || String(idx + 1);
        const rows = [];
        ['morning', 'afternoon', 'evening'].forEach(function (period) {
          if (!shouldRenderTimelinePeriod(day, period, idx, totalDays)) return;
          const slots = day[period];
          if (!Array.isArray(slots)) return;
          slots.forEach(function (slot, si) {
            rows.push(
              timelineRowMarkup(
                slot,
                slotTimesForPeriod(period, si, day, idx, totalDays),
                periodCategory(period),
                payload.places || [],
              ),
            );
          });
        });
        if (!rows.length) {
          rows.push(
            '<div class="itin-tl-row">' +
              '<div class="itin-tl-thumb"><div class="itin-tl-thumb-fallback">·</div></div>' +
              '<div class="itin-tl-time">—</div>' +
              '<div class="itin-tl-body"><p class="itin-tl-name">Open day</p>' +
              '<p class="itin-tl-desc">No stops were listed for this day yet.</p></div></div>',
          );
        }

        const meals = Array.isArray(day.meals)
          ? day.meals
              .map(function (m) {
                return (
                  '<li><strong>' +
                  escapeHtml(m.time || '') +
                  '</strong> ' +
                  escapeHtml(m.type || '') +
                  ' — ' +
                  escapeHtml(m.suggestion || '') +
                  (m.dish ? ' · ' + escapeHtml(m.dish) : '') +
                  '</li>'
                );
              })
              .join('')
          : '';
        const tips = Array.isArray(day.tips)
          ? day.tips
              .map(function (t) {
                return '<li>' + escapeHtml(t) + '</li>';
              })
              .join('')
          : '';

        const noteHtml =
          meals || tips
            ? '<div class="itin-tl-notes">' +
              (meals ? '<h5>Meals</h5><ul>' + meals + '</ul>' : '') +
              (tips ? '<h5>Tips</h5><ul>' + tips + '</ul>' : '') +
              '</div>'
            : '';

        const regenBtn =
          showDayRegenerate && planDetailVisible
            ? '<button type="button" class="itin-day-regen" data-regen-day="' +
              idx +
              '">Redraft this day</button>'
            : '';

        return (
          '<div class="itin-tl-day' +
          (idx === 0 ? ' is-active' : '') +
          '" data-tl-day="' +
          idx +
          '">' +
          '<div class="itin-tl-day-hdr">' +
          '<div>' +
          '<h3 class="itin-tl-day-title">Day ' +
          escapeHtml(ordinal) +
          ' — ' +
          escapeHtml(day.label || 'Day ' + (idx + 1)) +
          '</h3>' +
          (day.subtitle ? '<p class="itin-tl-day-sub">' + escapeHtml(day.subtitle) + '</p>' : '') +
          '<p class="itin-tl-day-wx" data-wx-day-idx="' +
          idx +
          '" data-wx-date="' +
          escapeHtml(String(day.date || '').slice(0, 10)) +
          '">Loading forecast…</p>' +
          '</div>' +
          regenBtn +
          '</div>' +
          '<div class="itin-tl-list">' +
          rows.join('') +
          '</div>' +
          noteHtml +
          '</div>'
        );
      })
      .join('');
  }

  function renderWarnings(warnings) {
    const w = $('itin-warnings');
    if (!w) return;
    const blockedTypes = {
      live_places: true,
      map_search_fallback: true,
    };
    const filtered = (Array.isArray(warnings) ? warnings : []).filter(function (x) {
      if (!x || typeof x !== 'object') return false;
      const t = String(x.type || '').trim();
      if (blockedTypes[t]) return false;
      return true;
    });
    if (!filtered.length) {
      w.innerHTML = '';
      w.hidden = true;
      w.setAttribute('hidden', '');
      return;
    }
    w.removeAttribute('hidden');
    w.hidden = false;
    w.innerHTML = filtered
      .map(function (x) {
        const sev = x.severity === 'warn' ? 'itin-warn--warn' : 'itin-warn--info';
        return (
          '<div class="itin-warn ' +
          sev +
          '">' +
          escapeHtml(x.message || '') +
          '</div>'
        );
      })
      .join('');
  }

  function renderTravelLinks() {
    const host = $('itin-trip-flights-links') || $('itin-travel-links');
    if (!host) return;
      host.innerHTML = '';
  }

  function renderResults(raw, opts) {
    opts = opts || {};
    const prevScopeKey = lastWeatherScopeKey;
    tripEnvelope = normalizeTripEnvelope(raw);
    const nVar = tripEnvelope.variants.length;
    var idx =
      typeof opts.variantIndex === 'number' && Number.isFinite(opts.variantIndex)
        ? Math.floor(opts.variantIndex)
        : 0;
    chosenVariantIdx = nVar ? Math.max(0, Math.min(nVar - 1, idx)) : 0;
    planDetailVisible = true;
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) {
      formSec.hidden = true;
      formSec.setAttribute('hidden', '');
    }
    if (resSec) resSec.hidden = false;

    if (planDetailVisible) {
      renderVariantStage();
      renderChosenPlan();
      const act = getActiveVariant();
      const city = getTripCityForWeather();
      const range = act ? getTripDateRangeFromDays(act.days) : null;
      const nextScopeKey = city && range ? weatherScopeKey(city, range) : '';
      if (nextScopeKey && nextScopeKey !== prevScopeKey) {
        refreshTripWeather();
      }
    } else {
      hidePlanSkeleton();
      renderVariantStage();
      renderToolbar();
    }
    refreshHeaderBack();
  }

  /** Clear trip / history UI state (shared by form reset and hub prefill). */
  function clearPlannerSession() {
    lastPayload = null;
    tripEnvelope = null;
    tripWeatherByDate = {};
    tripWeatherCurrent = null;
    tripWeatherLocale = '';
    tripWeatherNote = '';
    lastWeatherScopeKey = '';
    tripWeatherLoadSeq += 1;
    chosenVariantIdx = 0;
    planDetailVisible = false;
    stashBeforeHistory = null;
    itinHistoryVisible = false;
    plannerSelectedFlight = null;
    plannerSelectedHotel = null;
    plannerItineraryVibes = [];
    plannerItineraryPace = null;
    lastPlannerFlightRows = [];
    plannerFlightSearchSerial += 1;
    if (plannerPreflightTimer) {
      clearTimeout(plannerPreflightTimer);
      plannerPreflightTimer = null;
    }
    lastPreflightSearchKey = '';
    const pf = $('itin-preflight-block');
    if (pf) {
      pf.hidden = true;
      pf.setAttribute('hidden', '');
    }
    const fh = $('itin-form-flights-host');
    if (fh) fh.innerHTML = '';
    const sfc = $('itin-selected-flight-card');
    if (sfc) {
      sfc.hidden = true;
      sfc.setAttribute('hidden', '');
      sfc.innerHTML = '';
    }
    updateGenerateButtonState();
    const hs = $('itin-history-section');
    if (hs) hs.hidden = true;
    const ht = $('itin-history-status');
    if (ht) {
      ht.hidden = true;
      ht.setAttribute('hidden', '');
    }
    const he = $('itin-history-empty');
    if (he) he.hidden = true;
    const hul = $('itin-history-ul');
    if (hul) {
      hul.innerHTML = '';
      hul.hidden = true;
    }
    const st = $('itin-variant-stage');
    if (st) {
      st.innerHTML = '';
      st.hidden = true;
    }
    const tb = $('itin-plan-toolbar');
    if (tb) {
      tb.innerHTML = '';
      tb.hidden = true;
    }
    const pa = $('itin-plan-actions');
    if (pa) {
      pa.hidden = true;
    }
    hidePlanSkeleton();
    clearAlert();
  }

  function resetToForm() {
    clearPlannerSession();
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) {
      formSec.hidden = true;
      formSec.setAttribute('hidden', '');
    }
    if (resSec) resSec.hidden = true;
    refreshHeaderBack();
  }

  /** Event hub: skip the planner form — show results area (loading → journeys). */
  function showPlannerResultsShell() {
    clearPlannerSession();
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) {
      formSec.hidden = true;
      formSec.setAttribute('hidden', '');
    }
    if (resSec) resSec.hidden = false;
    refreshHeaderBack();
  }

  async function onGenerate() {
    if (!validateBeforeSubmit()) return;
    const btn = $('itin-generate');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generating…';
    }
    clearAlert();
    dismissItinReadyToast();
    setItineraryGenerating(true);
    showLoadingMsg('Crafting your perfect day...');
    const clientAbortMs = 280000;
    const ac = new AbortController();
    const abortTimer = setTimeout(function () {
      ac.abort();
    }, clientAbortMs);
    let generationSucceeded = false;
    try {
      const body = {
        eventId: String(selectedEvent.id != null ? selectedEvent.id : ''),
        eventUrl: String(selectedEvent.url || '').trim(),
        arrivalDate: $('itin-date-depart').value,
        departureDate: $('itin-date-return').value,
        city: (selectedEvent.city || '').trim(),
        adventureLevel: $('itin-adventure').value,
        interests: getCheckedInterests(),
        travelPace: $('itin-pace').value,
      };
      const flightForGen =
        plannerSelectedFlight ||
        (tripEnvelope && tripEnvelope.selectedFlight) ||
        null;
      if (flightForGen && typeof flightForGen === 'object') {
        const splitOk =
          flightForGen.tripType === 'round_trip_split' &&
          flightForGen.outbound &&
          flightForGen.returnFlight;
        const oneWayOk = flightForGen.departure && flightForGen.arrival;
        if (splitOk || oneWayOk) body.selectedFlight = flightForGen;
      }
      if (
        plannerSelectedHotel &&
        typeof plannerSelectedHotel === 'object' &&
        String(plannerSelectedHotel.name || '').trim()
      ) {
        body.selectedHotel = plannerSelectedHotel;
      }
      body.itineraryVibes =
        Array.isArray(plannerItineraryVibes) && plannerItineraryVibes.length
          ? plannerItineraryVibes.slice()
          : ['foodie'];
      body.itineraryPace = String(plannerItineraryPace || 'balanced').trim() || 'balanced';
      const res = await fetch('/api/itinerary/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(data.error || 'Could not generate itinerary. Try again later.');
        return;
      }
      hideLoadingMsg();
      renderResults(data, { skipPicker: true });
      generationSucceeded = true;
      showItinReadyToastIfNeeded();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        showAlert(
          'Request took too long and was cancelled. Try a shorter trip (fewer days) or check the server log — the AI step may need a higher timeout in .env (DASHSCOPE_ITINERARY_TIMEOUT_MS).',
        );
      } else {
        showAlert('Could not reach the server or the request failed. Confirm the app is running at http://localhost:3040 and try again.');
      }
    } finally {
      clearTimeout(abortTimer);
      hideLoadingMsg();
      setItineraryGenerating(false);
      if (btn) {
        btn.disabled = false;
      }
      updateGenerateButtonState();
      if (!generationSucceeded) dismissItinReadyToast();
    }
  }

  async function regenerateDay(dayIdx) {
    if (!tripEnvelope || !planDetailVisible) return;
    const act = getActiveVariant();
    if (!selectedEvent || !act) {
      showAlert('Select an event and a journey first.');
      return;
    }
    const btns = document.querySelectorAll('[data-regen-day="' + dayIdx + '"]');
    btns.forEach(function (b) {
      b.disabled = true;
    });
    clearAlert();
    dismissItinReadyToast();
    setItineraryGenerating(true);
    showLoadingMsg('Redrafting this day with fresh stops — usually 20–60 seconds…');
    let regenSucceeded = false;
    try {
      const res = await fetch('/api/itinerary/regenerate-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          eventId: String(selectedEvent.id != null ? selectedEvent.id : ''),
          eventUrl: String(selectedEvent.url || '').trim(),
          arrivalDate: $('itin-date-depart').value,
          departureDate: $('itin-date-return').value,
          adventureLevel: $('itin-adventure').value,
          interests: getCheckedInterests(),
          travelPace: $('itin-pace').value,
          dayIndex: dayIdx,
          variant: act,
          selectedFlight:
            (tripEnvelope && tripEnvelope.selectedFlight) ||
            plannerSelectedFlight ||
            null,
        }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(data.error || 'Could not refresh this day. Try again.');
        return;
      }
      tripEnvelope.variants[chosenVariantIdx] = data.variant;
      renderChosenPlan();
      regenSucceeded = true;
      showItinReadyToastIfNeeded();
      showAlert('Day updated — refreshed stops below.');
      setTimeout(function () {
        clearAlert();
      }, 4500);
    } catch (e) {
      showAlert('Could not reach the server. Try again.');
    } finally {
      hideLoadingMsg();
      setItineraryGenerating(false);
      btns.forEach(function (b) {
        b.disabled = false;
      });
      if (!regenSucceeded) dismissItinReadyToast();
    }
  }

  async function saveItinerary() {
    if (!tripEnvelope || !planDetailVisible || !selectedEvent) {
      showAlert('Generate and open a journey before saving.');
      return;
    }
    const act = getActiveVariant();
    const saveBtn = $('itin-save-trip');
    var prev = '';
    if (saveBtn) {
      prev = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }
    clearAlert();
    try {
      const res = await fetch('/api/itinerary/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: String(selectedEvent.id != null ? selectedEvent.id : ''),
          arrivalDate: $('itin-date-depart').value,
          departureDate: $('itin-date-return').value,
          city: tripEnvelope.city || (selectedEvent.city || '').trim(),
          event: tripEnvelope.event,
          selectedVariantKey: act.key || '',
          selectedVariantIndex: chosenVariantIdx,
          variants: tripEnvelope.variants,
          selectedFlight: tripEnvelope.selectedFlight || null,
          selectedHotel: tripEnvelope.selectedHotel || null,
        }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(data.error || 'Could not save. Check Supabase itineraries_generated table.');
        return;
      }
      showAlert(data.message || 'Saved to planner history ✓');
    } catch (e) {
      showAlert('Could not reach the save endpoint.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = prev || 'Save full trip';
      }
    }
  }

  function init() {
    const modal = $('itin-modal');
    if (!modal) return;
    updateGenerateButtonState();

    document.addEventListener(
      'click',
      function (e) {
        const addBtn = e.target.closest('[data-itin-add-flight]');
        if (addBtn) {
          const host = $('itin-form-flights-host');
          if (host && host.contains(addBtn)) {
            e.preventDefault();
            const idx = parseInt(addBtn.getAttribute('data-itin-add-flight'), 10);
            if (!Number.isNaN(idx)) onPlannerFormFlightAdd(idx);
            return;
          }
        }
        const clr = e.target.closest('[data-itin-clear-flight]');
        if (clr) {
          const card = $('itin-selected-flight-card');
          if (card && card.contains(clr)) {
            e.preventDefault();
            clearSelectedPlannerFlight();
            showAlert('Flight removed — pick another option if you like.');
            setTimeout(function () {
              clearAlert();
            }, 2600);
          }
        }
      },
      false,
    );
    const mClose = $('itin-modal-close');
    if (mClose) {
      mClose.addEventListener('click', function () {
        if (!canCloseTripModal()) return;
        closeTripModal();
      });
    }
    const mBd = $('itin-modal-backdrop');
    if (mBd) {
      mBd.addEventListener('click', function () {
        if (!canCloseTripModal()) return;
        closeTripModal();
      });
    }
    const toastView = $('itin-ready-toast-view');
    if (toastView) toastView.addEventListener('click', focusItineraryFromToast);
    const toastDismiss = $('itin-ready-toast-dismiss');
    if (toastDismiss) toastDismiss.addEventListener('click', dismissItinReadyToast);
    const itinScroll = modal && modal.querySelector('.itin-modal-scroll');
    if (itinScroll) {
      itinScroll.addEventListener('scroll', updateItinModalScrollHint, { passive: true });
    }
    window.addEventListener('resize', updateItinModalScrollHint, { passive: true });

    const pClose = $('itin-place-close');
    if (pClose) pClose.addEventListener('click', closePlaceOverlay);
    const pBd = $('itin-place-backdrop');
    if (pBd) pBd.addEventListener('click', closePlaceOverlay);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      const po = $('itin-place-overlay');
      if (po && po.classList.contains('is-open')) {
        closePlaceOverlay();
        return;
      }
      if (modal.classList.contains('is-open') && canCloseTripModal()) closeTripModal();
    });

    document.addEventListener('ts-auth-change', function () {
      updateTripFlightPanel();
    });

    const search = $('itin-event-search');
    if (search) {
      search.addEventListener('input', function () {
        const q = search.value.trim();
        if (acTimer) clearTimeout(acTimer);
        acTimer = setTimeout(function () {
          fetchAutocomplete(q);
        }, 220);
      });
    }

    const depInput = $('itin-date-depart');
    const retInput = $('itin-date-return');
    const minDate = todayMalaysiaISO();
    if (depInput) depInput.min = minDate;
    if (retInput) retInput.min = minDate;
    if (depInput && retInput) {
      depInput.addEventListener('change', function () {
        const d = depInput.value || minDate;
        retInput.min = d < minDate ? minDate : d;
        updateTripFlightPanel();
        updateTripHotelPanel();
        refreshPlannerPreflightVisibility();
        refreshTripWeather();
      });
      retInput.addEventListener('change', function () {
        updateTripFlightPanel();
        updateTripHotelPanel();
        refreshPlannerPreflightVisibility();
        refreshTripWeather();
      });
    }

    ;['itin-trip-from', 'itin-trip-to'].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener('input', updateTripFlightPanel);
    });

    const acList = $('itin-ac-list');
    if (acList) {
      acList.addEventListener('click', function (e) {
        const btn = e.target.closest('.itin-ac-item');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        const ev = lastAcEvents.find(function (x) {
          return String(x.id) === String(id);
        });
        if (ev) {
          setSelectedEvent(ev);
          refreshPlannerPreflightVisibility();
        }
      });
    }

    const gen = $('itin-generate');
    if (gen) gen.addEventListener('click', onGenerate);
    const edit = $('itin-edit-trip');
    if (edit) {
      edit.addEventListener('click', function () {
        clearPlannerSession();
        closeTripModal();
      });
    }

    const saveTrip = $('itin-save-trip');
    if (saveTrip) saveTrip.addEventListener('click', saveItinerary);

    const googleTripBtn = $('itin-trip-google-btn');
    if (googleTripBtn) {
      googleTripBtn.addEventListener('click', function () {
        void searchTripGoogleFlights();
      });
    }
    const googleHotelsTripBtn = $('itin-google-hotels-btn');
    if (googleHotelsTripBtn) {
      googleHotelsTripBtn.addEventListener('click', function () {
        void searchTripGoogleHotels();
      });
    }
    const hotelTripBtn = $('itin-trip-hotel-btn');
    if (hotelTripBtn) {
      hotelTripBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (typeof window.__prefillHotelModal !== 'function') return;
        const ev = (tripEnvelope && tripEnvelope.event) || {};
        window.__prefillHotelModal({
          venue: String(ev.venue || ''),
          city: String(ev.city || (tripEnvelope && tripEnvelope.city) || ''),
          depart: ($('itin-date-depart') && $('itin-date-depart').value) || '',
          ret: ($('itin-date-return') && $('itin-date-return').value) || '',
        });
      });
    }
    const shareTrip = $('itin-share-trip');
    if (shareTrip) {
      shareTrip.addEventListener('click', function () {
        const text = tripShareText();
        if (navigator.share) {
          navigator.share({ title: 'My trip', text: text }).catch(function () {});
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () {
              showAlert('Trip summary copied to clipboard.');
              setTimeout(clearAlert, 2200);
            },
            function () {
              showAlert('Could not copy — select text manually.');
            },
          );
        } else {
          showAlert(text.slice(0, 500));
        }
      });
    }
    const pdfTrip = $('itin-pdf-trip');
    if (pdfTrip) {
      pdfTrip.addEventListener('click', function () {
        window.print();
      });
    }
    const waTrip = $('itin-wa-trip');
    if (waTrip) {
      waTrip.addEventListener('click', function () {
        window.open(
          'https://wa.me/?text=' + encodeURIComponent(tripShareText()),
          '_blank',
          'noopener,noreferrer',
        );
      });
    }

    const backBtn = $('itin-back-btn');
    if (backBtn) backBtn.addEventListener('click', performTripBack);
    const historyOpen = $('itin-history-open');
    if (historyOpen) historyOpen.addEventListener('click', openHistoryPanel);
    const historyUl = $('itin-history-ul');
    if (historyUl) {
      historyUl.addEventListener('click', function (e) {
        const row = e.target.closest('[data-history-id]');
        if (!row) return;
        loadSavedItinerary(row.getAttribute('data-history-id'));
      });
    }

    const resWrap = $('itin-result-section');
    if (resWrap) {
      resWrap.addEventListener('click', function (e) {
        const go = e.target.closest('[data-go-day]');
        if (go) {
          e.preventDefault();
          const di = parseInt(go.getAttribute('data-go-day'), 10);
          if (!Number.isNaN(di)) activateTripDay(di);
          return;
        }
        const tlHdr = e.target.closest('.itin-tl-day-hdr');
        if (tlHdr) {
          const sec = tlHdr.closest('.itin-tl-day');
          if (sec) {
            const di = parseInt(sec.getAttribute('data-tl-day'), 10);
            if (!Number.isNaN(di)) activateTripDay(di);
          }
          return;
        }
        const pick = e.target.closest('[data-pick-variant]');
        if (pick) {
          const i = parseInt(pick.getAttribute('data-pick-variant'), 10);
          if (!Number.isNaN(i) && tripEnvelope && tripEnvelope.variants && tripEnvelope.variants[i]) {
            chosenVariantIdx = i;
            renderChosenPlan();
          }
          return;
        }
        const swEl = e.target.closest('[data-switch-variant]');
        if (swEl) {
          const j = parseInt(swEl.getAttribute('data-switch-variant'), 10);
          if (!Number.isNaN(j) && tripEnvelope && tripEnvelope.variants && tripEnvelope.variants[j]) {
            chosenVariantIdx = j;
            renderChosenPlan();
          }
        }
      });
    }

    const daysHost = $('itin-days-container');
    if (daysHost) {
      daysHost.addEventListener(
        'error',
        function (e) {
          const t = e.target;
          if (!t || t.tagName !== 'IMG') return;
          const wrap = t.closest('.itin-mini-img-wrap') || t.closest('.itin-tl-thumb');
          if (!wrap) return;
          if (t.dataset.itinImgFallback === '1') {
            t.dataset.itinImgFallback = '2';
            t.src = ITIN_IMG_STATIC_FALLBACK;
            return;
          }
          if (t.dataset.itinImgFallback === '2') {
            t.onerror = null;
            return;
          }
          t.dataset.itinImgFallback = '1';
          const card = t.closest('.itin-mini-card') || t.closest('.itin-tl-row');
          const pid = (card && card.getAttribute('data-place-id')) || 'place';
          t.src =
            'https://picsum.photos/seed/' +
            encodeURIComponent('itin-card-' + pid) +
            '/400/200';
        },
        true,
      );
      daysHost.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.itin-tl-row--click[data-place-id]');
        if (!row) return;
        e.preventDefault();
        const pid = row.getAttribute('data-place-id');
        if (pid) openPlaceOverlay(pid);
      });
      daysHost.addEventListener('click', function (e) {
        const regenBtn = e.target.closest('[data-regen-day]');
        if (regenBtn) {
          e.preventDefault();
          const di = parseInt(regenBtn.getAttribute('data-regen-day'), 10);
          if (!Number.isNaN(di)) {
            regenerateDay(di);
          }
          return;
        }
        const row = e.target.closest('.itin-tl-row[data-place-id]');
        if (!row || !row.classList.contains('itin-tl-row--click')) return;
        const pid = row.getAttribute('data-place-id');
        if (pid) openPlaceOverlay(pid);
      });
    }
  }

  /** Header / deep link: open modal on saved itineraries list. */
  window.__openSavedItineraries = function () {
    clearPlannerSession();
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) {
      formSec.hidden = true;
      formSec.setAttribute('hidden', '');
    }
    if (resSec) {
      resSec.hidden = true;
      resSec.setAttribute('hidden', '');
    }
    openTripModal();
    openHistoryPanel();
  };

  /** Event hub: open results modal and run AI generation (no separate planner UI). */
  window.__hubItineraryGenerate = async function (opts) {
    opts = opts || {};
    syncFormFromProfile();
    if (opts.event) setSelectedEvent(opts.event);
    var d1 = $('itin-date-depart');
    var d2 = $('itin-date-return');
    if (d1 && opts.arrivalDate) d1.value = String(opts.arrivalDate).slice(0, 10);
    if (d2 && opts.departureDate) d2.value = String(opts.departureDate).slice(0, 10);
    plannerSelectedFlight = null;
    plannerSelectedHotel = null;
    if (Array.isArray(opts.itineraryVibes) && opts.itineraryVibes.length) {
      plannerItineraryVibes = opts.itineraryVibes.map(function (x) {
        return String(x).trim();
      }).filter(Boolean);
    } else if (opts.itineraryVibe) {
      plannerItineraryVibes = [String(opts.itineraryVibe).trim()];
    } else {
      plannerItineraryVibes = ['foodie'];
    }
    plannerItineraryPace = String(opts.itineraryPace || 'balanced').trim() || 'balanced';
    showPlannerResultsShell();
    if (opts.selectedFlight && typeof opts.selectedFlight === 'object') {
      plannerSelectedFlight = opts.selectedFlight;
    }
    if (opts.selectedHotel && typeof opts.selectedHotel === 'object') {
      plannerSelectedHotel = opts.selectedHotel;
    }
    openTripModal();
    await onGenerate();
  };
  window.__tripPlannerGenerateNow = onGenerate;

  document.addEventListener('DOMContentLoaded', init);
})();
