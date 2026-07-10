# Team Pulse & Feedback

A monthly **anonymous** survey that measures team health and surfaces problems —
process, workload, communication, tools. It is **not** a tool for rating or
ranking people, and it is built so it *can't* become one.

- **Survey** — 6 sliders (1–10), 2 dropdowns, one open text box, a **private
  concerns box** (can be about anyone or anything; goes to management only,
  never to the team, with an "urgent" flag), and optional upward feedback for
  management (start/stop/continue).
- **Admin dashboard** — password-gated, shows **aggregates only**: averages,
  month-over-month trends, dropdown distributions, and anonymous comments.
- **Team summary** — top 3 themes + one action management commits to. This is
  the only output shared with the whole team.

## Quick start (demo for your manager)

```bash
npm install
npm run demo        # seeds 5 months of fake data and starts in demo mode
```

Then open:

- **Dashboard:** http://localhost:8080/admin — password `demo-admin` (or whatever
  `ADMIN_PASSWORD` you set in `.env` — copy `.env.example` to `.env` to configure;
  `.env` is loaded automatically by `npm start` and `npm run demo`)
- **Survey:** the seed prints a few unused demo links (`/s/<token>`) — submit one live
- **Team summary:** http://localhost:8080/summary

Demo mode forces the survey window open and shows a "fake data" banner
everywhere. `npm run seed` reseeds at any time.

Requires **Node 24+** (uses the built-in `node:sqlite` — no native modules, no
external database).

## The anonymity model (read this, verify this)

**One response per person, but no way to know whose response is whose.** Here is
exactly how, so any employee can check the code rather than take our word:

1. **Single-use anonymous links.** Each month the admin generates N random
   tokens — one link per person. The raw token appears **once** on the admin's
   screen and is never stored; the database keeps only a SHA-256 **hash** and a
   `used` flag ([src/db.js](src/db.js), `tokens` table).
2. **No bridge between token and answers.** On submit, the app does exactly two
   writes in one transaction: flip the token's `used` flag, and insert the
   response **with no reference to the token**
   ([server.js](server.js), `/api/survey/submit`). The `responses` table has no
   token column, no user column — and **no timestamp**, only the cycle month, so
   answers can't be correlated against when a token was redeemed (`used_at` is
   deliberately not recorded either).
3. **No edits, no individual views.** A used link stops working (409). There is
   no API that returns a single response; the dashboard endpoints return
   aggregates and shuffled comment lists only. Comments are re-shuffled on every
   read so display order never leaks submission order.
4. **Anonymity floor.** Aggregates stay hidden until a month has at least
   `MIN_RESPONSES_TO_SHOW` (default 5) responses — an "average" of 2 people is
   nearly an individual answer.
5. **What *is* visible to the admin:** how many links were used (participation
   count) and the anonymous aggregate results. That's the entire surface.

**Residual limits, stated honestly:** the admin knows who they *sent* each link
to (distribution happens over email/Slack, outside this app), and someone
watching the raw database file in real time during the 48-hour window could
observe rows appearing. Writing style in free-text comments can also identify
people on a small team — that is inherent to any free-text survey. The
mitigation is the schema: even with full DB access after the fact, there is
nothing to join.

## Why aggregates only — the hard rule

This app measures the **system** (process, workload, communication, tools), not
people. Per-person scores on a 15–20 person team would turn a health check into
a surveillance tool and kill honest answers within two cycles.

Enforced in code, not just policy:

- Pulse survey responses reference no person anywhere. (The only person roster
  in the schema belongs to the gated Phase 2 peer module, is unused while that
  module is off, and is never touched by Pulse.)
- No API returns an individual response.
- Survey questions are about the respondent's own experience of the system —
  there is no question that names or rates a colleague.
- The app cannot answer "who is the most annoying" because that data is never
  collected, never stored, and has no query path.

## The monthly cycle

1. **Window opens automatically** at 09:00 on the **last Monday of each month**
   (always inside the final week) and **locks 48 hours later**. Admin can force
   it open/closed from the dashboard (useful for demos or extending a window).
2. **Before the window:** admin generates one link per person on the dashboard
   and DMs/emails each person one link.
3. **During the 48 hours:** each link accepts exactly one submission. No
   editing, no viewing after submit.
4. **After the window:** admin reviews aggregates, clicks **"Generate draft
   themes from data"** (auto-drafts top 3 themes from the lowest slider, the
   top blocker/process, and recurring comment keywords), edits them, records
   **one action** management commits to, and hits **Publish**.
5. **Everyone** sees the published themes + action at `/summary`. Never
   individual responses.

## Deployment (Cloud Run)

```bash
gcloud run deploy team-pulse \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --set-env-vars ADMIN_PASSWORD=<strong-password>,SESSION_SECRET=<random-hex>
```

SQLite notes for Cloud Run:

- Keep `--max-instances 1` — SQLite is single-writer, one instance is plenty
  for 20 people.
- The container filesystem is **in-memory and ephemeral**: mount a persistent
  volume for `/app/data` (Cloud Run volume mounts with a GCS bucket:
  `--add-volume name=data,type=cloud-storage,bucket=<bucket> --add-volume-mount volume=data,mount-path=/app/data`)
  or the database resets on every new revision/instance.
- Alternatively set `DATA_DIR` and point it anywhere durable. If you outgrow
  this, the schema ports to Postgres almost 1:1.

Any Node 24 host works the same way: `ADMIN_PASSWORD=... node server.js`.

### Environment variables

See [.env.example](.env.example). `ADMIN_PASSWORD` is required (the server
refuses to start without it outside demo mode).

## Email invites (automatic monthly sending)

Save the team's emails once in the admin dashboard ("📮 Email invites"). Then:

- **Automatic:** with `AUTO_EMAIL=true`, the moment the monthly window opens,
  every saved address is emailed a cute HTML invite containing their own
  single-use link. One send per cycle (tracked in `email_log`), never in demo
  mode.
- **Manual:** "Send invites to everyone now", plus a single-address test send
  and a live preview at `/admin/email-preview`.

**Sending — easiest path (no mail-server access needed):** put your Google
OAuth `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env`, restart, and click
**"Connect Gmail"** once on the dashboard. Invites then send from your own
Gmail account (OAuth `gmail.send` scope only — the app can send, never read
your mail). Disconnect any time from the dashboard or at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Alternative: any classic SMTP provider via `SMTP_*` in `.env`
(see [.env.example](.env.example)).

**Anonymity:** each link is generated, emailed, and immediately forgotten
([src/mailer.js](src/mailer.js)) — the DB stores the email roster and hashed
tokens in unrelated tables with no mapping between them. Honest caveat: the
mail *server* (e.g. Google) inevitably has the sent emails, including which
link went to whom, in its own logs/sent folder. Someone with access to the
sending mailbox could look a link up — so use a dedicated sending account, or
distribute links by hand for maximum paranoia. The app itself keeps nothing.

The email's animations (floating emoji, fade-in) play in Apple Mail and iOS
Mail; Gmail and Outlook show a static version of the same design.

## The private Concerns channel

The survey includes a "🔒 Private concern" box: *is someone or something making
work hard for you?* It exists so a junior person, or anyone who feels like the
odd one out, can say "this person's behavior is hurting me" without saying it
out loud. Rules, enforced in code:

- Delivered **only to the admin dashboard** (management). It never appears on
  the team summary and there is no API that exposes it publicly.
- Same anonymity as everything else: no author, no timestamp, shuffled order,
  hidden below the anonymity floor.
- An **"urgent" flag** pins a concern to the top of the management view.
- It is a *listening* channel, not a rating: free text only, one direction,
  read by humans who can act. What management does with a concern (a quiet
  conversation, a policy change) happens outside the app — the app's job is to
  make raising it safe.

## Phase 2 — peer feedback module (built, but OFF by default)

[src/phase2-peer-feedback.js](src/phase2-peer-feedback.js) implements
structured **peer feedback**: start/stop/continue *in words* about working with
each colleague (management included — anyone on the roster can receive
feedback), collected via single-use anonymous links (`/p/<token>`), delivered
**privately to each individual + their manager only** via the admin's
per-person delivery view.

It returns 403 until `MANAGEMENT_SPONSORED=true`. **Leave it off unless
leadership formally sponsors a 360 process** (in writing, with rules for who
sees what). Peer feedback without that sponsorship becomes anonymous criticism
of colleagues — the exact thing the Pulse survey promises not to be.

Deliberate constraints, enforced by schema and API — not just policy:

- **Words only.** `peer_feedback` has no numeric columns, so per-person scores,
  rankings, or "most annoying" style leaderboards are structurally impossible.
- **Anonymous givers.** Same token model as Pulse: hash + used flag, no author,
  no timestamp on feedback rows.
- **Per-person delivery only.** The only read API returns feedback *about one
  person* for the manager to pass on privately. There is no cross-person
  comparison view, and nothing from this module ever reaches the team summary
  or the Pulse dashboard.

Why no anonymous person-ratings, ever: on a 15–20 person team, "rate your
colleagues" becomes a popularity contest that punishes exactly the people the
survey is meant to protect, and publishing any of it teaches everyone that the
survey can hurt them — which kills honest answers for good. Behavior-specific
words a person can act on; scores they can only be wounded by.

## Project layout

```
server.js                     Express app: survey, admin, summary APIs
src/db.js                     Schema — read the anonymity comments here
src/cycle.js                  Monthly window logic (last Monday, 48h)
src/questions.js              Survey content (single source of truth)
src/themes.js                 Heuristic draft-theme generation
src/phase2-peer-feedback.js   Gated Phase 2 stub
public/                       Mobile-friendly vanilla frontend
seed.js                       Fake data for demos
```
