// Runs one real sweep of the alert job against the Firestore emulator, with a
// fake FCM sender. Run with: npm run test:rules (needs Java for the emulator).
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runPush } from "../push/run.js";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

let db;
before(() => {
  const app = getApps()[0] || initializeApp({ projectId: "demo-trip-split-sweep" });
  db = getFirestore(app);
});

async function wipe() {
  for (const c of ["pushEvents", "pushTokens", "members", "expenses", "settings"]) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
  await db.recursiveDelete(db.collection("trips"));
}
beforeEach(wipe);

function fakeMessaging({ failTokens = [] } = {}) {
  const calls = [];
  return {
    calls,
    async sendEachForMulticast(m) {
      calls.push(m);
      const responses = m.tokens.map(t => failTokens.includes(t)
        ? { success: false, error: { code: "messaging/registration-token-not-registered" } }
        : { success: true });
      return { responses, successCount: responses.filter(r => r.success).length, failureCount: responses.filter(r => !r.success).length };
    },
  };
}

async function seed() {
  await db.doc("settings/trip").set({ name: "Hunza", currency: "PKR", ownerUid: "uA" });
  await db.doc("members/a").set({ name: "Alice", active: true, authUid: "uA" });
  await db.doc("members/b").set({ name: "Bob", active: true, authUid: "uB" });
  await db.doc("expenses/e1").set({ type: "expense", description: "Dinner", amount: 200, payerId: "a", participantIds: ["a", "b"], addedBy: "a", createdAt: 1 });
  await db.doc("pushTokens/uB").set({ tokens: ["tokGood", "tokDead"], updatedAt: 1 });
  await db.doc("pushEvents/default_e1_expense_added").set({
    tripKey: "default", expenseId: "e1", kind: "expense_added", fromUid: "uA", processed: false, createdAt: 1,
  });
}

test("sweep: sends to the other member's device, drops dead tokens, marks the event done", async () => {
  await seed();
  const messaging = fakeMessaging({ failTokens: ["tokDead"] });
  const report = await runPush({ db, messaging, log: () => {} });
  assert.equal(report.events, 1);
  assert.equal(report.sent, 1);
  assert.equal(messaging.calls.length, 1);
  assert.deepEqual(messaging.calls[0].tokens, ["tokGood", "tokDead"]);
  assert.match(messaging.calls[0].data.body, /Alice added "Dinner"/);

  const tokens = (await db.doc("pushTokens/uB").get()).data().tokens;
  assert.deepEqual(tokens, ["tokGood"]);
  const ev = (await db.doc("pushEvents/default_e1_expense_added").get()).data();
  assert.equal(ev.processed, true);
  assert.equal(ev.sent, 1);
});

test("sweep: an event is only ever sent once", async () => {
  await seed();
  const messaging = fakeMessaging();
  await runPush({ db, messaging, log: () => {} });
  const again = await runPush({ db, messaging, log: () => {} });
  assert.equal(again.events, 0);
  assert.equal(messaging.calls.length, 1);
});

test("sweep: a forged event is marked done without sending anything", async () => {
  await seed();
  await db.doc("pushEvents/default_e1_expense_added").update({ fromUid: "uB" }); // Bob claims Alice's expense
  const messaging = fakeMessaging();
  const report = await runPush({ db, messaging, log: () => {} });
  assert.equal(report.skipped, 1);
  assert.equal(messaging.calls.length, 0);
  assert.equal((await db.doc("pushEvents/default_e1_expense_added").get()).data().processed, true);
});

test("sweep: dry run prints but sends nothing and leaves the event pending", async () => {
  await seed();
  const lines = [];
  const messaging = fakeMessaging();
  await runPush({ db, messaging, dryRun: true, log: l => lines.push(l) });
  assert.equal(messaging.calls.length, 0);
  assert.ok(lines.some(l => l.includes("[dry run]")));
  assert.equal((await db.doc("pushEvents/default_e1_expense_added").get()).data().processed, false);
});

test("sweep: a person with no device registered is skipped quietly", async () => {
  await seed();
  await db.doc("pushTokens/uB").delete();
  const messaging = fakeMessaging();
  const report = await runPush({ db, messaging, log: () => {} });
  assert.equal(report.failed, 0);
  assert.equal(messaging.calls.length, 0);
});

test("sweep: nested trips use their own members, expenses and settings", async () => {
  await db.doc("trips/t9").set({ name: "Swat", currency: "USD", ownerUid: "uA" });
  await db.doc("trips/t9/members/a").set({ name: "Alice", active: true, authUid: "uA" });
  await db.doc("trips/t9/members/b").set({ name: "Bob", active: true, authUid: "uB" });
  await db.doc("trips/t9/expenses/e7").set({ type: "settlement", amount: 40, payerId: "b", participantIds: ["a"], addedBy: "b", confirmedBy: null });
  await db.doc("pushTokens/uA").set({ tokens: ["tokA"], updatedAt: 1 });
  await db.doc("pushEvents/t9_e7_settlement_marked").set({
    tripKey: "t9", expenseId: "e7", kind: "settlement_marked", fromUid: "uB", processed: false, createdAt: 1,
  });
  const messaging = fakeMessaging();
  await runPush({ db, messaging, log: () => {} });
  assert.equal(messaging.calls.length, 1);
  assert.equal(messaging.calls[0].data.title, "Swat");
  assert.equal(messaging.calls[0].data.link, "?trip=t9");
  assert.match(messaging.calls[0].data.body, /Bob says they paid you/);
  assert.match(messaging.calls[0].data.body, /\$40/);
});
