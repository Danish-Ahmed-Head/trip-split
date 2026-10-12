// Entry point for the scheduled GitHub Actions job (.github/workflows/push.yml).
// Needs FIREBASE_SERVICE_ACCOUNT (the service-account JSON) as an env var.
// Exits cleanly when it isn't set, so the workflow is harmless until configured.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { runPush } from "../push/run.js";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw || !raw.trim()) {
  console.log("FIREBASE_SERVICE_ACCOUNT is not set: background alerts are not configured, nothing to do.");
  process.exit(0);
}

let credentials;
try { credentials = JSON.parse(raw); }
catch { console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON."); process.exit(1); }

const app = initializeApp({ credential: cert(credentials) });
const report = await runPush({
  db: getFirestore(app),
  messaging: getMessaging(app),
  dryRun: process.env.DRY_RUN === "1",
});
console.log("push sweep:", JSON.stringify(report));
