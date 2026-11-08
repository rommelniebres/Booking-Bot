// ─── v2 pick phase ───────────────────────────────────────────────────────────
// Builds a ranked list of COURT BLOCKS for a future target date. Because the site
// only serves the next ~14 days, you can't open the target itself, so you pick
// against the latest already-open date that shares the target's weekday (same
// weekday ⇒ same shift pattern & admin blocks). Click a court's hours in priority
// order (free OR taken); clicks group into one block per court, ranked by the
// order courts are first clicked. Set the target date, each court's minimum
// consecutive hours, and how many courts to book, then press "Save selection" to
// write v2/selection.json, which run.js replays at the open moment.

import { chromium } from 'playwright';
import { DateTime } from 'luxon';
import fs           from 'fs';
import {
  USER_DATA_DIR, SELECTION_FILE, TZ, OPEN_WINDOW_DAYS,
  buildUrlForDate, latestOpenSameWeekday,
} from './core.js';

// Injected into every page (survives navigations). Tracks cell clicks, paints a
// panel with the ranked court blocks + target / per-court-min / courts controls,
// and persists state in sessionStorage so nothing is lost when a target change
// re-navigates.
function pickerScript(cfg) {
  if (window.__bookbotInit) return;
  window.__bookbotInit = true;

  const SS_SEL = 'bb_sel', SS_TARGET = 'bb_target', SS_MIN = 'bb_min', SS_COURTS = 'bb_courts';
  const DAY = 86400000;
  const HL  = '3px solid #22c55e';
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const TIME_ORDER = ['4-5','5-6','6-7','7-8','8-9','9-10','10-11','11-12','12-1','1-2','2-3','3-4'];

  // Group clicked slots into one block per court, preserving the order courts
  // were first clicked (= priority); hours sorted by schedule. `min` = how many
  // consecutive hours must be free to take the court (default = all = strict).
  function blocksOf(list, mins) {
    const order = [], byCourt = {};
    for (const s of list) {
      if (!byCourt[s.court]) { byCourt[s.court] = []; order.push(s.court); }
      byCourt[s.court].push(s.time);
    }
    return order.map(court => {
      const times = byCourt[court].slice().sort((a, b) => TIME_ORDER.indexOf(a) - TIME_ORDER.indexOf(b));
      const want  = mins && mins[court] != null ? mins[court] : times.length;
      return { court, times, min: Math.max(1, Math.min(want, times.length)) };
    });
  }

  const parseISO   = s => { const [y,m,d] = s.split('-').map(Number); return Date.UTC(y, m-1, d); };
  const toISO      = ms => new Date(ms).toISOString().slice(0, 10);
  const weekdayOf  = ms => DOW[new Date(ms).getUTCDay()];
  const todayMs    = parseISO(cfg.todayISO);

  // Latest already-open date (today..today+13) sharing the target's weekday.
  function referenceFor(targetMs) {
    const maxOpen = todayMs + 13 * DAY;
    let d = targetMs;
    while (d > maxOpen) d -= 7 * DAY;
    return d;
  }

  const load = (k, dflt) => { try { const v = sessionStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch { return dflt; } };
  const save = (k, v)    => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let sel    = load(SS_SEL, []);                       // [{court,time}] clicked, in order
  let target = load(SS_TARGET, cfg.defaultTargetISO);  // yyyy-mm-dd
  let mins   = load(SS_MIN, {});                        // { court: minConsecutiveHours }
  let courts = load(SS_COURTS, 1);                      // how many courts to book (default 1)

  const key = (c, t) => c + '|' + t;

  // Header TH text like "4pm-5pm" → data-time "4-5".
  const th2dt = s => { const m = (s || '').match(/(\d+)(?:am|pm)-(\d+)(?:am|pm)/i); return m ? `${m[1]}-${m[2]}` : ''; };
  const headerTimes = table => (table && table.rows[0])
    ? [...table.rows[0].cells].map(c => th2dt(c.textContent)) : [];

  // Court + time for ANY slot cell — free (btncell carries dataset) or taken
  // (alert-secondary/alert-warning: court from text, time from its column header).
  function slotOf(td) {
    if (!td) return null;
    const court = td.dataset.courtname
      || ((td.textContent || '').match(/MP-Court\s*\d+/) || [''])[0].replace(/\s+/g, ' ');
    if (!court) return null;
    if (td.dataset.time) return { court, time: td.dataset.time };
    const row = td.parentElement, table = td.closest('table');
    if (!row || !table) return null;
    let col = 0;
    for (const c of row.cells) { if (c === td) break; col += c.colSpan; }
    const time = headerTimes(table)[col];
    return time ? { court, time } : null;
  }

  function paint() {
    document.querySelectorAll('td[data-__picked]').forEach(td => {
      td.style.outline = ''; td.removeAttribute('data-__picked');
    });
    const wanted = new Set(sel.map(s => key(s.court, s.time)));
    document.querySelectorAll('table td').forEach(td => {
      if (td.offsetParent === null) return;          // only the active shift tab
      const slot = slotOf(td);
      if (slot && wanted.has(key(slot.court, slot.time))) {
        td.style.outline = HL; td.setAttribute('data-__picked', '1');
      }
    });
    renderPanel();
  }

  function activeShift() {
    const t = document.querySelector('[role="tab"][aria-selected="true"]')
      || document.querySelector('[role="tab"].active, [role="tab"].is-active');
    return t ? t.textContent.trim() : '';
  }

  document.addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td) return;
    const slot = slotOf(td);
    if (!slot) return;
    const taken = !td.classList.contains('btncell');
    // For a taken cell, stop the site reacting (no "reserved" popup) — we're only
    // recording it as a ranked wish; it may be free on the real target date.
    if (taken) { e.preventDefault(); e.stopPropagation(); }
    const i = sel.findIndex(s => key(s.court, s.time) === key(slot.court, slot.time));
    if (i >= 0) sel.splice(i, 1);
    else        sel.push({ court: slot.court, time: slot.time, label: taken ? 'taken today' : '' });
    save(SS_SEL, sel);
    setTimeout(paint, 30);   // repaint after the site's own click handler runs
  }, true);

  function renderPanel() {
    let panel = document.getElementById('__bookbotPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = '__bookbotPanel';
      panel.style.cssText = [
        'position:fixed','top:12px','right:12px','z-index:2147483647',
        'width:320px','max-height:80vh','overflow:auto',
        'font:13px/1.4 system-ui,sans-serif','color:#0f172a',
        'background:#ffffff','border:1px solid #cbd5e1','border-radius:10px',
        'box-shadow:0 8px 24px rgba(0,0,0,.18)','padding:12px',
      ].join(';');
      document.body.appendChild(panel);
    }

    const targetMs = parseISO(target);
    const refISO   = toISO(referenceFor(targetMs));
    const curBook  = new URLSearchParams(location.search).get('bookdate') || '';
    const onRef    = curBook === refISO;

    const blocks = blocksOf(sel, mins);
    const rows = blocks.length
      ? blocks.map((b, i) => `<li style="margin:7px 0;list-style:none;overflow:hidden">
          <button data-rmcourt="${b.court}" title="remove court" style="float:right;border:0;background:#fee2e2;color:#b91c1c;border-radius:5px;cursor:pointer;padding:1px 6px">✕</button>
          <b style="color:#16a34a">${i + 1}.</b> <b>${b.court}</b>
          <div style="color:#334155">${b.times.join(', ')} <span style="color:#94a3b8;font-size:11px">(${b.times.length}h)</span></div>
          <div style="color:#64748b;font-size:11px;margin-top:2px">take only if ≥
            <input type="number" data-min="${b.court}" min="1" max="${b.times.length}" value="${b.min}"
                   style="width:42px;padding:1px 3px;border:1px solid #cbd5e1;border-radius:4px"> consecutive hrs free
            ${b.min >= b.times.length ? '<span style="color:#94a3b8">(strict)</span>' : ''}</div></li>`).join('')
      : '<li style="color:#94a3b8;list-style:none">Click a court\'s hours (e.g. 4–7pm) — free OR taken…</li>';

    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px">🏓 Booking Bot — rank courts</div>
      <label style="display:block;color:#475569;margin-bottom:2px">Target date (what you'll book)</label>
      <input id="__bbTarget" type="date" value="${target}"
             style="width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:4px">
      <div style="color:#64748b;margin-bottom:8px">${weekdayOf(targetMs)} ·
        picking against <b>${curBook || '—'}</b>${onRef ? '' : ` <span style="color:#dc2626">(should be ${refISO})</span>`}
        · shift <b>${activeShift() || '—'}</b></div>
      <label style="display:block;color:#475569;margin-bottom:2px">Courts to book</label>
      <input id="__bbCourts" type="number" min="1" value="${courts}"
             style="width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:6px;margin-bottom:8px">
      <div style="color:#64748b;margin-bottom:8px">Click a court's hours in priority order — <b>free or taken</b>. Lower a court's "≥ hrs" to let it take a shorter consecutive block. It books up to the above number of courts, down the list.</div>
      <ol style="margin:0 0 10px 0;padding:0">${rows}</ol>
      <button id="__bbSave" style="width:100%;padding:9px;border:0;border-radius:8px;background:#16a34a;color:#fff;font-weight:700;cursor:pointer">✓ Save selection</button>
      <button id="__bbClear" style="width:100%;margin-top:6px;padding:7px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#334155;cursor:pointer">Clear all</button>`;

    panel.querySelectorAll('[data-rmcourt]').forEach(btn => btn.onclick = () => {
      sel = sel.filter(s => s.court !== btn.dataset.rmcourt);
      delete mins[btn.dataset.rmcourt];
      save(SS_SEL, sel); save(SS_MIN, mins);
      paint();
    });
    panel.querySelectorAll('[data-min]').forEach(inp => inp.onchange = () => {
      mins[inp.dataset.min] = Math.max(1, parseInt(inp.value) || 1);
      save(SS_MIN, mins);
      paint();
    });
    panel.querySelector('#__bbCourts').onchange = (e) => {
      courts = Math.max(1, parseInt(e.target.value) || 1);
      save(SS_COURTS, courts);
    };

    panel.querySelector('#__bbTarget').onchange = (e) => {
      target = e.target.value || cfg.defaultTargetISO;
      save(SS_TARGET, target);
      const ref = toISO(referenceFor(parseISO(target)));
      if (ref !== (new URLSearchParams(location.search).get('bookdate') || '')) {
        window.__bookbotNav(ref);        // re-navigate to the matching reference date
      } else {
        paint();
      }
    };
    panel.querySelector('#__bbSave').onclick = () => {
      if (!sel.length) { alert('Click at least one court\'s hours first.'); return; }
      window.__bookbotSave({
        bookdate: target,
        weekday:  weekdayOf(parseISO(target)),
        shift:    activeShift(),
        courts:   courts,
        blocks:   blocksOf(sel, mins),
        pickedAgainst: location.href,
      });
    };
    panel.querySelector('#__bbClear').onclick = () => {
      sel = []; mins = {}; save(SS_SEL, sel); save(SS_MIN, mins); paint();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint);
  } else {
    paint();
  }
}

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false });
  const page    = context.pages()[0] ?? await context.newPage();

  let resolveSave;
  const saved = new Promise(r => { resolveSave = r; });
  await context.exposeBinding('__bookbotSave', (_src, payload) => resolveSave(payload));
  // Re-navigate to a reference date (yyyy-mm-dd) when the target weekday changes.
  await context.exposeBinding('__bookbotNav', async (_src, iso) => {
    const d = DateTime.fromISO(iso, { zone: TZ });
    await page.goto(buildUrlForDate(d), { waitUntil: 'networkidle' }).catch(() => {});
  });

  const today      = DateTime.now().setZone(TZ).startOf('day');
  // Default to the date that newly opens at the next midnight — the one you race for.
  const target     = today.plus({ days: OPEN_WINDOW_DAYS });
  const reference  = latestOpenSameWeekday(target);
  await context.addInitScript(pickerScript, {
    todayISO: today.toISODate(),
    defaultTargetISO: target.toISODate(),
  });

  console.log('\n🏓 Booking Bot — pick phase (ranked)');
  console.log(`   Target  : ${target.toISODate()} (${target.toFormat('cccc')})`);
  console.log(`   Picking against: ${reference.toISODate()} (${reference.toFormat('cccc')}, latest open same weekday)`);
  console.log('   → Click a court\'s hours in priority order (1st court = top choice),');
  console.log('     set the target date, then press "✓ Save selection".\n');

  await page.goto(buildUrlForDate(reference), { waitUntil: 'networkidle' }).catch(() => {});
  await page.evaluate(pickerScript, {
    todayISO: today.toISODate(),
    defaultTargetISO: target.toISODate(),
  }).catch(() => {});

  const payload = await saved;
  fs.writeFileSync(SELECTION_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n✓ Saved to v2/selection.json');
  console.log(`  Target: ${payload.bookdate} (${payload.weekday})`);
  console.log(`  Shift : ${payload.shift || '(unknown)'}   Courts to book: ${payload.courts}`);
  payload.blocks.forEach((b, i) => {
    const rule = b.min >= b.times.length ? 'all or skip' : `≥${b.min}h consecutive`;
    console.log(`   ${i + 1}. ${b.court} — ${b.times.join(', ')}  (${b.times.length}h, ${rule})`);
  });
  console.log('\nNext:');
  console.log('  npm run test-book          — replay now vs latest same-weekday date, dummy PIN');
  console.log(`  npm run book               — official run (books ${payload.courts} court(s)): fires at the open time`);
  console.log('  npm run book -- --courts N — override the saved courts-to-book for one run\n');

  await context.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
