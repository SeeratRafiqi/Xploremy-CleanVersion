'use strict';

/**
 * Hotel listings via Amadeus Self-Service Hotel List API (official free-tier dev account).
 * Flow matches other scrapers: fetch → normalize → write JSON under data/.
 *
 * Does not scrape third-party travel booking sites. For AirAsia-branded inventory,
 * use AirAsia partner/API when available; use this for generic hotel discovery near a city or point.
 *
 * Docs: https://developers.amadeus.com/self-service/category/hotels/api-doc/hotel-list/api-reference
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const OUTPUT = path.join(__dirname, 'data', 'amadeus-hotels.json');

function baseUrl() {
  const env = (process.env.AMADEUS_ENV || 'test').toLowerCase();
  return env === 'production'
    ? 'https://api.amadeus.com'
    : 'https://test.api.amadeus.com';
}

function normalizeHotel(h) {
  const hotelId = String(h.hotelId || '').trim();
  if (!hotelId) return null;

  const lat = h.geoCode?.latitude;
  const lng = h.geoCode?.longitude;
  const lines = h.address?.lines;
  const addressText = Array.isArray(lines)
    ? lines.filter(Boolean).join(', ')
    : '';

  return {
    id: hotelId,
    name: (h.name || 'Unnamed').trim(),
    cityCode: h.iataCode || '',
    chainCode: h.chainCode || '',
    latitude: typeof lat === 'number' ? lat : null,
    longitude: typeof lng === 'number' ? lng : null,
    countryCode: h.address?.countryCode || '',
    address: addressText,
    lastUpdate: h.lastUpdate || '',
    source: 'amadeus',
  };
}

async function getAccessToken() {
  const clientId = (process.env.AMADEUS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.AMADEUS_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET in .env (create an app at https://developers.amadeus.com/my-apps)'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const { data } = await axios.post(
    `${baseUrl()}/v1/security/oauth2/token`,
    body.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    }
  );

  const token = data.access_token;
  if (!token) throw new Error('Amadeus token response missing access_token');
  return token;
}

function buildListParams() {
  const mode = (process.env.AMADEUS_HOTEL_MODE || 'city').toLowerCase();
  const hotelSource = (process.env.AMADEUS_HOTEL_SOURCE || 'ALL').trim();

  if (mode === 'geocode') {
    const lat = Number(process.env.AMADEUS_HOTEL_LAT);
    const lng = Number(process.env.AMADEUS_HOTEL_LNG);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(
        'AMADEUS_HOTEL_MODE=geocode requires AMADEUS_HOTEL_LAT and AMADEUS_HOTEL_LNG'
      );
    }
    const radius = Number(process.env.AMADEUS_HOTEL_RADIUS || 50);
    const radiusUnit = (process.env.AMADEUS_HOTEL_RADIUS_UNIT || 'KM').trim();
    return {
      path: '/v1/reference-data/locations/hotels/by-geocode',
      params: {
        latitude: lat,
        longitude: lng,
        radius: Number.isFinite(radius) ? radius : 50,
        radiusUnit,
        hotelSource,
      },
    };
  }

  const cityCode = (process.env.AMADEUS_HOTEL_CITY_CODE || 'KUL').trim().toUpperCase();
  const params = { cityCode, hotelSource };

  const radius = process.env.AMADEUS_HOTEL_RADIUS;
  const radiusUnit = (process.env.AMADEUS_HOTEL_RADIUS_UNIT || 'KM').trim();
  if (radius != null && String(radius).trim() !== '') {
    params.radius = Number(radius);
    params.radiusUnit = radiusUnit;
  }

  const chain = (process.env.AMADEUS_HOTEL_CHAIN_CODES || '').trim();
  if (chain) params.chainCodes = chain;

  return {
    path: '/v1/reference-data/locations/hotels/by-city',
    params,
  };
}

async function fetchHotelsOnce(token) {
  const { path, params } = buildListParams();
  const headers = { Authorization: `Bearer ${token}` };

  const { data } = await axios.get(`${baseUrl()}${path}`, {
    headers,
    params,
    timeout: 120000,
  });

  const byId = new Map();
  for (const h of data.data || []) {
    const row = normalizeHotel(h);
    if (row) byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

async function scrapeAmadeusHotels() {
  const mode = (process.env.AMADEUS_HOTEL_MODE || 'city').toLowerCase();
  console.log(
    `📡 Amadeus Hotel List — ${mode === 'geocode' ? 'by-geocode' : 'by-city'} (${baseUrl()})`
  );

  const token = await getAccessToken();
  const hotels = await fetchHotelsOnce(token);

  await fs.ensureDir(path.join(__dirname, 'data'));
  await fs.writeJson(OUTPUT, hotels, { spaces: 2 });

  console.log(`\n💾 Saved ${hotels.length} hotels → ${OUTPUT}`);
  return hotels;
}

if (require.main === module) {
  scrapeAmadeusHotels().catch((err) => {
    console.error(err.response?.data || err.message || err);
    process.exit(1);
  });
}

module.exports = { scrapeAmadeusHotels };
