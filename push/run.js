// One sweep of the alert job: find unprocessed events, work out who to tell,
// send through FCM, mark each event done. `db` is a firebase-admin Firestore,
// `messaging` a firebase-admin Messaging; both are injected so tests can use the
// emulator and a fake sender.

import { planPush } from "./plan.js";

// Only these mean "this device is gone". Anything else (a bad payload, a quota
// hiccup) must not cost a person their valid tokens.
const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);
const KEEP_PROCESSED_MS = 30 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;

export function tripPaths(tripKey) {
  const isDefault = !tripKey || tripKey === "default";
  const base = isDefault ? "" : `trips/${tripKey}/`;
  return {
    members: base + "members",
    expenses: base + "expenses",
    settings: isDefault ? "settings/trip" : `trips/${tripKey}`,
  };
}

const SAFE = /^[A-Za-z0-9_-]{1,100}$/;

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
    const done = (fields) => dryRun ? null : doc.ref.update({ processed: true, processedAt: now(), ...fields });
    try {
      // the rules already insist on plain ids; check again before building paths
      if (!SAFE.test(event.tripKey || "") || !SAFE.test(event.expenseId || "")) {
        log(`event ${doc.id}: skipped (malformed)`);
        await done({ sent: 0, skipped: "malformed" });
        report.skipped++;
        continue;
      }
      const { members, trip } = await loadTrip(event.tripKey);
      const eSnap = await db.doc(`${tripPaths(event.tripKey).expenses}/${event.expenseId}`).get();
      const plan = planPush({ event, expense: eSnap.exists ? { id: eSnap.id, ...eSnap.data() } : null, members, trip });

      // people already told on an earlier, partly failed attempt are not told twice
      const sentTo = new Set(event.sentTo || []);
      let sent = 0;
      if (plan.ok) {
        for (const msg of plan.messages) {
          if (sentTo.has(msg.uid)) continue;
          if (dryRun) { log(`[dry run] -> ${msg.uid}: ${msg.body}`); sent++; continue; }
          const tokRef = db.doc(`pushTokens/${msg.uid}`);
          const tokSnap = await tokRef.get();
          const tokens = (tokSnap.exists && tokSnap.data().tokens) || [];
          if (tokens.length) {
            const res = await messaging.sendEachForMulticast({
              tokens,
              data: { title: msg.title, body: msg.body, tag: msg.tag, link: msg.link },
              webpush: { headers: { Urgency: "high", TTL: "86400" } },
            });
            const dead = tokens.filter((_, i) => !res.responses[i].success && DEAD_TOKEN.has(res.responses[i].error?.code));
            if (dead.length) await tokRef.update({ tokens: tokens.filter(t => !dead.includes(t)) });
            sent += res.successCount;
          }
          sentTo.add(msg.uid);
          if (!dryRun) await doc.ref.update({ sentTo: [...sentTo] });
        }
      }
      // say why, so a quiet sweep can be explained from the Actions log alone
      log(`${dryRun ? "[dry run] " : ""}event ${doc.id}: ${plan.ok
        ? (sent ? `sent to ${sent} device(s)` : "recipients found, but none has a device registered")
        : `skipped (${plan.reason})`}`);
      await done({ sent, skipped: plan.ok ? null : plan.reason });
      if (plan.ok) report.sent += sent; else report.skipped++;
    } catch (err) {
      // retry on the next sweep, but give up after a few tries so one broken
      // event can't sit in the queue forever
      report.failed++;
      const attempts = (event.attempts || 0) + 1;
      log(`event ${doc.id}: failed (attempt ${attempts}): ${err.message}`);
      if (!dryRun) {
        await doc.ref.update(attempts >= MAX_ATTEMPTS
          ? { attempts, processed: true, processedAt: now(), skipped: `gave up: ${String(err.message).slice(0, 200)}` }
          : { attempts }).catch(() => {});
      }
    }
  }

  if (!dryRun) {
    const old = await db.collection("pushEvents").where("processedAt", "<", now() - KEEP_PROCESSED_MS).limit(200).get();
    await Promise.all(old.docs.map(d => d.ref.delete()));
  }
  return report;
}
