(function () {
  'use strict';

  var TRAIT_EMOJIS = {
    social: '🎭',
    entertainment: '🎵',
    educational: '🧠',
    budget_friendly: '💰',
    outdoor: '🌿',
    energy_level: '⚡',
    family_friendly: '👨‍👩‍👧',
    networking: '🤝',
  };

  var radarChartInstance = null;

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function matchTier(pct) {
    var n = Number(pct);
    if (!Number.isFinite(n)) return 'low';
    if (n > 75) return 'high';
    if (n >= 50) return 'med';
    return 'low';
  }

  function barTier(pct) {
    var n = Number(pct);
    if (!Number.isFinite(n)) return 'low';
    if (n >= 80) return 'high';
    if (n >= 50) return 'med';
    return 'low';
  }

  function tierClass(tier) {
    return 'eh-dna-tier--' + (tier || 'low');
  }

  function resolveMatch(match, fallbackScore) {
    if (match && match.complete) return match;
    if (match && match.score != null) return match;
    if (fallbackScore != null) {
      return {
        score: fallbackScore,
        percent: fallbackScore,
        complete: false,
        traits: [],
        summary: '',
        reasons: [],
        topMatches: [],
        gaps: [],
      };
    }
    return null;
  }

  function donutSvg(pct) {
    var n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    var r = 32;
    var circ = 2 * Math.PI * r;
    var offset = circ * (1 - n / 100);
    var tier = matchTier(n);
    return (
      '<div class="eh-dna-ring ' +
      tierClass(tier) +
      '" aria-hidden="true">' +
      '<svg width="80" height="80" viewBox="0 0 80 80">' +
      '<circle cx="40" cy="40" r="' +
      r +
      '" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="8"/>' +
      '<circle cx="40" cy="40" r="' +
      r +
      '" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"' +
      ' stroke-dasharray="' +
      circ.toFixed(2) +
      '" stroke-dashoffset="' +
      offset.toFixed(2) +
      '" transform="rotate(-90 40 40)"/>' +
      '<text x="40" y="44" text-anchor="middle" class="eh-dna-ring__text">' +
      esc(String(n)) +
      '%</text>' +
      '</svg></div>'
    );
  }

  function kpiCards(traits) {
    var strong = 0;
    var partial = 0;
    var low = 0;
    (traits || []).forEach(function (t) {
      var p = Number(t.percent);
      if (p >= 80) strong += 1;
      else if (p >= 50) partial += 1;
      else low += 1;
    });
    return (
      '<div class="eh-dna-kpis">' +
      '<div class="eh-dna-kpi eh-dna-kpi--high"><span class="eh-dna-kpi__val">' +
      strong +
      '</span><span class="eh-dna-kpi__label">Strong matches</span></div>' +
      '<div class="eh-dna-kpi eh-dna-kpi--med"><span class="eh-dna-kpi__val">' +
      partial +
      '</span><span class="eh-dna-kpi__label">Partial matches</span></div>' +
      '<div class="eh-dna-kpi eh-dna-kpi--low"><span class="eh-dna-kpi__val">' +
      low +
      '</span><span class="eh-dna-kpi__label">Low matches</span></div>' +
      '</div>'
    );
  }

  function breakdownRows(traits) {
    if (!traits || !traits.length) {
      return '<p class="eh-dna-muted">No trait breakdown available.</p>';
    }
    return traits
      .map(function (t) {
        var emoji = TRAIT_EMOJIS[t.trait] || '•';
        var tier = barTier(t.percent);
        return (
          '<div class="eh-dna-breakdown-item">' +
          '<span class="eh-dna-breakdown-item__label">' +
          esc(t.label) +
          '</span>' +
          '<div class="eh-dna-breakdown-item__track">' +
          '<span class="eh-dna-breakdown-item__fill ' +
          tierClass(tier) +
          '" style="width:' +
          esc(String(Math.max(0, Math.min(100, t.percent)))) +
          '%"></span></div>' +
          '<span class="eh-dna-breakdown-item__pct">' +
          esc(String(t.percent)) +
          '%</span></div>'
        );
      })
      .join('');
  }

  function pillHtml(label, tier, icon) {
    return (
      '<span class="eh-dna-pill ' +
      tierClass(tier) +
      '"><span class="eh-dna-pill__icon" aria-hidden="true">' +
      icon +
      '</span>' +
      esc(label) +
      '</span>'
    );
  }

  function whyPills(match) {
    var traits = match.traits || [];
    var topIds = {};
    var gapIds = {};
    (match.topMatches || []).forEach(function (t) {
      topIds[t.trait] = true;
    });
    (match.gaps || []).forEach(function (t) {
      gapIds[t.trait] = true;
    });
    var pills = [];
    traits.forEach(function (t) {
      if (topIds[t.trait]) {
        pills.push(pillHtml(t.label, 'high', '✓'));
      } else if (gapIds[t.trait]) {
        pills.push(pillHtml(t.label, 'low', '✕'));
      } else {
        pills.push(pillHtml(t.label, 'med', '−'));
      }
    });
    return pills.join('');
  }

  function explanationText(match) {
    if (match.explanation) return match.explanation;
    if (match.summary) return match.summary;
    if (match.reasons && match.reasons.length) return match.reasons.join(' ');
    var top = (match.traits || [])
      .filter(function (v) {
        return v.percent >= 70;
      })
      .slice(0, 2)
      .map(function (v) {
        return v.label.toLowerCase();
      });
    if (top.length === 2) {
      return 'Looks like your kind of night — it lines up with your taste for ' + top[0] + ' and ' + top[1] + '.';
    }
    if (top.length === 1) {
      return 'This one leans into your taste for ' + top[0] + ' — could be a good fit for you.';
    }
    return "Here's how this event stacks up against the things you usually go for.";
  }

  function buildFanDnaPromptHtml() {
    return (
      '<div class="eh-dna-card eh-dna-card--prompt">' +
      '<p class="eh-dna-prompt-title">Complete your Fan DNA profile to see how well this event matches your taste</p>' +
      '<a class="eh-btn eh-btn--cyan" href="/onboarding?fanDna=1">Set up Fan DNA →</a>' +
      '</div>'
    );
  }

  function buildDnaMatchDetailHtml(match, fallbackScore) {
    var resolved = resolveMatch(match, fallbackScore);
    if (!resolved || !resolved.complete) {
      return buildFanDnaPromptHtml();
    }

    var score = resolved.score != null ? resolved.score : resolved.percent;
    var tier = matchTier(score);
    var traits = resolved.traits || [];

    return (
      '<section class="eh-dna-layout">' +
      '<div class="eh-dna-main">' +
      '<div class="eh-dna-block eh-dna-block--score">' +
      '<div class="eh-dna-score-head">' +
      donutSvg(score) +
      '<div class="eh-dna-score-head__copy">' +
      '<p class="eh-dna-score-head__value ' +
      tierClass(tier) +
      '">' +
      esc(String(Math.round(Number(score)))) +
      '% match</p>' +
      '<p class="eh-dna-score-head__sub">Overall compatibility with your taste</p>' +
      '</div></div>' +
      kpiCards(traits) +
      '</div>' +
      '<div class="eh-dna-block">' +
      '<h3 class="eh-dna-block__title">Category breakdown</h3>' +
      '<div class="eh-dna-breakdown" id="eh-dna-breakdown">' +
      breakdownRows(traits) +
      '</div></div>' +
      '<div class="eh-dna-block eh-dna-why">' +
      '<h3 class="eh-dna-why__q">Why you might like this</h3>' +
      '<p class="eh-dna-why__a" id="eh-dna-match-desc">' +
      esc(explanationText(resolved)) +
      '</p>' +
      '<div class="eh-dna-pills">' +
      whyPills(resolved) +
      '</div></div>' +
      '</div>' +
      '<aside class="eh-dna-side">' +
      '<div class="eh-dna-block eh-dna-desc-card" id="eh-dna-desc-card">' +
      '<h3 class="eh-dna-block__title">About this event</h3>' +
      '<p class="eh-dna-desc-text" id="eh-dna-desc-text"></p>' +
      '</div>' +
      '<div class="eh-dna-block eh-dna-ask-card" id="eh-dna-ask-card">' +
      '<h3 class="eh-dna-block__title eh-dna-ask-title">Ask about this event</h3>' +
      '<p class="eh-dna-ask-hint">Ask anything — start time, lineup, what to expect.</p>' +
      '<div class="eh-dna-ask-chips" id="eh-dna-ask-chips">' +
      '<button type="button" class="eh-dna-ask-chip" data-q="When does it start?">Start time</button>' +
      '<button type="button" class="eh-dna-ask-chip" data-q="Who is performing?">Who\u2019s performing</button>' +
      '<button type="button" class="eh-dna-ask-chip" data-q="How much are tickets?">Ticket price</button>' +
      '<button type="button" class="eh-dna-ask-chip" data-q="What can I expect at this event?">What to expect</button>' +
      '</div>' +
      '<div class="eh-dna-ask-messages" id="eh-dna-ask-messages" aria-live="polite"></div>' +
      '<form class="eh-dna-ask-form" id="eh-dna-ask-form">' +
      '<input type="text" class="eh-dna-ask-input" id="eh-dna-ask-input" placeholder="Ask a question\u2026" autocomplete="off" maxlength="500" />' +
      '<button type="submit" class="eh-dna-ask-send" id="eh-dna-ask-send" aria-label="Send question">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>' +
      '</button>' +
      '</form>' +
      '</div>' +
      '<div class="eh-dna-block eh-dna-radar-card">' +
      '<h3 class="eh-dna-block__title">Trait alignment</h3>' +
      '<div class="eh-dna-radar-canvas-box">' +
      '<canvas id="eh-dna-radar-canvas" aria-label="DNA radar chart"></canvas>' +
      '</div>' +
      '<div class="eh-dna-radar-legend">' +
      '<span><i class="eh-dna-legend-swatch eh-dna-legend-swatch--you"></i> You</span>' +
      '<span><i class="eh-dna-legend-swatch eh-dna-legend-swatch--event"></i> This event</span>' +
      '</div></div>' +
      '</aside>' +
      '<div class="eh-dna-sticky-cta">' +
      '<button type="button" class="eh-btn eh-btn--plan" id="eh-btn-plan-trip">✈ Plan my trip</button>' +
      '</div></section>'
    );
  }

  function initDnaRadarChart(match) {
    var canvas = document.getElementById('eh-dna-radar-canvas');
    if (!canvas || !match || !match.complete || !match.traits || !match.traits.length) {
      return;
    }
    if (!window.Chart) {
      // Chart.js may still be loading (deferred CDN script); retry briefly.
      if ((initDnaRadarChart._tries = (initDnaRadarChart._tries || 0) + 1) <= 20) {
        setTimeout(function () {
          initDnaRadarChart(match);
        }, 150);
      }
      return;
    }
    initDnaRadarChart._tries = 0;
    if (radarChartInstance) {
      radarChartInstance.destroy();
      radarChartInstance = null;
    }
    var labels = match.traits.map(function (t) {
      return t.label;
    });
    var userData = match.traits.map(function (t) {
      return t.userScore;
    });
    var eventData = match.traits.map(function (t) {
      return t.eventScore;
    });
    radarChartInstance = new window.Chart(canvas, {
      type: 'radar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'You',
            data: userData,
            borderColor: '#76d6d5',
            backgroundColor: 'rgba(118, 214, 213, 0.15)',
            borderWidth: 2,
            pointBackgroundColor: '#76d6d5',
            pointRadius: 3,
          },
          {
            label: 'This event',
            data: eventData,
            borderColor: '#e9c349',
            backgroundColor: 'rgba(233, 195, 73, 0.12)',
            borderWidth: 2,
            pointBackgroundColor: '#e9c349',
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          r: {
            min: 0,
            max: 10,
            ticks: { stepSize: 2, color: 'rgba(255,255,255,0.35)', backdropColor: 'transparent' },
            grid: { color: 'rgba(255,255,255,0.08)' },
            angleLines: { color: 'rgba(255,255,255,0.08)' },
            pointLabels: { color: 'rgba(255,255,255,0.55)', font: { size: 10 } },
          },
        },
      },
    });
  }

  function initDnaMatchPanel(match, fallbackScore) {
    var resolved = resolveMatch(match, fallbackScore);
    if (resolved && resolved.complete) {
      initDnaRadarChart(resolved);
    }
  }

  window.buildDnaMatchDetailHtml = buildDnaMatchDetailHtml;
  window.initDnaMatchPanel = initDnaMatchPanel;
  window.matchTierForScore = matchTier;
})();
