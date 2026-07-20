/**
 * Log flight / hotel picks from event hub and trip planner.
 * DB-agnostic: receives the client (`db`) as its first argument.
 */
'use strict';

function isMissingTableError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return msg.includes('flight_selections') || msg.includes('hotel_selections') || msg.includes('does not exist');
}

function parseHotelPriceNumeric(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function logFlightSelection(supabase, row) {
  const payload = {
    user_id: row.user_id || null,
    event_id: row.event_id ? String(row.event_id).trim().slice(0, 200) : null,
    origin_airport: row.origin_airport ? String(row.origin_airport).trim().slice(0, 12) : null,
    destination_city: row.destination_city ? String(row.destination_city).trim().slice(0, 200) : null,
    flight_date: row.flight_date ? String(row.flight_date).slice(0, 10) : null,
  };
  const { error } = await supabase.from('flight_selections').insert(payload);
  if (error) throw new Error(error.message);
}

async function logHotelSelection(supabase, row) {
  const hotelPrice = row.hotel_price != null ? String(row.hotel_price).trim().slice(0, 80) : null;
  const hotelPriceNumeric =
    row.hotel_price_numeric != null
      ? parseHotelPriceNumeric(row.hotel_price_numeric)
      : parseHotelPriceNumeric(row.hotel_price);
  const payload = {
    user_id: row.user_id || null,
    event_id: row.event_id ? String(row.event_id).trim().slice(0, 200) : null,
    hotel_name: row.hotel_name ? String(row.hotel_name).trim().slice(0, 500) : null,
    hotel_price: hotelPrice,
    check_in: row.check_in ? String(row.check_in).slice(0, 10) : null,
    check_out: row.check_out ? String(row.check_out).slice(0, 10) : null,
    city: row.city ? String(row.city).trim().slice(0, 200) : null,
  };
  if (hotelPriceNumeric != null) payload.hotel_price_numeric = hotelPriceNumeric;
  const { error } = await supabase.from('hotel_selections').insert(payload);
  if (error) throw new Error(error.message);
}

module.exports = {
  isMissingTableError,
  logFlightSelection,
  logHotelSelection,
};
