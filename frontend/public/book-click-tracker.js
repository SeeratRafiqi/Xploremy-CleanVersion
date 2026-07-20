/**
 * Logs Book tickets clicks from the event hub overlay only.
 * Resolves events_chatbot.id by ticket URL before logging so event_clicks
 * joins correctly against events_chatbot.
 */
(function () {
  'use strict';

  const resolveCache = new Map();

  function ticketUrlFromEl(el) {
    if (!el) return '';
    return (el.getAttribute('data-event-url') || el.getAttribute('href') || '').trim();
  }

  function eventIdFromEl(el) {
    if (!el) return '';
    return (el.getAttribute('data-event-id') || '').trim();
  }

  function eventNameFromEl(el) {
    if (!el) return '';
    return (
      el.getAttribute('data-event-name') ||
      el.getAttribute('data-event-title') ||
      el.getAttribute('aria-label') ||
      ''
    ).trim();
  }

  function eventCityFromEl(el) {
    if (!el) return '';
    return (el.getAttribute('data-event-city') || '').trim();
  }

  function platformFromEl(el) {
    if (!el) return '';
    return (
      el.getAttribute('data-event-source') ||
      el.getAttribute('data-event-platform') ||
      el.getAttribute('data-source') ||
      ''
    ).trim();
  }

  function applyResolved(btn, row) {
    if (!btn || !row || row.id == null) return;
    btn.setAttribute('data-event-id', String(row.id));
    btn.setAttribute('data-event-city', String(row.city || ''));
    btn.setAttribute('data-event-source', String(row.platform || row.source || ''));
    if (row.title) btn.setAttribute('data-event-name', String(row.title));
    btn.setAttribute('data-chatbot-resolved', '1');
  }

  function fetchChatbotEventByUrl(ticketUrl) {
    if (!ticketUrl) return Promise.resolve(null);
    if (resolveCache.has(ticketUrl)) return resolveCache.get(ticketUrl);
    const p = fetch('/api/events/resolve-by-url?url=' + encodeURIComponent(ticketUrl), {
      credentials: 'same-origin',
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        return data && data.id != null ? data : null;
      })
      .catch(function () {
        return null;
      });
    resolveCache.set(ticketUrl, p);
    return p;
  }

  function ensureResolved(btn) {
    if (!btn) return Promise.resolve();
    if (btn.getAttribute('data-chatbot-resolved') === '1') return Promise.resolve();
    const ticketUrl = ticketUrlFromEl(btn);
    if (!ticketUrl) {
      btn.setAttribute('data-chatbot-resolved', '1');
      return Promise.resolve();
    }
    return fetchChatbotEventByUrl(ticketUrl).then(function (row) {
      if (row) applyResolved(btn, row);
      else btn.setAttribute('data-chatbot-resolved', '1');
    });
  }

  function onHubOpened(detail) {
    const btn = document.getElementById('eh-book-btn');
    if (!btn || btn.hasAttribute('hidden')) return;
    const d = detail && typeof detail === 'object' ? detail : {};
    const url = String(d.url || ticketUrlFromEl(btn) || '').trim();
    if (url) {
      btn.setAttribute('data-event-url', url);
      btn.removeAttribute('data-chatbot-resolved');
    }
    if (d.title) btn.setAttribute('data-event-name', String(d.title));
    btn.setAttribute('data-event-city', String(d.city || ''));
    btn.setAttribute('data-event-source', String(d.source || d.platform || ''));
    ensureResolved(btn);
  }

  function logOverlayBookClick(el) {
    const payload = {
      eventId: eventIdFromEl(el),
      eventName: eventNameFromEl(el),
      city: eventCityFromEl(el),
      platform: platformFromEl(el),
      clickSource: 'overlay_book',
    };
    if (!payload.eventId && !payload.eventName) return;
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon('/api/fan-dna/click', blob)) return;
      }
      fetch('/api/fan-dna/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: body,
      }).catch(function () {});
    } catch (e) {
      /* ignore */
    }
  }

  function logHubOpen(detail) {
    const d = detail && typeof detail === 'object' ? detail : {};
    const payload = {
      eventId: String(d.id || d.url || '').trim(),
      eventName: String(d.title || '').trim(),
      city: String(d.city || '').trim(),
      platform: String(d.source || d.platform || '').trim(),
      clickSource: 'hub_open',
    };
    if (!payload.eventId && !payload.eventName) return;
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon('/api/fan-dna/click', blob)) return;
      }
      fetch('/api/fan-dna/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: body,
      }).catch(function () {});
    } catch (err) {
      /* ignore */
    }
  }

  document.addEventListener('event-hub:opened', function (e) {
    onHubOpened(e.detail);
    logHubOpen(e.detail);
  });

  document.addEventListener(
    'click',
    function (e) {
      const btn = e.target.closest('#eh-book-btn');
      if (!btn || btn.hasAttribute('hidden')) return;
      ensureResolved(btn).then(function () {
        logOverlayBookClick(btn);
      });
    },
    true,
  );
})();
