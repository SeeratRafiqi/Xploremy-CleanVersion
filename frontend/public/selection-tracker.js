/**
 * Client-side: log flight / hotel selections when signed in.
 */
(function () {
  'use strict';

  function post(path, body) {
    try {
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify(body || {}),
      }).catch(function () {});
    } catch (e) {
      /* ignore */
    }
  }

  window.__logFlightSelection = function (opts) {
    if (!opts || typeof opts !== 'object') return;
    post('/api/fan-dna/flight-selection', opts);
  };

  window.__logHotelSelection = function (opts) {
    if (!opts || typeof opts !== 'object') return;
    post('/api/fan-dna/hotel-selection', opts);
  };
})();
