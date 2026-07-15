// ─── v2 pick phase ───────────────────────────────────────────────────────────
// Opens a visible browser on the booking page. You navigate to the date you want
// and click your court + time cells; each click is tracked here (toggle on/off,
// with a highlight) so capture never depends on the site's own styling. A
// floating "Save selection" button writes your exact date / shift / court / slots
// to v2/selection.json, which run.js replays at fire time.

import { chromium } from 'playwright';
import fs           from 'fs';
import {
  USER_DATA_DIR, SELECTION_FILE, buildUrlForDate, defaultTargetDate,
} from './core.js';

// Injected into every page (survives navigations). Tracks cell clicks and paints
// a small panel + Save button. Communicates back via the exposed __bookbotSave.
function pickerScript() {
  if (window.__bookbotInit) return;
  window.__bookbotInit = true;
  window.__bookbotSel = [];   // [{ court, time, label }]

  const HL = '3px solid #22c55e';

  function key(c, t) { return c + '|' + t; }

  function paint() {
    // Repaint highlights from the current selection set.
    document.querySelectorAll('td.btncell[data-__picked]').forEach(td => {
      td.style.outline = '';
      td.removeAttribute('data-__picked');
    });
    for (const s of window.__bookbotSel) {
      const td = document.querySelector(
        `td.btncell[data-courtname="${CSS.escape(s.court)}"][data-time="${CSS.escape(s.time)}"]`
      );
      if (td) { td.style.outline = HL; td.setAttribute('data-__picked', '1'); }
    }
    renderPanel();
  }

  function activeShift() {
    const sel = document.querySelector('[role="tab"][aria-selected="true"]')
      || document.querySelector('[role="tab"].active, [role="tab"].is-active');
    return sel ? sel.textContent.trim() : '';
  }

  function bookdate() {
    return new URLSearchParams(location.search).get('bookdate') || '';
  }

  document.addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td.btncell');
    if (!td) return;
    const court = td.getAttribute('data-courtname');
    const time  = td.getAttribute('data-time');
    if (!court || !time) return;
    const label = (td.innerText || '').trim().replace(/\s+/g, ' ');
    const k = key(court, time);
    const i = window.__bookbotSel.findIndex(s => key(s.court, s.time) === k);
    if (i >= 0) window.__bookbotSel.splice(i, 1);
    else        window.__bookbotSel.push({ court, time, label });
    // Repaint after the site's own click handler runs.
    setTimeout(paint, 30);
  }, true);

  function renderPanel() {
    let panel = document.getElementById('__bookbotPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = '__bookbotPanel';
      panel.style.cssText = [
        'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
        'width:300px', 'max-height:70vh', 'overflow:auto',
        'font:13px/1.4 system-ui,sans-serif', 'color:#0f172a',
        'background:#ffffff', 'border:1px solid #cbd5e1', 'border-radius:10px',
        'box-shadow:0 8px 24px rgba(0,0,0,.18)', 'padding:12px',
      ].join(';');
      document.body.appendChild(panel);
    }
    const sel  = window.__bookbotSel;
    const rows = sel.length
      ? sel.map(s => `<li style="margin:2px 0"><b>${s.court}</b> — ${s.time}${s.label ? ` <span style="color:#64748b">(${s.label})</span>` : ''}</li>`).join('')
      : '<li style="color:#94a3b8">Click court/time cells to select…</li>';
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">🏓 Booking Bot — pick</div>
      <div style="color:#64748b;margin-bottom:6px">Date: <b>${bookdate() || '—'}</b> · Shift: <b>${activeShift() || '—'}</b></div>
      <ul style="margin:0 0 10px 16px;padding:0">${rows}</ul>
      <button id="__bookbotSaveBtn" style="width:100%;padding:9px;border:0;border-radius:8px;background:#16a34a;color:#fff;font-weight:700;cursor:pointer">✓ Save selection</button>
      <button id="__bookbotClearBtn" style="width:100%;margin-top:6px;padding:7px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#334155;cursor:pointer">Clear</button>`;
    panel.querySelector('#__bookbotSaveBtn').onclick = () => {
      if (!window.__bookbotSel.length) { alert('Select at least one cell first.'); return; }
      window.__bookbotSave({
        bookdate: bookdate(),
        shift:    activeShift(),
        url:      location.href,
        selections: window.__bookbotSel,
      });
    };
    panel.querySelector('#__bookbotClearBtn').onclick = () => {
      window.__bookbotSel = [];
      paint();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderPanel);
  } else {
    renderPanel();
  }
}

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false });
  const page    = context.pages()[0] ?? await context.newPage();

  // Promise that resolves when you click "Save selection" in the browser.
  let resolveSave;
  const saved = new Promise(r => { resolveSave = r; });
  await context.exposeBinding('__bookbotSave', (_src, payload) => resolveSave(payload));

  await context.addInitScript(pickerScript);

  const url = buildUrlForDate(defaultTargetDate());
  console.log('\n🏓 Booking Bot — pick phase');
  console.log('   Opening:', url);
  console.log('   → Navigate to the date you want, click your court/time cells,');
  console.log('     then press the green "✓ Save selection" button in the browser.\n');

  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  // Re-inject in case the first load raced the init script.
  await page.evaluate(pickerScript).catch(() => {});

  const payload = await saved;

  if (!payload.bookdate) {
    console.warn('  ⚠ Could not read a booking date from the page URL. Saved anyway —');
    console.warn('    check "bookdate" in v2/selection.json before the official run.');
  }

  fs.writeFileSync(SELECTION_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n✓ Saved to v2/selection.json');
  console.log(`  Date : ${payload.bookdate || '(unknown)'}`);
  console.log(`  Shift: ${payload.shift || '(unknown)'}`);
  for (const s of payload.selections) {
    console.log(`  • ${s.court} — ${s.time}${s.label ? `  (${s.label})` : ''}`);
  }
  console.log('\nNext:');
  console.log('  npm run test-book   — replay now, fire ~10s out (dummy PIN)');
  console.log('  npm run book   — official run: fires at the open time\n');

  await context.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
