/**
 * One-off: capture Google Travel URL `ts` after setting guest count in UI.
 * Run: node scripts/capture-google-hotel-ts.js
 */
const { chromium } = require('playwright');

function buildDatesOnlyTs(checkIn, checkOut) {
  const ci = checkIn.split('-').map(Number);
  const co = checkOut.split('-').map(Number);
  function yearVarint(y) {
    const o = [];
    let v = y;
    while (v > 0x7f) {
      o.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    o.push(v & 0x7f);
    return o;
  }
  const nights = Math.round(
    (Date.UTC(co[0], co[1] - 1, co[2]) - Date.UTC(ci[0], ci[1] - 1, ci[2])) / 86400000,
  );
  const arr = [0x08].concat(yearVarint(ci[0]), [0x10, ci[1], 0x18, ci[2]]);
  const dep = [0x08].concat(yearVarint(co[0]), [0x10, co[1], 0x18, co[2]]);
  const core = [0x12, 0x1a, 0x12, 0x14, 0x0a, 0x07]
    .concat(arr, [0x12, 0x07])
    .concat(dep, [0x18, nights], [0x32, 0x02, 0x08, 4]);
  const wrapped = [0x0a, 0x02, 0x1a, 0x00].concat(core);
  const bytes = [0x08, 0x01].concat([0x1a, wrapped.length]).concat(wrapped);
  return Buffer.from(bytes).toString('base64');
}

(async () => {
  const checkIn = '2026-07-10';
  const checkOut = '2026-07-13';
  const ts = buildDatesOnlyTs(checkIn, checkOut);
  const startUrl =
    'https://www.google.com/travel/search?q=Hotels+in+Penang+Malaysia&qs=CAE4AA&ap=MAE&hl=en&gl=my&ts=' +
    encodeURIComponent(ts);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const consent = page.getByRole('button', { name: /accept all|reject all|agree/i }).first();
  if (await consent.isVisible().catch(() => false)) await consent.click({ timeout: 3000 }).catch(() => {});

  console.log('URL after load:', page.url().slice(0, 200));

  const travelers = page
    .getByRole('button', { name: /travelers|guests|adults|people/i })
    .or(page.locator('[aria-label*="Travelers"], [aria-label*="Guests"], [data-travelers]'))
    .first();
  if (await travelers.isVisible({ timeout: 8000 }).catch(() => false)) {
    await travelers.click();
    await page.waitForTimeout(1500);
    const inc = page.getByRole('button', { name: /increase adults|add adult/i }).last();
    for (let i = 0; i < 6; i++) {
      if (await inc.isVisible().catch(() => false)) await inc.click().catch(() => {});
      await page.waitForTimeout(200);
    }
    const done = page.getByRole('button', { name: /done|apply|ok/i }).first();
    if (await done.isVisible().catch(() => false)) await done.click().catch(() => {});
    await page.waitForTimeout(2000);
    console.log('URL after guests:', page.url());
    const tsMatch = page.url().match(/[?&]ts=([^&]+)/);
    if (tsMatch) {
      const decoded = Buffer.from(decodeURIComponent(tsMatch[1]), 'base64');
      console.log('ts hex:', decoded.toString('hex'));
      console.log('ts b64:', decoded.toString('base64'));
    }
  } else {
    console.log('Travelers control not found');
    await page.screenshot({ path: 'scripts/google-hotels-debug.png', fullPage: true });
    console.log('Saved scripts/google-hotels-debug.png');
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
