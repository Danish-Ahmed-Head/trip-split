# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trip Split: a shared-expense tracker (split costs, settle up with two-step confirmation). Static single-page app on GitHub Pages, backed by Firebase Auth (Google Sign-In) and Cloud Firestore. No backend server, no build step. Everything is designed to stay on free tiers (Firebase Spark plan, GitHub Actions); do not introduce Cloud Functions or other paid-plan features.

## Commands

```bash
npm install
npm test             # node --test on tests/logic.test.mjs + tests/push.test.mjs (no Java needed)
npm run test:rules   # Firestore emulator via firebase emulators:exec; runs tests/rules.test.mjs + tests/sweep.test.mjs (needs Java 11+, port 8080)
npm run test:all     # both
npm run push:sweep   # node scripts/send-push.mjs (needs FIREBASE_SERVICE_ACCOUNT; DRY_RUN=1 to preview)
node --test --test-name-pattern="<name>" tests/logic.test.mjs   # single test
python -m http.server 8743   # serve the app locally (or npx serve .)
```

No lint or build scripts exist. CI (`.github/workflows/test.yml`) runs `npm test` and `npm run test:rules` on push to `main` and on PRs.

## Architecture

- **`index.html`** (~110 KB) holds all UI, styles and app code as one `<script type="module">`. It imports `./logic.js` as `L` and loads the Firebase web SDK from gstatic CDN URLs (not from `node_modules`). The Firebase config points at the live project `spark-610ee`, so local runs hit real shared data; use "Start a new trip" for a sandbox.
- **`logic.js`** is the pure, DOM-free and Firebase-free core: balances, settle-up minimisation, split building (`buildShares`: equal/exact/percent/shares, remainder goes to the largest share so parts sum to the total), filters, recurrence. Keep logic here so it stays unit-testable; `index.html` only binds it to live data. A settlement counts toward balances only once `confirmedBy` is set.
- **`firestore.rules`** is the real authorization boundary (UI checks are cosmetic): account-to-member linking via `memberLinks`, only the addressee can confirm/dispute a settlement, only the owner edits trip settings or others' entries, closed trips reject new expenses. Data is duplicated in two layouts: the legacy default trip at top-level collections (`members`, `expenses`, `settings/trip`, ...) and every other trip under `trips/{tripId}/...`. A rules change usually needs to be made in both blocks, and in `push/run.js` `tripPaths`.
- **Closed-app alerts** (replaces Cloud Functions): clients write contentless markers to `pushEvents`; the scheduled `.github/workflows/push.yml` (every 5 min) runs `scripts/send-push.mjs` -> `push/run.js` (find unprocessed events, send via FCM, mark done) -> `push/plan.js` (pure: re-derives recipients and text from the expense itself, so a client cannot forge an alert). `firebase-messaging-sw.js` displays them and caches nothing. Without the `FIREBASE_SERVICE_ACCOUNT` secret the job exits cleanly. The workflow is gated to `Danish-Ahmed-Head/trip-split`.
- **Tests**: `logic.test.mjs` and `push.test.mjs` are plain unit tests. `rules.test.mjs` and `sweep.test.mjs` read `firestore.rules` from disk and run against the emulator with project `demo-trip-split`.

## Deployment gotchas

- Pushing to `main` auto-deploys the static files via GitHub Pages.
- **`firestore.rules` is not auto-deployed.** After changing it, publish via Firebase Console (project `spark-610ee`) or `firebase deploy --only firestore:rules`. The repo copy and the published rules have drifted before.
- Repeating expenses are materialised client-side on app open (no scheduler); alerts are near-real-time, delayed by GitHub's cron.
- Payment details (JazzCash/Easypaisa/Raast) are stored and shown only; the app never moves money.
