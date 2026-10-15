# Trip Split

A shared-expense tracker for a group — split costs, see who owes who, and settle up with both sides agreeing before any balance changes.

**Live:** https://danish-ahmed-head.github.io/trip-split/

## What it does

- Add expenses and split them across whoever was there (evenly or unequally, see below)
- See a live, auto-simplified "settle up" plan (minimum number of payments to zero everyone out)
- A private **Balance Sheet** per person — itemized Assets (who owes you, how much, for what) and Liabilities (what you owe, to whom, for what)
- **Two-step settlements**: the payer marks "I paid," and only the person who was actually paid can confirm or dispute it. Nobody else can, not even the trip owner
- Full audit trail: every add, edit, delete, and settlement confirmation records who and when
- Categories on every expense, a spending-by-category breakdown on Home, and ledger search plus category and date-range filters
- Repeating expenses (weekly or monthly): the next time anyone opens the app, due occurrences are added once each. There is no background scheduler, so nothing is added while nobody opens the app; it catches up on the next open.
- Close a trip when it's finished (owner only): no new expenses, settling up still works, reopen any time. Enforced by the security rules, not just the screen.
- Unequal splits: equally, by exact amounts, by percentage, or by shares (e.g. 2 : 1). Amounts always add up to the total to the cent.
- Receipt photos: attach a photo to an expense. It is shrunk to a small JPEG and kept in its own document, fetched only when opened; visible to trip members only.
- Payment details and "How to pay": each member can save their JazzCash / Easypaisa number and Raast ID / IBAN. The person who owes sees them with Copy buttons on their settle-up row, then pays in their own banking or wallet app and taps Mark paid. Trip Split never moves money.
- Share on WhatsApp: the trip summary, or a "I'm paying you" message from the How-to-pay sheet.
- Alerts: a browser notification when someone adds an expense that involves you, marks a payment to you, or confirms or disputes yours. They work while the app is open; with closed-app alerts set up (below) they also arrive when it is closed, usually within about 5 to 10 minutes.
- Trip switcher: tap the trip name to jump between every trip you've opened, with what you are owed or owe in each one
- Installable: use "Add to Home Screen" / "Install" in your browser for an app-style launcher (web app manifest and icons; no offline page caching beyond what Firestore stores)
- Multiple trips from one app, each with its own shareable link
- Works offline: with no signal, a save is kept on the phone and syncs automatically once you're back online
- Export the ledger as CSV or a text summary

## Who can do what

Trips are private and invite-only. Everything below is enforced server-side by [`firestore.rules`](firestore.rules), not just hidden in the UI.

- **Joining.** The trip owner adds each person by name, then taps **Invite** and types that person's Gmail. Only that Google account can link to that name. Anyone else who opens the link sees "You're not on this trip yet" and can read nothing.
- **Members** add expenses as themselves, edit or delete their own entries, rename themselves, and save their own payment details.
- **Settlements.** Only the payer can mark a payment, always to one other person. Only the person paid can confirm or dispute it.
- **The owner** adds and renames people, invites and unlinks Google accounts, edits or deletes any expense, withdraws unconfirmed settlements, and changes trip settings. The owner cannot confirm or dispute a payment for someone else.
- **Unlinking** takes effect at once: a removed account's old link stops working.

What the owner can still do, by design: they decide which Gmail is invited to which name, so a group has to trust its owner with that.

## Tech stack

Deliberately minimal — a single `index.html` (vanilla JS, ES modules, no build step, no framework) backed by Firebase:

- **Firebase Authentication** — Google Sign-In
- **Cloud Firestore** — the only data store, with offline persistence enabled
- **Firestore Security Rules** — the actual authorization boundary (see `firestore.rules`)
- **GitHub Pages** — static hosting, auto-deploys on push to `main`

Runs entirely on Firebase's free Spark plan. No backend server.

## Closed-app alerts, still free

Cloud Functions would need the paid Firebase plan, so a scheduled GitHub Actions job does the sending instead:

1. Whoever does something (adds an expense, marks paid, confirms, disputes) writes a small marker to `pushEvents`. It holds no text and no recipient.
2. Every 5 minutes a free Cloudflare Worker (`cloudflare/dispatch-worker.js`) starts `.github/workflows/push.yml`, which runs `scripts/send-push.mjs`. GitHub's own scheduler is kept as an hourly backup only: on a quiet repo it ran this job just every 3 to 7 hours. For each new marker it reads the expense, works out who is involved and what to say (`push/plan.js`), and sends through Firebase Cloud Messaging, which is free.
3. `firebase-messaging-sw.js` shows the notification. It caches nothing.

One-time setup:

1. Repository secret `FIREBASE_SERVICE_ACCOUNT`: a service-account JSON from Firebase console, Project settings, Service accounts. Until it exists the job exits cleanly and does nothing.
2. The Cloudflare Worker: paste `cloudflare/dispatch-worker.js` into a new Worker (free plan), add a secret `GH_TOKEN` (a fine-grained GitHub token for this repo only, "Actions: Read and write"), and a cron trigger `*/5 * * * *`.

The public web-push key is already in `index.html`.

Limits:
- Alerts take up to about 5 to 10 minutes; without the Worker, hours.
- GitHub pauses its own scheduled workflows on a public repo after 60 days with no activity. The Worker isn't affected.
- On iPhone the app must be added to the Home Screen first.
- The job retries a failing alert up to 5 times, then gives up and logs why.

## Tests

```bash
npm install
npm test            # unit tests: balances, splits, settle-up, filters, recurrence, alert planning (no Java needed)
npm run test:rules  # Security Rules attack tests and a full alert-job sweep against the Firestore emulator (needs Java 21)
```

Both run in GitHub Actions on every push to `main` and on every pull request (`.github/workflows/test.yml`). `logic.js` holds the pure logic so it can be tested outside the browser; `index.html` imports it.

## Local development

No build step — just serve the folder and open it:

```bash
python -m http.server 8743
# or: npx serve .
```

Then open `http://localhost:8743`. The Firebase config in `index.html` points at the live project, so local testing talks to real (shared) data — use "Start a new trip" from the People tab to get an isolated sandbox rather than testing against the live default trip.

## Deployment

Pushing to `main` auto-deploys `index.html` via GitHub Pages — there's no separate build artifact.

Firestore rules are **not** deployed automatically. After changing `firestore.rules`, paste its contents into Firebase Console → Firestore Database → Rules (project `spark-610ee`) and publish, or use the Firebase CLI:

```bash
firebase deploy --only firestore:rules
```

Keep the repo's `firestore.rules` and what's actually published in the console in sync — they drifted out of sync once already (see the Engineering doc's Test Plan tab, "Production rollout findings").

## Documentation

This project has living documentation written up as docs, not just this file:

- **Product & Market Strategy** — market sizing, competitive landscape, SWOT, full feature roadmap by phase
- **Engineering & SDLC Documentation** — SDLC process, SRS (requirements), SDD (design), and Test Plan, including real findings from production testing
- **Financial Statements (IFRS)** — balance sheet for the project itself

Ask whoever's maintaining this for the current links, or check the session history — they're Claude-authored docs, not files in this repo.

## Project status

Phase 1 (real auth, authorization, two-step settlements, balance sheet) is live. A second Google account was tested live on 2026-10-12 (claim, refused forgeries, own payment details).

Phase 2 shipped 2026-10-10: categories, filters, repeating expenses, in-app alerts, trip switcher, installable manifest, server-enforced closed trips, and automated tests.

Phase 3 shipped 2026-10-12: unequal splits, receipt photos, payment details with a How-to-pay helper, and WhatsApp sharing.

Phase 4 (2026-10-12): per-trip balances in the trip switcher, and closed-app alerts through Firebase Cloud Messaging sent by a scheduled GitHub job, so it stays on free tiers.

Security fixes (2026-10-15): an audit found that any Google account could read every trip, claim an unclaimed name, plant script through record ids, and create fake debts. Fixed by invite-only trips, rules that check both sides of every link, settlements limited to one other person, plausibility checks on split shares, and escaping every id in the page. The owner can no longer confirm payments for others.

Deliberately not built: real payment-rail integration (JazzCash/Easypaisa/Raast APIs need merchant onboarding, fees and a server, so the app stores payment details and guides the payer instead).
