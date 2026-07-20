/**
 * Loads session user for flight defaults + header. Dispatches `ts-auth-change` when ready or after logout.
 */
(function () {
  'use strict';

  window.__authUser = null;
  window.__authReady = false;

  window.__getHomeIataFromProfile = function () {
    const u = window.__authUser;
    const iata =
      u && u.profile && u.profile.homeIata && String(u.profile.homeIata).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(iata) ? iata : 'KUL';
  };

  /** Budget (1–4), pace (slow|balanced|packed), and home airport for Eventra Copilot. */
  window.__getTravelProfileFromUser = function () {
    const u = window.__authUser;
    const p = (u && u.profile) || {};
    let budgetLevel = parseInt(String(p.budgetLevel), 10);
    if (!Number.isFinite(budgetLevel) || budgetLevel < 1 || budgetLevel > 4) budgetLevel = 2;
    const paceRaw = String(p.pacePreference || 'balanced');
    const pacePreference = ['slow', 'balanced', 'packed'].includes(paceRaw) ? paceRaw : 'balanced';
    return {
      homeIata: window.__getHomeIataFromProfile(),
      budgetLevel: budgetLevel,
      pacePreference: pacePreference,
      hasProfile: Boolean(u && u.profile),
    };
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escAttr(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clearClientAuthArtifacts() {
    try {
      window.__authUser = null;
    } catch (e) {
      /* ignore */
    }
    function strip(store, keys) {
      if (!store || !keys || !keys.length) return;
      keys.forEach(function (k) {
        try {
          store.removeItem(k);
        } catch (err) {
          /* ignore */
        }
      });
    }
    // Per-user chat history uses ticket_scraper_ai_conversations_v2:<userId> — keep on sign-out.
    strip(window.localStorage, ['ts_session_backup', 'ticket_scraper_auth', 'ticket_scraper_ai_conversations_v2']);
    strip(window.sessionStorage, ['ts_session_backup', 'ticket_scraper_auth']);
  }

  async function signOutAndRedirect() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {
      /* still clear client + redirect */
    }
    clearClientAuthArtifacts();
    window.__authUser = null;
    document.dispatchEvent(new CustomEvent('ts-auth-change', { detail: { user: null } }));
    window.location.replace('/auth');
  }

  function renderHeaderAuth() {
    const host = $('header-auth');
    if (!host) return;
    const u = window.__authUser;
    if (!u) {
      host.innerHTML =
        '<a class="header-auth-link" href="/auth">Sign in</a>' +
        '<a class="header-auth-link header-auth-link--gold" href="/auth#register">Create account</a>';
      return;
    }
    const name = (u.displayName || u.email || 'Account').trim();
    const iata = (u.profile && u.profile.homeIata) || 'KUL';
    host.innerHTML =
      '<span class="header-auth-name" title="' +
      escAttr(u.email) +
      '">' +
      escAttr(name) +
      '</span>' +
      '<span class="header-auth-chip">Flights from · ' +
      escAttr(String(iata).toUpperCase()) +
      '</span>' +
      '<a class="header-auth-link" href="/profile">Profile</a>' +
      '<a class="header-auth-link" href="#" id="header-auth-saved-trips">Saved trips</a>' +
      '<button type="button" class="header-auth-out" id="header-auth-out">Sign out</button>';
  }

  async function refreshAuth() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (r.ok) {
        const j = await r.json();
        window.__authUser = j.user || null;
      } else {
        window.__authUser = null;
      }
    } catch (e) {
      window.__authUser = null;
    }
    window.__authReady = true;
    renderHeaderAuth();
    maybeRedirectGoLiveAdmin();
    maybeRedirectOnboarding();
    document.dispatchEvent(
      new CustomEvent('ts-auth-change', { detail: { user: window.__authUser } }),
    );
  }

  function maybeRedirectGoLiveAdmin() {
    const u = window.__authUser;
    if (
      !u ||
      String(u.email || '').trim().toLowerCase() !== 'admin@golive.com' ||
      !(location.pathname || '').endsWith('/admin.html')
    ) {
      return;
    }
    return;
  }

  function maybeRedirectOnboarding() {
    const u = window.__authUser;
    if (u && String(u.email || '').trim().toLowerCase() === 'admin@golive.com') {
      return;
    }
    const p = location.pathname || '';
    if (p !== '/events') return;
    if ((location.search || '').indexOf('tab=fan-dna') >= 0) return;
    if (u && u.profile && u.profile.onboardingComplete === false) {
      location.replace('/onboarding');
    }
  }

  window.__refreshAuth = refreshAuth;

  document.addEventListener(
    'click',
    function (e) {
      const t2 = e.target && e.target.closest && e.target.closest('#header-auth-saved-trips');
      if (t2) {
        e.preventDefault();
        if (typeof window.__openSavedItineraries === 'function') {
          window.__openSavedItineraries();
        }
        return;
      }
      const t = e.target && e.target.closest && e.target.closest('#header-auth-out');
      if (!t) return;
      e.preventDefault();
      void signOutAndRedirect();
    },
    false,
  );

  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted) void refreshAuth();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      void refreshAuth();
    });
  } else {
    void refreshAuth();
  }
})();
