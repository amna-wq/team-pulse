# November invites dead — tokens table lost through the Sheet mirror

Date: 2026-11-27 · Branch: `fix/sheet-mirror-never-blank` · Base: `afffc7a` (master)

## Business impact

The November pulse went out to all 23 people at 09:00:44 PKT (send record: 23, all
23 stamped, 0 delivery failures), but every link shows "This link isn't valid".
Nobody can submit. Unless links are re-issued before the window closes
(29 Nov 09:00 PKT), November reports nothing — a second lost month after October's
4/24. Survey answers themselves are intact (Aug 15 / Sep 14 / Oct 14 responses).

## What was found (receipts)

- Live prod, 2026-11-27 22:17 PKT: `/api/meta` window open (auto, 2026-11);
  `/api/admin/recipients` → `lastSend {cycle 2026-11, sent_at 2026-11-27T04:00:44Z, sent_count 23}`,
  `tokens issued 0 / opened 0 / used 0`, 23/23 stamped today, failures none.
- `/api/admin/overview?cycle=…` → tokens issued **0 for every cycle** (2026-08..11);
  responses 15 / 14 / 14 / 0.
- Google Sheet `tokens` tab: **no rows, no header** (values empty).
  `email_log`, `recipients`, `responses` tabs intact.
- Revision bisect of the Sheet (Drive export per revision): tokens tab had 64 rows at
  rev 2397, 88 at 5776, **115 at 7466 and 8311** (= Aug 64 + Sep 24 + Oct 27), **0 at
  8731** and every later revision. Loss happened between rev 8311 and 8731; the only
  listed revisions after 29 Oct are all on 2026-11-27 and all show 0.
- Cloud Run logs for the send: **not read** — `gcloud` auth expired mid-investigation
  (non-interactive session cannot re-login). The exact first failure at ~09:00 is
  therefore unverified.

## Root cause (code, `src/sheets.js` @ afffc7a)

1. **Clear-then-write** (`syncTable`, lines 146-153): the tab is cleared with one API
   call and rewritten with a second. A failure between them leaves the tab blank.
2. **Blank tab treated as a failed merge** (`absorbSheetRows`, line 96:
   `if (!header || !rows.length) return;` → `undefined`), and `syncTable` aborts the
   write on a falsy merge result ("write ABORTED — refusing to overwrite the sheet
   with an unmerged view"). Once the tokens tab was blank, **no instance could ever
   write tokens again**, and every cold boot restored zero tokens. The 23 tokens
   minted this morning lived only in the sending instance's memory-backed DB and
   died with it.

Chain: blank tab (1) → permanent abort (2) → cold boot restores 0 → all links dead.

## Fix

- `absorbSheetRows`: an empty tab is a successful (no-op) merge → returns `true`.
- `syncTable`: **write first, then clear only the stale tail** (`A<n+1>:ZZ`). A failure
  at any point leaves either the old rows or the new rows on the tab — never blank.
- `POST /api/admin/invites/resend` (new, admin, window must be open): clears the
  per-recipient sent-stamps and runs the normal send; the once-per-cycle claim stays.
  Optional `notice` is printed at the top of the invite email (`renderInviteEmail`,
  `inviteText`), HTML-escaped, so the team knows why a second email arrived.

## Verification

Against a throwaway **TEST COPY** spreadsheet (`1NyW8UBBlsTncnvR12xnqfFTYLPeotorzh2t1_G2WwE8`),
isolated `DATA_DIR`, `DEMO_MODE=false`:
```
PASS  write: tokens tab has 2 rows
PASS  write: recipients tab has 3 rows
PASS  setup: tokens tab blanked (no header)
PASS  refill: blank tab refilled from DB (2 rows)        <- the exact failure
PASS  shrink: recipients tab shows 2 rows, no stale tail
PASS  union: sheet-only token absorbed into DB
PASS  union: tokens tab now 3 rows
PASS  restore: ran
PASS  restore: 3 tokens back in DB
```
Email template:
```
PASS  notice renders at top of email, HTML-escaped
PASS  no notice box when notice is absent
```
`node --check` clean on server.js, src/mailer.js, src/sheets.js.

## Production logs (read after re-auth) — confirms the chain

```
04:00:44  [sheets] restored 69 rows          <- zero tokens: the tab was already blank
04:00:54  [sheets] tokens write ABORTED — refusing to overwrite the sheet with an unmerged view
04:00:56  [auto-email] 2026-11: sent 23 invites
04:05:46 / 04:10:48 / 04:15:46  tokens write ABORTED (every 5-min sync)
```

## Production execution — 2026-11-27 (builds e54f7a34 → 39eee980, with review fixes)

Roster updated by Amna to 24 (−mirela, +attila, +nicola; titles refreshed), deployed in
the same revision. Verification before resending:
```
roster: 24 | mirela gone: True | attila+nicola present: True
window: open=True mode=auto closes=2026-11-29T04:00:00Z
minted 1 test token -> SHEET tokens tab: header id,token_hash,cycle,used,opened | rows = 1
link valid before restart: valid=True
forced cold restart -> after restart: valid=True  <-- PERSISTED ; tokens in DB: 1
```
Resend (Amna: "go"), notice: "Quick fix: if you got a Team Pulse email this morning,
that link did not work — this one does. Same 3 minutes, same anonymity. Sorry for the
double email."
```
POST /api/admin/invites/resend -> {"ok":true,"cycle":"2026-11","newLinks":24,"sent":24,"failed":[]}
links this cycle in DB: 25 (24 + 1 test) | SHEET tokens tab rows: 25
```
One stray unused test token remains for 2026-11 (raw value never shared); it expires
with the window.

## Not verified / open

- Delivery into inboxes (Gmail Sent folder is the audit source).
- The original blanking event (between Sheet rev 8311 and 8731, i.e. between 29 Oct and
  27 Nov 09:00) has no log receipt — only its consequence is logged.

## Rollback

Code: revert the PR. The resend endpoint is admin-only and inert unless called.
