import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBalances, computeSettlements, pendingSettlementBetween, myPendingConfirmations,
  computePairwiseBalances, categoryTotals, matchesLedgerFilter,
  recurrenceOccurrences, nextOccurrenceMs, UNCATEGORISED,
  expenseShares, buildShares,
} from "../logic.js";

const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
const close = (x, y) => assert.ok(Math.abs(x - y) < 0.005, `${x} != ${y}`);
const exp = (o) => ({ type: "expense", createdAt: 1000, participantIds: ["a", "b", "c"], ...o });

test("balances: even three-way split paid by one person", () => {
  const net = computeBalances(members, [exp({ amount: 300, payerId: "a" })]);
  close(net.a, 200); close(net.b, -100); close(net.c, -100);
});

test("balances always sum to zero", () => {
  const net = computeBalances(members, [
    exp({ amount: 100, payerId: "a" }),
    exp({ amount: 77.77, payerId: "b", participantIds: ["b", "c"] }),
    exp({ amount: 33, payerId: "c", participantIds: ["a"] }),
  ]);
  close(Object.values(net).reduce((s, v) => s + v, 0), 0);
});

test("balances ignore deleted expenses", () => {
  const net = computeBalances(members, [exp({ amount: 300, payerId: "a", deleted: true })]);
  assert.deepEqual(net, { a: 0, b: 0, c: 0 });
});

test("an unconfirmed settlement does not move balances", () => {
  const base = exp({ amount: 300, payerId: "a" });
  const settle = { type: "settlement", amount: 100, payerId: "b", participantIds: ["a"], createdAt: 2000 };
  const before = computeBalances(members, [base]);
  const pending = computeBalances(members, [base, settle]);
  assert.deepEqual(pending, before);
});

test("a confirmed settlement clears the debt", () => {
  const base = exp({ amount: 300, payerId: "a" });
  const settle = { type: "settlement", amount: 100, payerId: "b", participantIds: ["a"], confirmedBy: "a", confirmedAt: 3000 };
  const net = computeBalances(members, [base, settle]);
  close(net.a, 100); close(net.b, 0); close(net.c, -100);
});

test("a disputed settlement never counts", () => {
  const settle = { type: "settlement", amount: 100, payerId: "b", participantIds: ["a"], disputed: true };
  const net = computeBalances(members, [exp({ amount: 300, payerId: "a" }), settle]);
  close(net.b, -100);
});

test("settle-up plan zeroes everyone out with minimal payments", () => {
  const net = computeBalances(members, [exp({ amount: 300, payerId: "a" })]);
  const plan = computeSettlements(net);
  assert.equal(plan.length, 2);
  plan.forEach(p => { assert.equal(p.to, "a"); close(p.amount, 100); });
});

test("settle-up plan is empty when everyone is square", () => {
  assert.deepEqual(computeSettlements({ a: 0, b: 0.004, c: -0.004 }), []);
});

test("pending settlement lookup is directional and ignores confirmed/disputed", () => {
  const s = { type: "settlement", amount: 5, payerId: "b", participantIds: ["a"] };
  assert.ok(pendingSettlementBetween([s], "b", "a"));
  assert.equal(pendingSettlementBetween([s], "a", "b"), undefined);
  assert.equal(pendingSettlementBetween([{ ...s, confirmedBy: "a" }], "b", "a"), undefined);
  assert.equal(pendingSettlementBetween([{ ...s, disputed: true }], "b", "a"), undefined);
});

test("only the creditor sees a pending confirmation", () => {
  const s = { type: "settlement", amount: 5, payerId: "b", participantIds: ["a"] };
  assert.equal(myPendingConfirmations([s], "a").length, 1);
  assert.equal(myPendingConfirmations([s], "b").length, 0);
  assert.equal(myPendingConfirmations([s], "c").length, 0);
});

test("pairwise: itemised, signed correctly, and symmetric", () => {
  const list = [
    exp({ amount: 300, payerId: "a", description: "Dinner" }),
    exp({ amount: 60, payerId: "b", participantIds: ["a", "b"], description: "Taxi" }),
  ];
  const forA = computePairwiseBalances(list, "a");
  close(forA.b.net, 100 - 30);
  assert.equal(forA.b.items.length, 2);
  const forB = computePairwiseBalances(list, "b");
  close(forB.a.net, -(100 - 30));
});

test("pairwise: confirmed settlement reduces what is owed, pending does not", () => {
  const dinner = exp({ amount: 300, payerId: "a", description: "Dinner" });
  const pending = { type: "settlement", amount: 100, payerId: "b", participantIds: ["a"] };
  const confirmed = { ...pending, confirmedBy: "a", confirmedAt: 5 };
  close(computePairwiseBalances([dinner, pending], "a").b.net, 100);
  close(computePairwiseBalances([dinner, confirmed], "a").b.net, 0);
});

test("category totals: excludes settlements and deleted, groups uncategorised", () => {
  const totals = categoryTotals([
    exp({ amount: 100, payerId: "a", category: "Food" }),
    exp({ amount: 50, payerId: "a", category: "Food" }),
    exp({ amount: 70, payerId: "a" }),
    exp({ amount: 999, payerId: "a", category: "Food", deleted: true }),
    { type: "settlement", amount: 500, payerId: "b", participantIds: ["a"] },
  ]);
  assert.deepEqual(totals.map(t => [t.category, t.total, t.count]),
    [["Food", 150, 2], [UNCATEGORISED, 70, 1]]);
});

const helpers = { nameOf: id => ({ a: "Ali", b: "Bilal", c: "Chai" }[id] || "Someone"), fmtMoney: n => `PKR ${n}` };

test("ledger filter: text matches item, person, amount and category", () => {
  const e = exp({ amount: 450, payerId: "b", description: "Hotel", category: "Stay" });
  const m = q => matchesLedgerFilter(e, { q }, helpers);
  assert.ok(m("hotel")); assert.ok(m("bilal")); assert.ok(m("450")); assert.ok(m("stay"));
  assert.ok(!m("airport"));
});

test("ledger filter: category and date range", () => {
  const e = exp({ amount: 10, payerId: "a", category: "Food", createdAt: 5000 });
  assert.ok(matchesLedgerFilter(e, { category: "Food" }, helpers));
  assert.ok(!matchesLedgerFilter(e, { category: "Stay" }, helpers));
  assert.ok(matchesLedgerFilter(e, { fromMs: 4000, toMs: 6000 }, helpers));
  assert.ok(!matchesLedgerFilter(e, { fromMs: 5001 }, helpers));
  assert.ok(!matchesLedgerFilter(e, { toMs: 4999 }, helpers));
});

test("ledger filter: uncategorised bucket and settlements under a category filter", () => {
  const plain = exp({ amount: 10, payerId: "a" });
  assert.ok(matchesLedgerFilter(plain, { category: UNCATEGORISED }, helpers));
  const settle = { type: "settlement", amount: 5, payerId: "b", participantIds: ["a"] };
  assert.ok(!matchesLedgerFilter(settle, { category: "Food" }, helpers));
});

test("recurrence: weekly occurrences have stable ids and stop at now", () => {
  const start = Date.UTC(2026, 0, 1, 9, 0, 0);
  const rec = { id: "r1", startDate: start, interval: "weekly" };
  const now = start + 15 * 86400000;
  const occ = recurrenceOccurrences(rec, now);
  assert.equal(occ.length, 3);
  assert.equal(occ[0].expenseId, "rec_r1_20260101");
  assert.equal(occ[1].expenseId, "rec_r1_20260108");
  assert.equal(occ[2].expenseId, "rec_r1_20260115");
});

test("recurrence: nothing is due before the start date", () => {
  const rec = { id: "r1", startDate: 10_000, interval: "weekly" };
  assert.deepEqual(recurrenceOccurrences(rec, 9_999), []);
});

test("recurrence: monthly clamps to the last day and does not drift", () => {
  const start = Date.UTC(2026, 0, 31, 12, 0, 0);
  const rec = { id: "m", startDate: start, interval: "monthly" };
  const keys = recurrenceOccurrences(rec, Date.UTC(2026, 4, 31, 13, 0, 0)).map(o => o.key);
  assert.deepEqual(keys, ["20260131", "20260228", "20260331", "20260430", "20260531"]);
});

test("recurrence: same input gives the same ids on any device", () => {
  const rec = { id: "x", startDate: Date.UTC(2026, 5, 10), interval: "monthly" };
  const a = recurrenceOccurrences(rec, Date.UTC(2026, 8, 20)).map(o => o.expenseId);
  const b = recurrenceOccurrences(rec, Date.UTC(2026, 8, 20)).map(o => o.expenseId);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test("recurrence: invalid interval or missing start yields nothing; cap holds", () => {
  assert.deepEqual(recurrenceOccurrences({ id: "x", startDate: 1, interval: "daily" }, 1e15), []);
  assert.deepEqual(recurrenceOccurrences({ id: "x", interval: "weekly" }, 1e15), []);
  assert.equal(recurrenceOccurrences({ id: "x", startDate: 1, interval: "weekly" }, 1e15, 5).length, 5);
});

test("nextOccurrenceMs returns the first future date", () => {
  const start = Date.UTC(2026, 0, 1);
  const rec = { id: "r", startDate: start, interval: "weekly" };
  assert.equal(nextOccurrenceMs(rec, start + 1), start + 7 * 86400000);
});

// ---- unequal splits ---------------------------------------------------------
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

test("expenseShares: legacy expenses split evenly, explicit shares win", () => {
  close(expenseShares(exp({ amount: 90, payerId: "a" })).b, 30);
  const e = exp({ amount: 100, payerId: "a", shares: { a: 70, b: 30 } });
  assert.deepEqual(expenseShares(e), { a: 70, b: 30 });
});

test("unequal split moves balances by the stored shares", () => {
  const e = exp({ amount: 100, payerId: "a", participantIds: ["a", "b"], shares: { a: 70, b: 30 } });
  const net = computeBalances(members, [e]);
  close(net.a, 30); close(net.b, -30); close(net.c, 0);
});

test("pairwise respects unequal shares from both sides", () => {
  const e = exp({ amount: 100, payerId: "a", participantIds: ["a", "b", "c"], shares: { a: 20, b: 50, c: 30 }, description: "Hotel" });
  close(computePairwiseBalances([e], "a").b.net, 50);
  close(computePairwiseBalances([e], "a").c.net, 30);
  close(computePairwiseBalances([e], "b").a.net, -50);
  assert.equal(computePairwiseBalances([e], "b").c, undefined);
});

test("buildShares exact: must add up to the total", () => {
  const ok = buildShares("exact", 100, ["a", "b"], { a: 60, b: 40 });
  assert.ok(ok.ok); assert.deepEqual(ok.shares, { a: 60, b: 40 });
  const bad = buildShares("exact", 100, ["a", "b"], { a: 60, b: 30 });
  assert.equal(bad.ok, false); assert.match(bad.error, /add up to 90/);
});

test("buildShares percent: must be 100, sums exactly to the total", () => {
  const r = buildShares("percent", 100, ["a", "b", "c"], { a: 33.33, b: 33.33, c: 33.34 });
  assert.ok(r.ok); close(sum(r.shares), 100);
  assert.equal(buildShares("percent", 100, ["a", "b"], { a: 60, b: 30 }).ok, false);
});

test("buildShares shares: proportional and rounding never loses a cent", () => {
  const r = buildShares("shares", 100, ["a", "b", "c"], { a: 1, b: 1, c: 1 });
  assert.ok(r.ok); close(sum(r.shares), 100);
  const r2 = buildShares("shares", 10, ["a", "b"], { a: 2, b: 1 });
  close(r2.shares.a, 6.67); close(r2.shares.b, 3.33); close(sum(r2.shares), 10);
});

test("buildShares: zero share means that person is left out", () => {
  const r = buildShares("exact", 50, ["a", "b", "c"], { a: 50, b: 0, c: 0 });
  assert.ok(r.ok); assert.deepEqual(Object.keys(r.shares), ["a"]);
});

test("buildShares: rejects bad input", () => {
  assert.equal(buildShares("exact", 0, ["a"], { a: 0 }).ok, false);
  assert.equal(buildShares("exact", 10, [], {}).ok, false);
  assert.equal(buildShares("exact", 10, ["a"], { a: -5 }).ok, false);
  assert.equal(buildShares("exact", 10, ["a"], { a: "x" }).ok, false);
  assert.equal(buildShares("weird", 10, ["a"], { a: 10 }).ok, false);
  assert.equal(buildShares("shares", 10, ["a", "b"], { a: 0, b: 0 }).ok, false);
});

test("buildShares equal: remainder cent is not lost", () => {
  const r = buildShares("equal", 100, ["a", "b", "c"]);
  assert.ok(r.ok); close(sum(r.shares), 100);
});

test("balances still sum to zero with mixed equal and unequal expenses", () => {
  const net = computeBalances(members, [
    exp({ amount: 100, payerId: "a" }),
    exp({ amount: 250, payerId: "b", participantIds: ["a", "b", "c"], shares: { a: 100.5, b: 49.5, c: 100 } }),
  ]);
  close(sum(net), 0);
});
