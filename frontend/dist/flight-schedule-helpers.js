/**
 * Flight arrival/departure constraints for itinerary days and timeline display.
 * Used by itinerary-routes.js (Node) and itinerary-modal.js (browser).
 */
'use strict';

const FLIGHT_ARRIVAL_BUFFER_MIN = 90;
const FLIGHT_AIRPORT_BUFFER_MIN = 150;

function formatMinutes12h(totalMin) {
  let m = Number(totalMin);
  if (!Number.isFinite(m)) return '—';
  m = ((m % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + String(mm).padStart(2, '0') + ' ' + ampm;
}

/** @returns {{ dateIso: string|null, minutes: number, hour: number, minute: number }|null} */
function parseFlightDateTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const ampm = s.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const minute = parseInt(ampm[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(minute)) return null;
    const pm = /^p/i.test(ampm[3].replace(/\./g, ''));
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { dateIso: null, minutes: h * 60 + minute, hour: h, minute };
  }

  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (iso) {
    const hour = parseInt(iso[2], 10);
    const minute = parseInt(iso[3], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return {
      dateIso: iso[1],
      minutes: hour * 60 + minute,
      hour,
      minute,
    };
  }

  const tod = s.match(/(\d{1,2}):(\d{2})/);
  if (tod) {
    const hour = parseInt(tod[1], 10);
    const minute = parseInt(tod[2], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { dateIso: null, minutes: hour * 60 + minute, hour, minute };
  }

  return null;
}

function flightSelectionValid(selectedFlight) {
  if (!selectedFlight || typeof selectedFlight !== 'object') return false;
  if (selectedFlight.tripType === 'round_trip_split') {
    const ob = selectedFlight.outbound;
    const ret = selectedFlight.returnFlight;
    return !!(
      ob &&
      ret &&
      typeof ob.departure === 'object' &&
      typeof ob.arrival === 'object' &&
      typeof ret.departure === 'object'
    );
  }
  return !!(selectedFlight.departure && selectedFlight.arrival);
}

function extractFlightSchedule(selectedFlight) {
  if (!selectedFlight || typeof selectedFlight !== 'object') return null;
  let outbound = selectedFlight;
  let returnLeg = null;
  if (selectedFlight.tripType === 'round_trip_split' && selectedFlight.outbound) {
    outbound = selectedFlight.outbound;
    returnLeg = selectedFlight.returnFlight || null;
  }
  const outboundArrival = parseFlightDateTime(outbound && outbound.arrival && outbound.arrival.time);
  const returnDeparture = returnLeg
    ? parseFlightDateTime(returnLeg.departure && returnLeg.departure.time)
    : null;
  if (!outboundArrival && !returnDeparture) return null;
  return {
    outboundArrival,
    outboundDeparture: parseFlightDateTime(outbound && outbound.departure && outbound.departure.time),
    returnDeparture,
    destination:
      String((outbound && outbound.arrival && (outbound.arrival.name || outbound.arrival.id)) || '').trim() ||
      'destination',
    origin:
      String((outbound && outbound.departure && (outbound.departure.name || outbound.departure.id)) || '').trim() ||
      'home',
  };
}

function computeDayFlightHints(dayIndex, totalDays, schedule) {
  if (!schedule || totalDays < 1) return null;
  const hints = { morning: 9 * 60, afternoon: 14 * 60, evening: 19 * 60 };
  let meta = null;

  if (dayIndex === 0 && schedule.outboundArrival && schedule.outboundArrival.minutes != null) {
    const land = schedule.outboundArrival.minutes;
    const earliest = land + FLIGHT_ARRIVAL_BUFFER_MIN;
    const landingLabel = formatMinutes12h(land);
    const earliestLabel = formatMinutes12h(earliest);
    meta = {
      type: 'arrival',
      landingMinutes: land,
      earliestActivityMinutes: earliest,
      landingLabel,
      earliestLabel,
    };
    if (land >= 22 * 60) {
      hints.morning = null;
      hints.afternoon = null;
      hints.evening = earliest;
    } else if (land >= 18 * 60) {
      hints.morning = null;
      hints.afternoon = null;
      hints.evening = Math.max(19 * 60, earliest);
    } else if (land >= 14 * 60) {
      hints.morning = null;
      hints.afternoon = Math.max(14 * 60, earliest);
      hints.evening = Math.max(19 * 60, earliest + 60);
    } else {
      hints.morning = Math.max(9 * 60, earliest);
      hints.afternoon = Math.max(14 * 60, earliest + 60);
      hints.evening = Math.max(19 * 60, earliest + 120);
    }
  }

  if (
    dayIndex === totalDays - 1 &&
    totalDays > 1 &&
    schedule.returnDeparture &&
    schedule.returnDeparture.minutes != null
  ) {
    const depMin = schedule.returnDeparture.minutes;
    const latest = depMin - FLIGHT_AIRPORT_BUFFER_MIN;
    const depLabel = formatMinutes12h(depMin);
    const latestLabel = formatMinutes12h(latest);
    meta = meta || {};
    Object.assign(meta, {
      type: meta.type ? 'arrival_departure' : 'departure',
      departureMinutes: depMin,
      latestActivityMinutes: latest,
      departureLabel: depLabel,
      latestLabel,
    });
    if (latest <= 8 * 60) {
      hints.morning = null;
      hints.afternoon = null;
      hints.evening = null;
    } else if (latest <= 12 * 60) {
      hints.afternoon = null;
      hints.evening = null;
      hints.morning = 7 * 60;
    } else if (latest <= 16 * 60) {
      hints.evening = null;
      hints.morning = 8 * 60;
      hints.afternoon = Math.min(13 * 60, latest - 60);
    } else {
      hints.morning = 9 * 60;
      hints.afternoon = 14 * 60;
      hints.evening = Math.min(18 * 60, latest - 90);
    }
  }

  return { hints, meta };
}

function filterMealsAfterMinutes(meals, earliestMin) {
  if (!Array.isArray(meals) || earliestMin == null) return meals;
  return meals.filter(function (m) {
    const parsed = parseFlightDateTime(m && m.time);
    if (!parsed || parsed.minutes == null) return true;
    return parsed.minutes >= earliestMin;
  });
}

function applyFlightScheduleToDays(days, schedule) {
  const warnings = [];
  if (!schedule || !Array.isArray(days) || !days.length) {
    return { days: days || [], warnings };
  }

  const total = days.length;
  days.forEach(function (day, dayIndex) {
    if (!day || typeof day !== 'object') return;
    const computed = computeDayFlightHints(dayIndex, total, schedule);
    if (!computed) return;

    day._slotTimeHints = Object.assign({}, day._slotTimeHints || {}, computed.hints);
    if (computed.meta) {
      day._flightMeta = Object.assign({}, day._flightMeta || {}, computed.meta);
    }

    if (dayIndex === 0 && schedule.outboundArrival && schedule.outboundArrival.minutes != null) {
      const land = schedule.outboundArrival.minutes;
      const earliest = land + FLIGHT_ARRIVAL_BUFFER_MIN;
      const landLabel = formatMinutes12h(land);

      if (land >= 22 * 60) {
        day.morning = [];
        day.afternoon = [];
        day.evening = Array.isArray(day.evening) ? day.evening.slice(0, 1) : [];
        day.subtitle = 'Late arrival (' + landLabel + ') — rest & check-in only';
        day.tips = (Array.isArray(day.tips) ? day.tips : []).concat([
          'Flight lands at ' +
            landLabel +
            ' — no sightseeing before you reach the hotel; timeline starts after landing.',
        ]);
        warnings.push({
          type: 'flight_arrival',
          severity: 'info',
          message:
            'Outbound lands at ' +
            landLabel +
            '. Day 1 plans start after ' +
            formatMinutes12h(earliest) +
            ' (not before you land).',
        });
      } else if (land >= 18 * 60) {
        day.morning = [];
        day.afternoon = [];
        day.tips = (Array.isArray(day.tips) ? day.tips : []).concat([
          'Flight lands at ' + landLabel + ' — afternoon/evening only after ' + formatMinutes12h(earliest) + '.',
        ]);
        warnings.push({
          type: 'flight_arrival',
          severity: 'info',
          message: 'Outbound lands at ' + landLabel + '. Day 1 activities are scheduled after landing.',
        });
      } else if (land >= 14 * 60) {
        day.morning = [];
        warnings.push({
          type: 'flight_arrival',
          severity: 'info',
          message: 'Outbound lands at ' + landLabel + '. Morning on day 1 is kept clear.',
        });
      }
      day.meals = filterMealsAfterMinutes(day.meals, earliest);
    }

    if (
      dayIndex === total - 1 &&
      total > 1 &&
      schedule.returnDeparture &&
      schedule.returnDeparture.minutes != null
    ) {
      const depMin = schedule.returnDeparture.minutes;
      const latest = depMin - FLIGHT_AIRPORT_BUFFER_MIN;
      const depLabel = formatMinutes12h(depMin);
      if (latest <= 12 * 60) {
        day.afternoon = [];
        day.evening = [];
      } else if (latest <= 16 * 60) {
        day.evening = [];
      }
      day.tips = (Array.isArray(day.tips) ? day.tips : []).concat([
        'Return flight at ' + depLabel + ' — finish by ' + formatMinutes12h(latest) + ' for the airport.',
      ]);
      warnings.push({
        type: 'flight_departure',
        severity: 'info',
        message: 'Return departs at ' + depLabel + '. Last-day timeline ends before you need to leave for the airport.',
      });
    }
  });

  return { days, warnings };
}

function shouldRenderPeriod(day, period, dayIndex, totalDays, selectedFlight) {
  const schedule = extractFlightSchedule(selectedFlight);
  const computed = computeDayFlightHints(dayIndex, totalDays, schedule);
  const hints = (day && day._slotTimeHints) || (computed && computed.hints);
  if (hints && hints[period] === null) return false;
  if (dayIndex === 0 && schedule && schedule.outboundArrival) {
    const land = schedule.outboundArrival.minutes;
    if (land != null && land >= 22 * 60 && (period === 'morning' || period === 'afternoon')) return false;
    if (land != null && land >= 18 * 60 && (period === 'morning' || period === 'afternoon')) return false;
    if (land != null && land >= 14 * 60 && period === 'morning') return false;
  }
  return true;
}

function slotTimeForPeriod(period, indexInPeriod, day, dayIndex, totalDays, selectedFlight) {
  const schedule = extractFlightSchedule(selectedFlight);
  const computed = computeDayFlightHints(dayIndex, totalDays, schedule);
  const hints = (day && day._slotTimeHints) || (computed && computed.hints);
  const meta = (day && day._flightMeta) || (computed && computed.meta);

  if (hints && hints[period] === null) return '—';

  let totalMin;
  if (hints && typeof hints[period] === 'number') {
    totalMin = hints[period] + indexInPeriod * 40;
  } else if (meta && meta.type === 'arrival' && period === 'evening' && meta.earliestActivityMinutes != null) {
    totalMin = meta.earliestActivityMinutes + indexInPeriod * 40;
  } else {
    const baseH = { morning: 9, afternoon: 14, evening: 19 }[period] || 12;
    totalMin = baseH * 60 + indexInPeriod * 40;
  }
  const fromFlight =
    (hints && typeof hints[period] === 'number') ||
    (meta && meta.type === 'arrival' && period === 'evening' && meta.earliestActivityMinutes != null);
  if (!fromFlight) {
    totalMin = Math.min(23 * 60 + 30, totalMin);
  }
  return formatMinutes12h(totalMin);
}

function flightSchedulePromptBlock(schedule) {
  if (!schedule) return '';
  const lines = [
    '',
    'CONFIRMED FLIGHT SCHEDULE (HARD CONSTRAINTS — never schedule activities before landing or after leave-by time):',
  ];
  if (schedule.outboundArrival && schedule.outboundArrival.minutes != null) {
    const land = formatMinutes12h(schedule.outboundArrival.minutes);
    const earliest = formatMinutes12h(schedule.outboundArrival.minutes + FLIGHT_ARRIVAL_BUFFER_MIN);
    lines.push(
      '- Outbound lands at ' +
        schedule.destination +
        ' at ' +
        land +
        ' on the FIRST trip date. Nothing before ' +
        earliest +
        ' (allow ~' +
        FLIGHT_ARRIVAL_BUFFER_MIN +
        ' min after wheels-down).',
    );
    if (schedule.outboundArrival.minutes >= 22 * 60) {
      lines.push('- Late-night landing: day 1 = hotel check-in/rest ONLY — no tours at 7 PM or earlier.');
    }
  }
  if (schedule.returnDeparture && schedule.returnDeparture.minutes != null) {
    const dep = formatMinutes12h(schedule.returnDeparture.minutes);
    const latest = formatMinutes12h(schedule.returnDeparture.minutes - FLIGHT_AIRPORT_BUFFER_MIN);
    lines.push('- Return departs ' + schedule.origin + ' at ' + dep + ' on the LAST day. End activities by ' + latest + '.');
  }
  return lines.join('\n');
}

const api = {
  FLIGHT_ARRIVAL_BUFFER_MIN,
  FLIGHT_AIRPORT_BUFFER_MIN,
  formatMinutes12h,
  parseFlightDateTime,
  flightSelectionValid,
  extractFlightSchedule,
  computeDayFlightHints,
  applyFlightScheduleToDays,
  shouldRenderPeriod,
  slotTimeForPeriod,
  flightSchedulePromptBlock,
  filterMealsAfterMinutes,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.__flightScheduleHelpers = api;
}
