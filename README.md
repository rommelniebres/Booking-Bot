# Booking Bot

A configurable [Playwright](https://playwright.dev) automation that reserves a
time slot on a scheduling website the moment its booking window opens. It
pre-selects your preferred slots shortly before the open time, waits at the
confirmation step, fires exactly at the open moment, then auto-fills the form
and completes checkout.

> **v2 (current):** You pick your court, date, and time slots **visually on the
> real booking page** — no more terminal prompts guessing at courts/hours. Your
> pick is saved and replayed automatically at the open moment. The old
> prompt-driven flow is still available as the `-v1` commands. See
> [Changelog](#changelog).

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

## Usage (v2 — default)

The v2 flow is two steps: **pick** once, then **run**.

```bash
npm run pick        # opens the booking page; click your court/date/time cells,
                    #   then press the green "✓ Save selection" button
npm run book        # official run: waits until ~3 min before the open time,
                    #   replays your saved pick, fires Confirm at the open moment
npm run test-book   # replay your pick with a ~10s countdown + dummy PIN (dry run)
npm run now         # replay your pick immediately (live test)
```

**How pick works:** the browser opens on the booking page. Navigate to the date
you want and click the court/time cells (click again to unselect — each is
highlighted). A corner panel shows your running selection, the date, and the
shift. Press **✓ Save selection** and the bot records the exact date, shift,
court(s), and slot(s) to `v2/selection.json`. Every later run just replays that.

**First run:** run `npm run pick` once and log in when prompted. The session is
saved to `.browser-data/` so you stay logged in on later runs. Run only **one**
command at a time (they share that folder).

### Legacy v1 commands

The original prompt-driven flow (choose a block/court via the terminal, with
automatic promo-day switching) is still here, suffixed `-v1`:

```bash
npm run book-v1        # full auto: pick a block via prompts, wait, book
npm run attend-v1      # you pick slots manually in-browser; bot fires at open
npm run now-v1         # run immediately against today's target (live test)
npm run test-book-v1   # dry run vs TEST_URL with a fake countdown + dummy PIN
```

## Security

- `.env` and `.browser-data/` are gitignored — they hold your PIN, personal
  details, target site, and login session. **Never commit them.**
- `npm run test-book` uses a dummy PIN, never your real one.
- The PIN is never printed to the console or sent to any webhook.

---

## Changelog

### v2.0.0 — visual pick flow (current)

- **Pick on the real page.** New `npm run pick` lets you select your court, date,
  and time slots directly on the booking site, then save them with an in-browser
  button — replacing the error-prone terminal prompts.
- **Saved & replayed.** Your pick is stored in `v2/selection.json` (gitignored)
  and replayed automatically by every run.
- **`book` / `test-book` / `now` now default to v2.** Timing is unchanged
  (official = ~3 min before the open time; test = ~10 s countdown).
- **v1 preserved.** The original prompt-driven flow is still available as the
  `-v1` commands; its code (`book.js`) is untouched. v2 lives in `v2/`.

### v1.0.0 — original

Prompt-driven block/court picker with automatic promo-day switching.

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
