/**
 * Hotel search — collect destination / check-in / check-out / guests
 * and hand off directly to Booking.com's live search in a new tab.
 * Prefills destination from the selected event's venue / city when opened
 * from the itinerary's "Hotel search" button.
 */

const POPULAR_DESTINATIONS = [
  'Kuala Lumpur',
  'George Town, Penang',
  'Johor Bahru',
  'Singapore',
  'Bangkok',
  'Bali',
];

/** Rough country → capital/city for geolocation fallback. */
const COUNTRY_TO_CITY = {
  MY: 'Kuala Lumpur',
  SG: 'Singapore',
  TH: 'Bangkok',
  ID: 'Jakarta',
  VN: 'Ho Chi Minh City',
  PH: 'Manila',
  KH: 'Phnom Penh',
  LA: 'Vientiane',
  BN: 'Bandar Seri Begawan',
  AU: 'Sydney',
  IN: 'New Delhi',
  JP: 'Tokyo',
  KR: 'Seoul',
  CN: 'Guangzhou',
  TW: 'Taipei',
  HK: 'Hong Kong',
};

function todayMalaysiaISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}

function addDaysIso(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBookingUrl(destination, checkin, checkout, guests = 1, rooms = 1) {
  const ss = String(destination || '').trim() || 'Kuala Lumpur';
  const adults = Math.min(9, Math.max(1, Number(guests) || 1));
  const noRooms = Math.min(9, Math.max(1, Number(rooms) || 1));
  const p = new URLSearchParams();
  p.set('ss', ss);
  if (/^\d{4}-\d{2}-\d{2}$/.test(checkin || '')) p.set('checkin', checkin);
  if (/^\d{4}-\d{2}-\d{2}$/.test(checkout || '')) p.set('checkout', checkout);
  p.set('group_adults', String(adults));
  p.set('group_children', '0');
  p.set('no_rooms', String(noRooms));
  p.set('lang', 'en-gb');
  return `https://www.booking.com/searchresults.html?${p.toString()}`;
}

function $(id) {
  return document.getElementById(id);
}

function showHsAlert(msg) {
  const el = $('hs-alert');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function openHsModal() {
  const m = $('hs-modal');
  if (!m) return;
  m.classList.add('is-open');
  m.setAttribute('aria-hidden', 'false');
  document.body.classList.add('hs-modal-open');
}

function closeHsModal() {
  const m = $('hs-modal');
  if (!m) return;
  m.classList.remove('is-open');
  m.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('hs-modal-open');
}

async function reverseGeocode(lat, lng) {
  const res = await fetch(
    `/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
  );
  if (!res.ok) throw new Error('Could not resolve location');
  return res.json();
}

function guessCityFromNominatim(data) {
  const a = data?.address || {};
  const town =
    a.city ||
    a.town ||
    a.village ||
    a.municipality ||
    a.county ||
    a.state ||
    '';
  if (town) {
    return a.country ? `${town}, ${a.country}` : String(town);
  }
  const cc = String(a.country_code || '').toUpperCase();
  return COUNTRY_TO_CITY[cc] || 'Kuala Lumpur';
}

function renderChips() {
  const host = $('hs-chips');
  if (!host) return;
  host.innerHTML = POPULAR_DESTINATIONS.map(
    (city) =>
      `<button type="button" class="fs-chip" data-dest="${escapeHtml(city)}">${escapeHtml(city)}</button>`,
  ).join('');
}

/**
 * Compose a "near event" destination string. Venue is usually more specific than the city;
 * when both are present we combine so Booking.com biases to that neighbourhood.
 */
function composeNearEventLocation(venue, city) {
  const v = String(venue || '').trim();
  const c = String(city || '').trim();
  if (v && c) {
    if (v.toLowerCase().includes(c.toLowerCase())) return v;
    return `${v}, ${c}`;
  }
  return v || c || '';
}

function prefillFromItinerary(trigger) {
  const destEl = $('hs-dest');
  const ciEl = $('hs-checkin');
  const coEl = $('hs-checkout');
  const nearEl = $('hs-near-event');
  const guestsEl = $('hs-guests');

  const venue = trigger?.getAttribute?.('data-event-venue') || '';
  const city = trigger?.getAttribute?.('data-event-city') || '';
  const depart = trigger?.getAttribute?.('data-trip-depart') || '';
  const ret = trigger?.getAttribute?.('data-trip-return') || '';
  const guests = trigger?.getAttribute?.('data-guests') || '';

  const near = composeNearEventLocation(venue, city);
  if (destEl) destEl.value = near || destEl.value || '';

  if (ciEl) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(depart)) ciEl.value = depart;
    else if (!ciEl.value) ciEl.value = todayMalaysiaISO();
  }
  if (coEl) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(ret)) coEl.value = ret;
    else if (!coEl.value) coEl.value = addDaysIso(ciEl?.value || todayMalaysiaISO(), 1);
  }

  if (nearEl) {
    if (near) {
      nearEl.hidden = false;
      nearEl.removeAttribute('hidden');
      nearEl.textContent = `Near the event: ${near}`;
      nearEl.setAttribute('data-near', near);
    } else {
      nearEl.hidden = true;
      nearEl.setAttribute('hidden', '');
      nearEl.removeAttribute('data-near');
    }
  }

  if (guestsEl && /^[1-9]$/.test(guests)) guestsEl.value = guests;
}

function onSearch() {
  showHsAlert('');
  const destEl = $('hs-dest');
  const ciEl = $('hs-checkin');
  const coEl = $('hs-checkout');
  const guestsEl = $('hs-guests');
  const roomsEl = $('hs-rooms');
  const results = $('hs-results');
  if (!destEl || !ciEl || !coEl || !guestsEl) return;

  const dest = String(destEl.value || '').trim();
  const checkin = ciEl.value || '';
  const checkout = coEl.value || '';
  const guests = Math.min(9, Math.max(1, Number(guestsEl.value) || 1));
  const rooms = Math.min(9, Math.max(1, Number(roomsEl?.value) || 1));

  if (!dest) {
    showHsAlert('Enter a destination (city, neighbourhood, or venue).');
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
    showHsAlert('Enter valid check-in and check-out dates.');
    return;
  }
  if (checkout <= checkin) {
    showHsAlert('Check-out must be after check-in.');
    return;
  }

  if (results) results.innerHTML = '';

  const deep = buildBookingUrl(dest, checkin, checkout, guests, rooms);

  /** Popup blockers can silence window.open; surface a manual link if that happens. */
  const win = window.open(deep, '_blank', 'noopener');
  if (!win && results) {
    results.innerHTML =
      '<div class="fs-empty">' +
      '<p>Your browser blocked the new tab. Open Booking.com for hotels near your destination:</p>' +
      '<a class="fs-deep-link" href="' +
      escapeHtml(deep) +
      '" target="_blank" rel="noopener noreferrer">Open Booking.com</a>' +
      '</div>';
    return;
  }

  closeHsModal();
}

function onDetectLocation() {
  showHsAlert('');
  const hint = $('hs-detect-hint');
  const destEl = $('hs-dest');
  if (!navigator.geolocation) {
    showHsAlert('Geolocation is not supported in this browser.');
    return;
  }
  if (hint) hint.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const data = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        const city = guessCityFromNominatim(data);
        if (destEl) destEl.value = city;
        const disp =
          data.display_name ||
          [data.address?.city, data.address?.country].filter(Boolean).join(', ');
        if (hint) {
          hint.textContent = disp ? `Near: ${disp} — set destination to ${city}` : `Set destination to ${city}`;
        }
      } catch (e) {
        if (hint) hint.textContent = '';
        showHsAlert(e.message || 'Reverse geocoding failed.');
      }
    },
    () => {
      if (hint) hint.textContent = '';
      showHsAlert('Could not read your location (permission denied or unavailable).');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
  );
}

function init() {
  renderChips();
  const minD = todayMalaysiaISO();
  const ciEl = $('hs-checkin');
  const coEl = $('hs-checkout');
  if (ciEl) {
    ciEl.min = minD;
    if (!ciEl.value) ciEl.value = minD;
  }
  if (coEl) {
    coEl.min = minD;
    if (!coEl.value) coEl.value = addDaysIso(ciEl?.value || minD, 1);
  }
  /** Keep check-out strictly after check-in, and auto-bump when user moves check-in forward. */
  if (ciEl && coEl) {
    ciEl.addEventListener('change', () => {
      const next = addDaysIso(ciEl.value || minD, 1);
      coEl.min = next;
      if (!coEl.value || coEl.value <= ciEl.value) coEl.value = next;
    });
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('#itin-hotel-search-open, [data-open="hs-modal"]');
    if (!trigger) return;
    e.preventDefault();
    prefillFromItinerary(trigger);
    openHsModal();
  });

  const chipsHost = $('hs-chips');
  if (chipsHost) {
    chipsHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.fs-chip');
      if (!btn) return;
      const dest = btn.getAttribute('data-dest');
      const de = $('hs-dest');
      if (de && dest) de.value = dest;
    });
  }

  $('hs-near-event')?.addEventListener('click', (e) => {
    const near = e.currentTarget.getAttribute('data-near') || '';
    const de = $('hs-dest');
    if (de && near) de.value = near;
  });

  $('hs-modal-close')?.addEventListener('click', closeHsModal);
  $('hs-modal-backdrop')?.addEventListener('click', closeHsModal);
  $('hs-search')?.addEventListener('click', () => {
    onSearch();
  });
  $('hs-detect')?.addEventListener('click', () => {
    onDetectLocation();
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const m = $('hs-modal');
      if (m && m.classList.contains('is-open')) {
        e.stopPropagation();
        closeHsModal();
      }
    },
    true,
  );

  window.__prefillHotelModal = function (opts) {
    opts = opts || {};
    const fake = document.createElement('button');
    fake.setAttribute('data-event-venue', String(opts.venue || ''));
    fake.setAttribute('data-event-city', String(opts.city || ''));
    fake.setAttribute('data-trip-depart', String(opts.depart || '').slice(0, 10));
    fake.setAttribute('data-trip-return', String(opts.ret || '').slice(0, 10));
    prefillFromItinerary(fake);
    openHsModal();
  };
}

init();
