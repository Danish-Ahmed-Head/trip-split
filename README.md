# Trip Split

A shared-expense tracker for a group — split costs, see who owes who, and settle up with both sides agreeing before any balance changes.

**Live:** https://danish-ahmed-head.github.io/trip-split/

## What it does

- Add expenses and split them evenly across whoever was there
- See a live, auto-simplified "settle up" plan (minimum number of payments to zero everyone out)
- A private **Balance Sheet** per person — itemized Assets (who owes you, how much, for what) and Liabilities (what you owe, to whom, for what)
- **Two-step settlements**: the payer marks "I paid," and only the person who was actually paid can confirm it — no one can clear a debt on someone else's behalf
- Full audit trail: every add, edit, delete, and settlement confirmation records who and when
- Categories on every expense, a spending-by-category breakdown on Home, and ledger search plus category and date-range filters
- Repeating expenses (weekly or monthly): the next time anyone opens the app, due occurrences are added once each. There is no background scheduler, so nothing is added while nobody opens the app; it catches up on the next open.
- Close a trip when it's finished (owner only): no new expenses, settling up still works, reopen any time. Enforced by the security rules, not just the screen.
- Unequal splits: equally, by exact amounts, by percentage, or by shares (e.g. 2 : 1). Amounts always add up to the total to the cent.
- Receipt photos: attach a photo to an expense. It is shrunk to a small JPEG and kept in its own document, fetched only when opened; visible to trip members only.
- Payment details and "How to pay": each member can save their JazzCash / Easypaisa number and Raast ID / IBAN. The person who owes sees them with Copy buttons on their settle-up row, then pays in their own banking or wallet app and taps Mark paid. Trip Split never moves money.
- Share on WhatsApp: the trip summary, or a "I'm paying you" message from the How-to-pay sheet.
- Alerts: a browser notification when someone adds an expense that involves you, marks a payment to you, or confirms or disputes yours. They work while the app is open; with closed-app alerts set up (below) they also arrive when it is closed, within a few minutes.
- Trip switcher: tap the trip name to jump between every trip you've opened, with what you are owed or owe in each one
- Installable: use "Add to Home Screen" / "Install" in your browser for an app-style launcher (web app manifest and icons; no offline page caching beyond what Firestore stores)
- Multiple trips from one app, each with its own shareable link
- Works offline — expenses added with no signal sync automatically once you're back online
- Export the ledger as CSV or a text summary

## Who can do what

Identity is tied to a real Google account (Google Sign-In), not just a name you tap. The first time you sign in, you link your account to your name in that trip — after that, only you can add expenses as yourself, only the person a settlement is addressed to can confirm or dispute it, and only the trip owner can edit trip settings or other people's entries. All of this is enforced server-side by [`firestore.rules`](firestore.rules), not just hidden in the UI.

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
2. Every 5 minutes `.github/workflows/push.yml` runs `scripts/send-push.mjs`. For each new marker it reads the expense, works out who is involved and what to say (`push/plan.js`), and sends through Firebase Cloud Messaging, which is free.
3. `firebase-messaging-sw.js` shows the notification. It caches nothing.

One-time setup: add the repository secret `FIREBASE_SERVICE_ACCOUNT` (a service-account JSON from Firebase console, Project settings, Service accounts). Until it exists the job exits cleanly and does nothing. The public web-push key is already in `index.html`.

Limits: GitHub may delay a scheduled run by a few minutes, so alerts are near-real-time rather than instant. GitHub pauses scheduled workflows on a public repo after 60 days with no repository activity. On iPhone the app must be added to the Home Screen first.

## Tests

```bash
npm install
npm test            # unit tests: balances, splits, settle-up, filters, recurrence, alert planning (no Java needed)
npm run test:rules  # Security Rules tests and a full alert-job sweep against the Firestore emulator (needs Java 11+)
```

Both run on every push in GitHub Actions (`.github/workflows/test.yml`). `logic.js` holds the pure logic so it can be tested outside the browser; `index.html` imports it.

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

Phase 1 (real auth, authorization, two-step settlements, balance sheet) is live and verified with one real account. Not yet verified: a second real account going through sign-in → claim → confirm, and the negative-case authorization checks (can someone confirm a settlement that isn't theirs, edit someone else's expense, etc.) against a second identity. See the Test Plan tab for the open items.

Phase 2 shipped 2026-10-10: categories, filters, repeating expenses, in-app alerts, trip switcher, installable manifest, server-enforced closed trips, and automated tests.

Phase 3 shipped 2026-10-12: unequal splits, receipt photos, payment details with a How-to-pay helper, and WhatsApp sharing.

Phase 4 (2026-10-12): per-trip balances in the trip switcher, and closed-app alerts through Firebase Cloud Messaging sent by a scheduled GitHub job, so it stays on free tiers.

Deliberately not built: real payment-rail integration (JazzCash/Easypaisa/Raast APIs need merchant onboarding, fees and a server, so the app stores payment details and guides the payer instead).
