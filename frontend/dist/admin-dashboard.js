(function () {
  'use strict';

  const LABELS = {
    music: 'Music',
    sports: 'Sports',
    food_drink: 'Food & Drink',
    arts_culture: 'Arts & Culture',
    technology: 'Technology',
    nature_outdoors: 'Nature & Outdoors',
    comedy: 'Comedy',
    networking: 'Networking',
    chill_relaxed: 'Chill',
    high_energy: 'High Energy',
    social_meetup: 'Social',
    educational: 'Educational',
    family_friendly: 'Family',
    intimate: 'Intimate',
    medium: 'Medium',
    large: 'Large',
    massive: 'Massive',
    free: 'Free',
    under_50: 'Under RM50',
    '50_150': 'RM50–150',
    '150_plus': 'RM150+',
  };

  function label(k) {
    return LABELS[k] || k || '—';
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function prefSummary(p) {
    if (!p) return '<span class="pill">No Fan DNA</span>';
    const parts = [];
    (p.categories || []).forEach(function (c) {
      parts.push('<span class="pill">' + esc(label(c)) + '</span>');
    });
    if (p.event_size) parts.push('<span class="pill">Size: ' + esc(label(p.event_size)) + '</span>');
    if (p.budget) parts.push('<span class="pill">' + esc(label(p.budget)) + '</span>');
    if (p.travel_distance) parts.push('<span class="pill">Travel: ' + esc(p.travel_distance) + '</span>');
    return parts.join('') || '—';
  }

  function clicksHtml(stats) {
    if (!stats || !stats.events || !stats.events.length) return '—';
    return (
      '<div class="clicks-list"><strong>' +
      stats.total +
      ' total</strong><ul>' +
      stats.events
        .slice(0, 8)
        .map(function (c) {
          return (
            '<li>' +
            esc(c.event_name || c.event_id || 'Event') +
            ' · ' +
            esc(c.clicked_at ? new Date(c.clicked_at).toLocaleString() : '') +
            '</li>'
          );
        })
        .join('') +
      '</ul></div>'
    );
  }

  async function init() {
    const root = document.getElementById('admin-root');
    const errEl = document.getElementById('admin-err');
    try {
      const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!meRes.ok) {
        location.href = '/auth';
        return;
      }
      const res = await fetch('/api/admin/dashboard', { credentials: 'same-origin' });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || 'Access denied';
          errEl.hidden = false;
        }
        root.innerHTML = '';
        return;
      }
      const rows = Array.isArray(data.users) ? data.users : [];
      let html =
        '<table><thead><tr><th>User</th><th>Fan DNA</th><th>Book clicks</th><th>Clicked events</th></tr></thead><tbody>';
      rows.forEach(function (row) {
        const u = row.user || {};
        html +=
          '<tr><td><strong>' +
          esc(u.displayName || u.email) +
          '</strong><br><span style="color:var(--muted)">' +
          esc(u.email) +
          '</span></td><td>' +
          prefSummary(row.preferences) +
          '</td><td>' +
          (row.clickStats && row.clickStats.total ? row.clickStats.total : 0) +
          '</td><td>' +
          clicksHtml(row.clickStats) +
          '</td></tr>';
      });
      html += '</tbody></table>';
      html +=
        '<p class="sub" style="margin-top:20px">Site-wide clicks logged: <strong>' +
        (data.totalClicks || 0) +
        '</strong></p>';
      root.innerHTML = html;
    } catch (e) {
      if (errEl) {
        errEl.textContent = 'Failed to load admin data';
        errEl.hidden = false;
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    void init();
  }
})();
