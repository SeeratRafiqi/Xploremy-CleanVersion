/**
 * Event hub — Flights tab step-by-step guided chat.
 */
(function () {
  'use strict';

  const STEP_OPTIONS = {
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

  let api = null;
  let inited = false;
  let state = {
    step: 'arrive',
    history: [],
    currentQuestion: '',
    answers: {},
    busy: false,
    done: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function addBubble(role, text) {
    const host = $('eh-flights-guided-messages');
    if (!host) return;
    const el = document.createElement('div');
    el.className =
      'hero-guided-bubble ' + (role === 'user' ? 'hero-guided-bubble--user' : 'hero-guided-bubble--bot');
    if (role === 'bot') {
      const av = document.createElement('span');
      av.className = 'hero-guided-avatar';
      av.setAttribute('aria-hidden', 'true');
      av.textContent = '\u2726';
      const txt = document.createElement('span');
      txt.className = 'hero-guided-bubble-text';
      txt.textContent = text;
      el.appendChild(av);
      el.appendChild(txt);
    } else {
      el.textContent = text;
    }
    host.appendChild(el);
    host.scrollTop = host.scrollHeight;
  }

  function renderMessages() {
    const host = $('eh-flights-guided-messages');
    if (!host) return;
    host.innerHTML = '';
    state.history.forEach(function (item) {
      addBubble(item.role, item.text);
    });
    if (state.currentQuestion && state.step !== 'done') {
      addBubble('bot', state.currentQuestion);
    }
  }

  function renderChips() {
    const host = $('eh-flights-guided-chips');
    const wrap = $('eh-flights-guided-options');
    if (!host) return;
    host.innerHTML = '';
    if (state.busy || state.done || state.step === 'done') {
      if (wrap) wrap.hidden = true;
      return;
    }
    const step = STEP_OPTIONS[state.step];
    if (!step) {
      if (wrap) wrap.hidden = true;
      return;
    }
    if (wrap) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
    }
    step.choices.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hero-guided-chip';
      btn.textContent = opt.label;
      btn.dataset.fgStep = state.step;
      btn.dataset.fgId = opt.id;
      host.appendChild(btn);
    });
  }

  function setResultsVisible(show) {
    const wrap = $('eh-flights-results-wrap');
    if (!wrap) return;
    if (show) {
      wrap.hidden = false;
      wrap.removeAttribute('hidden');
    } else {
      wrap.hidden = true;
      wrap.setAttribute('hidden', '');
    }
  }

  function render() {
    renderMessages();
    renderChips();
  }

  function onPick(step, opt) {
    if (state.busy || state.done) return;
    state.history.push({ role: 'user', text: opt.label });

    if (step === 'arrive') {
      state.answers.daysBefore = opt.daysBefore;
      state.currentQuestion = STEP_OPTIONS.stay.question;
      state.step = 'stay';
      render();
      return;
    }

    if (step === 'stay') {
      state.answers.daysAfter = opt.daysAfter;
      state.currentQuestion = STEP_OPTIONS.pref.question;
      state.step = 'pref';
      render();
      return;
    }

    if (step === 'pref') {
      state.answers.sortMode = opt.sortMode;
      state.answers.preferDirect = opt.preferDirect;
      state.currentQuestion = '';
      state.step = 'done';
      state.done = true;
      state.history.push({ role: 'bot', text: 'Perfect, here\u2019s what I found for you \ud83c\udfaf' });
      render();
      setResultsVisible(true);
      state.busy = true;
      renderChips();
      if (api && typeof api.onComplete === 'function') {
        Promise.resolve(
          api.onComplete({
            daysBefore: state.answers.daysBefore,
            daysAfter: state.answers.daysAfter,
            sortMode: state.answers.sortMode || 'default',
            preferDirect: !!state.answers.preferDirect,
          }),
        ).finally(function () {
          state.busy = false;
          renderChips();
        });
      } else {
        state.busy = false;
      }
    }
  }

  function reset() {
    state = {
      step: 'arrive',
      history: [{ role: 'bot', text: 'Let\u2019s find you flights! \u2708\ufe0f' }],
      currentQuestion: STEP_OPTIONS.arrive.question,
      answers: {},
      busy: false,
      done: false,
    };
    setResultsVisible(false);
    const fr = $('eh-flights-results');
    if (fr) fr.innerHTML = '';
    render();
  }

  function init(hubApi) {
    api = hubApi || null;
    const chips = $('eh-flights-guided-chips');
    if (!chips) return false;
    if (!inited) {
      chips.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-fg-step]');
        if (!btn || btn.disabled || state.busy) return;
        e.preventDefault();
        const step = btn.dataset.fgStep;
        const stepDef = STEP_OPTIONS[step];
        if (!stepDef) return;
        const opt = stepDef.choices.find(function (o) {
          return o.id === btn.dataset.fgId;
        });
        if (opt) onPick(step, opt);
      });
      inited = true;
    }
    reset();
    return true;
  }

  function boot() {
    if (!$('eh-flights-guided-chips')) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      }
      return;
    }
    if (window.__ehFlightsGuidedPendingApi) {
      init(window.__ehFlightsGuidedPendingApi);
    }
  }

  window.__ehFlightsGuided = {
    init: init,
    reset: reset,
    isDone: function () {
      return state.done;
    },
    ensure: function (hubApi) {
      if (hubApi) api = hubApi;
      if (!init(api)) return false;
      if (!state.done) reset();
      return true;
    },
  };

  boot();
})();
