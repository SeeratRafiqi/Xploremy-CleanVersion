const { chromium } = require('playwright');

function buildGoogleHotelsTs(checkIn, checkOut, adults) {
  const ci = checkIn.split('-').map(Number);
  const co = checkOut.split('-').map(Number);
  function yv(y) {
    const out = [];
    let v = y;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v & 0x7f);
    return out;
  }
  const nights = Math.round(
    (Date.UTC(co[0], co[1] - 1, co[2]) - Date.UTC(ci[0], ci[1] - 1, ci[2])) / 86400000,
  );
  const n = Math.max(1, Math.min(9, parseInt(adults, 10) || 1));
  const guest = [];
  for (let i = 0; i < n; i++) guest.push(0x0a, 0x02, 0x08, 0x03);
  guest.push(0x10, 0x01);
  const arr = [0x08].concat(yv(ci[0]), [0x10, ci[1], 0x18, ci[2]]);
  const dep = [0x08].concat(yv(co[0]), [0x10, co[1], 0x18, co[2]]);
  const core = [0x12, 0x1a, 0x12, 0x14, 0x0a, 0x07]
    .concat(arr, [0x12, 0x07])
    .concat(dep, [0x18, nights], [0x32, 0x02, 0x08, 0x01]);
  const dates = [0x0a, 0x02, 0x1a, 0x00].concat(core);
  const cur = [0x2a, 0x09, 0x0a, 0x05, 0x3a, 0x03, 0x4d, 0x59, 0x52, 0x1a, 0x00];
  const bytes = [0x08, 0x01, 0x12, guest.length]
    .concat(guest, [0x1a, dates.length])
    .concat(dates, cur);
  return Buffer.from(bytes).toString('base64');
}

(async () => {
  for (const adults of [1, 4]) {
    const ts = buildGoogleHotelsTs('2026-07-10', '2026-07-13', adults);
    const url =
      'https://www.google.com/travel/search?q=Hotels+in+Penang+Malaysia&qs=CAE4AA&ap=MAE&hl=en&gl=my&ts=' +
      encodeURIComponent(ts);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const btn = page
      .getByRole('button', { name: /travelers|guests/i })
      .or(page.locator('[aria-label*="Travelers"], [aria-label*="Guests"]'))
      .first();
    const label = (await btn.getAttribute('aria-label').catch(() => null)) || (await btn.innerText().catch(() => ''));
    console.log('adults encoded:', adults, '→ UI label:', String(label).replace(/\s+/g, ' ').trim());
    await browser.close();
  }
})();
