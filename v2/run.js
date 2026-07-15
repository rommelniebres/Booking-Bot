// ─── v2 run phase ────────────────────────────────────────────────────────────
// Replays the selection saved by pick.js (v2/selection.json). Timing is
// unchanged from v1: official run sleeps until PRE_OPEN_MS before the open time,
// re-selects your exact cells, and fires Confirm at the open moment; --test fires
// FIRE_IN_SECONDS out; --now runs immediately.

import { chromium } from 'playwright';
import { DateTime } from 'luxon';
import fs           from 'fs';
import {
  USER_DATA_DIR, SELECTION_FILE, HEADLESS, RETRY_MS, PRE_OPEN_MS, TZ,
  FIRE_IN_SECONDS, WALLET_PIN, TEST_WALLET_PIN,
  buildUrlForDate, nextOpenMoment, cellState, cell,
  fireConfirm, fillForm, pay,
} from './core.js';

// ─── load saved selection ──────────────────────────────────────────────────────
function loadSelection() {
  if (!fs.existsSync(SELECTION_FILE)) {
    console.error('No saved selection. Run "npm run pick" first.');
    process.exit(1);
  }
  const sel = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'));
  if (!sel.selections?.length) {
    console.error('Saved selection is empty. Run "npm run pick" again.');
    process.exit(1);
  }
  const date = DateTime.fromFormat(sel.bookdate ?? '', 'yyyy-MM-dd', { zone: TZ });
  if (!date.isValid) {
    console.error(`Saved bookdate "${sel.bookdate}" is invalid. Run "npm run pick" again.`);
    process.exit(1);
  }
  sel.date = date;
  return sel;
}

function summarize(sel) {
  console.log('Replaying saved selection:');
  console.log(`  Date : ${sel.bookdate} (${sel.date.toFormat('cccc')})`);
  console.log(`  Shift: ${sel.shift || '(auto)'}`);
  for (const s of sel.selections) {
    console.log(`  • ${s.court} — ${s.time}${s.label ? `  (${s.label})` : ''}`);
  }
}

// ─── replay: pick the saved cells on the right shift tab, park at Confirm ───────
// Returns true when parked at Confirm, false if the cells aren't all free yet
// (caller reloads and retries).
async function replayOnce(page, sel) {
  // Candidate tabs: the saved shift first, then every "Shift N" tab (N ≥ 2).
  const allTabs  = await page.getByRole('tab').all();
  const tabNames = (await Promise.all(allTabs.map(t => t.textContent().catch(() => ''))))
    .map(t => t.trim())
    .filter(t => { const m = t.match(/^Shift\s*(\d+)/i); return m && parseInt(m[1]) >= 2; });

  const candidates = [];
  if (sel.shift && !candidates.includes(sel.shift)) candidates.push(sel.shift);
  for (const t of tabNames) if (!candidates.includes(t)) candidates.push(t);
  if (!candidates.length) candidates.push(null); // no tabs — use the page as-is

  for (const tabName of candidates) {
    if (tabName) {
      await page.getByRole('tab', { name: tabName }).click().catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(200);
    }

    let anyPresent = false, allFree = true;
    for (const s of sel.selections) {
      const st = await cellState(page, s.court, s.time);
      if (st !== 'absent') anyPresent = true;
      if (st !== 'free')   allFree = false;
    }

    if (!anyPresent) continue;          // wrong tab — try the next one
    if (!allFree) {
      console.log(`  [${tabName ?? 'page'}] Saved slots not all free yet — retrying…`);
      return false;                     // present but taken — reload & retry
    }

    for (const s of sel.selections) {
      console.log(`  [${tabName ?? 'page'}] ${s.court} — ${s.time}`);
      await cell(page, s.court, s.time).click();
      await page.waitForTimeout(120);
    }
    await page.getByRole('button', { name: /Proceed/i }).click();
    console.log('  Parked at Confirm.');
    return true;
  }

  return false;
}

// Reload + replay until parked. `deadline` (ms epoch) bounds --now/--test; the
// official run passes Infinity and waits out the open time.
async function replayUntilParked(page, sel, url, deadline = Infinity) {
  while (Date.now() < deadline) {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (await replayOnce(page, sel)) return true;
    console.log(`  Retrying in ${RETRY_MS}ms…`);
    await page.waitForTimeout(RETRY_MS);
  }
  return false;
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main(mode) {
  const sel = loadSelection();
  const url = buildUrlForDate(sel.date);

  console.log('\n🏓 Booking Bot v2 — run');
  summarize(sel);
  console.log('  URL  :', url);

  // pick runs headful; honour HEADLESS only for the actual run.
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: HEADLESS });
  const page    = context.pages()[0] ?? await context.newPage();

  try {
    // ── now: immediate live run ──────────────────────────────────────────────
    if (mode === 'now') {
      const parked = await replayUntilParked(page, sel, url, Date.now() + 30_000);
      if (!parked) { console.log('Saved slots not bookable right now.'); return; }
      const confirmBtn = page.getByRole('button', { name: 'Confirm' });
      await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await confirmBtn.isVisible()) await confirmBtn.click();
      await fillForm(page);
      await pay(page);
      return;
    }

    // ── test: same date/cells, short countdown, dummy PIN ────────────────────
    if (mode === 'test') {
      console.log('[test] Fire in:', FIRE_IN_SECONDS, 'seconds');
      const fireAt = DateTime.now().setZone(TZ).plus({ seconds: FIRE_IN_SECONDS });
      const parked = await replayUntilParked(page, sel, url, Date.now() + 60_000);
      if (!parked) { console.log('Saved slots not bookable for test.'); return; }
      await fireConfirm(page, fireAt);
      await fillForm(page);
      await pay(page, TEST_WALLET_PIN);
      return;
    }

    // ── book (official): sleep → pre-select → fire at the open moment ────────
    const openMidnight = nextOpenMoment();
    console.log('Opens at:', openMidnight.toISO());

    const preLoadAt      = openMidnight.minus({ milliseconds: PRE_OPEN_MS });
    const msUntilPreLoad = preLoadAt.toMillis() - Date.now();
    if (msUntilPreLoad > 0) {
      console.log(`\nPre-select at ${preLoadAt.toISO()}  (${Math.round(msUntilPreLoad / 1000)}s away)`);
      console.log('Sleeping…');
      await new Promise(r => setTimeout(r, msUntilPreLoad));
    }

    console.log('\nPre-selecting slots…');
    await replayUntilParked(page, sel, url);   // waits out the open time
    await fireConfirm(page, openMidnight);
    await fillForm(page);
    await pay(page);

  } finally {
    await context.close();
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--now')  ? 'now'
           : args.includes('--test') ? 'test'
           : 'book';
main(mode).catch(err => { console.error('Fatal:', err); process.exit(1); });
