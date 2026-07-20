(function () {
  'use strict';

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showErr(msg) {
    const el = document.getElementById('fdna-err');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
      el.removeAttribute('hidden');
    } else {
      el.hidden = true;
      el.setAttribute('hidden', '');
    }
  }

  function promptHtml() {
    return (
      '<div class="fdna-prompt">' +
      '<p class="fdna-title" style="font-size:1.35rem">Complete your Fan DNA profile</p>' +
      '<p class="fdna-sub" style="margin:12px auto 0">Set your taste sliders in Profile so we can rank DNA matches above 60%.</p>' +
      '<a href="/onboarding?fanDna=1">Set up Fan DNA</a>' +
      ' · <a href="/profile" style="color:var(--gold);font-size:0.85rem">Profile</a>' +
      '</div>'
    );
  }

  function cardHtml(e, idx) {
    const img = e.image
      ? '<img src="' + esc(e.image) + '" alt="" loading="lazy" />'
      : '<div class="no-img">🎟️</div>';
    const dateStr = e.date ? new Date(e.date).toDateString() : 'Date TBA';
    const score = e.fanDnaScore != null ? e.fanDnaScore : 0;
    const book =
      e.url
        ? '<a class="fdna-book" href="' +
          esc(e.url) +
          '" target="_blank" rel="noopener noreferrer" data-track-book="1" data-event-id="' +
          esc(e.url) +
          '" data-event-name="' +
          esc(e.title) +
          '" onclick="event.stopPropagation()">Book Now</a>'
        : '';
    return (
      '<article class="fdna-card fdna-card--clickable" data-event-idx="' +
      idx +
      '" role="button" tabindex="0">' +
      img +
      '<div class="fdna-card-body">' +
      '<span class="fdna-score">' +
      esc(String(score)) +
      '% DNA match</span>' +
      '<h2 class="fdna-card-title">' +
      esc(e.title || 'Untitled') +
      '</h2>' +
      '<p class="fdna-meta">📍 ' +
      esc(e.venue || 'Venue TBA') +
      (e.city ? ', ' + esc(e.city) : '') +
      '</p>' +
      '<p class="fdna-meta">📅 ' +
      esc(dateStr) +
      '</p>' +
      '<p class="fdna-meta">💰 ' +
      esc(e.isFree ? 'Free' : e.price || 'Paid') +
      '</p>' +
      '<p class="fdna-tap-hint">Tap for match breakdown</p>' +
      book +
      '</div></article>'
    );
  }

  function openDetailModal(e) {
    var modal = document.getElementById('fdna-detail-modal');
    if (!modal) return;
    var match = e.dnaMatch;
    var titleEl = document.getElementById('fdna-modal-title');
    var bodyEl = document.getElementById('fdna-modal-body');
    if (titleEl) titleEl.textContent = e.title || 'Event';
    if (bodyEl) {
      if (typeof window.buildDnaMatchDetailHtml === 'function') {
        bodyEl.innerHTML = window.buildDnaMatchDetailHtml(match, e.fanDnaScore);
      } else {
        bodyEl.innerHTML =
          '<p class="fdna-meta">' + esc((e.fanDnaScore != null ? e.fanDnaScore : '—') + '% match') + '</p>';
      }
    }
    modal.hidden = false;
    modal.removeAttribute('hidden');
    document.body.classList.add('fdna-modal-open');
  }

  function closeDetailModal() {
    var modal = document.getElementById('fdna-detail-modal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('hidden', '');
    document.body.classList.remove('fdna-modal-open');
  }

  function bindCardClicks() {
    document.querySelectorAll('.fdna-card--clickable').forEach(function (card) {
      card.addEventListener('click', function () {
        var idx = parseInt(card.getAttribute('data-event-idx'), 10);
        if (!Number.isFinite(idx) || !eventsCache[idx]) return;
        openDetailModal(eventsCache[idx]);
      });
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          card.click();
        }
      });
    });
    var closeBtn = document.getElementById('fdna-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDetailModal);
    var backdrop = document.querySelector('.fdna-modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeDetailModal);
  }

  var eventsCache = [];

  async function init() {
    const root = document.getElementById('fdna-root');
    if (!root) return;

    try {
      const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!meRes.ok) {
        location.href = '/auth';
        return;
      }
      const me = await meRes.json();
      if (!me.user) {
        location.href = '/auth';
        return;
      }

      const res = await fetch('/api/fan-dna/matches?minScore=60&_=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showErr(data.error || 'Could not load matches');
        root.innerHTML = '<p class="fdna-empty">Something went wrong.</p>';
        return;
      }
      showErr('');
      if (!data.complete) {
        root.innerHTML = promptHtml();
        return;
      }
      eventsCache = Array.isArray(data.events) ? data.events : [];
      if (!eventsCache.length) {
        root.innerHTML =
          '<p class="fdna-empty">No events above 60% DNA match yet. Adjust your taste sliders in Profile and save.</p>';
        return;
      }
      root.innerHTML = '<div class="fdna-grid">' + eventsCache.map(cardHtml).join('') + '</div>';
      bindCardClicks();
    } catch (e) {
      showErr('Network error');
      root.innerHTML = '<p class="fdna-empty">Could not load Fan DNA.</p>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    void init();
  }
})();
