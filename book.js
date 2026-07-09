import { chromium }  from 'playwright';
import { DateTime }  from 'luxon';
import readline      from 'readline';
import dotenv        from 'dotenv';
import path          from 'path';
import { fileURLToPath } from 'url';
import https         from 'https';
import http          from 'http';

dotenv.config();

// ─── config ───────────────────────────────────────────────────────────────────
const DAYS_AHEAD      = parseInt(process.env.DAYS_AHEAD      ?? '14');
const HEADLESS        = process.env.HEADLESS                 !== 'false';
const RETRY_MS        = parseInt(process.env.RETRY_MS        ?? '400');
const OPEN_TIME       = process.env.OPEN_TIME                ?? '00:00';
const PRE_OPEN_MS     = parseInt(process.env.PRE_OPEN_MS     ?? String(3 * 60 * 1000));
const NOTIFY_WEBHOOK  = process.env.NOTIFY_WEBHOOK           ?? '';
const BOOKER_NAME     = process.env.BOOKER_NAME              ?? '';
const BOOKER_PHONE    = process.env.BOOKER_PHONE             ?? '';
const BOOKER_EMAIL    = process.env.BOOKER_EMAIL             ?? '';
const WALLET_PIN       = process.env.WALLET_PIN               ?? '';
const FIRE_IN_SECONDS  = parseInt(process.env.FIRE_IN_SECONDS ?? '10');
const TEST_WALLET_PIN  = process.env.TEST_WALLET_PIN          ?? '000000';

// Folder where the browser stores cookies/session so the wallet stays logged in.
const USER_DATA_DIR = process.env.USER_DATA_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.browser-data');

// ── Site-specific values (kept out of source — set them in your local .env) ──
const BASE_URL         = process.env.BOOKING_BASE_URL   ?? 'https://example.com/step2.php';
const FACILITY         = process.env.BOOKING_FACILITY   ?? 'facility';
const PRIMARY_RESOURCE = process.env.PRIMARY_RESOURCE   ?? 'Resource 1';
const SALE_RESOURCE_1  = process.env.SALE_RESOURCE_1    ?? 'Resource 2';
const SALE_RESOURCE_2  = process.env.SALE_RESOURCE_2    ?? 'Resource 3';
// Court options shown in the startup picker (comma-separated in .env).
const COURT_CHOICES    = (process.env.COURT_CHOICES ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
const SALE_PRICE       = process.env.SALE_PRICE         ?? '100.00';
const PAYMENT_CATEGORY = process.env.PAYMENT_CATEGORY   ?? 'E-Wallets';
const PAYMENT_LABEL    = process.env.PAYMENT_LABEL      ?? 'Wallet';

// All slots available in the afternoon/evening shift (4pm is present on sale days)
const ALL_SLOTS = [
  '4pm-5pm', '5pm-6pm', '6pm-7pm', '7pm-8pm',
  '8pm-9pm', '9pm-10pm', '10pm-11pm',
];

// 3-hour block choices shown at startup (for non-promo days)
const BLOCK_MENU = [
  ['4pm-5pm', '5pm-6pm', '6pm-7pm'],   // 4–7 pm
  ['5pm-6pm', '6pm-7pm', '7pm-8pm'],   // 5–8 pm
  ['6pm-7pm', '7pm-8pm', '8pm-9pm'],   // 6–9 pm
  ['7pm-8pm', '8pm-9pm', '9pm-10pm'],  // 7–10 pm
];

// Ordered hour boundaries for the custom picker (4pm through 2am).
const HOURS = ['4pm','5pm','6pm','7pm','8pm','9pm','10pm','11pm','12am','1am','2am'];

// Build the list of hourly slot labels between a start and end hour, e.g.
// buildSlots('4pm','7pm') → ['4pm-5pm','5pm-6pm','6pm-7pm'].
function buildSlots(startHour, endHour) {
  const s = HOURS.indexOf(startHour);
  const e = HOURS.indexOf(endHour);
  if (s === -1 || e === -1 || e <= s) return [];
  const slots = [];
  for (let i = s; i < e; i++) slots.push(`${HOURS[i]}-${HOURS[i + 1]}`);
  return slots;
}

// ─── url builder ─────────────────────────────────────────────────────────────

function buildBookingUrl(openMidnight, targetOverride = null) {
  const target   = targetOverride ?? openMidnight.plus({ days: DAYS_AHEAD });
  const bookdate = target.toFormat('yyyy-MM-dd');
  const bookday2 = target.toFormat('cccc');
  return `${BASE_URL}?court=${FACILITY}&bookdate=${bookdate}&bookday2=${bookday2}`;
}

// ─── slot helpers (original working logic) ───────────────────────────────────

function slotToAttrs(timeLabel) {
  const m = timeLabel.match(/^(\d+)([ap]m)-(\d+)[ap]m$/);
  return m ? { time: `${m[1]}-${m[3]}` } : null;
}

function freeCellSel(court, timeLabel) {
  const a = slotToAttrs(timeLabel);
  return a ? `td.btncell[data-courtname="${court}"][data-time="${a.time}"]` : null;
}

// Both shift grids stay in the DOM — only the active tab's cells are visible.
// A data-time like "7-8" exists in Shift 1 (7am, hidden) AND Shift 2 (7pm).
// Scope to :visible so we always target the cell in the active shift tab.
function cell(page, court, timeLabel) {
  const sel = freeCellSel(court, timeLabel);
  return sel ? page.locator(`${sel}:visible`) : null;
}

function consecutiveBlock(startTime, n) {
  const idx   = ALL_SLOTS.indexOf(startTime);
  if (idx === -1) return null;
  const block = ALL_SLOTS.slice(idx, idx + n);
  return block.length === n ? block : null;
}

// 'free'   = bookable, 'taken' = shows a "(…)" marker, 'absent' = not on this tab
async function cellState(page, court, timeLabel) {
  const el = cell(page, court, timeLabel);
  if (!el) return 'absent';
  if (!(await el.isVisible().catch(() => false))) return 'absent';
  const text = await el.innerText().catch(() => '');
  return text.includes('(') ? 'taken' : 'free';
}

async function isSlotFree(page, court, timeLabel) {
  return (await cellState(page, court, timeLabel)) === 'free';
}

async function isBlockFree(page, court, startTime, n = 3) {
  const block = consecutiveBlock(startTime, n);
  if (!block) return false;
  for (const slot of block) {
    if (!(await isSlotFree(page, court, slot))) return false;
  }
  return true;
}

// ─── promo detection ──────────────────────────────────────────────────────────
// Promo = a free 4pm cell on a sale resource shows the promo price.

async function isSaleDay(page) {
  for (const court of [SALE_RESOURCE_1, SALE_RESOURCE_2]) {
    const el = cell(page, court, '4pm-5pm');
    if (!el) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = await el.innerText().catch(() => '');
    if (!text.includes('(') && text.includes(SALE_PRICE)) return true;
  }
  return false;
}

// ─── runtime prompt ───────────────────────────────────────────────────────────

// Pick one of the preset 3-hour blocks for the primary resource.
async function pickBlock(ask) {
  console.log('\n┌─────────────────────────────────────────────────┐');
  console.log('│  Preferred block (used on non-promo days)       │');
  console.log('├─────────────────────────────────────────────────┤');
  BLOCK_MENU.forEach((b, i) => {
    console.log(`│  ${i + 1}) ${b[0]}  →  ${b[b.length - 1]}`.padEnd(51) + '│');
  });
  console.log('│  [Enter]  Default: 4pm–7pm                      │');
  console.log('└─────────────────────────────────────────────────┘');
  const ans = (await ask('  Choice: ')).trim();
  const idx = parseInt(ans) - 1;
  return (idx >= 0 && idx < BLOCK_MENU.length) ? BLOCK_MENU[idx] : BLOCK_MENU[0];
}

// Pick a court from COURT_CHOICES by number, with a default. Typing a name
// that isn't in the list is accepted as a custom value.
async function pickCourt(ask, label, def) {
  console.log(`\n  ${label}`);
  if (COURT_CHOICES.length) {
    COURT_CHOICES.forEach((c, i) => console.log(`    ${i + 1}) ${c}`));
  }
  const ans = (await ask(`    Choice [Enter = ${def}]: `)).trim();
  if (!ans) return def;
  const idx = parseInt(ans) - 1;
  if (idx >= 0 && idx < COURT_CHOICES.length) return COURT_CHOICES[idx];
  return ans; // custom court name typed directly
}

// Pick an hour from HOURS by number, with a default.
async function pickHour(ask, label, def) {
  const list = HOURS.map((h, i) => `${i + 1}) ${h}`).join('   ');
  console.log(`\n  ${label}`);
  console.log(`    ${list}`);
  const ans = (await ask(`    Choice [Enter = ${def}]: `)).trim();
  const idx = parseInt(ans) - 1;
  return (idx >= 0 && idx < HOURS.length) ? HOURS[idx] : def;
}

// Pick the booking date. Accepts an ISO date (YYYY-MM-DD) or a number of days
// ahead; Enter keeps the default (DAYS_AHEAD out). Returns a Manila-midnight
// DateTime to use as the target, or null to keep the default.
async function pickDate(ask) {
  const preview = DateTime.now().setZone('Asia/Manila')
    .plus({ days: DAYS_AHEAD }).toFormat('yyyy-MM-dd (cccc)');
  console.log('\n  Booking date');
  console.log('    Enter a date (YYYY-MM-DD) or a number of days ahead.');
  const ans = (await ask(`    Choice [Enter = default ${preview}]: `)).trim();
  if (!ans) return null;

  const midnight = DateTime.now().setZone('Asia/Manila')
    .set({ hour: 0, minute: 0, second: 0, millisecond: 0 });

  if (/^\d+$/.test(ans)) return midnight.plus({ days: parseInt(ans) });

  const dt = DateTime.fromFormat(ans, 'yyyy-MM-dd', { zone: 'Asia/Manila' });
  if (!dt.isValid) {
    console.log(`  ⚠ Invalid date "${ans}" — using default.`);
    return null;
  }
  return dt.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
}

// Returns either:
//   { mode: 'default', preferredBlock }            — smart defaults + promo switch
//   { mode: 'manual',  selections: [{court, slots}], date } — book exactly these
async function askPlan() {
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));
  try {
    console.log('\n════════════════════════════════════════════════════');
    console.log(' Booking plan');
    console.log('   [Enter] Use defaults  (primary court; promo → sale courts)');
    console.log('   c       Customize courts & hours');
    console.log('════════════════════════════════════════════════════');
    const mode = (await ask('  Choice: ')).trim().toLowerCase();

    if (mode !== 'c') {
      const court = await pickCourt(ask, 'Court', PRIMARY_RESOURCE);
      const preferredBlock = await pickBlock(ask);
      return { mode: 'default', court, preferredBlock };
    }

    const date = await pickDate(ask);

    const countRaw = (await ask('\n  How many courts? [1]: ')).trim();
    const count = Math.max(1, parseInt(countRaw) || 1);

    const selections = [];
    for (let i = 0; i < count; i++) {
      const court = await pickCourt(ask, `Court #${i + 1}`, PRIMARY_RESOURCE);
      const start = await pickHour(ask, `Court #${i + 1} START hour`, '4pm');
      // default end = one block after start (or last hour)
      const defEndIdx = Math.min(HOURS.indexOf(start) + 1, HOURS.length - 1);
      const end = await pickHour(ask, `Court #${i + 1} END hour`, HOURS[defEndIdx]);
      const slots = buildSlots(start, end);
      if (!slots.length) {
        console.log(`  ⚠ ${court}: end must be after start — skipped.`);
        continue;
      }
      console.log(`  ✓ ${court}: ${slots[0]} → ${slots[slots.length - 1]}`);
      selections.push({ court, slots });
    }

    if (!selections.length) {
      console.log('  No valid selections — falling back to defaults.');
      return { mode: 'default', preferredBlock: BLOCK_MENU[0], date };
    }
    return { mode: 'manual', selections, date };
  } finally {
    rl.close();
  }
}

// ─── slot selection ───────────────────────────────────────────────────────────

async function selectAndPark(page, plan) {
  const allTabs  = await page.getByRole('tab').all();
  const tabNames = (await Promise.all(allTabs.map(t => t.textContent().catch(() => ''))))
    .map(t => t.trim())
    .filter(t => { const m = t.match(/^Shift\s*(\d+)/i); return m && parseInt(m[1]) >= 2; });

  if (!tabNames.length) { console.log('  No Shift tabs found.'); return false; }

  for (const tabName of tabNames) {
    await page.getByRole('tab', { name: tabName }).click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(200);

    // ── manual mode: book exactly the picked courts/hours (no promo switch) ──
    if (plan.mode === 'manual') {
      let anyPresent = false, allFree = true;
      for (const sel of plan.selections) {
        for (const slot of sel.slots) {
          const st = await cellState(page, sel.court, slot);
          if (st !== 'absent') anyPresent = true;
          if (st !== 'free')   allFree = false;
        }
      }

      if (!anyPresent) continue;              // wrong tab — try the next one
      if (!allFree) {
        console.log(`  [${tabName}] Picked slots not all free yet — retrying…`);
        return false;                          // present but taken — reload & retry
      }

      for (const sel of plan.selections) {
        console.log(`  [${tabName}] ${sel.court}: ${sel.slots[0]} → ${sel.slots[sel.slots.length - 1]}`);
        for (const slot of sel.slots) {
          await cell(page, sel.court, slot).click();
          await page.waitForTimeout(120);
        }
      }
      await page.getByRole('button', { name: /Proceed/i }).click();
      console.log('  Parked at Confirm — waiting for fire time.');
      return true;
    }

    const preferredBlock = plan.preferredBlock;
    const primaryCourt   = plan.court ?? PRIMARY_RESOURCE;

    // ── promo day: book sale resource 1 (4–7pm) + sale resource 2 (4–6pm) ────
    if (await isSaleDay(page)) {
      const slots1 = ['4pm-5pm', '5pm-6pm', '6pm-7pm'];
      const slots2 = ['4pm-5pm', '5pm-6pm'];

      const ok1 = await isBlockFree(page, SALE_RESOURCE_1, '4pm-5pm', 3);
      const ok2 = await isBlockFree(page, SALE_RESOURCE_2, '4pm-5pm', 2);

      if (!ok1 || !ok2) {
        console.log(`  [${tabName}] Promo detected but cells not all free — retrying…`);
        return false;
      }

      console.log(`  [${tabName}] PROMO — ${SALE_RESOURCE_1}: 4–7pm + ${SALE_RESOURCE_2}: 4–6pm`);
      for (const s of slots1) {
        await cell(page, SALE_RESOURCE_1, s).click();
        await page.waitForTimeout(120);
      }
      for (const s of slots2) {
        await cell(page, SALE_RESOURCE_2, s).click();
        await page.waitForTimeout(120);
      }
      await page.getByRole('button', { name: /Proceed/i }).click();
      console.log('  Parked at Confirm — waiting for fire time.');
      return true;
    }

    // ── standard: find a free block on the chosen court ──────────────────────
    // Try the user's preferred start first, then fall back to any 3-hour window.
    const preferredStart = preferredBlock[0];
    let found = null;

    if (await isBlockFree(page, primaryCourt, preferredStart, 3)) {
      found = preferredStart;
    } else {
      for (const start of ALL_SLOTS) {
        if (start === preferredStart) continue; // already tried
        if (await isBlockFree(page, primaryCourt, start, 3)) {
          found = start;
          break;
        }
      }
    }

    if (!found) {
      console.log(`  [${tabName}] ${primaryCourt} — no free 3-hour block here, trying next tab…`);
      continue;
    }

    const block = consecutiveBlock(found, 3);
    console.log(`  [${tabName}] ${primaryCourt}: ${block[0]} → ${block[block.length - 1]}`);
    for (const s of block) {
      await cell(page, primaryCourt, s).click();
      await page.waitForTimeout(120);
    }
    await page.getByRole('button', { name: /Proceed/i }).click();
    console.log('  Parked at Confirm — waiting for fire time.');
    return true;
  }

  return false;
}

// ─── fire confirm ─────────────────────────────────────────────────────────────

async function fireConfirm(page, fireAt) {
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

async function fillForm(page) {
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
// The wallet uses a hidden <input maxlength="6" inputmode="numeric"> paired with
// a clickable container of 6 boxes; it auto-submits after the 6th digit.
async function enterPin(pg, pin) {
  for (const frame of pg.frames()) {
    // 6-digit wallet PIN: hidden numeric input + clickable box container.
    // The input is visually hidden, so set its value directly via the DOM using
    // React's native setter + input/change events (does not rely on keyboard
    // focus, which is unreliable across windows).
    const grabInput = frame.locator('input[maxlength="6"][inputmode="numeric"]').first();
    if (await grabInput.count() > 0) {
      await grabInput.evaluate((el, value) => {
        const proto  = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        el.focus();
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // Type digit-by-digit so length-based handlers (auto-submit) fire
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

async function pay(page, pin = WALLET_PIN) {
  console.log('  Paying…');

  // Payment method is usually pre-defaulted, so these selection steps are
  // optional — click them only if present, never block on them.
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

  // Capture a popup only if one opens — do NOT block waiting for it. The wallet
  // usually renders the PIN inline on the same page, so we start polling
  // immediately after clicking Pay.
  let popup = null;
  page.context().on('page', p => { popup = p; });

  await payBtn.click();

  // Poll fast (150ms) for the PIN screen on the page and any popup that appears.
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

function notify(msg) {
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

function nextOpenMoment() {
  const [hh, mm] = OPEN_TIME.split(':').map(Number);
  const now  = DateTime.now().setZone('Asia/Manila');
  let open   = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (open <= now) open = open.plus({ days: 1 });
  return open;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(mode) {
  // Auto-select modes ask for a booking plan; attend picks manually in-browser.
  let plan = { mode: 'default', preferredBlock: BLOCK_MENU[0] };

  if (['book', 'now', 'test'].includes(mode)) {
    plan = await askPlan();
  }

  // Persistent context keeps the wallet login (cookies/session) across runs.
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: HEADLESS });
  const page    = context.pages()[0] ?? await context.newPage();

  try {
    // ── now: immediate run (no sleep, no countdown) ──────────────────────────
    if (mode === 'now') {
      const anchor = DateTime.now().setZone('Asia/Manila')
        .set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
      const url = buildBookingUrl(anchor, plan.date);
      console.log('[now] URL:', url);
      await page.goto(url, { waitUntil: 'networkidle' });
      const parked = await selectAndPark(page, plan);
      if (!parked) { console.log('Nothing free.'); return; }
      const confirmBtn = page.getByRole('button', { name: 'Confirm' });
      await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await confirmBtn.isVisible()) await confirmBtn.click();
      await fillForm(page);
      await pay(page);
      return;
    }

    // ── test: same URL/date as the official run, but a short countdown ───────
    if (mode === 'test') {
      const openMidnight = nextOpenMoment();
      const url = buildBookingUrl(openMidnight, plan.date);
      console.log('[test] URL     :', url);
      console.log('[test] Fire in :', FIRE_IN_SECONDS, 'seconds');
      const fireAt = DateTime.now().setZone('Asia/Manila').plus({ seconds: FIRE_IN_SECONDS });
      await page.goto(url, { waitUntil: 'networkidle' });
      const parked = await selectAndPark(page, plan);
      if (!parked) { console.log('Nothing free on test URL.'); return; }
      await fireConfirm(page, fireAt);
      await fillForm(page);
      await pay(page, TEST_WALLET_PIN);
      return;
    }

    const openMidnight = nextOpenMoment();
    const url = buildBookingUrl(openMidnight, plan.date);
    console.log('Target URL  :', url);
    console.log('Opens at    :', openMidnight.toISO());

    // ── attend: open browser, user selects manually, bot fires at midnight ───
    if (mode === 'attend') {
      console.log('\n[attend] Opening browser — select your slots then click Proceed.');
      console.log('         Bot fires Confirm at midnight automatically.\n');
      await page.goto(url, { waitUntil: 'networkidle' });
      console.log('  Waiting for Confirm (you have 30 min)…');
      await page.getByRole('button', { name: 'Confirm' })
        .waitFor({ state: 'visible', timeout: 30 * 60 * 1000 });
      console.log('  Confirm detected.');
      await fireConfirm(page, openMidnight);
      await fillForm(page);
      await pay(page);
      return;
    }

    // ── book: sleep → pre-select → fire at midnight ──────────────────────────
    const preLoadAt      = openMidnight.minus({ milliseconds: PRE_OPEN_MS });
    const msUntilPreLoad = preLoadAt.toMillis() - Date.now();

    if (msUntilPreLoad > 0) {
      console.log(`\nPre-select at ${preLoadAt.toISO()}  (${Math.round(msUntilPreLoad / 1000)}s away)`);
      console.log('Sleeping…');
      await new Promise(r => setTimeout(r, msUntilPreLoad));
    }

    console.log('\nPre-selecting slots…');
    let parked = false;
    while (!parked) {
      await page.goto(url, { waitUntil: 'networkidle' });
      parked = await selectAndPark(page, plan);
      if (!parked) {
        console.log(`  Retrying in ${RETRY_MS}ms…`);
        await page.waitForTimeout(RETRY_MS);
      }
    }

    await fireConfirm(page, openMidnight);
    await fillForm(page);
    await pay(page);

  } finally {
    await context.close();
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--now')    ? 'now'
           : args.includes('--attend') ? 'attend'
           : args.includes('--test')   ? 'test'
           : 'book';
main(mode).catch(err => { console.error('Fatal:', err); process.exit(1); });
