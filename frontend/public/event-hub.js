/**
 * Event hub — click an event card to open details with Itinerary / Flights / Hotels tabs.
 * Depends on window.__lastRenderedEventSlice (set in viewer.html when cards render).
 */
(function () {
  'use strict';

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

  function todayMalaysiaIso() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  }

  /** SerpAPI google_hotels requires check-in today or later — clamp for search only (UI keeps trip dates). */
  function hotelSerpSearchDates(arrivalIso, departureIso) {
    const today = todayMalaysiaIso();
    let checkIn = String(arrivalIso || '').slice(0, 10);
    let checkOut = String(departureIso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
      return { ok: false, checkIn: '', checkOut: '', adjusted: false };
    }
    let adjusted = false;
    if (checkIn < today) {
      checkIn = today;
      adjusted = true;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) {
      checkOut = addDaysIso(checkIn, 1);
      adjusted = true;
    }
    return { ok: true, checkIn: checkIn, checkOut: checkOut, adjusted: adjusted };
  }

  function hubEventId() {
    const ev = hubState && hubState.event;
    if (!ev) return '';
    return String(ev.id || ev.url || ev.event_url || '').trim();
  }

  function logHubFlightPick(flightDate) {
    if (typeof window.__logFlightSelection !== 'function') return;
    window.__logFlightSelection({
      eventId: hubEventId(),
      originAirport: (hubState && hubState.originIata) || '',
      destinationCity: (hubState && hubState.destIata) || '',
      flightDate: flightDate || (hubState && hubState.arrivalIso) || '',
    });
  }

  function logHubHotelPick(hotel, checkIn, checkOut, priceNumeric) {
    if (typeof window.__logHotelSelection !== 'function' || !hotel) return;
    const ev = hubState && hubState.event;
    let numeric = priceNumeric;
    if (numeric == null) {
      const H = window.__serpHotelsHelpers;
      if (H && typeof H.hotelExtractedPrice === 'function') numeric = H.hotelExtractedPrice(hotel);
    }
    const payload = {
      eventId: hubEventId(),
      hotelName: hotel.name,
      hotelPrice: hotel.priceLabel || hotel.price,
      checkIn: checkIn,
      checkOut: checkOut,
      city: (ev && ev.city) || '',
    };
    if (numeric != null && Number.isFinite(Number(numeric)) && Number(numeric) > 0) {
      payload.hotelPriceNumeric = Number(numeric);
    }
    window.__logHotelSelection(payload);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Plain-text snippet from listing fields (summary / description / etc.). */
  function pickEventDescriptionSnippet(ev) {
    if (!ev) return '';
    const raw =
      ev.summary ||
      ev.description ||
      ev.details ||
      ev.body ||
      ev.teaser ||
      ev.subtitle ||
      '';
    let s = String(raw)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '';
    const max = 400;
    return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
  }

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

  function scrollEventHubToTop() {
    const sc = $('event-hub-scroll') || document.querySelector('.event-hub-scroll');
    if (sc && typeof sc.scrollTo === 'function') {
      sc.scrollTo({ top: 0, behavior: scrollMotionBehavior() });
    }
  }

  function updateEventHubScrollHint() {
    const sc = $('event-hub-scroll');
    const hint = $('event-hub-scroll-hint');
    if (!sc || !hint) return;
    const canScroll = sc.scrollHeight > sc.clientHeight + 8;
    const nearBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 28;
    hint.classList.toggle('is-dismissed', !canScroll || nearBottom || sc.scrollTop > 20);
  }

  function updateEventHubHeroParallax() {
    const sc = $('event-hub-scroll');
    const hero = $('eh-hero-bar');
    if (!sc || !hero) return;
    const imgWrap = $('eh-hero-imgwrap');
    const body = hero.querySelector('.eh-hero-bar__body');
    if (hero.classList.contains('eh-hero-bar--compact')) {
      if (imgWrap) {
        imgWrap.style.transform = '';
        imgWrap.style.opacity = '';
      }
      if (body) {
        body.style.transform = '';
        body.style.opacity = '';
      }
      return;
    }
    const h = imgWrap ? imgWrap.offsetHeight || 1 : hero.offsetHeight || 1;
    const st = Math.max(0, sc.scrollTop);
    const p = Math.min(1, st / Math.max(h * 0.85, 1));
    if (imgWrap) {
      imgWrap.style.transform =
        'translateY(' + (st * 0.3).toFixed(1) + 'px) scale(' + (1 + p * 0.06).toFixed(3) + ')';
      imgWrap.style.opacity = Math.max(0, 1 - p * 1.1).toFixed(3);
    }
    if (body) {
      body.style.transform = 'translateY(' + (st * 0.18).toFixed(1) + 'px)';
      body.style.opacity = Math.max(0, 1 - p * 1.3).toFixed(3);
    }
  }

  const BUDGET_LABELS = {
    1: 'budget',
    2: 'balanced budget',
    3: 'upscale budget',
    4: 'luxury budget',
  };
  const PACE_LABELS = {
    slow: 'relaxed pace',
    balanced: 'balanced pace',
    packed: 'packed pace',
  };

  const COPILOT_CHIPS = [
    {
      id: 'recommended',
      label: 'Recommended 3-day trip',
      icon: '✈️',
      apply: function (ctx, opts) {
        const db =
          opts && opts.daysOverride
            ? opts.daysOverride.daysBefore
            : ctx.aiDays.daysBefore != null
              ? ctx.aiDays.daysBefore
              : 1;
        const da =
          opts && opts.daysOverride
            ? opts.daysOverride.daysAfter
            : ctx.aiDays.daysAfter != null
              ? ctx.aiDays.daysAfter
              : 1;
        return {
          daysBefore: db,
          daysAfter: da,
          sortMode: 'default',
          reply:
            (opts && opts.reason) ||
            ctx.aiReason ||
            'Here\u2019s your balanced trip around the event.',
        };
      },
    },
    {
      id: 'event-day',
      label: 'Just the event day',
      icon: '⚡',
      apply: function () {
        return {
          daysBefore: 0,
          daysAfter: 0,
          sortMode: 'default',
          reply: 'Tight schedule \u2014 arrive and leave on event day.',
        };
      },
    },
    {
      id: 'explore-before',
      label: 'Add a day to explore before',
      icon: '🌅',
      apply: function (ctx) {
        return {
          daysBefore: Math.min(14, ctx.current.daysBefore + 1),
          daysAfter: ctx.current.daysAfter,
          sortMode: 'default',
          reply: 'Great \u2014 an extra day before the event to explore.',
        };
      },
    },
    {
      id: 'stay-after',
      label: 'Stay a day after',
      icon: '🌇',
      apply: function (ctx) {
        return {
          daysBefore: ctx.current.daysBefore,
          daysAfter: Math.min(14, ctx.current.daysAfter + 1),
          sortMode: 'default',
          reply: 'Nice \u2014 one more day after the event to unwind.',
        };
      },
    },
    {
      id: 'luxury',
      label: 'Luxury version',
      icon: '💎',
      apply: function (ctx) {
        const db = ctx.aiDays.daysBefore != null ? ctx.aiDays.daysBefore : Math.max(1, ctx.current.daysBefore);
        const da = ctx.aiDays.daysAfter != null ? ctx.aiDays.daysAfter : Math.max(1, ctx.current.daysAfter);
        return {
          daysBefore: db,
          daysAfter: da,
          sortMode: 'luxury',
          reply: 'Here\u2019s your plan with premium flight and hotel picks up top.',
        };
      },
    },
    {
      id: 'budget',
      label: 'Budget mode',
      icon: '🎒',
      apply: function (ctx) {
        return {
          daysBefore: ctx.current.daysBefore,
          daysAfter: ctx.current.daysAfter,
          sortMode: 'budget',
          reply: 'Showing leaner options that match your budget vibe.',
        };
      },
    },
    {
      id: 'slow',
      label: 'Slow travel (more days)',
      icon: '🐢',
      apply: function (ctx) {
        const extra = ctx.profile.pacePreference === 'slow' ? 2 : 1;
        return {
          daysBefore: Math.min(14, Math.max(ctx.current.daysBefore, 1) + extra),
          daysAfter: Math.min(14, Math.max(ctx.current.daysAfter, 1) + extra),
          sortMode: 'default',
          reply: 'Relaxed pace \u2014 extra buffer days around the event.',
        };
      },
    },
    {
      id: 'quick',
      label: 'Quick trip (tightest schedule)',
      icon: '⏩',
      apply: function () {
        return {
          daysBefore: 0,
          daysAfter: 0,
          sortMode: 'default',
          reply: 'Quick in-and-out \u2014 minimum days away.',
        };
      },
    },
  ];

  let hubState = {
    event: null,
    daysBefore: 1,
    daysAfter: 1,
    arrivalIso: '',
    departureIso: '',
    originIata: 'KUL',
    destIata: 'KUL',
    selectedFlight: null,
    selectedOutboundFlight: null,
    selectedReturnFlight: null,
    flightLeg: 'outbound',
    lastFlightRows: [],
    lastFlightCurrency: 'MYR',
    lastFlightLowestPrice: null,
    lastFlightApiTotal: 0,
    selectedHotel: null,
    lastHotelRows: [],
    autoTravelToken: 0,
    flightSearchSeq: 0,
    flightPrefetchSeq: 0,
    prefetchedFlightRaw: null,
    prefetchedFlightKey: '',
    selectedChipId: 'recommended',
    resultSortMode: 'default',
    flightPreferDirect: false,
    hotelSortMode: 'default',
    tripFlowStep: 'flights',
    hotelSearchSeq: 0,
    itineraryVibes: [],
    itineraryPace: null,
    generatingItinerary: false,
    aiDays: { daysBefore: 1, daysAfter: 1 },
    aiReason: '',
    copilotReply: '',
    copilotLoading: false,
    lastFlightBookUrl: '',
    lastHotelBookContext: null,
  };

  function getTravelProfile() {
    if (typeof window.__getTravelProfileFromUser === 'function') {
      return window.__getTravelProfileFromUser();
    }
    return { homeIata: 'KUL', budgetLevel: 2, pacePreference: 'balanced', hasProfile: false };
  }

  function formatHumanDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '').slice(0, 10))) return '—';
    try {
      return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-MY', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch (e) {
      return iso;
    }
  }

  function buildCopilotSummaryLine(ev, daysBefore, daysAfter) {
    const evIso = toIsoDate(ev && ev.date);
    if (!evIso) return 'Add an event date to build your trip plan.';
    const city = String((ev && ev.city) || (ev && ev.venue) || 'your destination').trim();
    const arrive = addDaysIso(evIso, -daysBefore);
    const depart = addDaysIso(evIso, daysAfter);
    return (
      'This event is on ' +
      formatHumanDate(evIso) +
      ' in ' +
      city +
      '. Based on your profile, I suggest arriving ' +
      formatHumanDate(arrive) +
      ', attending the event, and departing ' +
      formatHumanDate(depart) +
      '.'
    );
  }

  function updateCopilotProfileFoot() {
    const el = $('eh-copilot-profile');
    if (!el) return;
    const p = getTravelProfile();
    const budget = BUDGET_LABELS[p.budgetLevel] || BUDGET_LABELS[2];
    const pace = PACE_LABELS[p.pacePreference] || PACE_LABELS.balanced;
    const origin = String(p.homeIata || 'KUL').toUpperCase();
    el.textContent =
      'Using profile: origin ' +
      origin +
      ' \u00b7 ' +
      budget +
      ' \u00b7 ' +
      pace +
      (p.hasProfile ? '' : ' (defaults — sign in to personalize)');
  }

  function renderCopilotChips() {
    const host = $('eh-copilot-chips');
    if (!host) return;
    const ctx = getCopilotContext();
    host.innerHTML = COPILOT_CHIPS.map(function (chip) {
      const selected = hubState.selectedChipId === chip.id;
      let disabled = false;
      if (chip.id === 'explore-before' && ctx.current.daysBefore >= 14) disabled = true;
      if (chip.id === 'stay-after' && ctx.current.daysAfter >= 14) disabled = true;
      return (
        '<button type="button" class="eh-copilot-chip' +
        (selected ? ' is-selected' : '') +
        '" data-eh-copilot-chip="' +
        escapeHtml(chip.id) +
        '"' +
        (selected ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        (disabled ? ' disabled' : '') +
        '>' +
        escapeHtml(chip.icon + ' ' + chip.label) +
        '</button>'
      );
    }).join('');
  }

  function getCopilotContext() {
    return {
      ev: hubState.event,
      profile: getTravelProfile(),
      current: { daysBefore: hubState.daysBefore, daysAfter: hubState.daysAfter },
      aiDays: hubState.aiDays || { daysBefore: 1, daysAfter: 1 },
      aiReason: hubState.aiReason || '',
    };
  }

  function setCopilotLoading(on) {
    hubState.copilotLoading = !!on;
    const box = $('eh-copilot');
    if (box) box.classList.toggle('is-loading', !!on);
    const sum = $('eh-copilot-summary');
    if (sum && on) {
      sum.textContent = 'Eventra Copilot is reading this event and your profile\u2026';
    }
  }

  function updateCopilotUI() {
    const sum = $('eh-copilot-summary');
    if (sum) {
      if (hubState.copilotReply) {
        sum.textContent = hubState.copilotReply;
      } else {
        sum.textContent = buildCopilotSummaryLine(hubState.event, hubState.daysBefore, hubState.daysAfter);
      }
    }
    updateCopilotProfileFoot();
    renderCopilotChips();
  }

  function updateAutoTravelStatus(text) {
    const el = $('eh-auto-travel-status');
    if (!el) return;
    const msg = String(text || '').trim();
    if (!msg) {
      el.hidden = true;
      el.setAttribute('hidden', '');
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.removeAttribute('hidden');
    el.textContent = msg;
  }

  function normalizeTripSuggestionResponse(data) {
    if (!data || typeof data !== 'object') return null;
    const rawDb = data.daysBefore != null ? data.daysBefore : data.days_before;
    const rawDa = data.daysAfter != null ? data.daysAfter : data.days_after;
    if (rawDb == null && rawDa == null) return null;
    return {
      daysBefore: Math.min(14, Math.max(0, parseInt(rawDb, 10) || 0)),
      daysAfter: Math.min(14, Math.max(0, parseInt(rawDa, 10) || 0)),
      reason: String(data.reason || '').trim(),
      source: String(data.source || 'ai'),
      apiFallback: Boolean(data.apiFallback),
      apiFallbackReason: String(data.apiFallbackReason || '').trim(),
    };
  }

  function heuristicTripDaysClient(ev, homeIata, apiFallbackReason) {
    const title = String(ev.title || '').toLowerCase();
    const cat = String(ev.category || '').toLowerCase();
    const blob = title + ' ' + cat;
    let db = 1;
    let da = 1;
    if (/festival|expo|fair|conference|summit|marathon|week-long|multi.?day/i.test(blob)) {
      db = 1;
      da = 2;
    } else if (/gala|dinner|party|club|night out|after.?party/i.test(blob)) {
      db = 1;
      da = 0;
    } else if (/workshop|seminar|talk|meetup/i.test(blob)) {
      db = 0;
      da = 0;
    }
    const cityVenue = (String(ev.city || '') + ' ' + String(ev.venue || '')).toLowerCase();
    const nearKul = /kuala|kl\b|selangor|petaling|putrajaya|cyberjaya|shah alam/i.test(cityVenue);
    const home = String(homeIata || 'KUL')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    if (home === 'KUL' && nearKul) {
      db = Math.min(db, 0);
      da = Math.min(da, 1);
    }
    return {
      daysBefore: db,
      daysAfter: da,
      reason: 'Balanced trip window around your event (adjust anytime).',
      source: 'heuristic',
      apiFallback: true,
      apiFallbackReason: String(apiFallbackReason || '').trim(),
    };
  }

  function syncTripDatesFromState() {
    const db = Math.min(14, Math.max(0, hubState.daysBefore));
    const da = Math.min(14, Math.max(0, hubState.daysAfter));
    const evIso = toIsoDate(hubState.event && hubState.event.date);
    if (!evIso) {
      hubState.arrivalIso = '';
      hubState.departureIso = '';
      return;
    }
    hubState.daysBefore = db;
    hubState.daysAfter = da;
    hubState.arrivalIso = addDaysIso(evIso, -db);
    hubState.departureIso = addDaysIso(evIso, da);
    if (hubState.departureIso < hubState.arrivalIso) {
      hubState.departureIso = hubState.arrivalIso;
    }
    const maxLen = 14;
    let len =
      Math.round(
        (new Date(hubState.departureIso + 'T12:00:00Z') - new Date(hubState.arrivalIso + 'T12:00:00Z')) /
          86400000,
      ) + 1;
    if (len > maxLen) {
      hubState.departureIso = addDaysIso(hubState.arrivalIso, maxLen - 1);
      hubState.daysAfter = Math.max(
        0,
        Math.round(
          (new Date(hubState.departureIso + 'T12:00:00Z') - new Date(evIso + 'T12:00:00Z')) / 86400000,
        ),
      );
    }
  }

  function applyChipPlan(chipId, opts) {
    opts = opts || {};
    const chip = COPILOT_CHIPS.find(function (c) {
      return c.id === chipId;
    });
    if (!chip) return;
    const ctx = getCopilotContext();
    const plan = chip.apply(ctx, opts);
    hubState.selectedChipId = chipId;
    const fgSort =
      fgState.done &&
      fgState.answers &&
      (fgState.answers.sortMode === 'budget' || fgState.answers.sortMode === 'luxury');
    if (!(chipId === 'recommended' && fgSort)) {
      hubState.resultSortMode = plan.sortMode || 'default';
    }
    const hgSort =
      hgState.done &&
      hgState.answers &&
      (hgState.answers.sortMode === 'budget' || hgState.answers.sortMode === 'luxury');
    if (!(chipId === 'recommended' && hgSort)) {
      hubState.hotelSortMode = plan.sortMode || 'default';
    }
    hubState.copilotReply = String(plan.reply || '').trim();
    hubState.daysBefore = Math.min(14, Math.max(0, parseInt(plan.daysBefore, 10) || 0));
    hubState.daysAfter = Math.min(14, Math.max(0, parseInt(plan.daysAfter, 10) || 0));
    syncTripDatesFromState();
    updateCopilotUI();
    updateRouteLine();
    updateHotelRouteBar();
    syncHotelTabFromHub();
    syncFlightTabInputsFromHub();
  }

  function applyTripDaysSuggestion(data) {
    if (!data) return;
    hubState.aiDays = {
      daysBefore: Math.min(14, Math.max(0, parseInt(data.daysBefore, 10) || 0)),
      daysAfter: Math.min(14, Math.max(0, parseInt(data.daysAfter, 10) || 0)),
    };
    hubState.aiReason = String(data.reason || '').trim();
    applyChipPlan('recommended', {
      daysOverride: hubState.aiDays,
      reason: hubState.aiReason || buildCopilotSummaryLine(hubState.event, hubState.aiDays.daysBefore, hubState.aiDays.daysAfter),
    });
  }

  function flightRowPrice(row) {
    const H = window.__serpFlightsHelpers;
    if (H && typeof H.parseFlightPrice === 'function') {
      return H.parseFlightPrice(row);
    }
    const n = Number(row && row.price);
    return Number.isFinite(n) && n >= 0 ? n : Infinity;
  }

  function getEffectiveFlightSortMode() {
    if (fgState.answers && fgState.answers.sortMode) {
      return fgState.answers.sortMode;
    }
    return hubState.resultSortMode || 'default';
  }

  function flightSortFootnote(mode) {
    if (mode === 'budget') {
      return 'Sorted by price (lowest first). Confirm times and prices before booking.';
    }
    if (mode === 'luxury') {
      return 'Sorted by price (highest first). Confirm times and prices before booking.';
    }
    return 'Results from Google Flights (SerpAPI). Confirm times and prices before booking.';
  }

  function flightResultsFootnote(sortMode, shown, total, extra) {
    extra = extra || {};
    const n = Math.max(0, Number(total) || 0);
    const s = Math.max(0, Number(shown) || 0);
    const H = window.__serpFlightsHelpers;
    const cur = extra.currency || hubState.lastFlightCurrency || 'MYR';
    const apiTotal = extra.apiTotal != null ? Number(extra.apiTotal) : null;
    let line = '';
    const leg = hubState.flightLeg === 'return' ? 'return' : 'outbound';
    line +=
      leg === 'return'
        ? 'One-way return search for your departure date. '
        : 'One-way outbound search for your arrival date. Return is chosen next. ';
    if (apiTotal != null && apiTotal > 0) {
      line +=
        'Google Flights returned ' +
        apiTotal +
        ' option' +
        (apiTotal === 1 ? '' : 's') +
        '. ';
    }
    line +=
      'Showing ' +
      s +
      ' of ' +
      n +
      ' flight option' +
      (n === 1 ? '' : 's') +
      (sortMode === 'budget' ? ' (cheapest first)' : '') +
      '. ';
    if (hubState.flightPreferDirect && n > 0 && n <= 3) {
      line +=
        'Only nonstop/direct offers match your choice — pick "Doesn\u2019t matter" for more results. ';
    }
    if (extra.lowestPrice != null && sortMode === 'budget' && H && H.formatFlightPrice) {
      line +=
        'Google lowest in this search: ' +
        H.formatFlightPrice(extra.lowestPrice, cur) +
        '. ';
    }
    line +=
      'Fares are from Google Flights (' +
      cur +
      ') via SerpAPI — tap Verify on Google for the live price (baggage/fees may differ). ';
    return line + flightSortFootnote(sortMode);
  }

  function hotelRowPrice(row) {
    if (!row) return Infinity;
    const Hh = window.__serpHotelsHelpers;
    if (Hh && typeof Hh.hotelExtractedPrice === 'function') {
      const ex = Hh.hotelExtractedPrice(row);
      if (ex != null && Number.isFinite(ex)) return ex;
    }
    if (row.extracted_price != null && Number.isFinite(Number(row.extracted_price))) {
      return Number(row.extracted_price);
    }
    const rnEx = row.rate_per_night && row.rate_per_night.extracted_lowest;
    if (rnEx != null && Number.isFinite(Number(rnEx))) return Number(rnEx);
    const trEx = row.total_rate && row.total_rate.extracted_lowest;
    if (trEx != null && Number.isFinite(Number(trEx))) return Number(trEx);
    const hotelPriceRaw =
      row.hotel_price != null
        ? row.hotel_price
        : row.hotelPrice != null
          ? row.hotelPrice
          : row.price != null
            ? row.price
            : null;
    if (hotelPriceRaw != null) {
      const parsed = parseFloat(String(hotelPriceRaw).replace(/[^0-9.]/g, '')) || 0;
      if (parsed > 0) return parsed;
    }
    const raw = row.rate_per_night && row.rate_per_night.lowest;
    if (raw != null) {
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
      if (n > 0) return n;
    }
    const totalLow = row.total_rate && row.total_rate.lowest;
    if (totalLow != null) {
      const n = parseFloat(String(totalLow).replace(/[^0-9.]/g, '')) || 0;
      if (n > 0) return n;
    }
    return Infinity;
  }

  function sortRowsForMode(rows, mode) {
    const H = window.__serpFlightsHelpers;
    if (H && typeof H.sortFlightsByPrice === 'function') {
      if (mode === 'budget') return H.sortFlightsByPrice(rows, true);
      if (mode === 'luxury') return H.sortFlightsByPrice(rows, false);
    }
    const list = Array.isArray(rows) ? rows.slice() : [];
    if (mode === 'budget') {
      list.sort(function (a, b) {
        const pa = flightRowPrice(a);
        const pb = flightRowPrice(b);
        if (pa !== pb) return pa - pb;
        return (Number(a.total_duration) || 0) - (Number(b.total_duration) || 0);
      });
    } else if (mode === 'luxury') {
      list.sort(function (a, b) {
        const pa = flightRowPrice(a);
        const pb = flightRowPrice(b);
        if (pa !== pb) return pb - pa;
        return (Number(b.total_duration) || 0) - (Number(a.total_duration) || 0);
      });
    }
    return list;
  }

  function sortHotelRowsForMode(rows, mode) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    if (mode === 'luxury') {
      list.sort(function (a, b) {
        const ra = a.overall_rating != null ? Number(a.overall_rating) : 0;
        const rb = b.overall_rating != null ? Number(b.overall_rating) : 0;
        if (rb !== ra) return rb - ra;
        return hotelRowPrice(b) - hotelRowPrice(a);
      });
    } else {
      list.sort(function (a, b) {
        return hotelRowPrice(a) - hotelRowPrice(b);
      });
    }
    return list;
  }

  async function selectCopilotChip(chipId, opts) {
    opts = opts || {};
    const onlySort = chipId === 'budget' || chipId === 'luxury';
    const hasResults = hubState.lastFlightRows.length > 0 || hubState.lastHotelRows.length > 0;
    applyChipPlan(chipId, opts);
    if (opts.skipSearch || (onlySort && hasResults)) {
      if (hasResults) await rerenderTravelResultsSorted();
      return;
    }
    hubState.tripFlowStep = 'flights';
    updateTripFlowUi();
    setTripFlowMessage('Dates updated. Open Flights when you\u2019re ready — just a few quick taps.');
    updateAutoTravelStatus('Dates saved. Use the Flights tab for a guided search, then Hotels.');
  }

  async function rerenderTravelResultsSorted() {
    const Hf = window.__serpFlightsHelpers;
    const Hh = window.__serpHotelsHelpers;
    const fr = $('eh-flights-results');
    const hr = $('eh-hotels-results');
    const mode = hubState.resultSortMode;
    if (fr && hubState.lastFlightRows.length && Hf) {
      const sortMode = getEffectiveFlightSortMode();
      const rows = sortRowsForMode(hubState.lastFlightRows, sortMode);
      hubState.lastFlightRows = rows;
      const maxShow = Hf.maxFlightsToShow
        ? Hf.maxFlightsToShow(sortMode)
        : sortMode === 'budget'
          ? Hf.MAX_FLIGHTS_DISPLAY_BUDGET || 100
          : Hf.MAX_FLIGHTS_DISPLAY || 30;
      const toShow = rows.slice(0, maxShow);
      const cur = hubState.lastFlightCurrency || 'MYR';
      fr.innerHTML =
        '<ul class="eh-flight-list">' +
        Hf.renderSerpFlightListItems(
          toShow,
          hubState.lastFlightBookUrl || '',
          true,
          cur,
          getFlightSearchContext().pickLabel,
        ) +
        '</ul>' +
        '<p class="eh-footnote">' +
        escapeHtml(
          flightResultsFootnote(sortMode, toShow.length, rows.length, {
            currency: cur,
            lowestPrice: hubState.lastFlightLowestPrice,
            apiTotal: hubState.lastFlightApiTotal,
          }),
        ) +
        '</p>';
    }
    if (hr && hubState.lastHotelRows.length && Hh) {
      const hotelMode = getEffectiveHotelSortMode();
      const rows = sortHotelRowsForMode(hubState.lastHotelRows, hotelMode);
      hubState.lastHotelRows = rows;
      hr.innerHTML =
        '<ul class="eh-flight-list">' +
        Hh.renderSerpHotelListItems(
          rows,
          hubState.lastHotelBookContext || hubHotelBookContextFromTrip() || { city: 'Kuala Lumpur' },
          true,
        ) +
        '</ul>' +
        '<p class="eh-footnote">Sorted for your Copilot selection. Confirm before booking.</p>';
    }
  }

  async function fetchAiTripSuggestion() {
    const ev = hubState.event;
    if (!ev || !toIsoDate(ev.date)) {
      return null;
    }
    const homeIata =
      typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
    const snippet = pickEventDescriptionSnippet(ev);
    const payload = {
      homeIata: homeIata,
      event: {
        title: ev.title || 'Event',
        date: toIsoDate(ev.date),
        city: ev.city || '',
        venue: ev.venue || '',
        category: ev.category || '',
        description: snippet,
        summary: snippet,
      },
    };
    try {
      const res = await fetch('/api/trip/suggest-days', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const contentType = String(res.headers.get('content-type') || '');
      let data = {};
      if (contentType.includes('application/json')) {
        data = await res.json().catch(() => ({}));
      }
      if (res.ok) {
        const norm = normalizeTripSuggestionResponse(data);
        if (norm) return norm;
      }
      let fallbackReason = '';
      if (res.status === 404) {
        fallbackReason =
          'Trip AI API not found — stop the old server and run: npm run server (then refresh this page).';
      } else if (data.error) {
        fallbackReason = String(data.error);
      } else {
        fallbackReason = 'Trip API error (' + res.status + ')';
      }
      console.warn('[event-hub] suggest-days fallback:', fallbackReason);
      return heuristicTripDaysClient(ev, homeIata, fallbackReason);
    } catch (e) {
      const msg = e && e.message ? e.message : 'Network error';
      let hint = msg;
      if (/failed to fetch|networkerror/i.test(msg)) {
        hint = 'Open the app at http://localhost:3040 after running npm run server (not as a raw HTML file).';
      }
      console.warn('[event-hub] suggest-days error:', hint);
      return heuristicTripDaysClient(ev, homeIata, hint);
    }
  }

  async function runAutomatedTravelSearch(token, opts) {
    opts = opts || {};
    if (token != null && token !== hubState.autoTravelToken) return;
    const flightsHost = $('eh-flights-results');
    const hotelsHost = $('eh-hotels-results');
    const skipFlights = !!opts.skipFlights;
    if (!skipFlights && flightsHost && !flightsHost.innerHTML) {
      flightsHost.innerHTML = '<p class="eh-loading">Searching flights…</p>';
    }
    if (!skipFlights) {
      await searchGoogleFlights();
      if (token != null && token !== hubState.autoTravelToken) return;
    }
  }

  async function fetchAndApplyAiTripPlan(token) {
    const ev = hubState.event;
    if (!ev) return;
    if (!toIsoDate(ev.date)) {
      setCopilotLoading(false);
      hubState.copilotReply = 'This event has no date yet — pick a chip once a date is listed.';
      updateCopilotUI();
      updateAutoTravelStatus('');
      return;
    }
    setCopilotLoading(true);
    updateAutoTravelStatus('');
    try {
      const data = await fetchAiTripSuggestion();
      if (token !== hubState.autoTravelToken) return;
      setCopilotLoading(false);
      if (!data) {
        applyChipPlan('recommended', {});
        updateAutoTravelStatus('Pick a Copilot option above to search flights and hotels.');
        return;
      }
      applyTripDaysSuggestion(data);
      if (data.apiFallback && data.apiFallbackReason) {
        hubState.copilotReply =
          hubState.copilotReply + ' (' + data.apiFallbackReason + ')';
        updateCopilotUI();
      }
      hubState.tripFlowStep = 'flights';
      updateTripFlowUi();
      setTripFlowMessage('Your dates look good. Open Flights when you\u2019re ready — we\u2019ll guide you step by step.');
      let doneMsg =
        'Copilot set your trip dates. Open Flights, then Hotels — we\u2019ll walk you through each.';
      if (data.apiFallback && data.apiFallbackReason) {
        doneMsg += ' Tip: ' + data.apiFallbackReason;
      }
      updateAutoTravelStatus(doneMsg);
    } catch (e) {
      if (token !== hubState.autoTravelToken) return;
      setCopilotLoading(false);
      applyChipPlan('recommended', {});
      updateAutoTravelStatus(
        (e && e.message) ||
          'Could not reach trip AI \u2014 using defaults. Tap another Copilot chip or search manually.',
      );
    }
  }

  function updateRouteLine() {
    syncTripDatesFromState();
    const route = $('eh-route-line');
    const dates = $('eh-route-dates');
    if (route) {
      if (hubState.arrivalIso) {
        route.textContent = 'Outbound flight date: ' + hubState.arrivalIso;
      } else {
        route.textContent = 'Choose a Copilot plan on the Itinerary tab to set dates.';
      }
    }
    if (dates) {
      dates.textContent =
        hubState.arrivalIso && hubState.departureIso
          ? 'Arrive ' + hubState.arrivalIso + ' · Depart ' + hubState.departureIso
          : '—';
    }
  }

  function syncFlightTabInputsFromHub() {
    /* IATA codes come from profile + event (no manual inputs on Flights tab). */
  }

  function readFlightTabIata() {
    const from = String(hubState.originIata || 'KUL')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    const to = String(hubState.destIata || '')
      .trim()
      .toUpperCase()
      .slice(0, 3);
    return { from, to };
  }

  function flightPrefetchKey(ctx) {
    const c = ctx || {};
    return [c.leg || 'outbound', c.from || '', c.to || '', c.date || ''].join('|');
  }

  function clearFlightPrefetchCache() {
    hubState.prefetchedFlightRaw = null;
    hubState.prefetchedFlightKey = '';
    ++hubState.flightPrefetchSeq;
  }

  /** Start outbound Serp search in the background once arrival + stay length are known. */
  function prefetchFlightsForCurrentDates() {
    if (!fgState.answers || fgState.answers.daysAfter == null) return;
    hubState.daysBefore = Math.min(14, Math.max(0, parseInt(fgState.answers.daysBefore, 10) || 0));
    hubState.daysAfter = Math.min(14, Math.max(0, parseInt(fgState.answers.daysAfter, 10) || 0));
    syncTripDatesFromState();
    updateRouteLine();
    updateHotelRouteBar();
    syncHotelTabFromHub();
    const H = window.__serpFlightsHelpers;
    if (!H || typeof H.fetchSerpFlights !== 'function') return;
    const ctx = getFlightSearchContext();
    if (!/^[A-Z]{3}$/.test(ctx.from) || !/^[A-Z]{3}$/.test(ctx.to) || ctx.from === ctx.to) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.date)) return;
    if (ctx.leg !== 'outbound') return;
    const key = flightPrefetchKey(ctx);
    if (hubState.prefetchedFlightKey === key && hubState.prefetchedFlightRaw) return;
    const seq = ++hubState.flightPrefetchSeq;
    H.fetchSerpFlights(
      { from: ctx.from, to: ctx.to, date: ctx.date, passengers: 1, type: '2' },
      undefined,
    )
      .then(function (data) {
        if (seq !== hubState.flightPrefetchSeq) return;
        hubState.prefetchedFlightRaw = data;
        hubState.prefetchedFlightKey = key;
      })
      .catch(function () {
        if (seq !== hubState.flightPrefetchSeq) return;
      });
  }

  function getFlightSearchContext() {
    const iata = readFlightTabIata();
    const leg = hubState.flightLeg === 'return' ? 'return' : 'outbound';
    if (leg === 'return') {
      return {
        leg: 'return',
        from: iata.to,
        to: iata.from,
        date: hubState.departureIso,
        pickLabel: 'Select return flight',
        loadingText: 'Searching return flights\u2026',
        routeLabel: iata.to + ' \u2192 ' + iata.from + ' on ' + hubState.departureIso,
      };
    }
    return {
      leg: 'outbound',
      from: iata.from,
      to: iata.to,
      date: hubState.arrivalIso,
      pickLabel: 'Select outbound flight',
      loadingText: 'Searching outbound flights\u2026',
      routeLabel: iata.from + ' \u2192 ' + iata.to + ' on ' + hubState.arrivalIso,
    };
  }

  function syncCombinedSelectedFlight() {
    const ob = hubState.selectedOutboundFlight;
    const ret = hubState.selectedReturnFlight;
    const H = window.__serpFlightsHelpers;
    if (!ob) {
      hubState.selectedFlight = null;
      return;
    }
    if (ret && H && typeof H.combineRoundTripForItinerary === 'function') {
      hubState.selectedFlight = H.combineRoundTripForItinerary(ob, ret);
    } else {
      hubState.selectedFlight = ob;
    }
  }

  function flightsRoundTripComplete() {
    return !!(
      hubState.selectedOutboundFlight &&
      hubState.selectedOutboundFlight.departure &&
      hubState.selectedReturnFlight &&
      hubState.selectedReturnFlight.departure
    );
  }

  function resetFlightLegSelection() {
    hubState.flightLeg = 'outbound';
    hubState.selectedOutboundFlight = null;
    hubState.selectedReturnFlight = null;
    hubState.selectedFlight = null;
  }

  function updateFlightsLegBar() {
    const bar = $('eh-flights-leg-bar');
    if (!bar) return;
    const ctx = getFlightSearchContext();
    const obDone = !!hubState.selectedOutboundFlight;
    const retDone = !!hubState.selectedReturnFlight;
    const leg = hubState.flightLeg || 'outbound';
    bar.hidden = false;
    bar.removeAttribute('hidden');
    bar.innerHTML =
      '<div class="eh-flights-leg-steps" role="list" aria-label="Flight selection steps">' +
      '<span class="eh-flights-leg-step' +
      (leg === 'outbound' ? ' is-active' : '') +
      (obDone ? ' is-done' : '') +
      '" role="listitem">1 · Outbound</span>' +
      '<span class="eh-flights-leg-step' +
      (leg === 'return' ? ' is-active' : '') +
      (retDone ? ' is-done' : '') +
      '" role="listitem">2 · Return</span>' +
      '</div>' +
      '<p class="eh-flights-leg-route">' +
      escapeHtml(ctx.routeLabel) +
      '</p>';
  }

  function applyFlightsGuidedAnswers(ans) {
    const a = ans || {};
    hubState.daysBefore = Math.min(14, Math.max(0, parseInt(a.daysBefore, 10) || 0));
    hubState.daysAfter = Math.min(14, Math.max(0, parseInt(a.daysAfter, 10) || 0));
    const sortMode = a.sortMode === 'budget' || a.sortMode === 'luxury' ? a.sortMode : 'default';
    hubState.resultSortMode = sortMode;
    fgState.answers.sortMode = sortMode;
    const preferDirect = sortMode === 'budget' ? false : !!a.preferDirect;
    hubState.flightPreferDirect = preferDirect;
    fgState.answers.preferDirect = preferDirect;
    syncTripDatesFromState();
    updateRouteLine();
    updateHotelRouteBar();
    syncHotelTabFromHub();
    hubState.tripFlowStep = 'flights';
    resetFlightLegSelection();
    updateTripFlowUi();
    return searchGoogleFlights();
  }

  function hubTripCity() {
    const ev = hubState.event || {};
    return String(ev.city || '').trim() || 'Kuala Lumpur';
  }

  /** City-level Serp query — use city name (SerpAPI google_hotels `q` param). */
  function hotelSerpQueryFromHub(areaMode) {
    const city = hubTripCity();
    const mode = String(areaMode || '').trim();
    if (mode === 'venue') {
      const venue = String((hubState.event && hubState.event.venue) || '').trim();
      if (venue && city) return city + ', Malaysia';
    }
    return city.indexOf('Malaysia') >= 0 ? city : city + ', Malaysia';
  }

  function suggestHotelQuery(ev) {
    if (!ev) return 'Kuala Lumpur, Malaysia';
    const city = String(ev.city || '').trim() || 'Kuala Lumpur';
    return city.indexOf('Malaysia') >= 0 ? city : city + ', Malaysia';
  }

  function syncHotelTabFromHub() {
    syncTripDatesFromState();
    updateHotelRouteBar();
    const hq = $('eh-hotel-q');
    if (!hq || !hubState.event) return;
    const areaMode = hgState.answers && hgState.answers.areaMode;
    hq.value = hotelSerpQueryFromHub(areaMode);
  }

  function updateHotelRouteBar() {
    syncTripDatesFromState();
    const line = $('eh-hotel-route-line');
    const dates = $('eh-hotel-route-dates');
    const city = hubTripCity();
    if (line) {
      if (hubState.arrivalIso && hubState.departureIso) {
        line.textContent = 'Hotels in ' + city;
      } else if (hubState.arrivalIso) {
        line.textContent = 'Hotels in ' + city + ' · check-in ' + hubState.arrivalIso;
      } else {
        line.textContent = 'Complete Flights questions first to set check-in and check-out';
      }
    }
    if (dates) {
      dates.textContent =
        hubState.arrivalIso && hubState.departureIso
          ? 'Check-in ' + hubState.arrivalIso + ' · Check-out ' + hubState.departureIso
          : '—';
    }
  }

  /** Malaysia visa-free stay limits (days) by home country — profile country or home airport. */
  const FG_IATA_TO_COUNTRY = {
    KUL: 'Malaysia',
    PEN: 'Malaysia',
    SIN: 'Singapore',
    XSP: 'Singapore',
    BWN: 'Brunei',
    CGK: 'Indonesia',
    DPS: 'Indonesia',
    BKK: 'Thailand',
    MNL: 'Philippines',
    SGN: 'Vietnam',
    PNH: 'Cambodia',
    VTE: 'Laos',
    RGN: 'Myanmar',
    JFK: 'United States',
    LAX: 'United States',
    LHR: 'United Kingdom',
    SYD: 'Australia',
    NRT: 'Japan',
    ICN: 'South Korea',
    YYZ: 'Canada',
    YVR: 'Canada',
    AKL: 'New Zealand',
    DEL: 'India',
    BOM: 'India',
    PEK: 'China',
    PVG: 'China',
    FRA: 'Germany',
    CDG: 'France',
    AMS: 'Netherlands',
  };

  const FG_EU_COUNTRY_KEYS = {
    austria: true,
    belgium: true,
    bulgaria: true,
    croatia: true,
    cyprus: true,
    czechia: true,
    'czech republic': true,
    denmark: true,
    estonia: true,
    finland: true,
    france: true,
    germany: true,
    greece: true,
    hungary: true,
    ireland: true,
    italy: true,
    latvia: true,
    lithuania: true,
    luxembourg: true,
    malta: true,
    netherlands: true,
    poland: true,
    portugal: true,
    romania: true,
    slovakia: true,
    slovenia: true,
    spain: true,
    sweden: true,
  };

  const FG_COUNTRY_ALIASES = {
    usa: 'united states',
    us: 'united states',
    'u.s.': 'united states',
    'u.s.a.': 'united states',
    uk: 'united kingdom',
    'u.k.': 'united kingdom',
    uae: 'united arab emirates',
    korea: 'south korea',
    'republic of korea': 'south korea',
    burma: 'myanmar',
  };

  function fgNormalizeCountryKey(raw) {
    const s = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    if (!s) return '';
    return FG_COUNTRY_ALIASES[s] || s;
  }

  function fgCountryFromHomeIata(iata) {
    const code = String(iata || '')
      .trim()
      .toUpperCase();
    return code && FG_IATA_TO_COUNTRY[code] ? FG_IATA_TO_COUNTRY[code] : '';
  }

  function fgGetUserHomeCountry() {
    const u = window.__authUser;
    const p = (u && u.profile) || {};
    const fromProfile = fgNormalizeCountryKey(p.locationCountry);
    if (fromProfile) return fromProfile;
    const iata =
      (p.homeIata && String(p.homeIata).trim().toUpperCase()) ||
      (typeof window.__getHomeIataFromProfile === 'function'
        ? window.__getHomeIataFromProfile()
        : '');
    const fromIata = fgNormalizeCountryKey(fgCountryFromHomeIata(iata));
    return fromIata || 'malaysia';
  }

  function fgMalaysiaVisaLimitDays(countryKey) {
    const c = fgNormalizeCountryKey(countryKey);
    if (!c) return 30;
    if (c === 'singapore' || c === 'brunei') return 30;
    if (
      c === 'indonesia' ||
      c === 'thailand' ||
      c === 'philippines' ||
      c === 'vietnam' ||
      c === 'cambodia' ||
      c === 'laos' ||
      c === 'myanmar'
    ) {
      return 30;
    }
    if (
      c === 'united states' ||
      c === 'united kingdom' ||
      c === 'australia' ||
      c === 'japan' ||
      c === 'south korea' ||
      c === 'canada' ||
      c === 'new zealand' ||
      FG_EU_COUNTRY_KEYS[c]
    ) {
      return 90;
    }
    return 30;
  }

  function fgTripTotalDaysInMalaysia(daysBefore, daysAfter) {
    const db = Math.max(0, parseInt(daysBefore, 10) || 0);
    const da = Math.max(0, parseInt(daysAfter, 10) || 0);
    return db + 1 + da;
  }

  function fgStayChoiceExceedsVisa(daysAfter, daysBefore, visaLimit) {
    const limit = visaLimit != null ? visaLimit : fgMalaysiaVisaLimitDays(fgGetUserHomeCountry());
    return fgTripTotalDaysInMalaysia(daysBefore, daysAfter) > limit;
  }

  const FG_STEP_OPTIONS = {
    arrive: {
      question: 'How many days before the event do you want to arrive?',
      choices: [
        { id: '0', label: 'Same day', daysBefore: 0 },
        { id: '1', label: '1 day before', daysBefore: 1 },
        { id: '2', label: '2\u20133 days before', daysBefore: 3 },
        { id: '7', label: 'A week before', daysBefore: 7 },
        { id: '10', label: '8\u201310 days before', daysBefore: 10 },
        { id: '15', label: '15+ days before', daysBefore: 15 },
      ],
    },
    stay: {
      question: 'Nice! And how long are you staying after the event?',
      choices: [
        { id: '0', label: 'Leave same day', daysAfter: 0 },
        { id: '1', label: '1 day after', daysAfter: 1 },
        { id: '2', label: '2\u20133 days after', daysAfter: 3 },
        { id: '7', label: 'Make a full trip out of it', daysAfter: 7 },
        { id: '10', label: '8\u201310 days after', daysAfter: 10 },
        { id: '15', label: '15+ days after', daysAfter: 15 },
      ],
    },
    pref: {
      question: 'Got it! Any flight preference?',
      choices: [
        { id: 'budget', label: 'Cheapest available', sortMode: 'budget', preferDirect: false },
        { id: 'direct', label: 'Direct flights only', sortMode: 'default', preferDirect: true },
        { id: 'any', label: "Doesn't matter", sortMode: 'default', preferDirect: false },
      ],
    },
  };

  let fgInited = false;
  let fgEventKey = '';
  let fgState = {
    step: 'arrive',
    currentQuestion: '',
    answers: {},
    busy: false,
    done: false,
  };

  function fgRenderPrompt() {
    const el = $('eh-flights-guided-prompt');
    if (!el) return;
    if (fgState.busy) {
      el.textContent = 'Finding flights for you\u2026';
      el.hidden = false;
      el.removeAttribute('hidden');
      return;
    }
    if (fgState.done) {
      if (hubState.flightLeg === 'return') {
        el.textContent = 'Choose your return flight on your departure date';
      } else if (hubState.selectedOutboundFlight) {
        el.textContent = 'Outbound saved — now pick your return flight';
      } else {
        el.textContent = 'Choose your outbound flight to the event';
      }
      el.hidden = false;
      el.removeAttribute('hidden');
      return;
    }
    const stepDef = FG_STEP_OPTIONS[fgState.step];
    const q =
      String(fgState.currentQuestion || '').trim() ||
      (stepDef && stepDef.question) ||
      '';
    if (q) {
      el.textContent = q;
      el.hidden = false;
      el.removeAttribute('hidden');
    } else {
      el.textContent = '';
      el.hidden = true;
      el.setAttribute('hidden', '');
    }
  }

  function fgRenderVisaWarn(show, visaLimit) {
    const warn = $('eh-flights-guided-visa-warn');
    if (!warn) return;
    if (!show) {
      warn.textContent = '';
      warn.hidden = true;
      warn.setAttribute('hidden', '');
      return;
    }
    const x = visaLimit != null ? visaLimit : fgMalaysiaVisaLimitDays(fgGetUserHomeCountry());
    warn.textContent =
      '\u26a0\ufe0f Your visa allows ' +
      x +
      ' days in Malaysia. Selecting this would exceed your limit. Please choose a shorter stay.';
    warn.hidden = false;
    warn.removeAttribute('hidden');
  }

  function fgRenderChips() {
    const host = $('eh-flights-guided-chips');
    const wrap = $('eh-flights-guided-options');
    if (!host) return;
    host.innerHTML = '';
    if (fgState.busy || fgState.done) {
      fgRenderVisaWarn(false);
      if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute('hidden', '');
      }
      return;
    }
    const step = FG_STEP_OPTIONS[fgState.step];
    if (!step) {
      fgRenderVisaWarn(false);
      if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute('hidden', '');
      }
      return;
    }
    if (wrap) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
    }
    const visaLimit =
      fgState.step === 'stay' ? fgMalaysiaVisaLimitDays(fgGetUserHomeCountry()) : null;
    const daysBefore =
      fgState.answers.daysBefore != null ? fgState.answers.daysBefore : 0;
    let showVisaWarn = false;
    step.choices.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'eh-fg-chip';
      btn.textContent = opt.label;
      btn.dataset.fgStep = fgState.step;
      btn.dataset.fgId = opt.id;
      if (fgState.step === 'stay' && fgStayChoiceExceedsVisa(opt.daysAfter, daysBefore, visaLimit)) {
        btn.disabled = true;
        btn.classList.add('eh-fg-chip--visa-disabled');
        btn.setAttribute(
          'aria-label',
          opt.label + ' — exceeds ' + visaLimit + '-day visa-free stay',
        );
        showVisaWarn = true;
      }
      host.appendChild(btn);
    });
    fgRenderVisaWarn(showVisaWarn, visaLimit);
  }

  function fgSetResultsVisible(show) {
    const wrap = $('eh-flights-results-wrap');
    if (!wrap) return;
    if (show) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
      updateFlightsLegBar();
    } else {
      wrap.hidden = true;
      wrap.setAttribute('hidden', '');
    }
  }

  function fgRender() {
    fgRenderPrompt();
    fgRenderChips();
  }

  function fgOnPick(step, opt) {
    if (fgState.busy || fgState.done) return;

    if (step === 'arrive') {
      fgState.answers.daysBefore = opt.daysBefore;
      fgState.currentQuestion = FG_STEP_OPTIONS.stay.question;
      fgState.step = 'stay';
      fgRender();
      return;
    }

    if (step === 'stay') {
      const daysBefore =
        fgState.answers.daysBefore != null ? fgState.answers.daysBefore : 0;
      if (fgStayChoiceExceedsVisa(opt.daysAfter, daysBefore)) return;
      fgState.answers.daysAfter = opt.daysAfter;
      fgState.currentQuestion = FG_STEP_OPTIONS.pref.question;
      fgState.step = 'pref';
      fgRender();
      prefetchFlightsForCurrentDates();
      return;
    }

    if (step === 'pref') {
      fgState.answers.sortMode = opt.sortMode;
      fgState.answers.preferDirect = opt.preferDirect;
      fgState.currentQuestion = '';
      fgState.step = 'done';
      fgState.done = true;
      fgRender();
      fgSetResultsVisible(true);
      fgState.busy = true;
      fgRender();
      fgUpdateRestartButton();
      Promise.resolve(
        applyFlightsGuidedAnswers({
          daysBefore: fgState.answers.daysBefore,
          daysAfter: fgState.answers.daysAfter,
          sortMode: fgState.answers.sortMode || 'default',
          preferDirect: !!fgState.answers.preferDirect,
        }),
      ).finally(function () {
        fgState.busy = false;
        fgRender();
        fgUpdateRestartButton();
        setTripFlowMessage('Choose your outbound flight first, then your return flight on your departure date.');
        updateFlightsLegBar();
        syncHotelTabFromHub();
        updateTripFlowUi();
      });
    }
  }

  function fgUpdateRestartButton() {
    const restartBtn = $('eh-flights-guided-restart');
    if (!restartBtn) return;
    restartBtn.disabled = !!fgState.busy;
  }

  function fgReset() {
    ++hubState.flightSearchSeq;
    clearFlightPrefetchCache();
    fgState = {
      step: 'arrive',
      currentQuestion: FG_STEP_OPTIONS.arrive.question,
      answers: {},
      busy: false,
      done: false,
    };
    fgSetResultsVisible(false);
    const fr = $('eh-flights-results');
    if (fr) fr.innerHTML = '';
    hubState.lastFlightRows = [];
    resetFlightLegSelection();
    updateHubFlightSummaryUI();
    updateGenButtonStateHub();
    fgRender();
    fgUpdateRestartButton();
  }

  function fgInitHandlers() {
    const chips = $('eh-flights-guided-chips');
    if (!chips) return false;
    if (!fgInited) {
      chips.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-fg-step]');
        if (!btn || btn.disabled || fgState.busy) return;
        e.preventDefault();
        const step = btn.dataset.fgStep;
        const stepDef = FG_STEP_OPTIONS[step];
        if (!stepDef) return;
        const opt = stepDef.choices.find(function (o) {
          return o.id === btn.dataset.fgId;
        });
        if (!opt || btn.disabled) return;
        if (opt) fgOnPick(step, opt);
      });
      const restartBtn = $('eh-flights-guided-restart');
      if (restartBtn) {
        restartBtn.addEventListener('click', function () {
          if (fgState.busy) return;
          fgReset();
        });
      }
      fgInited = true;
    }
    fgUpdateRestartButton();
    return true;
  }

  function ensureFlightsGuidedUi() {
    if (!fgInitHandlers()) return false;
    fgRender();
    fgUpdateRestartButton();
    return true;
  }

  function resetFlightsGuidedForEvent(ev) {
    const key =
      (ev && (ev.id || ev.title || ev.url)) +
      '|' +
      String(ev && ev.date) +
      '|' +
      String(ev && ev.city);
    if (key && key === fgEventKey) return;
    fgEventKey = key;
    fgReset();
    resetHotelsGuidedForEvent(ev, true);
    hubState.tripFlowStep = 'flights';
    updateTripFlowUi();
  }

  function setTripFlowMessage(text) {
    const el = $('eh-trip-flow-status');
    if (!el) return;
    el.style.opacity = '0';
    window.setTimeout(function () {
      el.textContent = String(text || '').trim() || 'Take it one step at a time — no rush.';
      el.style.opacity = '1';
    }, 120);
  }

  function updateTripFlowUi() {
    const step = hubState.tripFlowStep || 'flights';
    const flightPicked = flightsRoundTripComplete();
    const hotelPicked =
      hubState.selectedHotel &&
      typeof hubState.selectedHotel === 'object' &&
      String(hubState.selectedHotel.name || '').trim().length >= 2;

    document.querySelectorAll('[data-trip-step]').forEach(function (li) {
      const s = li.getAttribute('data-trip-step');
      li.classList.remove('is-active', 'is-done');
      if (s === 'flights') {
        if (flightPicked) li.classList.add('is-done');
        else if (!flightPicked) li.classList.add('is-active');
      }
      if (s === 'hotels') {
        if (hotelPicked) li.classList.add('is-done');
        else if (flightPicked && !hotelPicked) li.classList.add('is-active');
      }
      if (s === 'itin') {
        if (flightPicked && hotelPicked) {
          if (step === 'itin') li.classList.add('is-active');
          else li.classList.add('is-done');
        }
      }
    });

    const skipBtn = $('eh-hotels-skip-to-itin');
    if (skipBtn) {
      const hgDone = !!hgState.done;
      const showSkip = hgDone && flightPicked && !hotelPicked;
      skipBtn.hidden = !showSkip;
      if (showSkip) skipBtn.removeAttribute('hidden');
      else skipBtn.setAttribute('hidden', '');
    }
  }

  function maybeShowTripReadyState() {
    const flightOk = flightsRoundTripComplete();
    const hotelOk =
      hubState.selectedHotel &&
      typeof hubState.selectedHotel === 'object' &&
      String(hubState.selectedHotel.name || '').trim().length >= 2;
    const banner = $('eh-trip-ready-banner');
    const genBtn = $('eh-gen-itin');
    const hint = $('eh-gen-hint');
    if (!flightOk || !hotelOk) {
      if (banner) {
        banner.hidden = true;
        banner.setAttribute('hidden', '');
      }
      if (genBtn) genBtn.classList.remove('eh-gen-itin--ready');
      if (hint && !flightOk) {
        hint.textContent =
          'On Flights, pick your outbound flight, then your return flight on your departure date.';
      } else if (hint && !hotelOk) {
        hint.textContent = 'Almost there — pick a hotel and we\u2019ll build your itinerary for you.';
      }
      hubState.tripFlowStep = flightOk ? 'hotels' : 'flights';
      updateTripFlowUi();
      return;
    }
    if (!hubState.itineraryVibes.length || !hubState.itineraryPace) {
      hubState.tripFlowStep = 'hotels';
      updateTripFlowUi();
      if (banner) {
        banner.hidden = true;
        banner.setAttribute('hidden', '');
      }
      if (genBtn) genBtn.classList.add('eh-gen-itin--ready');
      if (hint) {
        hint.textContent = 'Answer the two quick questions on the Hotels tab to craft your day.';
      }
      setTripFlowMessage('What\u2019s your vibe? Tap all that apply, then Continue.');
      return;
    }
    hubState.tripFlowStep = 'itin';
    updateTripFlowUi();
    if (banner) {
      banner.hidden = false;
      banner.removeAttribute('hidden');
    }
    if (genBtn) genBtn.classList.add('eh-gen-itin--ready');
    if (hint) hint.textContent = 'Your plan is ready to view on the Itinerary tab.';
    setTripFlowMessage('Trip plan generated.');
  }

  function transitionToTab(which, message) {
    setTripFlowMessage(message || '');
    ['flights', 'hotels', 'itin'].forEach(function (w) {
      const panel = $('eh-panel-' + w);
      if (panel) panel.classList.remove('eh-panel--enter');
    });
    setTab(which);
    const panel = $('eh-panel-' + which);
    if (panel) {
      panel.classList.add('eh-panel--enter');
      window.setTimeout(function () {
        panel.classList.remove('eh-panel--enter');
      }, 400);
    }
  }

  const HG_STEP_OPTIONS = {
    area: {
      question: 'Where would you like to stay?',
      choices: [
        { id: 'venue', label: 'Near the event venue', areaMode: 'venue' },
        { id: 'city', label: 'City centre', areaMode: 'city' },
        { id: 'flex', label: 'I\u2019m flexible', areaMode: 'flex' },
      ],
    },
    pref: {
      question: 'What matters most for your stay?',
      choices: [
        { id: 'budget', label: 'Cheapest First', sortMode: 'budget' },
        { id: 'rated', label: 'Highest rated', sortMode: 'luxury' },
        { id: 'comfort', label: 'Comfortable mid-range', sortMode: 'default' },
        { id: 'any', label: "Doesn't matter", sortMode: 'default' },
      ],
    },
    adults: {
      question: 'How many adults?',
      // No `choices` — rendered as a +/- stepper, not chips.
    },
    vibe: {
      question: 'What\u2019s your vibe? (tap all that apply)',
      choices: [
        { id: 'chill', label: 'Chill' },
        { id: 'adventurous', label: 'Adventurous' },
        { id: 'foodie', label: 'Foodie' },
        { id: 'cultural', label: 'Cultural' },
        { id: 'party', label: 'Party' },
      ],
    },
    pace: {
      question: 'How packed do you want your day?',
      choices: [
        { id: 'light', label: 'Light (2-3 activities)' },
        { id: 'balanced', label: 'Balanced (4-5 activities)' },
        { id: 'full_on', label: 'Full On (6+ activities)' },
      ],
    },
  };

  function getHgStepDef(step) {
    return HG_STEP_OPTIONS[step] || null;
  }

  let hgInited = false;
  let hgEventKey = '';
  let hgState = {
    step: 'area',
    currentQuestion: '',
    answers: {},
    busy: false,
    done: false,
  };

  function buildHotelQueryForArea(areaMode) {
    return hotelSerpQueryFromHub(areaMode);
  }

  function hgRenderPrompt() {
    const el = $('eh-hotels-guided-prompt');
    if (!el) return;
    if (hgState.busy) {
      el.textContent = 'Finding stays for you\u2026';
      el.hidden = false;
      el.removeAttribute('hidden');
      return;
    }
    if (hgState.step === 'pick_hotel') {
      el.textContent = isSameDayTrip()
        ? 'Day trip — pick a hotel below, or skip if you\u2019re only visiting for the day'
        : 'Pick a hotel below';
      el.hidden = false;
      el.removeAttribute('hidden');
      return;
    }
    if (hgState.step === 'itin_generating') {
      el.textContent = 'Crafting your perfect day\u2026';
      el.hidden = false;
      el.removeAttribute('hidden');
      return;
    }
    const stepDef = getHgStepDef(hgState.step);
    const q =
      String(hgState.currentQuestion || '').trim() ||
      (stepDef && stepDef.question) ||
      '';
    if (q) {
      el.textContent = q;
      el.hidden = false;
      el.removeAttribute('hidden');
    } else {
      el.textContent = '';
      el.hidden = true;
      el.setAttribute('hidden', '');
    }
  }

  const HG_ADULTS_MIN = 1;
  const HG_ADULTS_MAX = 10;

  function hgRenderChips() {
    const host = $('eh-hotels-guided-chips');
    const wrap = $('eh-hotels-guided-options');
    if (!host) return;
    host.innerHTML = '';
    host.className = 'eh-fg-chips';
    if (
      hgState.busy ||
      hgState.step === 'pick_hotel' ||
      hgState.step === 'itin_generating'
    ) {
      if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute('hidden', '');
      }
      return;
    }
    const step = getHgStepDef(hgState.step);
    if (!step) {
      if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute('hidden', '');
      }
      return;
    }
    if (wrap) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
    }

    // Adults step: minus / number / plus counter + Continue (not chip choices).
    if (hgState.step === 'adults') {
      host.className = 'eh-fg-chips eh-fg-chips--adults';
      const cur = Math.max(
        HG_ADULTS_MIN,
        Math.min(HG_ADULTS_MAX, parseInt(hgState.answers.adults, 10) || HG_ADULTS_MIN),
      );
      hgState.answers.adults = cur;

      const counter = document.createElement('div');
      counter.className = 'eh-fg-counter';
      counter.setAttribute('role', 'group');
      counter.setAttribute('aria-label', 'Number of guests');

      const dec = document.createElement('button');
      dec.type = 'button';
      dec.className = 'eh-fg-counter__btn';
      dec.textContent = '−';
      dec.dataset.hgAction = 'adults-dec';
      dec.disabled = cur <= HG_ADULTS_MIN;
      dec.setAttribute('aria-label', 'Decrease guest count');
      counter.appendChild(dec);

      const val = document.createElement('span');
      val.className = 'eh-fg-counter__value';
      val.textContent = String(cur);
      val.dataset.hgRole = 'adults-val';
      val.setAttribute('aria-live', 'polite');
      val.setAttribute('aria-atomic', 'true');
      counter.appendChild(val);

      const inc = document.createElement('button');
      inc.type = 'button';
      inc.className = 'eh-fg-counter__btn';
      inc.textContent = '+';
      inc.dataset.hgAction = 'adults-inc';
      inc.disabled = cur >= HG_ADULTS_MAX;
      inc.setAttribute('aria-label', 'Increase guest count');
      counter.appendChild(inc);

      host.appendChild(counter);

      const cont = document.createElement('button');
      cont.type = 'button';
      cont.className = 'eh-fg-chip eh-fg-chip--continue';
      cont.textContent = 'Continue';
      cont.dataset.hgAction = 'adults-continue';
      host.appendChild(cont);
      return;
    }

    const selectedVibes =
      hgState.step === 'vibe' && Array.isArray(hubState.itineraryVibes) ? hubState.itineraryVibes : [];
    step.choices.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isVibeSelected = hgState.step === 'vibe' && selectedVibes.indexOf(opt.id) >= 0;
      btn.className = 'eh-fg-chip' + (isVibeSelected ? ' eh-fg-chip--selected' : '');
      btn.textContent = (isVibeSelected ? '\u2713 ' : '') + opt.label;
      btn.dataset.hgStep = hgState.step;
      btn.dataset.hgId = opt.id;
      btn.setAttribute('aria-pressed', isVibeSelected ? 'true' : 'false');
      host.appendChild(btn);
    });
    if (hgState.step === 'vibe') {
      const cont = document.createElement('button');
      cont.type = 'button';
      cont.className = 'eh-fg-chip eh-fg-chip--continue';
      cont.textContent = 'Continue';
      cont.dataset.hgAction = 'vibe-continue';
      cont.disabled = selectedVibes.length === 0;
      cont.style.gridColumn = '1 / -1';
      host.appendChild(cont);
    }
  }

  function hgSetResultsVisible(show) {
    const wrap = $('eh-hotels-results-wrap');
    if (!wrap) return;
    if (show) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
    } else {
      wrap.hidden = true;
      wrap.setAttribute('hidden', '');
    }
  }

  function hgRender() {
    hgRenderPrompt();
    hgRenderChips();
  }

  function getEffectiveHotelSortMode() {
    if (hgState.answers && hgState.answers.sortMode) {
      return hgState.answers.sortMode;
    }
    return hubState.hotelSortMode || 'default';
  }

  function applyHotelsGuidedAnswers(ans) {
    const a = ans || {};
    const areaMode = a.areaMode || 'flex';
    const sortMode = a.sortMode === 'budget' || a.sortMode === 'luxury' ? a.sortMode : 'default';
    const adults = Math.max(1, Math.min(9, parseInt(a.adults, 10) || 1));
    hubState.hotelSortMode = sortMode;
    hubState.hotelAdults = adults;
    hgState.answers.sortMode = sortMode;
    hgState.answers.adults = adults;
    syncHotelTabFromHub();
    const hq = $('eh-hotel-q');
    if (hq) hq.value = buildHotelQueryForArea(areaMode);
    hubState.tripFlowStep = 'hotels';
    updateTripFlowUi();
    return searchGoogleHotelsSerp();
  }

  function hgOnPick(step, opt) {
    if (hgState.busy || hgState.step === 'itin_generating') return;

    if (step === 'area') {
      hgState.answers.areaMode = opt.areaMode;
      hgState.currentQuestion = HG_STEP_OPTIONS.pref.question;
      hgState.step = 'pref';
      hgRender();
      return;
    }

    if (step === 'pref') {
      hgState.answers.sortMode = opt.sortMode;
      if (hgState.answers.adults == null) hgState.answers.adults = 1;
      hgState.currentQuestion = HG_STEP_OPTIONS.adults.question;
      hgState.step = 'adults';
      hgRender();
      setTripFlowMessage('How many adults are travelling?');
      return;
    }

    if (step === 'vibe') {
      if (!Array.isArray(hubState.itineraryVibes)) hubState.itineraryVibes = [];
      const idx = hubState.itineraryVibes.indexOf(opt.id);
      if (idx >= 0) hubState.itineraryVibes.splice(idx, 1);
      else hubState.itineraryVibes.push(opt.id);
      hgRender();
      setTripFlowMessage(
        hubState.itineraryVibes.length
          ? hubState.itineraryVibes.length + ' vibe(s) selected — tap Continue when ready.'
          : 'Pick at least one vibe, then Continue.',
      );
      return;
    }

    if (step === 'pace') {
      hubState.itineraryPace = opt.id;
      hgState.step = 'itin_generating';
      hgState.busy = true;
      hgRender();
      setTripFlowMessage('Crafting your perfect day\u2026');
      void generateItineraryFromHub().finally(function () {
        hgState.busy = false;
      });
    }
  }

  function beginItinQuestionsAfterHotel() {
    ensureHotelsGuidedUi();
    hubState.itineraryVibes = [];
    hubState.itineraryPace = null;
    hgState.step = 'vibe';
    hgState.currentQuestion = HG_STEP_OPTIONS.vibe.question;
    hgState.busy = false;
    hgSetResultsVisible(false);
    hgRender();
    setTripFlowMessage('Two quick questions \u2014 then we\u2019ll craft your day.');
    hubState.tripFlowStep = 'hotels';
    updateTripFlowUi();
    if ($('eh-tab-hotels')?.getAttribute('aria-selected') !== 'true') {
      setTab('hotels');
    }
    requestAnimationFrame(function () {
      const guided = $('eh-hotels-guided');
      if (guided && typeof guided.scrollIntoView === 'function') {
        guided.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function hgUpdateRestartButton() {
    const restartBtn = $('eh-hotels-guided-restart');
    if (!restartBtn) return;
    restartBtn.disabled = !!hgState.busy;
  }

  function hgReset() {
    ++hubState.hotelSearchSeq;
    hgState = {
      step: 'area',
      currentQuestion: HG_STEP_OPTIONS.area.question,
      answers: { adults: 1 },
      busy: false,
      done: false,
    };
    hubState.hotelAdults = 1;
    hgSetResultsVisible(false);
    const hr = $('eh-hotels-results');
    if (hr) hr.innerHTML = '';
    hubState.lastHotelRows = [];
    hubState.selectedHotel = null;
    hubState.itineraryVibes = [];
    hubState.itineraryPace = null;
    updateHubHotelSummaryUI();
    updateGenButtonStateHub();
    maybeShowTripReadyState();
    hgRender();
    hgUpdateRestartButton();
  }

  function hgInitHandlers() {
    const chips = $('eh-hotels-guided-chips');
    if (!chips) return false;
    if (!hgInited) {
      chips.addEventListener('click', function (e) {
        const continueBtn = e.target.closest('[data-hg-action="vibe-continue"]');
        if (continueBtn) {
          if (continueBtn.disabled || hgState.busy || hgState.step !== 'vibe') return;
          e.preventDefault();
          if (!hubState.itineraryVibes.length) {
            setTripFlowMessage('Pick at least one vibe first.');
            return;
          }
          hgState.step = 'pace';
          hgState.currentQuestion = HG_STEP_OPTIONS.pace.question;
          hgRender();
          setTripFlowMessage('How packed should your days be?');
          return;
        }
        const adultsBtn = e.target.closest(
          '[data-hg-action="adults-inc"],[data-hg-action="adults-dec"],[data-hg-action="adults-continue"]',
        );
        if (adultsBtn) {
          if (adultsBtn.disabled || hgState.busy || hgState.step !== 'adults') return;
          e.preventDefault();
          const action = adultsBtn.dataset.hgAction;
          const cur = Math.max(
            HG_ADULTS_MIN,
            Math.min(HG_ADULTS_MAX, parseInt(hgState.answers.adults, 10) || HG_ADULTS_MIN),
          );
          if (action === 'adults-inc') {
            hgState.answers.adults = Math.min(HG_ADULTS_MAX, cur + 1);
            hgRender();
            return;
          }
          if (action === 'adults-dec') {
            hgState.answers.adults = Math.max(HG_ADULTS_MIN, cur - 1);
            hgRender();
            return;
          }
          // adults-continue → kick off the hotel search with chosen adults.
          hgState.currentQuestion = '';
          hgState.step = 'pick_hotel';
          hgState.done = true;
          hgRender();
          hgSetResultsVisible(true);
          hgState.busy = true;
          hgRender();
          hgUpdateRestartButton();
          Promise.resolve(
            applyHotelsGuidedAnswers({
              areaMode: hgState.answers.areaMode || 'flex',
              sortMode: hgState.answers.sortMode || 'default',
              adults: hgState.answers.adults || 1,
            }),
          ).finally(function () {
            hgState.busy = false;
            hgRender();
            hgUpdateRestartButton();
            setTripFlowMessage('Pick a hotel below.');
            maybeShowTripReadyState();
          });
          return;
        }
        const btn = e.target.closest('[data-hg-step]');
        if (!btn || btn.disabled || hgState.busy) return;
        e.preventDefault();
        const step = btn.dataset.hgStep;
        const stepDef = getHgStepDef(step);
        if (!stepDef) return;
        const opt = stepDef.choices.find(function (o) {
          return o.id === btn.dataset.hgId;
        });
        if (opt) hgOnPick(step, opt);
      });
      const restartBtn = $('eh-hotels-guided-restart');
      if (restartBtn) {
        restartBtn.addEventListener('click', function () {
          if (hgState.busy) return;
          hgReset();
        });
      }
      const skipBtn = $('eh-hotels-skip-to-itin');
      if (skipBtn) {
        skipBtn.addEventListener('click', function () {
          transitionToTab('itin', 'You can add a hotel later — your plan is on the Itinerary tab.');
        });
      }
      hgInited = true;
    }
    hgUpdateRestartButton();
    return true;
  }

  function ensureHotelsGuidedUi() {
    if (!hgInitHandlers()) return false;
    hgRender();
    hgUpdateRestartButton();
    return true;
  }

  function resetHotelsGuidedForEvent(ev, force) {
    const key =
      (ev && (ev.id || ev.title || ev.url)) +
      '|' +
      String(ev && ev.date) +
      '|' +
      String(ev && ev.city);
    if (!force && key && key === hgEventKey) return;
    hgEventKey = key;
    hgReset();
  }

  function showHubScreen(which) {
    const dna = $('eh-screen-dna');
    const trip = $('eh-screen-trip');
    const hero = $('eh-hero-bar');
    const isTrip = which === 'trip';
    if (dna) {
      dna.hidden = isTrip;
      if (isTrip) dna.setAttribute('hidden', '');
      else dna.removeAttribute('hidden');
    }
    if (trip) {
      trip.hidden = !isTrip;
      if (isTrip) trip.removeAttribute('hidden');
      else trip.setAttribute('hidden', '');
    }
    if (hero) {
      hero.classList.toggle('eh-hero-bar--compact', isTrip);
    }
    updateEventHubHeroParallax();
    const badge = $('eh-hero-match-badge');
    if (badge && !isTrip) {
      badge.hidden = true;
      badge.setAttribute('hidden', '');
    } else if (badge && isTrip && hubState.event) {
      updateHeroMatchBadge(hubState.event.fanDnaScore);
    }
    if (isTrip) {
      updateTripStepCards(hubState.tripFlowStep || 'flights');
      updateTripNavUi(hubState.tripFlowStep || 'flights');
      updateFlightsSectionLabel();
    }
    requestAnimationFrame(updateEventHubScrollHint);
  }

  function updateHeroMatchBadge(score) {
    const badge = $('eh-hero-match-badge');
    if (!badge) return;
    if (score != null && Number.isFinite(Number(score))) {
      const n = Math.round(Number(score));
      const tier =
        typeof window.matchTierForScore === 'function'
          ? window.matchTierForScore(n)
          : n > 75
            ? 'high'
            : n >= 50
              ? 'med'
              : 'low';
      badge.textContent = n + '% match';
      badge.className = 'eh-hero-bar__match-badge eh-dna-tier--' + tier;
      badge.hidden = false;
      badge.removeAttribute('hidden');
    } else {
      badge.textContent = '';
      badge.hidden = true;
      badge.setAttribute('hidden', '');
    }
  }

  function updateHeroMeta(ev) {
    const loc = $('eh-hero-loc-text');
    const date = $('eh-hero-date-text');
    const price = $('eh-hero-price-text');
    if (loc) {
      loc.textContent = [ev.venue, ev.city].filter(Boolean).join(', ') || 'Location TBA';
    }
    if (date) {
      date.textContent = ev.date ? new Date(ev.date).toDateString() : 'Date TBA';
    }
    if (price) {
      price.textContent = ev.isFree ? 'Free' : ev.price || 'Paid';
    }
  }

  function updateFlightsSectionLabel() {
    const label = $('eh-flights-section-label');
    if (!label) return;
    const ev = hubState.event || {};
    const city = String(ev.city || 'your destination').trim() || 'your destination';
    const onFlights = (hubState.tripFlowStep || 'flights') === 'flights';
    label.textContent = 'Select your flight to ' + city;
    label.hidden = !onFlights;
    if (onFlights) label.removeAttribute('hidden');
    else label.setAttribute('hidden', '');
  }

  function updateTripStepCards(step) {
    document.querySelectorAll('.eh-step-card[data-eh-step]').forEach(function (btn) {
      const on = btn.getAttribute('data-eh-step') === step;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function updateTripNavUi(step) {
    const dots = $('eh-trip-nav-dots');
    const nextBtn = $('eh-btn-trip-next');
    const dotIndex = step === 'flights' ? 1 : step === 'hotels' ? 2 : 3;
    if (dots) {
      dots.querySelectorAll('.eh-dna-dot').forEach(function (dot, i) {
        dot.classList.toggle('is-active', i === dotIndex);
      });
    }
    if (nextBtn) {
      if (step === 'flights') {
        nextBtn.textContent = 'Hotels →';
        nextBtn.hidden = false;
        nextBtn.removeAttribute('hidden');
      } else if (step === 'hotels') {
        nextBtn.textContent = 'Itinerary →';
        nextBtn.hidden = false;
        nextBtn.removeAttribute('hidden');
      } else {
        nextBtn.hidden = true;
        nextBtn.setAttribute('hidden', '');
      }
    }
  }

  function resolveEventDnaMatch(ev) {
    if (ev.dnaMatch && ev.dnaMatch.complete) return ev.dnaMatch;
    if (
      typeof window.calculateDnaMatch === 'function' &&
      window.__hubUserDna &&
      ev.event_dna
    ) {
      return window.calculateDnaMatch(window.__hubUserDna, ev.event_dna);
    }
    if (typeof window.calculateDnaMatch === 'function' && window.__hubUserDna && ev.dnaMatch) {
      return ev.dnaMatch;
    }
    return ev.dnaMatch || null;
  }

  function fetchMatchExplanation(ev, match) {
    if (!match || !match.complete || match.explanation) return;
    const key = ev.url ? String(ev.url) : ev.id != null ? String(ev.id) : '';
    if (!key) return;
    fetch(
      '/api/fan-dna/match-explanation?url=' + encodeURIComponent(key) + '&_=' + Date.now(),
      { credentials: 'same-origin', cache: 'no-store' },
    )
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.explanation || hubState.event !== ev) return;
        match.explanation = data.explanation;
        ev.dnaMatch = match;
        var el = document.getElementById('eh-dna-match-desc') || document.querySelector('.eh-dna-why__a');
        if (el) el.textContent = data.explanation;
      })
      .catch(function () {});
  }

  // Feature 3 — "Who usually attends" persona tags inferred from the event's text.
  // Each def matches keywords against the event title/description/category/venue.
  var PERSONA_KEYWORD_DEFS = [
    { icon: '🎤', label: 'K-Pop fans', keywords: ['k-pop', 'kpop', 'k pop', 'bts', 'blackpink', 'twice', 'seventeen', 'stray kids', 'nct', 'korean pop'] },
    { icon: '🀄', label: 'Anime & manga community', keywords: ['anime', 'manga', 'cosplay', 'otaku', 'comic con', 'comiccon', 'comic-con', 'comicon', 'j-pop', 'jpop'] },
    { icon: '💻', label: 'Tech enthusiasts', keywords: ['tech', 'technology', ' ai ', 'a.i.', 'artificial intelligence', 'developer', 'coding', 'hackathon', 'blockchain', 'crypto', 'web3', 'software', 'robotics', 'gadget', 'innovation', 'data', 'cloud', 'devops', 'saas'] },
    { icon: '🚀', label: 'Startup founders & entrepreneurs', keywords: ['startup', 'start-up', 'entrepreneur', 'founder', 'pitch', 'investor', 'venture', 'incubator', 'accelerator'] },
    { icon: '💼', label: 'Young professionals', keywords: ['networking', 'career', 'professional', 'business', 'conference', 'summit', 'seminar', 'corporate', 'leadership', 'mba'] },
    { icon: '🌍', label: 'International travelers', keywords: ['international', 'world', 'global', 'expat', 'tourism', 'tourist', 'travel', 'cross-border', 'worldwide'] },
    { icon: '👨‍👩‍👧', label: 'Families with children', keywords: ['family', 'families', 'kids', 'kid', 'children', 'child', 'family-friendly', 'family friendly', 'toddler', 'parent'] },
    { icon: '🎶', label: 'Live music fans', keywords: ['concert', 'live music', 'band', 'gig', 'festival', ' dj', 'orchestra', 'symphony', 'acoustic', 'singer', 'tour'] },
    { icon: '🍽️', label: 'Foodies & tastemakers', keywords: ['food', 'culinary', 'tasting', 'dining', 'restaurant', 'gastronomy', 'wine', 'beer', 'coffee', 'street food', 'chef', 'cuisine', 'brunch'] },
    { icon: '🎭', label: 'Art & culture lovers', keywords: ['art', 'gallery', 'exhibition', 'museum', 'culture', 'cultural', 'heritage', 'theatre', 'theater', 'painting', 'sculpture', 'craft'] },
    { icon: '🧘', label: 'Wellness & fitness seekers', keywords: ['yoga', 'wellness', 'fitness', 'marathon', 'meditation', 'health', 'retreat', 'pilates', 'workout', 'mindfulness', 'spa'] },
    { icon: '🌿', label: 'Nature & outdoor lovers', keywords: ['hiking', 'hike', 'nature', 'outdoor', 'camping', 'beach', 'park', 'trail', 'adventure', 'mountain', 'eco'] },
    { icon: '🏆', label: 'Sports fans', keywords: ['football', 'basketball', 'sports', 'match', 'tournament', 'race', 'cup', 'league', 'badminton', 'tennis', 'golf', 'cycling', 'esports'] },
    { icon: '🎮', label: 'Gamers', keywords: ['gaming', 'esports', 'e-sports', 'video game', 'playstation', 'xbox', 'nintendo', 'arcade', 'lan party'] },
    { icon: '🌃', label: 'Nightlife & party crowd', keywords: ['party', 'nightlife', 'club', 'rave', 'night', 'lounge', 'afterparty', 'edm', 'techno', 'house music'] },
    { icon: '😂', label: 'Comedy fans', keywords: ['comedy', 'standup', 'stand-up', 'stand up', 'comedian', 'improv'] },
    { icon: '🎬', label: 'Film & cinema buffs', keywords: ['film', 'cinema', 'movie', 'screening', 'premiere', 'documentary', 'short film'] },
    { icon: '👗', label: 'Fashion & lifestyle crowd', keywords: ['fashion', 'runway', 'style', 'beauty', 'lifestyle', 'designer', 'catwalk', 'makeup'] },
    { icon: '📸', label: 'Photography enthusiasts', keywords: ['photography', 'photo', 'camera', 'photowalk', 'photographer'] },
    { icon: '🎓', label: 'Students & learners', keywords: ['student', 'university', 'college', 'education', 'workshop', 'class', 'course', 'lecture', 'bootcamp', 'training', 'masterclass'] },
    { icon: '📚', label: 'Book & literature lovers', keywords: ['book', 'author', 'poetry', 'literature', 'reading', 'writer', 'storytelling'] },
    { icon: '🙏', label: 'Faith & community groups', keywords: ['worship', 'church', 'faith', 'gospel', 'spiritual', 'charity', 'fundraiser', 'community'] },
  ];

  // DNA-trait based tags used only as a secondary source when event_dna exists.
  var PERSONA_TAG_DEFS = [
    { trait: 'family_friendly', min: 6, icon: '👨‍👩‍👧', label: 'Families with children' },
    { trait: 'networking', min: 6, icon: '💼', label: 'Young professionals' },
    { trait: 'social', min: 6, icon: '🎉', label: 'Social & outgoing crowd' },
    { trait: 'energy_level', min: 7, icon: '⚡', label: 'High-energy fans' },
    { trait: 'entertainment', min: 7, icon: '🎭', label: 'Entertainment lovers' },
    { trait: 'educational', min: 6, icon: '📚', label: 'Curious learners' },
    { trait: 'outdoor', min: 6, icon: '🌿', label: 'Nature & outdoor lovers' },
  ];

  var CATEGORY_PERSONA_FALLBACK = {
    music: [
      { icon: '🎶', label: 'Live music fans' },
      { icon: '🎉', label: 'Social & outgoing crowd' },
    ],
    arts_culture: [
      { icon: '🎭', label: 'Art & culture lovers' },
      { icon: '📚', label: 'Curious learners' },
    ],
    networking: [
      { icon: '💼', label: 'Young professionals' },
      { icon: '🚀', label: 'Startup founders & entrepreneurs' },
    ],
    nature_outdoors: [
      { icon: '🌿', label: 'Nature & outdoor lovers' },
      { icon: '🧘', label: 'Wellness & fitness seekers' },
    ],
    sports: [
      { icon: '🏆', label: 'Sports fans' },
      { icon: '⚡', label: 'High-energy fans' },
    ],
    food_drink: [
      { icon: '🍽️', label: 'Foodies & tastemakers' },
      { icon: '🎉', label: 'Social & outgoing crowd' },
    ],
  };

  var DEFAULT_PERSONA_FALLBACK = [
    { icon: '🎟️', label: 'Curious explorers' },
    { icon: '🙌', label: 'Local event-goers' },
  ];

  function eventPersonaText(ev) {
    if (!ev) return '';
    var parts = [
      ev.title,
      ev.name,
      ev.category,
      ev.venue,
      ev.city,
      ev.summary,
      ev.description,
    ];
    if (Array.isArray(ev.tags)) parts = parts.concat(ev.tags);
    if (Array.isArray(ev.genres)) parts = parts.concat(ev.genres);
    return ' ' + parts.filter(Boolean).join(' ').toLowerCase() + ' ';
  }

  function pushUniqueTag(list, tag) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].label === tag.label) return;
    }
    list.push(tag);
  }

  function buildPersonaTags(ev) {
    var text = eventPersonaText(ev);
    var scored = [];
    PERSONA_KEYWORD_DEFS.forEach(function (def) {
      var hits = 0;
      def.keywords.forEach(function (kw) {
        if (text.indexOf(kw) >= 0) hits += 1;
      });
      if (hits > 0) scored.push({ icon: def.icon, label: def.label, hits: hits });
    });
    scored.sort(function (a, b) {
      return b.hits - a.hits;
    });

    var tags = [];
    scored.forEach(function (t) {
      pushUniqueTag(tags, { icon: t.icon, label: t.label });
    });

    // Secondary: DNA-trait tags, if the event has a DNA profile.
    var dna = ev && ev.event_dna ? ev.event_dna : null;
    if (dna && typeof dna === 'object') {
      var dnaTags = [];
      PERSONA_TAG_DEFS.forEach(function (def) {
        var score = Number(dna[def.trait]);
        if (!isNaN(score) && score >= def.min) {
          dnaTags.push({ icon: def.icon, label: def.label, score: score });
        }
      });
      dnaTags.sort(function (a, b) {
        return b.score - a.score;
      });
      dnaTags.forEach(function (t) {
        pushUniqueTag(tags, { icon: t.icon, label: t.label });
      });
    }

    if (tags.length < 2) {
      var cat = String((ev && ev.category) || '').toLowerCase();
      var fallback = CATEGORY_PERSONA_FALLBACK[cat] || DEFAULT_PERSONA_FALLBACK;
      fallback.forEach(function (t) {
        pushUniqueTag(tags, { icon: t.icon, label: t.label });
      });
    }

    return tags.slice(0, 5);
  }

  function buildPersonaCardHtml(ev) {
    var tags = buildPersonaTags(ev);
    if (!tags.length) return '';
    var chips = tags
      .map(function (t) {
        return (
          '<span class="eh-persona-tag">' +
          '<span class="eh-persona-tag__icon" aria-hidden="true">' +
          t.icon +
          '</span>' +
          escapeHtml(t.label) +
          '</span>'
        );
      })
      .join('');
    return (
      '<div class="eh-dna-block eh-persona-card">' +
      '<h3 class="eh-dna-block__title">Who usually attends</h3>' +
      '<div class="eh-persona-tags">' +
      chips +
      '</div>' +
      '</div>'
    );
  }

  // Feature 4 — Expected Crowd Match (real aggregation from interested users).
  function crowdEventQuery(ev) {
    if (!ev) return '';
    const parts = [];
    if (ev.id != null && ev.id !== '') parts.push('eventId=' + encodeURIComponent(String(ev.id)));
    if (ev.url) parts.push('url=' + encodeURIComponent(String(ev.url)));
    if (ev.title) parts.push('name=' + encodeURIComponent(String(ev.title)));
    if (ev.category) parts.push('category=' + encodeURIComponent(String(ev.category)));
    return parts.join('&');
  }

  function renderCrowdCard(data) {
    const card = $('eh-crowd-card');
    if (!card) return;
    if (!data || !data.enoughData || !Array.isArray(data.stats) || !data.stats.length) {
      const interested = data && data.interested ? data.interested : 0;
      const min = (data && data.min) || 5;
      card.innerHTML =
        '<h3 class="eh-dna-block__title">Expected crowd</h3>' +
        '<p class="eh-crowd-empty">Not enough data yet to estimate the crowd.' +
        (interested
          ? ' <span class="eh-crowd-empty__sub">' +
            escapeHtml(String(interested)) +
            ' interested so far — need ' +
            escapeHtml(String(min)) +
            '+.</span>'
          : '') +
        '</p>';
      return;
    }
    const bars = data.stats
      .map(function (s) {
        const pct = Math.max(0, Math.min(100, Number(s.pct) || 0));
        return (
          '<div class="eh-crowd-row">' +
          '<span class="eh-crowd-row__label">' +
          escapeHtml(s.label) +
          '</span>' +
          '<span class="eh-crowd-row__track"><span class="eh-crowd-row__fill" style="width:' +
          pct +
          '%"></span></span>' +
          '<span class="eh-crowd-row__pct">' +
          pct +
          '%</span>' +
          '</div>'
        );
      })
      .join('');
    card.innerHTML =
      '<h3 class="eh-dna-block__title">Expected crowd</h3>' +
      '<div class="eh-crowd-rows">' +
      bars +
      '</div>' +
      (data.note ? '<p class="eh-crowd-note">' + escapeHtml(data.note) + '</p>' : '');
  }

  function fetchCrowdMatch(ev) {
    const card = $('eh-crowd-card');
    if (!card || !ev) return;
    const qs = crowdEventQuery(ev);
    if (!qs) return;
    fetch('/api/event/crowd-match?' + qs, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (hubState.event !== ev) return;
        renderCrowdCard(data);
      })
      .catch(function () {
        if (hubState.event !== ev) return;
        renderCrowdCard(null);
      });
  }

  var CROWD_PROFESSION_OPTS = [
    { id: 'working', label: 'Working professional' },
    { id: 'student', label: 'Student' },
    { id: 'other', label: 'Other' },
  ];
  var CROWD_AGE_OPTS = [
    { id: 'under_18', label: 'Under 18' },
    { id: '18_24', label: '18\u201324' },
    { id: '25_34', label: '25\u201334' },
    { id: '35_44', label: '35\u201344' },
    { id: '45_plus', label: '45+' },
  ];

  function dismissCrowdPrompt() {
    try {
      sessionStorage.setItem('eh_crowd_prompt_dismissed', '1');
    } catch (e) {}
    const bar = document.getElementById('eh-crowd-prompt');
    if (bar) bar.remove();
  }

  function openCrowdProfileModal() {
    if (document.getElementById('eh-crowd-modal')) return;
    const picked = { profession: null, age_group: null };

    function optButtons(opts, key) {
      return opts
        .map(function (o) {
          return (
            '<button type="button" class="eh-crowd-opt" data-key="' +
            key +
            '" data-id="' +
            o.id +
            '">' +
            escapeHtml(o.label) +
            '</button>'
          );
        })
        .join('');
    }

    const overlay = document.createElement('div');
    overlay.id = 'eh-crowd-modal';
    overlay.className = 'eh-crowd-modal';
    overlay.innerHTML =
      '<div class="eh-crowd-modal__box" role="dialog" aria-modal="true" aria-label="Quick profile">' +
      '<button type="button" class="eh-crowd-modal__close" aria-label="Close">\u00d7</button>' +
      '<h3 class="eh-crowd-modal__title">2 quick questions</h3>' +
      '<p class="eh-crowd-modal__sub">Helps us show who usually attends each event.</p>' +
      '<p class="eh-crowd-modal__q">What best describes you?</p>' +
      '<div class="eh-crowd-opts" data-group="profession">' +
      optButtons(CROWD_PROFESSION_OPTS, 'profession') +
      '</div>' +
      '<p class="eh-crowd-modal__q">Your age group?</p>' +
      '<div class="eh-crowd-opts" data-group="age_group">' +
      optButtons(CROWD_AGE_OPTS, 'age_group') +
      '</div>' +
      '<p class="eh-crowd-modal__msg" id="eh-crowd-modal-msg"></p>' +
      '<button type="button" class="eh-crowd-modal__save" id="eh-crowd-modal-save" disabled>Save</button>' +
      '</div>';
    document.body.appendChild(overlay);

    const saveBtn = overlay.querySelector('#eh-crowd-modal-save');
    const msg = overlay.querySelector('#eh-crowd-modal-msg');

    function refreshSave() {
      saveBtn.disabled = !(picked.profession && picked.age_group);
    }

    overlay.querySelectorAll('.eh-crowd-opt').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-key');
        picked[key] = btn.getAttribute('data-id');
        overlay
          .querySelectorAll('.eh-crowd-opt[data-key="' + key + '"]')
          .forEach(function (b) {
            b.classList.remove('is-on');
          });
        btn.classList.add('is-on');
        refreshSave();
      });
    });

    function closeModal() {
      overlay.remove();
    }
    overlay.querySelector('.eh-crowd-modal__close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    saveBtn.addEventListener('click', function () {
      if (!(picked.profession && picked.age_group)) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      if (msg) msg.textContent = '';
      fetch('/api/fan-dna/crowd-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(picked),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, j: j };
          });
        })
        .then(function (x) {
          if (!x.ok) {
            if (msg) msg.textContent = (x.j && x.j.error) || 'Could not save. Try again.';
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            return;
          }
          closeModal();
          dismissCrowdPrompt();
        })
        .catch(function () {
          if (msg) msg.textContent = 'Network error. Try again.';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        });
    });
  }

  function showCrowdProfileBanner() {
    if (document.getElementById('eh-crowd-prompt')) return;
    const bar = document.createElement('div');
    bar.id = 'eh-crowd-prompt';
    bar.className = 'eh-crowd-prompt';
    bar.innerHTML =
      '<span class="eh-crowd-prompt__text">Help us show who attends each event \u2014 answer 2 quick questions.</span>' +
      '<button type="button" class="eh-crowd-prompt__cta" id="eh-crowd-prompt-cta">Answer now</button>' +
      '<button type="button" class="eh-crowd-prompt__close" aria-label="Dismiss">\u00d7</button>';
    document.body.appendChild(bar);
    const cta = bar.querySelector('#eh-crowd-prompt-cta');
    if (cta) cta.addEventListener('click', openCrowdProfileModal);
    const closeBtn = bar.querySelector('.eh-crowd-prompt__close');
    if (closeBtn) closeBtn.addEventListener('click', dismissCrowdPrompt);
  }

  function maybePromptCrowdProfile() {
    try {
      if (sessionStorage.getItem('eh_crowd_prompt_dismissed') === '1') return;
    } catch (e) {}
    fetch('/api/fan-dna/preferences?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data || !data.complete) return;
        const prefs = data.preferences || {};
        if (prefs.profession && prefs.age_group) return;
        showCrowdProfileBanner();
      })
      .catch(function () {});
  }

  function paintDnaPanel(ev) {
    const dnaPanel = $('eh-dna-panel');
    if (!dnaPanel) return;
    const match = resolveEventDnaMatch(ev);
    const score = match && match.score != null ? match.score : ev.fanDnaScore;
    if ($('eh-screen-trip') && !$('eh-screen-trip').hidden) {
      updateHeroMatchBadge(score);
    }
    if (typeof window.buildDnaMatchDetailHtml === 'function') {
      dnaPanel.innerHTML = window.buildDnaMatchDetailHtml(match, score);
    } else if (score != null) {
      dnaPanel.innerHTML =
        '<div class="eh-dna-card eh-dna-card--prompt"><p class="eh-dna-prompt-title">' +
        escapeHtml(String(score)) +
        '% match</p></div>';
    } else {
      dnaPanel.innerHTML =
        '<div class="eh-dna-card eh-dna-card--prompt"><p class="eh-dna-prompt-title">Complete your Fan DNA profile to see how well this event matches your taste</p><a class="eh-btn eh-btn--cyan" href="/onboarding?fanDna=1">Set up Fan DNA →</a></div>';
    }
    const crowdShell =
      '<div class="eh-dna-block eh-crowd-card" id="eh-crowd-card">' +
      '<h3 class="eh-dna-block__title">Expected crowd</h3>' +
      '<p class="eh-crowd-loading">Checking who\u2019s interested\u2026</p>' +
      '</div>';
    dnaPanel.insertAdjacentHTML('afterbegin', crowdShell);
    const personaHtml = buildPersonaCardHtml(ev);
    if (personaHtml) {
      dnaPanel.insertAdjacentHTML('afterbegin', personaHtml);
    }
    fetchCrowdMatch(ev);
    const descSlot = $('eh-dna-desc-text');
    const descCard = $('eh-dna-desc-card');
    if (descSlot) {
      const snippet = pickEventDescriptionSnippet(ev);
      if (snippet) {
        descSlot.textContent = snippet;
        if (descCard) descCard.hidden = false;
      } else {
        descSlot.textContent = 'No description available for this event yet.';
        if (descCard) descCard.hidden = false;
      }
    }
    if (typeof window.initDnaMatchPanel === 'function') {
      window.initDnaMatchPanel(match, score);
    }
    fetchMatchExplanation(ev, match);
    wireEventAskPanel(ev);
  }

  function appendEventAskMessage(role, text, opts) {
    const box = $('eh-dna-ask-messages');
    if (!box) return null;
    const div = document.createElement('div');
    div.className = 'eh-dna-ask-msg eh-dna-ask-msg--' + role;
    if (opts && opts.typing) div.classList.add('eh-dna-ask-msg--typing');
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function wireEventAskPanel(ev) {
    const form = $('eh-dna-ask-form');
    const input = $('eh-dna-ask-input');
    const sendBtn = $('eh-dna-ask-send');
    const messages = $('eh-dna-ask-messages');
    const chipBox = $('eh-dna-ask-chips');
    if (!form || !input || !ev) return;
    if (messages) messages.innerHTML = '';
    input.value = '';

    function setBusy(busy) {
      if (sendBtn) sendBtn.disabled = busy;
      input.disabled = busy;
      if (chipBox) {
        chipBox.querySelectorAll('.eh-dna-ask-chip').forEach(function (c) {
          c.disabled = busy;
        });
      }
    }

    function askQuestion(q) {
      if (!q) return;
      appendEventAskMessage('user', q);
      input.value = '';
      setBusy(true);
      const typingEl = appendEventAskMessage('bot', 'Thinking\u2026', { typing: true });

      const slim = {
        id: ev.id,
        title: ev.title,
        url: ev.url,
        date: ev.date,
        time: ev.time,
        venue: ev.venue,
        city: ev.city,
        price: ev.isFree ? 'Free' : ev.price,
        category: ev.category,
        source: ev.source || ev._source,
        summary: ev.summary,
        description: ev.description || ev.summary,
      };

      fetch('/api/event/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ event: slim, question: q }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, data: data };
          });
        })
        .then(function (res) {
          const reply =
            (res.data && res.data.reply) ||
            (res.data && res.data.error) ||
            'Sorry, I could not answer that.';
          if (typingEl) {
            typingEl.classList.remove('eh-dna-ask-msg--typing');
            typingEl.textContent = reply;
          } else {
            appendEventAskMessage('bot', reply);
          }
        })
        .catch(function () {
          if (typingEl) {
            typingEl.classList.remove('eh-dna-ask-msg--typing');
            typingEl.textContent = 'Network error — please try again.';
          } else {
            appendEventAskMessage('bot', 'Network error — please try again.');
          }
        })
        .finally(function () {
          setBusy(false);
          input.focus();
          if (messages) messages.scrollTop = messages.scrollHeight;
        });
    }

    form.onsubmit = function (e) {
      e.preventDefault();
      askQuestion(input.value.trim());
    };

    if (chipBox) {
      chipBox.querySelectorAll('.eh-dna-ask-chip').forEach(function (chip) {
        chip.onclick = function () {
          if (chip.disabled) return;
          askQuestion(chip.getAttribute('data-q') || chip.textContent.trim());
        };
      });
    }
  }

  function renderHubDnaPanel(ev) {
    paintDnaPanel(ev);
    showHubScreen('dna');
    if (!ev.dnaMatch && ev.fanDnaScore == null && (ev.url || ev.id)) {
      fetch('/api/fan-dna/scores?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!data || !data.complete) return;
          if (data.user_dna) window.__hubUserDna = data.user_dna;
          const key = ev.url ? String(ev.url) : String(ev.id);
          const hit = (data.scores && data.scores[key]) || null;
          if (!hit || hubState.event !== ev) return;
          ev.fanDnaScore = hit.fanDnaScore;
          ev.dnaMatch = hit.dnaMatch;
          paintDnaPanel(ev);
        })
        .catch(function () {});
    }
  }

  function setTab(which) {
    hubState.tripFlowStep = which;
    ['flights', 'hotels', 'itin'].forEach(function (w) {
      const btn = $('eh-tab-' + w);
      const panel = $('eh-panel-' + w);
      const on = w === which;
      if (btn) {
        btn.classList.toggle('eh-tab--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (panel) {
        panel.hidden = !on;
        if (on) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      }
    });
    if (which === 'flights') {
      showHubScreen('trip');
      ensureFlightsGuidedUi();
      updateRouteLine();
      if (!fgState.done && hubState.arrivalIso) {
        setTripFlowMessage('Answer a few quick questions — we\u2019ll find flights that fit your dates.');
      }
    }
    if (which === 'hotels') {
      showHubScreen('trip');
      ensureHotelsGuidedUi();
      syncHotelTabFromHub();
      if (!hgState.done && hubState.arrivalIso) {
        setTripFlowMessage('A couple of choices about your stay — then we\u2019ll show matching hotels.');
      }
    }
    if (which === 'itin') {
      showHubScreen('trip');
      maybeShowTripReadyState();
    }
    updateTripFlowUi();
    updateTripStepCards(which);
    updateTripNavUi(which);
    updateFlightsSectionLabel();
    updateGenButtonStateHub();
    scrollEventHubToTop();
    requestAnimationFrame(updateEventHubScrollHint);
  }

  function formatFlightRm(n) {
    return Number(n) === Number(n)
      ? 'RM ' + Number(n).toLocaleString('en-MY', { maximumFractionDigits: 0 })
      : '—';
  }

  function flightLegSummaryHtml(leg, label) {
    if (!leg || typeof leg !== 'object') return '';
    const dep = (leg.departure && (leg.departure.name || leg.departure.id)) || '—';
    const arr = (leg.arrival && (leg.arrival.name || leg.arrival.id)) || '—';
    const t = (leg.departure && leg.departure.time) || '—';
    const p = formatFlightRm(leg.price);
    return (
      '<p class="eh-hub-flight-leg"><strong>' +
      escapeHtml(label) +
      '</strong> · ' +
      escapeHtml(String(leg.airline || '').trim()) +
      ' ' +
      escapeHtml(String(leg.flightNumber || '').trim()) +
      '<br />' +
      escapeHtml(dep) +
      ' \u2192 ' +
      escapeHtml(arr) +
      ' · ' +
      escapeHtml(String(t).slice(0, 20)) +
      ' · ' +
      escapeHtml(p) +
      '</p>'
    );
  }

  function updateHubFlightSummaryUI() {
    const box = $('eh-hub-flight-summary');
    if (!box) return;
    const ob = hubState.selectedOutboundFlight;
    const ret = hubState.selectedReturnFlight;
    if (!ob) {
      box.hidden = true;
      box.setAttribute('hidden', '');
      box.innerHTML = '';
      return;
    }
    let html = '<strong>Your flights</strong>';
    html += flightLegSummaryHtml(ob, 'Outbound');
    if (ret) {
      html += flightLegSummaryHtml(ret, 'Return');
      syncCombinedSelectedFlight();
      const total = hubState.selectedFlight && hubState.selectedFlight.price;
      html +=
        '<p class="eh-hub-flight-total">Estimated total: ' + escapeHtml(formatFlightRm(total)) + '</p>';
    }
    box.innerHTML = html;
    box.hidden = false;
    box.removeAttribute('hidden');
  }

  function updateHubHotelSummaryUI() {
    const box = $('eh-hub-hotel-summary');
    const h = hubState.selectedHotel;
    if (!box) return;
    if (!h || typeof h !== 'object' || !String(h.name || '').trim()) {
      box.hidden = true;
      box.setAttribute('hidden', '');
      box.innerHTML = '';
      return;
    }
    if (h.dayTripOnly) {
      const iso = escapeHtml(String(h.checkIn || hubState.arrivalIso || '').slice(0, 10));
      box.innerHTML =
        '<strong>Your stay</strong> · Day trip — no overnight hotel' +
        (iso ? '<br />Visit date ' + iso : '');
      box.hidden = false;
      box.removeAttribute('hidden');
      return;
    }
    const rt =
      h.overallRating != null && Number.isFinite(Number(h.overallRating))
        ? Number(h.overallRating).toFixed(1)
        : '—';
    const rev = h.reviewsCount != null && Number.isFinite(Number(h.reviewsCount)) ? String(h.reviewsCount) : '';
    const price = escapeHtml(String(h.priceLabel || '—').trim());
    const ci = escapeHtml(String(h.checkIn || '').slice(0, 10));
    const co = escapeHtml(String(h.checkOut || '').slice(0, 10));
    box.innerHTML =
      '<strong>Your stay</strong> · ' +
      escapeHtml(String(h.name || '').trim()) +
      (h.type ? ' · ' + escapeHtml(String(h.type).trim()) : '') +
      '<br />Rating ' +
      escapeHtml(rt) +
      (rev ? ' · ' + escapeHtml(rev) + ' reviews' : '') +
      ' · ' +
      price +
      '<br />Check-in ' +
      ci +
      ' · Check-out ' +
      co;
    box.hidden = false;
    box.removeAttribute('hidden');
  }

  function updateGenButtonStateHub() {
    const btn = $('eh-gen-itin');
    if (!btn) return;
    const flightOk = flightsRoundTripComplete();
    const hotelOk =
      hubState.selectedHotel &&
      typeof hubState.selectedHotel === 'object' &&
      String(hubState.selectedHotel.name || '').trim().length >= 2;
    const ok = flightOk && hotelOk;
    btn.disabled = !ok;
    if (!ok) {
      if (!flightOk) {
        btn.title = 'Pick a flight on the Flights tab first.';
      } else if (!hotelOk) {
        btn.title = 'Pick a hotel on the Hotels tab (Add to my itinerary).';
      }
    } else {
      btn.removeAttribute('title');
    }
  }

  function closeHub() {
    hubState.autoTravelToken += 1;
    setCopilotLoading(false);
    updateAutoTravelStatus('');
    showHubScreen('dna');
    const m = $('event-hub-modal');
    if (!m) return;
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('event-hub-open');
  }

  function openHub(ev) {
    if (!ev) return;
    hubState.event = ev;
    hubState.daysBefore = 1;
    hubState.daysAfter = 1;
    hubState.selectedChipId = 'recommended';
    hubState.resultSortMode = 'default';
    hubState.hotelSortMode = 'default';
    hubState.flightPreferDirect = false;
    hubState.tripFlowStep = 'flights';
    hubState.aiDays = { daysBefore: 1, daysAfter: 1 };
    hubState.aiReason = '';
    hubState.copilotReply = '';
    hubState.lastFlightBookUrl = '';
    hubState.lastHotelBookContext = null;
    hubState.originIata =
      typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
    hubState.destIata = guessDestIata(ev.city, ev.venue);
    if (!hubState.destIata || hubState.destIata === hubState.originIata) {
      hubState.destIata = '';
    }

    const m = $('event-hub-modal');
    const img = $('eh-hero-img');
    const ph = $('eh-hero-placeholder');
    const title = $('eh-hero-title');
    const book = $('eh-book-btn');
    if (!m) return;

    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('event-hub-open');

    if (title) title.textContent = ev.title || 'Event';
    updateHeroMeta(ev);
    const dnaPanel = $('eh-dna-panel');
    if (dnaPanel) {
      renderHubDnaPanel(ev);
    }
    if (book) {
      if (ev.url) {
        book.href = ev.url;
        book.target = '_blank';
        book.rel = 'noopener noreferrer';
        book.setAttribute('data-event-url', String(ev.url || ''));
        book.setAttribute('data-event-id', String(ev.id != null && ev.id !== '' ? ev.id : ev.url || ''));
        book.setAttribute('data-event-name', String(ev.title || ''));
        book.setAttribute('data-event-source', String(ev.source || ev._source || ''));
        book.setAttribute('data-event-city', String(ev.city || ''));
        book.removeAttribute('data-chatbot-resolved');
        book.removeAttribute('hidden');
        book.hidden = false;
        document.dispatchEvent(
          new CustomEvent('event-hub:opened', {
            detail: {
              id: ev.id != null ? ev.id : '',
              url: ev.url || '',
              title: ev.title || '',
              city: ev.city || '',
              source: ev.source || ev._source || '',
            },
          }),
        );
      } else {
        book.hidden = true;
        book.setAttribute('hidden', '');
        book.removeAttribute('href');
      }
    }
    if (img && ph) {
      if (ev.image) {
        img.src = ev.image;
        img.alt = ev.title || '';
        img.hidden = false;
        img.removeAttribute('hidden');
        ph.hidden = true;
        ph.setAttribute('hidden', '');
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        img.setAttribute('hidden', '');
        ph.hidden = false;
        ph.removeAttribute('hidden');
      }
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(updateEventHubHeroParallax);
    } else {
      updateEventHubHeroParallax();
    }

    const descEl = $('eh-event-desc');
    if (descEl) {
      const snippet = pickEventDescriptionSnippet(ev);
      if (snippet) {
        descEl.textContent = snippet;
        descEl.hidden = false;
        descEl.removeAttribute('hidden');
      } else {
        descEl.textContent = '';
        descEl.hidden = true;
        descEl.setAttribute('hidden', '');
      }
    }

    syncTripDatesFromState();
    updateCopilotUI();
    updateRouteLine();
    resetFlightsGuidedForEvent(ev);
    ensureFlightsGuidedUi();
    ensureHotelsGuidedUi();
    setTripFlowMessage('Take it one step at a time — no rush.');
    const hotelsRes = $('eh-hotels-results');
    if (hotelsRes) hotelsRes.innerHTML = '';
    syncHotelTabFromHub();
    const fr = $('eh-flights-results');
    if (fr) fr.innerHTML = '';
    resetFlightLegSelection();
    hubState.lastFlightRows = [];
    hubState.selectedHotel = null;
    hubState.itineraryVibes = [];
    hubState.itineraryPace = null;
    hubState.lastHotelRows = [];
    updateHubFlightSummaryUI();
    updateHubHotelSummaryUI();
    updateGenButtonStateHub();
    maybeShowTripReadyState();
    hubState.tripFlowStep = 'flights';
    updateTripFlowUi();
    updateTripStepCards('flights');
    updateTripNavUi('flights');
    showHubScreen('dna');

    updateAutoTravelStatus('');

    requestAnimationFrame(updateEventHubScrollHint);

    const travelToken = ++hubState.autoTravelToken;
    void fetchAndApplyAiTripPlan(travelToken);
  }

  async function generateItineraryFromHub() {
    if (hubState.generatingItinerary) return;
    syncTripDatesFromState();
    const ev = hubState.event;
    if (!ev || !hubState.arrivalIso || !hubState.departureIso) return;
    const hint = $('eh-gen-hint');
    if (!flightsRoundTripComplete()) {
      if (hint) {
        hint.textContent =
          'On Flights, pick your outbound flight, then your return flight on your departure date.';
      }
      transitionToTab('flights', 'Pick outbound, then return — two quick steps.');
      return;
    }
    syncCombinedSelectedFlight();
    if (
      !hubState.selectedHotel ||
      typeof hubState.selectedHotel !== 'object' ||
      !String(hubState.selectedHotel.name || '').trim()
    ) {
      if (hint) hint.textContent = 'Open Hotels, tell us what you prefer, then tap Add to my itinerary on a stay.';
      transitionToTab('hotels', 'Almost there — let\u2019s find your stay.');
      return;
    }
    if (!hubState.itineraryVibes.length || !hubState.itineraryPace) {
      beginItinQuestionsAfterHotel();
      return;
    }
    if (hint) hint.textContent = '';
    hubState.generatingItinerary = true;
    setTripFlowMessage('Crafting your perfect day\u2026');
    const plannerEv = {
      id: ev.id != null ? ev.id : '',
      title: ev.title || 'Event',
      date: ev.date || '',
      city: String(ev.city || '').trim(),
      url: String(ev.url || '').trim(),
      venue: String(ev.venue || '').trim(),
    };
    if (typeof window.__hubItineraryGenerate !== 'function') {
      hubState.generatingItinerary = false;
      if (hint) hint.textContent = 'Itinerary builder failed to load. Refresh the page and try again.';
      return;
    }
    closeHub();
    try {
      await window.__hubItineraryGenerate({
        event: plannerEv,
        arrivalDate: hubState.arrivalIso,
        departureDate: hubState.departureIso,
        selectedFlight: hubState.selectedFlight,
        selectedHotel: hubState.selectedHotel,
        itineraryVibes: hubState.itineraryVibes.slice(),
        itineraryPace: hubState.itineraryPace,
      });
    } finally {
      hubState.generatingItinerary = false;
    }
  }

  function openHotels() {
    syncTripDatesFromState();
    const ev = hubState.event;
    if (!ev) return;
    if (typeof window.__prefillHotelModal === 'function') {
      window.__prefillHotelModal({
        venue: ev.venue || '',
        city: ev.city || '',
        depart: hubState.arrivalIso,
        ret: hubState.departureIso,
      });
    }
  }

  async function searchGoogleFlights() {
    const searchSeq = ++hubState.flightSearchSeq;
    const host = $('eh-flights-results');
    const H = window.__serpFlightsHelpers;
    if (!host) return;
    if (!H) {
      host.innerHTML =
        '<p class="eh-muted">Flight search script failed to load. Refresh the page and try again.</p>';
      return;
    }
    syncTripDatesFromState();
    const ctx = getFlightSearchContext();
    const from = ctx.from;
    const to = ctx.to;
    const date = ctx.date;
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) {
      hubState.lastFlightRows = [];
      host.innerHTML =
        '<p class="eh-muted">We need valid home and event airport codes to search flights.</p>';
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      hubState.lastFlightRows = [];
      host.innerHTML =
        '<p class="eh-muted">Set your trip dates first (arrival and departure).</p>';
      return;
    }
    hubState.originIata = readFlightTabIata().from;
    hubState.destIata = readFlightTabIata().to;
    if (ctx.leg === 'outbound') {
      hubState.selectedReturnFlight = null;
      hubState.selectedHotel = null;
      syncCombinedSelectedFlight();
      updateHubHotelSummaryUI();
    }
    hubState.lastFlightRows = [];
    updateHubFlightSummaryUI();
    updateGenButtonStateHub();
    updateFlightsLegBar();
    fgRenderPrompt();
    host.innerHTML = '<p class="eh-loading">' + escapeHtml(ctx.loadingText) + '</p>';
    try {
      let data = null;
      const cacheKey = flightPrefetchKey(ctx);
      if (hubState.prefetchedFlightKey === cacheKey && hubState.prefetchedFlightRaw) {
        data = hubState.prefetchedFlightRaw;
        hubState.prefetchedFlightRaw = null;
        hubState.prefetchedFlightKey = '';
      }
      if (!data) {
        data = await H.fetchSerpFlights(
          { from: from, to: to, date: date, passengers: 1, type: '2' },
          undefined,
        );
      }
      if (searchSeq !== hubState.flightSearchSeq) return;
      const sortMode = getEffectiveFlightSortMode();
      const prep = H.prepareFlightResults
        ? H.prepareFlightResults(data, {
            directOnly: hubState.flightPreferDirect,
            sortMode: sortMode,
          })
        : {
            rows: H.mergeSerpLists(data),
            currency: 'MYR',
            bookUrl: H.bookUrlFromResponse(data),
            counts: { total: H.mergeSerpLists(data).length },
            totalFromApi: H.mergeSerpLists(data).length,
            afterFilter: H.mergeSerpLists(data).length,
            lowestPrice: null,
          };
      const rows = prep.rows;
      const apiTotal =
        (prep.counts && prep.counts.total) || prep.totalFromApi || rows.length;
      const book = prep.bookUrl;
      hubState.lastFlightCurrency = prep.currency || 'MYR';
      hubState.lastFlightLowestPrice = prep.lowestPrice;
      hubState.lastFlightApiTotal = apiTotal;
      if (!rows.length) {
        hubState.lastFlightRows = [];
        host.innerHTML = hubState.flightPreferDirect
          ? '<p class="eh-muted">No direct flights for this route and date. Try &ldquo;Doesn&rsquo;t matter&rdquo; or different arrival timing.' +
            (apiTotal > 0
              ? ' (' + apiTotal + ' connecting option' + (apiTotal === 1 ? '' : 's') + ' from Google.)'
              : '') +
            '</p>'
          : '<p class="eh-muted">No flights returned for this route and date. Try other dates or airports.</p>';
        return;
      }
      if (searchSeq !== hubState.flightSearchSeq) return;
      const maxShow = H.maxFlightsToShow
        ? H.maxFlightsToShow(sortMode)
        : sortMode === 'budget'
          ? H.MAX_FLIGHTS_DISPLAY_BUDGET || 100
          : H.MAX_FLIGHTS_DISPLAY || 30;
      const toShow = rows.slice(0, maxShow);
      hubState.lastFlightRows = rows;
      hubState.lastFlightBookUrl = book || '';
      hubState.resultSortMode = sortMode;
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        H.renderSerpFlightListItems(toShow, book, true, hubState.lastFlightCurrency, ctx.pickLabel) +
        '</ul>' +
        '<p class="eh-footnote">' +
        escapeHtml(
          flightResultsFootnote(sortMode, toShow.length, rows.length, {
            currency: hubState.lastFlightCurrency,
            lowestPrice: hubState.lastFlightLowestPrice,
            apiTotal: apiTotal,
          }),
        ) +
        '</p>';
    } catch (e) {
      if (searchSeq !== hubState.flightSearchSeq) return;
      hubState.lastFlightRows = [];
      host.innerHTML = '<p class="eh-muted">' + escapeHtml(e.message || 'Flight search failed') + '</p>';
    }
  }

  function isSameDayTrip() {
    syncTripDatesFromState();
    const arrival = String(hubState.arrivalIso || '').slice(0, 10);
    const departure = String(hubState.departureIso || '').slice(0, 10);
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(arrival) &&
      /^\d{4}-\d{2}-\d{2}$/.test(departure) &&
      arrival === departure
    );
  }

  function dayTripNoHotelSelection() {
    syncTripDatesFromState();
    const iso = String(hubState.arrivalIso || '').slice(0, 10);
    return {
      name: 'No hotel stay',
      dayTripOnly: true,
      type: 'Day trip',
      priceLabel: 'No overnight stay',
      checkIn: iso,
      checkOut: iso,
    };
  }

  function injectDayTripNoHotelOption(host) {
    if (!host || !isSameDayTrip()) return;
    if (host.querySelector('[data-eh-no-hotel-stay]')) return;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'eh-daytrip-no-hotel-card';
    card.setAttribute('data-eh-no-hotel-stay', '1');
    card.innerHTML =
      '<span class="eh-daytrip-no-hotel-card__icon" aria-hidden="true">☀️</span>' +
      '<span class="eh-daytrip-no-hotel-card__body">' +
      '<strong class="eh-daytrip-no-hotel-card__title">No Hotel Stay</strong>' +
      '<span class="eh-daytrip-no-hotel-card__sub">I\u2019m visiting for the day only</span>' +
      '</span>' +
      '<span class="eh-daytrip-no-hotel-card__cta">Continue</span>';
    host.insertBefore(card, host.firstChild);
  }

  /** Trip dates for hotel Book links — same fields as itineraries_generated (arrival_date / departure_date). */
  function hubHotelBookContextFromTrip() {
    syncTripDatesFromState();
    const arrival_date = String(hubState.arrivalIso || '').slice(0, 10);
    let departure_date = String(hubState.departureIso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival_date)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departure_date) || departure_date <= arrival_date) {
      departure_date = addDaysIso(arrival_date, 1);
    }
    const ev = hubState.event || {};
    const city = String(ev.city || '').trim() || 'Kuala Lumpur';
    const adults = Math.max(1, Math.min(9, parseInt(hubState.hotelAdults, 10) || 1));
    return {
      city: city,
      arrival_date: arrival_date,
      departure_date: departure_date,
      adults: adults,
    };
  }

  async function searchGoogleHotelsSerp() {
    const searchSeq = ++hubState.hotelSearchSeq;
    const host = $('eh-hotels-results');
    const H = window.__serpHotelsHelpers;
    if (!host) return;
    if (!H) {
      host.innerHTML =
        '<p class="eh-muted">Hotel search script failed to load. Refresh the page and try again.</p>';
      return;
    }
    syncHotelTabFromHub();
    const bookCtx = hubHotelBookContextFromTrip();
    const tripIn = bookCtx && bookCtx.arrival_date ? bookCtx.arrival_date : '';
    const tripOut = bookCtx && bookCtx.departure_date ? bookCtx.departure_date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tripIn)) {
      hubState.lastHotelRows = [];
      host.innerHTML =
        '<p class="eh-muted">Set trip dates on the Flights tab first (arrival and stay questions).</p>';
      return;
    }
    const serpDates = hotelSerpSearchDates(tripIn, tripOut);
    if (!serpDates.ok) {
      hubState.lastHotelRows = [];
      host.innerHTML = '<p class="eh-muted">Set valid check-in and check-out dates.</p>';
      return;
    }
    let checkIn = serpDates.checkIn;
    let checkOut = serpDates.checkOut;
    let dateNote = '';
    if (serpDates.adjusted) {
      dateNote =
        ' Showing availability from ' +
        checkIn +
        ' to ' +
        checkOut +
        ' (SerpAPI requires today or future dates; your trip window is still ' +
        tripIn +
        ' – ' +
        tripOut +
        ').';
    }
    let q = String($('eh-hotel-q')?.value || '').trim();
    if (q.length < 2) {
      q = hotelSerpQueryFromHub(hgState.answers && hgState.answers.areaMode);
    }
    const hq = $('eh-hotel-q');
    if (hq) hq.value = q;
    hubState.selectedHotel = null;
    hubState.lastHotelRows = [];
    updateHubHotelSummaryUI();
    updateGenButtonStateHub();
    host.innerHTML = '<p class="eh-loading">Searching Google Hotels…</p>';
    try {
      const adultsForSearch = Math.max(1, Math.min(9, parseInt(hubState.hotelAdults, 10) || 1));
      const data = await H.fetchSerpHotels(
        { q: q, checkIn: checkIn, checkOut: checkOut, adults: adultsForSearch },
        undefined,
      );
      if (searchSeq !== hubState.hotelSearchSeq) return;
      const rows = H.mergeHotelProperties(data);
      if (!rows.length) {
        hubState.lastHotelRows = [];
        host.innerHTML =
          '<p class="eh-muted">No hotels returned for this search. Try another destination or dates.</p>';
        injectDayTripNoHotelOption(host);
        return;
      }
      hubState.lastHotelBookContext = H.hotelBookContextFromSerpSearch(
        data,
        q,
        checkIn,
        checkOut,
        Object.assign({}, bookCtx, { adults: adultsForSearch }),
      );
      const sortMode = getEffectiveHotelSortMode();
      const sorted = sortHotelRowsForMode(rows, sortMode);
      hubState.lastHotelRows = sorted;
      hubState.hotelSortMode = sortMode;
      let sortNote =
        sortMode === 'luxury'
          ? 'Higher-rated stays first'
          : 'Cheapest stays first';
      if (data && data.serp_dates_adjusted) {
        dateNote =
          ' Showing availability from ' +
          (data.serp_check_in_date || checkIn) +
          ' to ' +
          (data.serp_check_out_date || checkOut) +
          ' (adjusted to today or later for SerpAPI).';
      }
      const footId = 'eh-hotel-price-footnote';
      host.innerHTML =
        '<ul class="eh-flight-list">' +
        H.renderSerpHotelListItems(
          sorted,
          hubState.lastHotelBookContext || bookCtx || { city: 'Kuala Lumpur' },
          true,
        ) +
        '</ul>' +
        '<p class="eh-footnote" id="' +
        footId +
        '">' +
        escapeHtml(sortNote) +
        '. Showing estimated prices — refining with Google in the background.' +
        escapeHtml(dateNote) +
        '</p>';
      injectDayTripNoHotelOption(host);
      if (typeof H.refreshLiveHotelPricesInDom === 'function') {
        void H.refreshLiveHotelPricesInDom(host, sorted, {
          q: q,
          checkIn: checkIn,
          checkOut: checkOut,
          adults: adultsForSearch,
          maxRows: 10,
          concurrency: 8,
          isStale: function () {
            return searchSeq !== hubState.hotelSearchSeq;
          },
          onPrice: function (_rowIndex, row, live) {
            if (!row || !live) return;
            const token = String(row.property_token || '').trim();
            hubState.lastHotelRows = (hubState.lastHotelRows || []).map(function (r) {
              if (String(r.property_token || '').trim() !== token) return r;
              return Object.assign({}, r, {
                ehDisplayPrice: live.extracted,
                ehDisplayLabel: live.label,
              });
            });
          },
        }).then(function () {
          if (searchSeq !== hubState.hotelSearchSeq) return;
          const foot = document.getElementById(footId);
          if (foot) {
            foot.textContent =
              sortNote +
              '. Prices are the lowest per-night offer on Google for your dates and adult count. Confirm on Google before booking.' +
              dateNote;
          }
        });
      }
    } catch (e) {
      if (searchSeq !== hubState.hotelSearchSeq) return;
      hubState.lastHotelRows = [];
      host.innerHTML = '<p class="eh-muted">' + escapeHtml(e.message || 'Hotel search failed') + '</p>';
      injectDayTripNoHotelOption(host);
    }
  }

  function onGridClick(e) {
    const card = e.target.closest('#grid .card[data-ev-idx]');
    if (!card) return;
    const idx = parseInt(card.getAttribute('data-ev-idx'), 10);
    const list = window.__lastRenderedEventSlice;
    if (!list || Number.isNaN(idx) || !list[idx]) return;
    e.preventDefault();
    try {
      openHub(list[idx]);
    } catch (err) {
      console.error('[event-hub] openHub failed:', err);
    }
  }

  function init() {
    document.addEventListener('click', onGridClick);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = document.activeElement && document.activeElement.closest('.card[data-ev-idx]');
      if (!card || !document.getElementById('grid')?.contains(card)) return;
      e.preventDefault();
      card.click();
    });

    $('eh-modal-close')?.addEventListener('click', closeHub);
    $('eh-modal-backdrop')?.addEventListener('click', closeHub);

    $('eh-dna-panel')?.addEventListener('click', function (e) {
      const planBtn = e.target.closest('#eh-btn-plan-trip');
      if (!planBtn) return;
      e.preventDefault();
      setTab('flights');
    });

    $('eh-btn-back-dna')?.addEventListener('click', function () {
      showHubScreen('dna');
      scrollEventHubToTop();
    });

    $('eh-btn-trip-next')?.addEventListener('click', function () {
      const step = hubState.tripFlowStep || 'flights';
      if (step === 'flights') setTab('hotels');
      else if (step === 'hotels') setTab('itin');
    });

    const ehScroll = $('event-hub-scroll');
    if (ehScroll) {
      ehScroll.addEventListener('scroll', updateEventHubScrollHint, { passive: true });
      ehScroll.addEventListener('scroll', updateEventHubHeroParallax, { passive: true });
    }
    window.addEventListener('resize', updateEventHubScrollHint, { passive: true });
    window.addEventListener('resize', updateEventHubHeroParallax, { passive: true });

    maybePromptCrowdProfile();

    $('eh-tab-itin')?.addEventListener('click', function () {
      setTab('itin');
    });
    $('eh-tab-flights')?.addEventListener('click', function () {
      setTab('flights');
    });
    $('eh-tab-hotels')?.addEventListener('click', function () {
      setTab('hotels');
    });

    $('eh-copilot-chips')?.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-eh-copilot-chip]');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      const chipId = btn.getAttribute('data-eh-copilot-chip');
      if (!chipId) return;
      if (chipId === hubState.selectedChipId) return;
      void selectCopilotChip(chipId, {});
    });

    $('eh-gen-itin')?.addEventListener('click', function () {
      void generateItineraryFromHub();
    });
    $('eh-open-hotels')?.addEventListener('click', function () {
      openHotels();
      closeHub();
    });
    $('eh-flights-results')?.addEventListener('click', function (e) {
      const b = e.target.closest('[data-eh-add-flight]');
      if (!b) return;
      e.preventDefault();
      const idx = parseInt(b.getAttribute('data-eh-add-flight'), 10);
      const row = hubState.lastFlightRows[idx];
      const H = window.__serpFlightsHelpers;
      if (!row || !H || typeof H.serializeForItinerary !== 'function') return;

      document.querySelectorAll('#eh-flights-results .eh-flight-row').forEach(function (li) {
        li.classList.remove('is-selected');
        const pick = li.querySelector('[data-eh-add-flight]');
        if (pick) {
          pick.classList.remove('is-selected');
          pick.textContent = pick.getAttribute('data-eh-pick-label') || 'Select';
        }
      });
      const flightLi = b.closest('.eh-flight-row');
      if (flightLi) flightLi.classList.add('is-selected');
      b.classList.add('is-selected');
      b.textContent = 'Selected ✓';

      if (hubState.flightLeg === 'return') {
        hubState.selectedReturnFlight = H.serializeForItinerary(row);
        syncCombinedSelectedFlight();
        logHubFlightPick(hubState.departureIso);
        updateHubFlightSummaryUI();
        updateGenButtonStateHub();
        updateFlightsLegBar();
        hubState.tripFlowStep = 'hotels';
        const hotelMsg = hgState.done
          ? 'Flights saved. Pick a hotel when one feels right.'
          : 'Great — a few quick questions about your stay, then we\u2019ll show hotels.';
        transitionToTab('hotels', hotelMsg);
        syncHotelTabFromHub();
        if (!hgState.done) ensureHotelsGuidedUi();
        maybeShowTripReadyState();
        return;
      }

      hubState.selectedOutboundFlight = H.serializeForItinerary(row);
      hubState.selectedReturnFlight = null;
      hubState.flightLeg = 'return';
      syncCombinedSelectedFlight();
      logHubFlightPick(hubState.arrivalIso);
      updateHubFlightSummaryUI();
      updateGenButtonStateHub();
      updateFlightsLegBar();
      fgRenderPrompt();
      setTripFlowMessage('Outbound saved. Now choose your return flight.');
      void searchGoogleFlights();
    });

    $('eh-hotels-results')?.addEventListener('click', function (e) {
      const noStay = e.target.closest('[data-eh-no-hotel-stay]');
      if (noStay) {
        if (hubState.generatingItinerary) return;
        e.preventDefault();
        hubState.selectedHotel = dayTripNoHotelSelection();
        updateHubHotelSummaryUI();
        updateGenButtonStateHub();
        setTripFlowMessage('No hotel — two quick questions, then we\u2019ll craft your day.');
        beginItinQuestionsAfterHotel();
        return;
      }
      const b = e.target.closest('[data-eh-add-hotel]');
      if (!b || b.disabled || hubState.generatingItinerary) return;
      e.preventDefault();
      const idx = parseInt(b.getAttribute('data-eh-add-hotel'), 10);
      const row = hubState.lastHotelRows[idx];
      const H = window.__serpHotelsHelpers;
      if (!row || !H || typeof H.serializeForItinerary !== 'function') return;
      syncTripDatesFromState();
      let checkOut = hubState.departureIso;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= hubState.arrivalIso) {
        checkOut = addDaysIso(hubState.arrivalIso, 1);
      }
      hubState.selectedHotel = H.serializeForItinerary(row, hubState.arrivalIso, checkOut);
      const hotelPriceNumeric =
        typeof H.hotelExtractedPrice === 'function' ? H.hotelExtractedPrice(row) : null;
      logHubHotelPick(hubState.selectedHotel, hubState.arrivalIso, checkOut, hotelPriceNumeric);
      updateHubHotelSummaryUI();
      updateGenButtonStateHub();
      beginItinQuestionsAfterHotel();
    });

    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key !== 'Escape') return;
        const m = $('event-hub-modal');
        if (m && m.classList.contains('is-open')) {
          e.stopPropagation();
          closeHub();
        }
      },
      true,
    );

    document.addEventListener('ts-auth-change', function () {
      const h =
        typeof window.__getHomeIataFromProfile === 'function' ? window.__getHomeIataFromProfile() : 'KUL';
      hubState.originIata = h;
      updateCopilotProfileFoot();
    });

    fgInitHandlers();
    hgInitHandlers();
    ivInitHandlers();
  }

  window.__openEventHub = openHub;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
