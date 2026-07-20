/**
 * Hero "Tell your vibe" — guided button chat (Shein / Kommunicate style).
 * Builds a natural-language query and calls window.__heroGuidedSubmitQuery.
 */
(function () {
  'use strict';

  const DIMENSIONS = {
    energy: {
      question: "What's your energy right now?",
      options: [
        { id: 'chill', label: 'Low key & chill', value: 'low-key and relaxed' },
        { id: 'balanced', label: 'Balanced', value: 'balanced, not too intense' },
        { id: 'high', label: 'High energy', value: 'high energy and exciting' },
        { id: 'party', label: 'Party mode', value: 'party and nightlife energy' },
      ],
    },
    budget: {
      question: "What's your budget?",
      options: [
        { id: 'free', label: 'Free & cheap', value: 'free or very budget-friendly' },
        { id: 'mid', label: 'Fair balance', value: 'mid-range budget' },
        { id: 'treat', label: 'Treat yourself', value: 'willing to spend more for quality' },
        { id: 'luxury', label: 'Go all out', value: 'luxury or premium experiences' },
      ],
    },
    when: {
      question: 'When do you want to go?',
      options: [
        { id: 'weekend', label: 'This weekend', value: 'this weekend' },
        { id: 'month', label: 'This month', value: 'this month' },
        { id: 'next', label: 'Next month', value: 'next month' },
        { id: 'flex', label: 'Flexible / anytime soon', value: 'anytime soon, flexible dates' },
      ],
    },
    mood: {
      question: 'What mood or vibe are you after?',
      options: [
        { id: 'all', label: 'Open to anything', value: 'any category or mood' },
        { id: 'music', label: '🎵 Music', value: 'music and concerts' },
        { id: 'arts', label: '🎭 Arts & culture', value: 'arts, culture, and theatre' },
        { id: 'food', label: '🍜 Food & dining', value: 'food, markets, and dining events' },
        { id: 'sports', label: '⚽ Sports & outdoors', value: 'sports and outdoor events' },
        { id: 'comedy', label: '🎪 Comedy & shows', value: 'comedy and live shows' },
        { id: 'wellness', label: '🌿 Wellness', value: 'wellness and mindful events' },
        { id: 'tech', label: '💻 Tech & innovation', value: 'tech and innovation events' },
        { id: 'family', label: '👨‍👩‍👧 Family', value: 'family-friendly events' },
      ],
    },
  };

  const ROOT_OPTIONS = [
    { id: 'energy', label: "What's your energy right now?", type: 'dimension' },
    { id: 'budget', label: "What's your budget?", type: 'dimension' },
    { id: 'when', label: 'When do you want to go?', type: 'dimension' },
    { id: 'mood', label: 'What mood or vibe?', type: 'dimension' },
    { id: 'more', label: 'More info about events', type: 'openDrawer' },
  ];

  let state = {
    answers: {},
    activeDimension: null,
    busy: false,
  };

  let autoSubmitTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildQueryFromAnswers() {
    const a = state.answers;
    const parts = [];
    if (a.energy) parts.push('My energy is ' + a.energy.value);
    if (a.budget) parts.push('My budget preference is ' + a.budget.value);
    if (a.when) parts.push('Timing: ' + a.when.value);
    if (a.mood && a.mood.catId && a.mood.catId !== 'all') {
      parts.push('Mood or category: ' + a.mood.value);
    }
    if (!parts.length) {
      return 'Show me upcoming events in Malaysia that are worth attending.';
    }
    return (
      'Find events in Malaysia for me. ' +
      parts.join('. ') +
      '. Recommend specific upcoming events from the listings.'
    );
  }

  function answerCount() {
    return Object.keys(state.answers).length;
  }

  function addBotMessage() {
    /* Guided UI shows picks as pills + events in grid — no chat bubbles here. */
  }

  function addUserChoice() {
    /* Selections appear as vibe pills only. */
  }

  function renderPills() {
    const host = $('hero-guided-pills');
    if (!host) return;
    const keys = Object.keys(state.answers);
    if (!keys.length) {
      host.hidden = true;
      host.setAttribute('hidden', '');
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.removeAttribute('hidden');
    host.innerHTML = keys
      .map(function (k) {
        const a = state.answers[k];
        return (
          '<span class="hero-guided-pill">' +
          escapeHtml(a.short || a.label) +
          '</span>'
        );
      })
      .join('');
  }

  function renderChips(options, context) {
    const host = $('hero-guided-chips');
    if (!host) return;
    host.innerHTML = '';
    host.dataset.context = context || 'root';

    options.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hero-guided-chip';
      if (opt.type === 'openDrawer') btn.classList.add('hero-guided-chip--accent');
      if (opt.type === 'find') btn.classList.add('hero-guided-chip--primary');
      if (opt.type === 'back') btn.classList.add('hero-guided-chip--ghost');
      btn.textContent = opt.label;
      btn.dataset.action = opt.type || 'dimension';
      if (opt.id) btn.dataset.id = opt.id;
      if (opt.dimension) btn.dataset.dimension = opt.dimension;
      host.appendChild(btn);
    });
  }

  function showRootMenu() {
    state.activeDimension = null;
    const opts = ROOT_OPTIONS.slice();
    opts.push({ id: 'restart', label: 'Start over', type: 'restart' });
    renderChips(opts, 'root');
  }

  function showDimensionMenu(dimKey) {
    const dim = DIMENSIONS[dimKey];
    if (!dim) return;
    state.activeDimension = dimKey;
    const opts = dim.options.map(function (o) {
      return {
        id: o.id,
        label: o.label,
        type: 'pick',
        dimension: dimKey,
        value: o.value,
      };
    });
    opts.push({ id: 'back', label: '← Back to questions', type: 'back' });
    renderChips(
      opts.map(function (o) {
        return {
          label: o.label,
          type: o.type,
          id: o.id,
          dimension: o.dimension,
          value: o.value,
        };
      }),
      dimKey,
    );
  }

  function applyCategoryFilter(catId) {
    if (typeof window.__setEventCategoryFilter === 'function') {
      window.__setEventCategoryFilter(catId || 'all');
    }
  }

  function onDimensionPick(dimKey, label, value, catId) {
    const short =
      dimKey === 'energy'
        ? 'Energy'
        : dimKey === 'budget'
          ? 'Budget'
          : dimKey === 'when'
            ? 'When'
            : 'Mood';
    state.answers[dimKey] = {
      label: label,
      value: value,
      short: short + ': ' + label,
      catId: catId || null,
    };
    if (dimKey === 'mood') {
      applyCategoryFilter(catId || 'all');
    }
    renderPills();
    showRootMenu();
    scheduleAutoFindEvents();
  }

  function clearAutoSubmitTimer() {
    if (autoSubmitTimer) {
      clearTimeout(autoSubmitTimer);
      autoSubmitTimer = null;
    }
  }

  function scheduleAutoFindEvents() {
    if (answerCount() === 0) return;
    clearAutoSubmitTimer();
    autoSubmitTimer = setTimeout(function trySubmit() {
      if (state.busy) {
        autoSubmitTimer = setTimeout(trySubmit, 350);
        return;
      }
      autoSubmitTimer = null;
      submitFindEvents({ auto: true });
    }, 450);
  }

  function setBusy(on) {
    state.busy = !!on;
    const host = $('hero-guided-chips');
    if (host) {
      host.classList.toggle('is-busy', state.busy);
      host.querySelectorAll('button').forEach(function (b) {
        b.disabled = state.busy;
      });
    }
  }

  function submitFindEvents(opts) {
    if (state.busy) return;
    const auto = !!(opts && opts.auto);
    const q = buildQueryFromAnswers();
    setBusy(true);
    if (typeof window.__heroGuidedSubmitQuery === 'function') {
      window.__heroGuidedSubmitQuery(q, function done() {
        setBusy(false);
      });
    } else {
      setBusy(false);
    }
  }

  function openFullChatbot() {
    const q = buildQueryFromAnswers();
    if (typeof window.__openAiAssistantDrawer === 'function') {
      window.__openAiAssistantDrawer(q, { newChat: true });
    }
    showRootMenu();
  }

  function resetGuided() {
    clearAutoSubmitTimer();
    state.answers = {};
    state.activeDimension = null;
    applyCategoryFilter('all');
    renderPills();
    showRootMenu();
  }

  function onChipClick(e) {
    const btn = e.target.closest('.hero-guided-chip');
    if (!btn || btn.disabled || state.busy) return;
    e.preventDefault();
    const action = btn.dataset.action || 'dimension';
    const id = btn.dataset.id;

    if (action === 'back') {
      showRootMenu();
      return;
    }
    if (action === 'restart') {
      resetGuided();
      return;
    }
    if (action === 'find') {
      clearAutoSubmitTimer();
      submitFindEvents();
      return;
    }
    if (action === 'openDrawer') {
      openFullChatbot();
      return;
    }
    if (action === 'dimension' && id && DIMENSIONS[id]) {
      showDimensionMenu(id);
      return;
    }
    if (action === 'pick') {
      const dimKey = btn.dataset.dimension;
      const dim = DIMENSIONS[dimKey];
      if (!dim) return;
      const opt = dim.options.find(function (o) {
        return o.id === id;
      });
      if (opt) onDimensionPick(dimKey, opt.label, opt.value, opt.id);
    }
  }

  function init() {
    const chips = $('hero-guided-chips');
    if (!chips) return;

    chips.addEventListener('click', onChipClick);
    resetGuided();
  }

  window.__heroGuidedChatReset = resetGuided;

  function boot() {
    if (!$('hero-guided-chips')) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      }
      return;
    }
    init();
  }

  boot();
})();
