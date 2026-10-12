// One sweep of the alert job: find unprocessed events, work out who to tell,
// send through FCM, mark each event done. `db` is a firebase-admin Firestore,
// `messaging` a firebase-admin Messaging; both are injected so tests can use the
// emulator and a fake sender.

import { planPush } from "./plan.js";

const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);
const KEEP_PROCESSED_MS = 30 * 24 * 3600 * 1000;

export function tripPaths(tripKey) {
  const isDefault = !tripKey || tripKey === "default";
  const base = isDefault ? "" : `trips/${tripKey}/`;
  return {
    members: base + "members",
    expenses: base + "expenses",
    settings: isDefault ? "settings/trip" : `trips/${tripKey}`,
  };
}

export async function runPush({ db, messaging, dryRun = false, log = console.log, now = Date.now, limit = 100 }) {
  const snap = await db.collection("pushEvents").where("processed", "==", false).limit(limit).get();
  const tripCache = new Map();
  const report = { events: snap.size, sent: 0, skipped: 0, failed: 0 };

  async function loadTrip(tripKey) {
    if (!tripCache.has(tripKey)) {
      const p = tripPaths(tripKey);
      const [mSnap, tSnap] = await Promise.all([db.collection(p.members).get(), db.doc(p.settings).get()]);
      tripCache.set(tripKey, {
        members: mSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        trip: tSnap.exists ? tSnap.data() : {},
      });
    }
    return tripCache.get(tripKey);
  }

  for (const doc of snap.docs) {
    const event = doc.data();
    try {
      const { members, trip } = await loadTrip(event.tripKey);
      const eSnap = await db.doc(`${tripPaths(event.tripKey).expenses}/${event.expenseId}`).get();
      const plan = planPush({ event, expense: eSnap.exists ? { id: eSnap.id, ...eSnap.data() } : null, members, trip });

      let sent = 0;
      if (plan.ok) {
        for (const msg of plan.messages) {
          if (dryRun) { log(`[dry run] -> ${msg.uid}: ${msg.body}`); sent++; continue; }
          const tokRef = db.doc(`pushTokens/${msg.uid}`);
          const tokSnap = await tokRef.get();
          const tokens = (tokSnap.exists && tokSnap.data().tokens) || [];
          if (!tokens.length) continue;
          const res = await messaging.sendEachForMulticast({
            tokens,
            data: { title: msg.title, body: msg.body, tag: msg.tag, link: msg.link },
            webpush: { headers: { Urgency: "high", TTL: "86400" } },
          });
          const dead = tokens.filter((_, i) => !res.responses[i].success && DEAD_TOKEN.has(res.responses[i].error?.code));
          if (dead.length) await tokRef.update({ tokens: tokens.filter(t => !dead.includes(t)) });
          sent += res.successCount;
        }
      }
      if (!dryRun) {
        await doc.ref.update({ processed: true, processedAt: now(), sent, skipped: plan.ok ? null : plan.reason });
      }
      if (plan.ok) report.sent += sent; else report.skipped++;
    } catch (err) {
      // leave it unprocessed so the next sweep retries
      report.failed++;
      log(`event ${doc.id} failed: ${err.message}`);
    }
  }

  if (!dryRun) {
    const old = await db.collection("pushEvents").where("processedAt", "<", now() - KEEP_PROCESSED_MS).limit(200).get();
    await Promise.all(old.docs.map(d => d.ref.delete()));
  }
  return report;
}
