import { test } from "node:test";
import assert from "node:assert/strict";
import { planPush } from "../push/plan.js";

const members = [
  { id: "a", name: "Alice", active: true, authUid: "uA" },
  { id: "b", name: "Bob", active: true, authUid: "uB" },
  { id: "c", name: "Cara", active: true, authUid: "uC" },
  { id: "d", name: "Dan", active: true }, // never signed in
  { id: "x", name: "Old", active: false, authUid: "uX" },
];
const trip = { name: "Hunza", currency: "PKR" };
const ev = (o) => ({ tripKey: "default", expenseId: "e1", fromUid: "uA", kind: "expense_added", ...o });
const exp = (o) => ({ id: "e1", type: "expense", description: "Dinner", amount: 300, payerId: "a", participantIds: ["a", "b", "c", "d"], addedBy: "a", ...o });
const plan = (o) => planPush({ members, trip, ...o });

test("expense added: everyone involved except the sender, who has signed in", () => {
  const r = plan({ event: ev(), expense: exp() });
  assert.ok(r.ok);
  assert.deepEqual(r.messages.map(m => m.uid).sort(), ["uB", "uC"]);
  assert.match(r.messages[0].body, /Alice added "Dinner"/);
  assert.match(r.messages[0].body, /Your share/);
  assert.equal(r.messages[0].title, "Hunza");
});

test("expense added: each person gets their own share, including unequal splits", () => {
  const r = plan({ event: ev(), expense: exp({ amount: 300, participantIds: ["a", "b", "c"], shares: { a: 100, b: 50, c: 150 } }) });
  const body = uid => r.messages.find(m => m.uid === uid).body;
  assert.match(body("uB"), /50/);
  assert.match(body("uC"), /150/);
});

test("expense added: a payer who is not in the split is told they paid", () => {
  const r = plan({ event: ev({ fromUid: "uB" }), expense: exp({ addedBy: "b", payerId: "a", participantIds: ["b", "c"] }) });
  assert.ok(r.ok);
  const toPayer = r.messages.find(m => m.uid === "uA");
  assert.match(toPayer.body, /You paid for it/);
});

test("expense added: only the person who added it can trigger it", () => {
  const r = plan({ event: ev({ fromUid: "uB" }), expense: exp() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not add/);
});

test("expense added: a settlement is not an expense", () => {
  const r = plan({ event: ev(), expense: exp({ type: "settlement", participantIds: ["b"] }) });
  assert.equal(r.ok, false);
});

test("marked paid: only the person paid is told", () => {
  const s = exp({ type: "settlement", payerId: "b", participantIds: ["a"], addedBy: "b", amount: 1500 });
  const r = plan({ event: ev({ kind: "settlement_marked", fromUid: "uB" }), expense: s });
  assert.ok(r.ok);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].uid, "uA");
  assert.match(r.messages[0].body, /Bob says they paid you/);
  assert.match(r.messages[0].body, /1,500/);
});

test("marked paid: someone else can't announce it on the payer's behalf", () => {
  const s = exp({ type: "settlement", payerId: "b", participantIds: ["a"], addedBy: "b" });
  const r = plan({ event: ev({ kind: "settlement_marked", fromUid: "uC" }), expense: s });
  assert.equal(r.ok, false);
});

test("confirmed: payer is told, and only if the creditor really confirmed", () => {
  const base = { type: "settlement", payerId: "b", participantIds: ["a"], addedBy: "b" };
  const ok = plan({ event: ev({ kind: "settlement_confirmed", fromUid: "uA" }), expense: exp({ ...base, confirmedBy: "a" }) });
  assert.ok(ok.ok);
  assert.equal(ok.messages[0].uid, "uB");
  const notYet = plan({ event: ev({ kind: "settlement_confirmed", fromUid: "uA" }), expense: exp(base) });
  assert.equal(notYet.ok, false);
});

test("disputed: payer is told, and only if it is really disputed by the creditor", () => {
  const base = { type: "settlement", payerId: "b", participantIds: ["a"], addedBy: "b" };
  const ok = plan({ event: ev({ kind: "settlement_disputed", fromUid: "uA" }), expense: exp({ ...base, disputed: true, disputedBy: "a" }) });
  assert.ok(ok.ok);
  assert.match(ok.messages[0].body, /disputed/);
  const fake = plan({ event: ev({ kind: "settlement_disputed", fromUid: "uA" }), expense: exp(base) });
  assert.equal(fake.ok, false);
});

test("a non-member, an inactive member, or a deleted expense gets nothing", () => {
  assert.equal(plan({ event: ev({ fromUid: "stranger" }), expense: exp() }).ok, false);
  assert.equal(plan({ event: ev({ fromUid: "uX" }), expense: exp({ addedBy: "x" }) }).ok, false);
  assert.equal(plan({ event: ev(), expense: exp({ deleted: true }) }).ok, false);
  assert.equal(plan({ event: ev(), expense: null }).ok, false);
});

test("unknown kinds are refused", () => {
  assert.equal(plan({ event: ev({ kind: "free_money" }), expense: exp() }).ok, false);
});

test("nested trips link back to their own ?trip= page", () => {
  const r = plan({ event: ev({ tripKey: "abc123" }), expense: exp() });
  assert.equal(r.messages[0].link, "?trip=abc123");
  assert.equal(r.messages[0].tag, "abc123_e1_expense_added");
  assert.equal(plan({ event: ev(), expense: exp() }).messages[0].link, "");
});

test("long descriptions and names are clipped", () => {
  const r = plan({ event: ev(), expense: exp({ description: "x".repeat(500) }) });
  assert.ok(r.messages[0].body.length < 200);
});
