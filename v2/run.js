// ─── v2 run phase ────────────────────────────────────────────────────────────
// Replays the ranked court blocks saved by pick.js (v2/selection.json). At the
// open moment the grid appears all at once; a present cell is a free cell (taken
// / admin-blocked slots are absent from the DOM). So each attempt reads the whole
// availability map in ONE pass and books, in priority order, up to `courts`
// courts — each taking its longest consecutive free run that meets its minimum.
//
// Timing is unchanged from v1: official run sleeps until PRE_OPEN_MS before the
// open time, then tight-loops reloads until the date flips open and fires
// Confirm at the open moment. --test fires FIRE_IN_SECONDS out; --now runs now.
// Because the real target is past the 2-week window, --test / --now replay
// against the latest already-open date that shares the target's weekday.

import { chromium } from 'playwright';
import { DateTime } from 'luxon';
import fs           from 'fs';
import {
  USER_DATA_DIR, SELECTION_FILE, HEADLESS, RETRY_MS, PRE_OPEN_MS, TZ,
  FIRE_IN_SECONDS, TEST_WALLET_PIN,
  buildUrlForDate, latestOpenSameWeekday, nextOpenMoment, longestFreeRun,
  freeCellsOnActiveTab, cell, fireConfirm, fillForm, pay,
} from './core.js';

// ─── load saved selection ──────────────────────────────────────────────────────
function loadSelection() {
  if (!fs.existsSync(SELECTION_FILE)) {
    console.error('No saved selection. Run "npm run pick" first.');
    process.exit(1);
  }
  const sel = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'));

  // Priority-ordered COURT BLOCKS: each is one court + its consecutive hours, and
  // it's all-or-nothing — a block books only if EVERY hour in it is free. Accept
  // old flat `ranked`/`selections` by grouping them into one block per court.
  sel.blocks = sel.blocks ?? groupLegacy(sel.ranked ?? sel.selections ?? []);
  if (!sel.blocks.length) {
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

// Group a flat [{court,time}] list into one block per court, preserving the
// order courts first appear (= priority). Backward-compat for old selection.json.
function groupLegacy(flat) {
  const order = [], byCourt = {};
  for (const s of flat) {
    if (!byCourt[s.court]) { byCourt[s.court] = []; order.push(s.court); }
    byCourt[s.court].push(s.time);
  }
  return order.map(court => ({ court, times: byCourt[court] }));
}

function summarize(sel, courts) {
  console.log('Replaying ranked court blocks:');
  console.log(`  Target: ${sel.bookdate} (${sel.date.toFormat('cccc')})`);
  console.log(`  Shift : ${sel.shift || '(auto)'}   Book up to ${courts} court(s)`);
  sel.blocks.forEach((b, i) => {
    const min = Math.max(1, Math.min(b.min || b.times.length, b.times.length));
    const rule = min >= b.times.length ? 'all or skip' : `≥${min}h consecutive`;
    console.log(`   ${i + 1}. ${b.court} — ${b.times.join(', ')}  (${b.times.length}h, ${rule})`);
  });
}

// ─── which shift tabs to try, in order ─────────────────────────────────────────
// Saved shift first, then every real "Shift N" tab present on the page. When the
// date is still closed the page redirects to step1 with no tabs → [null], which
// reads an empty grid and returns fast (no 30s tab-click stall).
async function candidateTabs(page, sel) {
  const tabs  = await page.getByRole('tab').all();
  const names = (await Promise.all(tabs.map(t => t.textContent().catch(() => ''))))
    .map(t => t.trim())
    .filter(t => /^Shift\s*\d+/i.test(t));

  const out = [];
  if (sel.shift && names.includes(sel.shift)) out.push(sel.shift);
  for (const n of names) if (!out.includes(n)) out.push(n);
  return out.length ? out : [null];
}

// ─── replay: book up to `courts` courts (priority order), park at Confirm ──────
// For each court in rank order, take its longest consecutive free run meeting its
// min; book up to `courts` of them, then Proceed. Returns true when parked, false
// if nothing qualified yet (caller reloads and retries).
async function replayOnce(page, sel, courts) {
  for (const tabName of await candidateTabs(page, sel)) {
    if (tabName) {
      await page.getByRole('tab', { name: tabName }).click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(150);
    }

    // Whole availability map for this tab in one pass.
    const free = new Set(await freeCellsOnActiveTab(page));

    const chosen = [];
    for (const b of sel.blocks) {
      if (chosen.length >= courts) break;
      const run = longestFreeRun(b, free);
      if (run) chosen.push({ court: b.court, times: run });
    }
    if (!chosen.length) continue;   // nothing qualifies on this tab — next tab

    for (const c of chosen) {
      for (const t of c.times) {
        console.log(`  [${tabName ?? 'page'}] ${c.court} — ${t}`);
        await cell(page, c.court, t).click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(100);
      }
    }
    await page.getByRole('button', { name: /Proceed/i }).click({ timeout: 3000 });
    console.log(`  Parked at Confirm — ${chosen.map(c => `${c.court} (${c.times.join(', ')})`).join(' + ')}.`);
    return true;
  }
  return false;
}

// Reload + replay until parked. `deadline` (ms epoch) bounds --now/--test; the
// official run passes Infinity and tight-loops until the date opens.
async function replayUntilParked(page, sel, url, courts, deadline = Infinity) {
  while (Date.now() < deadline) {
    await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
    if (await replayOnce(page, sel, courts)) return true;
    await page.waitForTimeout(RETRY_MS);
  }
  return false;
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main(mode, cliCourts) {
  const sel = loadSelection();

  // Courts to book: CLI override wins, else the saved default from pick, else 1.
  const courts = cliCourts
    ?? (Number.isInteger(sel.courts) && sel.courts > 0 ? sel.courts : 1);

  // book + test-open run against the REAL target date (test-open waits out the
  // real midnight open, it just never commits). test / now can't open the future
  // target, so they replay against the latest open date of the same weekday.
  const liveTarget = mode === 'book' || mode === 'test-open';
  const runDate    = liveTarget ? sel.date : latestOpenSameWeekday(sel.date);
  const url        = buildUrlForDate(runDate);

  console.log('\n🏓 Booking Bot v2 — run');
  summarize(sel, courts);
  if (!liveTarget) {
    console.log(`  [${mode}] Target not open yet — replaying against ${runDate.toISODate()} ` +
                `(${runDate.toFormat('cccc')}, same weekday).`);
  }
  console.log('  URL  :', url);

  // pick runs headful; honour HEADLESS only for the actual run.
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: HEADLESS });
  const page    = context.pages()[0] ?? await context.newPage();

  try {
    // ── now: immediate live run ──────────────────────────────────────────────
    if (mode === 'now') {
      const parked = await replayUntilParked(page, sel, url, courts, Date.now() + 30_000);
      if (!parked) { console.log('None of your ranked slots are bookable right now.'); return; }
      const confirmBtn = page.getByRole('button', { name: 'Confirm' });
      await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await confirmBtn.isVisible()) await confirmBtn.click();
      await fillForm(page);
      await pay(page);
      return;
    }

    // ── test: same block logic, short countdown, dummy PIN ───────────────────
    if (mode === 'test') {
      console.log('[test] Fire in:', FIRE_IN_SECONDS, 'seconds');
      const fireAt = DateTime.now().setZone(TZ).plus({ seconds: FIRE_IN_SECONDS });
      const parked = await replayUntilParked(page, sel, url, courts, Date.now() + 60_000);
      if (!parked) { console.log('None of your ranked slots are bookable for test.'); return; }
      await fireConfirm(page, fireAt);
      await fillForm(page);
      await pay(page, TEST_WALLET_PIN);
      return;
    }

    // ── test-open: real midnight dry-run — race the real open, never commit ──
    // Same timing as the official run against the real target date, but stops the
    // instant it parks at Confirm: no Confirm-fire, no form, no payment.
    if (mode === 'test-open') {
      const openAt = nextOpenMoment();
      console.log('\n[test-open] DRY RUN — real open at:', openAt.toISO());
      console.log('            Will race the open and STOP at Confirm — no booking.');
      const preLoadAt = openAt.minus({ milliseconds: PRE_OPEN_MS });
      const msUntil   = preLoadAt.toMillis() - Date.now();
      if (msUntil > 0) {
        console.log(`Sleeping ${Math.round(msUntil / 1000)}s until pre-select…`);
        await new Promise(r => setTimeout(r, msUntil));
      }
      console.log('Tight-looping until the date opens…');
      const parked = await replayUntilParked(page, sel, url, courts, openAt.plus({ minutes: 5 }).toMillis());
      if (parked) {
        console.log(`\n✅ DRY RUN OK — parked at Confirm at ${DateTime.now().setZone(TZ).toISO()}.`);
        console.log('   Not clicking Confirm, not paying. A short-lived slot hold may linger but expires.');
      } else {
        console.log('\n⚠ DRY RUN — never parked (slots never came free within 5 min of open).');
      }
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

    console.log('\nTight-looping until the date opens…');
    await replayUntilParked(page, sel, url, courts);   // waits out the open time
    await fireConfirm(page, openMidnight);
    await fillForm(page);
    await pay(page);

  } finally {
    await context.close();
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--now')       ? 'now'
           : args.includes('--test-open') ? 'test-open'
           : args.includes('--test')      ? 'test'
           : 'book';

// Optional courts-to-book override for this run: `--courts N` or a bare number
// (e.g. `npm run book -- --courts 2`). If omitted, main() uses the saved default.
const flagIdx   = args.indexOf('--courts');
const rawCourts = flagIdx >= 0 ? args[flagIdx + 1] : args.find(a => /^\d+$/.test(a));
const cliCourts = rawCourts != null ? Math.max(1, parseInt(rawCourts) || 1) : null;

main(mode, cliCourts).catch(err => { console.error('Fatal:', err); process.exit(1); });
