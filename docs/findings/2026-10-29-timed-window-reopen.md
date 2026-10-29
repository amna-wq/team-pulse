# Timed window reopen — October 2026 second chance for 3 new teammates

Date: 2026-10-29 · Branch: `feat/timed-window-override` · Base commit: `7613de3`

## Task (business goal)

Three teammates added to the roster on 2026-10-29 (Mustafa Shabbir, Hamza Munir,
Waleed Sultan) never received the October invite (sent 2026-10-27 09:00 PKT, window
closed 2026-10-29 09:00 PKT). Amna's decision: reopen October until 30 Oct 23:59 PKT,
email only those 3, and let the other 20's existing links simply work again (no
reminder email). Supports: October team-health read for Khalid; currently 4/24
responses, below the 5-response reporting floor.

## Current behaviour + evidence (before change)

- Override has no expiry: `src/cycle.js:19-32` (`getOverride` returns a bare state,
  `setOverride(cycle, state)`), so "close on the 30th" would be a manual step.
- Window close time is always the automatic one: `src/cycle.js:39,53` — with a plain
  override the invite email would print the already-past 29 Oct deadline
  (`src/mailer.js:121-123,174-175` render `closes` from `windowState()`).
- Email header also hardcodes "closes in 48 hours": `src/mailer.js:152`.
- Send routine only emails people with no stamp since the window opened
  (`pendingEmails` in `autoEmailTick`, `server.js`), so a tick during the reopen
  sends to exactly the 3 unstamped people. Prod roster check 2026-10-29: 20 of 23
  stamped `2026-10-27`, 3 `never`, 0 delivery failures.

## Change (smallest safe design)

- `src/cycle.js`: `getOverride(cycle, now)` returns `{state, until}` and treats an
  expired `until` as no override; `setOverride(cycle, state, until)`; `windowState`
  reports `closes = until` while a timed open override is active.
- `src/db.js`: `window_overrides.until TEXT` (fresh installs); `server.js` migration
  `ALTER TABLE window_overrides ADD COLUMN until TEXT` (existing DBs).
- `server.js` `POST /api/admin/window`: optional `until` (ISO; must parse; must be in
  the future) → 400 otherwise.
- `src/mailer.js:152`: header line prints the real deadline when known.
- Out of scope: reminder emails to existing invitees; dashboard UI for overrides.

## Verification

Unit (fixed clocks, isolated DATA_DIR, `DEMO_MODE=false`):
```
PASS  during: open
PASS  during: mode=override
PASS  during: closes == until
PASS  after:  closed
PASS  after:  mode=auto (expired)
PASS  after:  closes back to 29 Oct 09:00 PKT
PASS  cleared: auto + closed
```
Live HTTP on a throwaway local instance (port 8091, isolated data + export dirs):
```
1) before: open= False mode= auto
2) open until 30 Oct 23:59 PKT -> open= True mode= override closes= 2026-10-30T18:59:00.000Z
3) email preview: "closes Friday, October 30 at 11:59 PM" (header) / "Closes Friday, October 30 at 11:59 PM" (badge)
4) until in the past -> HTTP 400
5) garbage until -> HTTP 400
6) clear -> open= False mode= auto
```

## Production runbook (after deploy)

1. `POST /api/admin/window {state:'open', until:'2026-10-30T18:59:00Z'}` (= 30 Oct 23:59 PKT).
2. `POST /api/cron/tick` once → expect exactly 3 invites (tokens 24 → 27, send_count 24 → 27).
3. Verify: `/api/meta` open+override+closes; roster shows the 3 stamped today, nobody else re-stamped.
4. Nothing to do on the 30th: the override expires by itself.

Rollback: `POST /api/admin/window {state:null}` → window reverts to closed immediately.
Code rollback: revert the PR; the extra column is harmless.

## Not verified / open

- Prod execution results are recorded below once run.
- Anonymity caveat (accepted by Amna): with only 3 people invited into a 1-day reopen,
  any late October rows are attributable to that group of 3, not to an individual.
- Sheet mirror of `window_overrides` gains a column; not exercised locally (no Google
  creds in the test instance).
