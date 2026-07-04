# Booking Bot

A configurable [Playwright](https://playwright.dev) automation that reserves a
time slot on a scheduling website the moment its booking window opens. It
pre-selects your preferred slots shortly before the open time, waits at the
confirmation step, fires exactly at the open moment, then auto-fills the form
and completes checkout.

Everything site-specific (URL, resource names, prices, payment labels,
credentials) lives in a local `.env` file, so the code itself is generic and
reusable for any similar booking flow.

## Features

- **Two-phase timing:** pre-selects before the open time, then fires the confirm
  click at the exact second the window opens.
- **Promo handling:** if a discounted early slot is detected, books an
  alternate pair of resources in a single transaction.
- **Configurable block picker:** choose your preferred 3-hour block at startup,
  with automatic fallback to any free window.
- **Persistent login:** saves the browser session so you stay logged in for
  checkout across runs.
- **Dry-run mode:** test the whole flow against any URL with a simulated
  countdown and a dummy PIN — no real payment.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer

## Install

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then edit .env with your values
```

## Configure

Edit `.env` (or run `npm run setup`). See `.env.example` for every option.
Key values:

| Variable            | Meaning                                            |
|---------------------|----------------------------------------------------|
| `BOOKING_BASE_URL`  | The scheduling page to automate                    |
| `PRIMARY_RESOURCE`  | Resource name to book on a normal day              |
| `SALE_RESOURCE_*`   | Resources to book when a promo is detected         |
| `WALLET_PIN`        | Your 6-digit checkout PIN (local only)             |
| `BOOKER_*`          | Name / phone / email for the booking form          |
| `HEADLESS`          | `false` shows the browser window (recommended)     |

## Usage

```bash
npm run book        # full auto: pick a block, wait for open time, book
npm run attend      # you pick slots manually; bot fires confirm at open time
npm run now         # run immediately against today's target (live test)
npm run test-book   # dry run vs TEST_URL with a fake countdown + dummy PIN
```

**First run:** use `npm run now` or `npm run book` once and log in when
prompted. The session is saved to `.browser-data/` so you stay logged in on
later runs. Run only **one** command at a time (they share that folder).

## Security

- `.env` and `.browser-data/` are gitignored — they hold your PIN, personal
  details, target site, and login session. **Never commit them.**
- `npm run test-book` uses a dummy PIN, never your real one.
- The PIN is never printed to the console or sent to any webhook.

---

## Publishing to GitHub

`.gitignore` already excludes your secrets, so this is safe:

```bash
git init
git add .
git status              # confirm .env and .browser-data are NOT listed
git commit -m "Booking bot"
git remote add origin https://github.com/<your-username>/<repo>.git
git branch -M main
git push -u origin main
```

Only `.env.example` (placeholders) is committed — your real `.env` stays on your
machine.

### Authentication note

GitHub no longer accepts your account password over HTTPS. When `git push` asks
for a password, paste a **Personal Access Token** instead
(GitHub → *Settings → Developer settings → Personal access tokens*, with the
`repo` scope). To have Windows remember it:

```bash
git config --global credential.helper manager
```

## Keeping credentials private

Your real values in `.env` should **not** be committed, even to a private repo.
Options, best first:

1. **Keep `.env` local (recommended).** It never leaves your machine.
2. **GitHub Secrets** (an encrypted vault, not the code): repo *Settings →
   Secrets and variables*. A safe place to back up values without exposing them.
3. **Encrypt before committing** with a tool like
   [SOPS](https://github.com/getsops/sops) if you truly need values in the repo.

If you ever commit `.env` by accident, treat the PIN as compromised: change it
and scrub the file from git history.
