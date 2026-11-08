# Booking Bot

A configurable [Playwright](https://playwright.dev) automation that reserves a
time slot on a scheduling website the moment its booking window opens. It
pre-selects your preferred slots shortly before the open time, waits at the
confirmation step, fires exactly at the open moment, then auto-fills the form
and completes checkout.

> **v2 (current):** You build a **ranked wish-list of court blocks** visually on
> the real booking page — click a court's consecutive hours (e.g. 4–7pm), add
> backup courts, and set how many courts to book. At the open moment the bot
> grabs the best courts that are actually free. It works for **future dates past
> the bookable window** by picking against the latest open date of the same
> weekday. The old prompt-driven flow is still available as the `-v1` commands.
> See [Changelog](#changelog).

Everything site-specific (URL, resource names, prices, payment labels,
credentials) lives in a local `.env` file, so the code itself is generic and
reusable for any similar booking flow.

## Features

- **Two-phase timing:** pre-selects before the open time, then fires the confirm
  click at the exact second the window opens.
- **Ranked court blocks:** rank courts by preference; each court books its
  consecutive hours **all-or-nothing** (or a per-court minimum, so a backup court
  can take a shorter run). At the open, the bot reads the whole grid in one pass
  and books the best-ranked courts that are free.
- **Multi-court:** book more than one court in a single run (set a default when
  picking, or override per run with `--courts N`).
- **Future-date picking:** the target date can be past the bookable window; you
  pick against the latest open date of the same weekday (same shift pattern).
- **Persistent login:** saves the browser session so you stay logged in for
  checkout across runs.
- **Two test modes:** `test-book` (mechanics, dummy PIN) and `test-open` (a real
  pre-midnight dry run that races the open but never books).

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

| Variable            | Meaning                                                      |
|---------------------|--------------------------------------------------------------|
| `BOOKING_BASE_URL`  | The scheduling page to automate                              |
| `BOOKING_FACILITY`  | Facility/court group in the page URL                         |
| `OPEN_TIME`         | Local time the booking window opens (e.g. `00:00`)           |
| `DAYS_AHEAD`        | Booking lead — how many days out the target date is          |
| `OPEN_WINDOW_DAYS`  | How many dates the site serves at once (default `14`)        |
| `PRE_OPEN_MS`       | How long before the open time to start pre-selecting         |
| `WALLET_PIN`        | Your 6-digit checkout PIN (local only)                       |
| `BOOKER_*`          | Name / phone / email for the booking form                    |
| `HEADLESS`          | `false` shows the browser window (recommended)               |

## Usage (v2 — default)

The v2 flow is two steps: **pick** once, then **run**.

```bash
npm run pick               # build your ranked court blocks on the real page,
                           #   then press the green "✓ Save selection" button
npm run book               # official run: waits until ~3 min before the open time,
                           #   replays your pick, fires Confirm at the open moment
npm run book -- --courts 2 # same, but book up to 2 courts this run (overrides the
                           #   saved default)
npm run test-book          # mechanics dry run: ~10s countdown + dummy PIN, replayed
                           #   against the latest same-weekday open date
npm run test-open          # REAL pre-midnight dry run: races the actual open on the
                           #   real target date, parks at Confirm, never books
npm run now                # replay your pick immediately (live test)
```

**How pick works:** the browser opens on the booking page, on the latest already
open date that shares your target's weekday (the real target is usually past the
bookable window). In the corner panel:

- **Target date** — the date you'll actually book (defaults to the one that opens
  at the next midnight). Changing it re-navigates to the matching reference date.
- **Click a court's hours in priority order** — free *or* already-taken cells
  both work (a slot taken today may be free on the target date). Clicks group into
  one **block per court**, ranked by the order you first click each court.
- **Per-court minimum** — each court shows "take only if ≥ N consecutive hrs
  free". Default = all its hours (strict / all-or-nothing); lower it so a backup
  court will take a shorter run (e.g. 2h).
- **Courts to book** — how many courts to grab in a run (saved as your default).

Press **✓ Save selection** and the bot records your target date, shift, ranked
court blocks, per-court minimums, and courts-to-book to `v2/selection.json`.

**At the open**, the run reads the whole grid in one pass and books, in priority
order, up to your courts-to-book count — each court taking its longest consecutive
free run that meets its minimum, skipping any court that can't.

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

### v2.1.0 — ranked court blocks & multi-court (current)

- **Ranked court blocks.** Pick replaced the single fixed selection with a
  priority-ordered list of courts, each a block of consecutive hours booked
  all-or-nothing (or down to a per-court minimum).
- **Multi-court.** Book more than one court per run — set a default while picking
  or override with `npm run book -- --courts N`.
- **Future-date picking.** The target date can be past the bookable window; you
  pick against the latest open date of the same weekday. Click **taken** cells too
  (time is read from the grid's column header).
- **`test-open`.** A real pre-midnight dry run that races the actual open on the
  real target date and parks at Confirm without booking.
- **Faster retries.** Removed a 30s stall when the date is still closed, so the
  run catches the open within one loop tick.

### v2.0.0 — visual pick flow

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
