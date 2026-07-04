import readline from 'readline';
import fs       from 'fs';
import path     from 'path';
import { fileURLToPath } from 'url';
import dotenv   from 'dotenv';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
dotenv.config({ path: ENV_FILE });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

// ─── prompt helpers ───────────────────────────────────────────────────────────

async function choose(label, options, current) {
  console.log(`\n${label}`);
  console.log(`  Current: ${current || '(not set)'}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  console.log('  c) Type custom value');
  console.log('  [Enter] Keep current');

  const ans = (await ask('  Choice: ')).trim();
  if (!ans) return current;

  const idx = parseInt(ans);
  if (!isNaN(idx) && idx >= 1 && idx <= options.length) return options[idx - 1];
  if (ans.toLowerCase() === 'c') {
    const custom = (await ask('  Custom value: ')).trim();
    return custom || current;
  }
  return ans;
}

async function prompt(label, current, mask = false) {
  console.log(`\n${label}`);
  if (!mask) console.log(`  Current: ${current || '(not set)'}`);
  const ans = (await ask('  Value ([Enter] to keep): ')).trim();
  return ans || current || '';
}

// ─── .env writer ──────────────────────────────────────────────────────────────

function writeEnv(updates) {
  const existing = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').split('\n')
    : [];

  for (const [key, value] of Object.entries(updates)) {
    const idx = existing.findIndex(l => l.startsWith(`${key}=`));
    if (idx !== -1) {
      existing[idx] = `${key}=${value}`;
    } else {
      existing.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(ENV_FILE, existing.join('\n'), 'utf8');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Booking Bot — Setup                         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('\nPress [Enter] at any prompt to keep the current value.\n');

  const e       = process.env;
  const updates = {};
  const set     = (k, v) => { if (v !== (e[k] ?? '')) updates[k] = v; };

  // Days ahead
  set('DAYS_AHEAD', await choose(
    'DAYS_AHEAD — days ahead of midnight to target',
    ['13', '14', '7'],
    e.DAYS_AHEAD ?? '14'
  ));

  // Payment option label (e.g. the wallet shown in the checkout list)
  set('PAYMENT_LABEL', await prompt(
    'PAYMENT_LABEL — payment option label to click at checkout',
    e.PAYMENT_LABEL
  ));

  // Booker details
  set('BOOKER_NAME',  await prompt('BOOKER_NAME  — full name for the booking form', e.BOOKER_NAME));
  set('BOOKER_PHONE', await prompt('BOOKER_PHONE — contact number',                 e.BOOKER_PHONE));
  set('BOOKER_EMAIL', await prompt('BOOKER_EMAIL — email address',                  e.BOOKER_EMAIL));

  // Wallet PIN — masked display
  set('WALLET_PIN', await prompt(
    'WALLET_PIN   — 6-digit wallet PIN (stored in .env only, never printed)',
    e.WALLET_PIN,
    true
  ));

  // Headless
  set('HEADLESS', await choose(
    'HEADLESS — run browser in background? (false = show window)',
    ['false', 'true'],
    e.HEADLESS ?? 'false'
  ));

  // Retry interval
  set('RETRY_MS', await choose(
    'RETRY_MS — ms between retries when slots are not free yet',
    ['400', '600', '1000'],
    e.RETRY_MS ?? '400'
  ));

  // PRE_OPEN_MS
  set('PRE_OPEN_MS', await choose(
    'PRE_OPEN_MS — ms before midnight to start pre-selecting slots',
    ['180000 (3 min)', '300000 (5 min)', '60000 (1 min)'],
    e.PRE_OPEN_MS ?? '180000'
  ));

  // Webhook
  set('NOTIFY_WEBHOOK', await prompt(
    'NOTIFY_WEBHOOK — notification URL (ntfy.sh / Discord webhook, optional)',
    e.NOTIFY_WEBHOOK
  ));

  rl.close();

  if (!Object.keys(updates).length) {
    console.log('\nNo changes — .env unchanged.\n');
    return;
  }

  writeEnv(updates);

  console.log('\n✓ .env updated:');
  for (const [k, v] of Object.entries(updates)) {
    console.log(`  ${k}=${k === 'WALLET_PIN' ? '******' : v}`);
  }
  console.log('\nNext steps:');
  console.log('  npm run now    — run immediately (test mode)');
  console.log('  npm run book   — wait for the open time and book\n');
}

main().catch(err => {
  rl.close();
  console.error('Setup error:', err);
  process.exit(1);
});
