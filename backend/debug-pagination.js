/**
 * One-off: inspect Eventbrite discovery page for pagination / next controls.
 * Run: node debug-pagination.js
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url =
    'https://www.eventbrite.com/d/malaysia--kuala-lumpur/events/';
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise((r) => setTimeout(r, 800));
  }
  await new Promise((r) => setTimeout(r, 3000));

  const byDataSpec = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('[data-spec]').forEach((el) => {
      const spec = el.getAttribute('data-spec');
      if (!spec) return;
      const s = spec.toLowerCase();
      if (
        s.includes('page') ||
        s.includes('next') ||
        s.includes('pag') ||
        s.includes('more')
      ) {
        rows.push({
          dataSpec: spec,
          tag: el.tagName,
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
          aria: el.getAttribute('aria-label'),
          disabled: el.disabled === true,
          href: el.getAttribute('href'),
        });
      }
    });
    return rows;
  });

  const allDataSpecs = await page.evaluate(() => {
    const set = new Set();
    document.querySelectorAll('[data-spec]').forEach((el) => {
      const s = el.getAttribute('data-spec');
      if (s) set.add(s);
    });
    return Array.from(set).sort();
  });

  const loadMoreLike = await page.evaluate(() => {
    const out = [];
    const all = document.querySelectorAll('a, button, [role="button"]');
    all.forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      if (
        !t.includes('more') &&
        !t.includes('next') &&
        !t.includes('load') &&
        !a.includes('next') &&
        !a.includes('more')
      )
        return;
      out.push({
        tag: el.tagName,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        aria: el.getAttribute('aria-label'),
        dataSpec: el.getAttribute('data-spec'),
        href: el.getAttribute('href'),
      });
    });
    return out;
  });

  const nextLike = await page.evaluate(() => {
    const out = [];
    const all = document.querySelectorAll('a, button, [role="button"], [role="link"]');
    all.forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const a = el.getAttribute('aria-label') || '';
      if (!/^next$/i.test(t) && !/next\s+page/i.test(a) && !/^next$/i.test(a))
        return;
      out.push({
        tag: el.tagName,
        text: t.slice(0, 80),
        aria: a,
        dataSpec: el.getAttribute('data-spec'),
        href: el.getAttribute('href'),
        className: String(el.className || '').slice(0, 120),
      });
    });
    return out;
  });

  const pageNextExact = await page.evaluate(() => {
    const el = document.querySelector('[data-spec="page-next"]');
    if (!el) return null;
    return {
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      visible: el.offsetParent !== null,
    };
  });

  console.log('--- [data-spec="page-next"] present? ---');
  console.log(pageNextExact);

  console.log('\n--- data-spec hints (page/next/pag/more) ---');
  console.log(JSON.stringify(byDataSpec, null, 2));

  console.log('\n--- all unique data-spec (count ' + allDataSpecs.length + ') ---');
  console.log(allDataSpecs.slice(0, 120).join('\n'));
  if (allDataSpecs.length > 120) console.log('... truncated');

  console.log('\n--- load more / next / more (text or aria) ---');
  console.log(JSON.stringify(loadMoreLike, null, 2));

  console.log('\n--- strict Next label ---');
  console.log(JSON.stringify(nextLike, null, 2));

  const loadMoreEvents = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a, button, [role="button"]').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t.includes('load') || !t.includes('event')) return;
      out.push({
        tag: el.tagName,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        dataSpec: el.getAttribute('data-spec'),
        aria: el.getAttribute('aria-label'),
      });
    });
    return out;
  });

  const navLandmarks = await page.evaluate(() => {
    const navs = document.querySelectorAll('nav, [role="navigation"]');
    return Array.from(navs).map((n) => ({
      aria: n.getAttribute('aria-label'),
      text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));
  });

  console.log('\n--- "load" + "event" buttons/links ---');
  console.log(JSON.stringify(loadMoreEvents, null, 2));

  console.log('\n--- nav landmarks (snippet) ---');
  console.log(JSON.stringify(navLandmarks, null, 2));

  const hasPageNextString = await page.evaluate(() =>
    document.documentElement.innerHTML.includes('page-next')
  );
  console.log('\n--- raw HTML contains "page-next" string? ---', hasPageNextString);

  await browser.close();
})();
