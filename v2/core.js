// ─── v2 shared core ──────────────────────────────────────────────────────────
// Proven logic copied from ../book.js so v2 is fully self-contained and v1 stays
// untouched. Config, cell selectors, fire-at-time, form fill, PIN, payment,
// notify, and the scheduler all live here; pick.js and run.js import from it.

import { DateTime }       from 'luxon';
import dotenv             from 'dotenv';
import path               from 'path';
import { fileURLToPath }  from 'url';
import https              from 'https';
import http               from 'http';

// Load ../.env regardless of where the script is launched from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── config ───────────────────────────────────────────────────────────────────
export const DAYS_AHEAD      = parseInt(process.env.DAYS_AHEAD      ?? '14');
export const HEADLESS        = process.env.HEADLESS                 !== 'false';
export const RETRY_MS        = parseInt(process.env.RETRY_MS        ?? '400');
export const OPEN_TIME       = process.env.OPEN_TIME                ?? '00:00';
export const PRE_OPEN_MS     = parseInt(process.env.PRE_OPEN_MS     ?? String(3 * 60 * 1000));
export const NOTIFY_WEBHOOK  = process.env.NOTIFY_WEBHOOK           ?? '';
export const BOOKER_NAME     = process.env.BOOKER_NAME              ?? '';
export const BOOKER_PHONE    = process.env.BOOKER_PHONE             ?? '';
export const BOOKER_EMAIL    = process.env.BOOKER_EMAIL             ?? '';
export const WALLET_PIN      = process.env.WALLET_PIN               ?? '';
export const FIRE_IN_SECONDS = parseInt(process.env.FIRE_IN_SECONDS ?? '10');
export const TEST_WALLET_PIN = process.env.TEST_WALLET_PIN          ?? '000000';

export const TZ = 'Asia/Manila';

// Canonical schedule order of the hourly slots (matches the grid's column order).
// Used to sort a court's hours and to test whether two hours are consecutive.
export const TIME_ORDER = ['4-5','5-6','6-7','7-8','8-9','9-10','10-11','11-12','12-1','1-2','2-3','3-4'];

// Longest run of CONSECUTIVE free hours within a court's picked hours, as long as
// it meets the court's `min` (default = all its hours = strict). Null if none.
// `free` is a Set of "court|time" keys. This is what lets the main court demand
// its full block while an extra court takes whatever 2h/3h is open.
export function longestFreeRun(block, free) {
  const idx = t => TIME_ORDER.indexOf(t);
  const sorted = block.times.slice().sort((a, b) => idx(a) - idx(b));
  const min = Math.max(1, Math.min(block.min || block.times.length, block.times.length));
  let best = [], cur = [];
  for (const t of sorted) {
    if (!free.has(`${block.court}|${t}`)) { cur = []; continue; }
    cur = (cur.length && idx(t) === idx(cur[cur.length - 1]) + 1) ? [...cur, t] : [t];
    if (cur.length > best.length) best = cur;
  }
  return best.length >= min ? best : null;
}

// Folder where the browser stores cookies/session so the wallet stays logged in.
// Shared with v1 so you stay logged in across both.
export const USER_DATA_DIR = process.env.USER_DATA_DIR
  ?? path.join(__dirname, '..', '.browser-data');

// Where v2 saves your picked selection.
export const SELECTION_FILE = path.join(__dirname, 'selection.json');

// ── Site-specific values (kept out of source — set them in your local .env) ──
export const BASE_URL         = process.env.BOOKING_BASE_URL   ?? 'https://example.com/step2.php';
export const FACILITY         = process.env.BOOKING_FACILITY   ?? 'facility';
export const PAYMENT_CATEGORY = process.env.PAYMENT_CATEGORY   ?? 'E-Wallets';
export const PAYMENT_LABEL    = process.env.PAYMENT_LABEL      ?? 'Wallet';

// ─── url builder ─────────────────────────────────────────────────────────────
// Build the booking page URL for a specific calendar date (a Manila-midnight
// DateTime). v2 always books an explicit saved date, so no DAYS_AHEAD math here.
export function buildUrlForDate(target) {
  const bookdate = target.toFormat('yyyy-MM-dd');
  const bookday2 = target.toFormat('cccc');
  return `${BASE_URL}?court=${FACILITY}&bookdate=${bookdate}&bookday2=${bookday2}`;
}

// Default target date (DAYS_AHEAD out from tonight's open) — where pick.js lands.
export function defaultTargetDate() {
  return DateTime.now().setZone(TZ)
    .set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
    .plus({ days: DAYS_AHEAD });
}

// The site serves a rolling window of this many dates (today .. today+13);
// anything past it redirects to step1 with no grid. This is a site fact, kept
// separate from DAYS_AHEAD (which is only the booking lead, often the same ~14).
export const OPEN_WINDOW_DAYS = parseInt(process.env.OPEN_WINDOW_DAYS ?? '14');

// For picking against a realistic layout and for --test (which can't open the
// future target), fall back to the LATEST already-open date that shares the
// target's weekday — same weekday ⇒ same shift pattern & admin blocks.
export function latestOpenSameWeekday(target) {
  const today   = DateTime.now().setZone(TZ).startOf('day');
  const maxOpen = today.plus({ days: OPEN_WINDOW_DAYS - 1 }); // last open date in the window
  let d = target.startOf('day');
  while (d > maxOpen) d = d.minus({ days: 7 });
  return d;
}

// One-pass read of every free cell on the active shift tab. Taken/blocked slots
// are removed from the DOM entirely, so a present btncell *is* a free slot. We
// return a flat list of "court|time" keys — the whole availability map in a
// single round trip, so the ranked grab decides a winner with no per-slot checks.
export async function freeCellsOnActiveTab(page) {
  return page.$$eval('td.btncell', tds =>
    tds
      .filter(td => td.offsetParent !== null && !(td.innerText || '').includes('('))
      .map(td => `${td.dataset.courtname}|${td.dataset.time}`)
  );
}

// ─── cell helpers ────────────────────────────────────────────────────────────
// The grid uses <td class="btncell" data-courtname="..." data-time="H-H">. Both
// shift grids stay in the DOM; only the active tab's cells are visible, so we
// always scope to :visible to hit the cell in the active shift tab.
export function cell(page, court, dataTime) {
  return page.locator(
    `td.btncell[data-courtname="${court}"][data-time="${dataTime}"]:visible`
  );
}

// 'free' = bookable, 'taken' = shows a "(…)" marker, 'absent' = not on this tab.
export async function cellState(page, court, dataTime) {
  const el = cell(page, court, dataTime);
  if (!(await el.isVisible().catch(() => false))) return 'absent';
  const text = await el.innerText().catch(() => '');
  return text.includes('(') ? 'taken' : 'free';
}

// ─── fire confirm ─────────────────────────────────────────────────────────────
export async function fireConfirm(page, fireAt) {
  const confirmBtn = page.getByRole('button', { name: 'Confirm' });
  await confirmBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

  const msUntil = fireAt.toMillis() - Date.now();
  if (msUntil > 100) {
    console.log(`  Standing by — ${(msUntil / 1000).toFixed(2)}s until fire…`);
    await new Promise(r => setTimeout(r, msUntil - 50));
  }

  console.log('  *** FIRE — clicking Confirm ***');
  await confirmBtn.click();
}

// ─── form fill ────────────────────────────────────────────────────────────────
export async function fillForm(page) {
  console.log('  Filling form…');
  await page.waitForSelector('input:visible', { timeout: 8000 }).catch(() => {});
  await page.getByRole('textbox', { name: 'Enter your Complete Name' }).fill(BOOKER_NAME);
  await page.getByPlaceholder('Enter your Contact Number').fill(BOOKER_PHONE);
  await page.getByRole('textbox', { name: 'Enter your Email Address' }).fill(BOOKER_EMAIL);
  await page.getByRole('button', { name: /Pay Now/i }).click();
}

// ─── pin entry ────────────────────────────────────────────────────────────────
// Searches the page and every iframe for the wallet PIN screen and enters the
// PIN. Returns true if entered, false if no PIN UI was found.
export async function enterPin(pg, pin) {
  for (const frame of pg.frames()) {
    // 6-digit wallet PIN: hidden numeric input + clickable box container.
    const grabInput = frame.locator('input[maxlength="6"][inputmode="numeric"]').first();
    if (await grabInput.count() > 0) {
      await grabInput.evaluate((el, value) => {
        const proto  = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        el.focus();
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        for (const ch of value) {
          setter.call(el, el.value + ch);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, pin);
      return true;
    }

    // Generic single field (password/tel)
    const input = frame.locator('input[type="password"], input[type="tel"]').first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(pin);
      const submit = frame.getByRole('button', { name: /submit|confirm|ok|next|proceed|pay/i }).first();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      return true;
    }

    // One input per digit
    const boxes = frame.locator('input[maxlength="1"]');
    if (await boxes.first().isVisible().catch(() => false)) {
      const n = await boxes.count();
      for (let i = 0; i < Math.min(n, pin.length); i++) {
        await boxes.nth(i).fill(pin[i]);
      }
      return true;
    }

    // Numeric keypad rendered as digit buttons
    const firstDigit = frame.getByRole('button', { name: pin[0], exact: true }).first();
    if (await firstDigit.isVisible().catch(() => false)) {
      for (const digit of pin.split('')) {
        await frame.getByRole('button', { name: digit, exact: true }).first().click();
        await frame.waitForTimeout(80);
      }
      return true;
    }
  }

  return false;
}

// ─── payment ──────────────────────────────────────────────────────────────────
export async function pay(page, pin = WALLET_PIN) {
  console.log('  Paying…');

  const clickIfVisible = async (locator, ms = 1500) => {
    if (await locator.first().isVisible().catch(() => false)) {
      await locator.first().click().catch(() => {});
      return;
    }
    await locator.first().waitFor({ state: 'visible', timeout: ms })
      .then(() => locator.first().click()).catch(() => {});
  };

  await clickIfVisible(page.getByRole('button', { name: new RegExp(PAYMENT_CATEGORY, 'i') }));
  await clickIfVisible(page.locator('label').filter({ hasText: PAYMENT_LABEL }));
  await clickIfVisible(page.getByRole('button', { name: 'Continue' }));

  // First button: shows the amount (e.g. "Pay 600.00"). Click it to reach checkout.
  await clickIfVisible(page.getByRole('button', { name: /pay\s*[^\s\d]*\s*[\d,][\d,.\s]*/i }), 10_000);

  // Second button: labelled exactly "Pay" — starts the wallet PIN step.
  const payBtn = page.getByRole('button', { name: 'Pay', exact: true }).last();
  await payBtn.waitFor({ state: 'visible', timeout: 10_000 });

  let popup = null;
  page.context().on('page', p => { popup = p; });

  await payBtn.click();

  let pinEntered = false;
  if (pin) {
    console.log('  Looking for PIN screen…');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !pinEntered) {
      if (popup) pinEntered = await enterPin(popup, pin);
      if (!pinEntered) pinEntered = await enterPin(page, pin);
      if (!pinEntered) await page.waitForTimeout(150);
    }
    if (pinEntered) console.log('  PIN entered.');
  }

  if (!pinEntered) {
    notify('Action required: complete payment in the browser.');
    console.log('\n⚡ Human step: complete payment in the browser window.\n');
  }

  await page.waitForURL(/success|thank|confirm|receipt/i, { timeout: 600_000 });
  console.log('Booking confirmed!', page.url());
  notify('Booking confirmed! ' + page.url());
}

// ─── notify ───────────────────────────────────────────────────────────────────
export function notify(msg) {
  if (!NOTIFY_WEBHOOK) return;
  try {
    const url  = new URL(NOTIFY_WEBHOOK);
    const mod  = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ content: msg });
    const req  = mod.request(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (e) {
    console.warn('notify() error:', e.message);
  }
}

// ─── scheduler ────────────────────────────────────────────────────────────────
export function nextOpenMoment() {
  const [hh, mm] = OPEN_TIME.split(':').map(Number);
  const now  = DateTime.now().setZone(TZ);
  let open   = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (open <= now) open = open.plus({ days: 1 });
  return open;
}
