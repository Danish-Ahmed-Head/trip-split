// Security Rules tests. Run with: npm run test:rules
// Needs Java (for the Firestore emulator) and `npm install`.
import { test, before, after, beforeEach, describe } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, setDoc, getDoc, updateDoc, writeBatch, collection,
} from "firebase/firestore";

const here = path.dirname(fileURLToPath(import.meta.url));
const rules = fs.readFileSync(path.join(here, "..", "firestore.rules"), "utf8");

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-trip-split",
    firestore: { rules, host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

// ---- world -----------------------------------------------------------------
// uids: owner(own), alice(ali), bob(bob), eve(eve = signed in, not a member)
// members: mA (alice), mB (bob), mC (unclaimed, legacy: no authUid field at all)
async function seed({ closed = false } = {}) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "settings", "trip"), { name: "T", currency: "PKR", ownerUid: "own", ...(closed ? { closed: true } : {}) });
    await setDoc(doc(db, "members", "mA"), { name: "Alice", active: true, authUid: "ali", createdAt: 1 });
    await setDoc(doc(db, "members", "mB"), { name: "Bob", active: true, authUid: "bob", createdAt: 1 });
    await setDoc(doc(db, "members", "mC"), { name: "Cara", active: true, createdAt: 1 }); // legacy shape
    await setDoc(doc(db, "memberLinks", "ali"), { memberId: "mA" });
    await setDoc(doc(db, "memberLinks", "bob"), { memberId: "mB" });
    // a normal expense by Alice, a pending settlement Bob -> Alice, a legacy settlement (no confirmedBy field)
    await setDoc(doc(db, "expenses", "e1"), { type: "expense", description: "Dinner", amount: 300, payerId: "mA", participantIds: ["mA", "mB"], createdAt: 5, addedBy: "mA" });
    await setDoc(doc(db, "expenses", "s1"), { type: "settlement", amount: 100, payerId: "mB", participantIds: ["mA"], createdAt: 6, addedBy: "mB", confirmedBy: null, confirmedAt: null });
    await setDoc(doc(db, "expenses", "sLegacy"), { type: "settlement", amount: 50, payerId: "mB", participantIds: ["mA"], createdAt: 2, addedBy: "mB" });
    await setDoc(doc(db, "recurring", "r1"), { description: "Rent", amount: 900, payerId: "mA", participantIds: ["mA", "mB"], interval: "monthly", startDate: 1, active: true, createdBy: "mA", createdAt: 1 });
  });
}
const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const D = (db, ...p) => doc(db, ...p);

describe("sign-in required", () => {
  test("anonymous (signed-out) users can't read or write", async () => {
    await seed();
    await assertFails(getDoc(D(anon(), "members", "mA")));
    await assertFails(setDoc(D(anon(), "expenses", "x"), { type: "expense", amount: 5, addedBy: "mA", payerId: "mA", participantIds: ["mA"] }));
  });
  test("any signed-in user can read the trip", async () => {
    await seed();
    await assertSucceeds(getDoc(D(as("eve"), "expenses", "e1")));
  });
});

describe("claiming a name", () => {
  test("claim an unclaimed legacy member (field absent) + link in one batch", async () => {
    await seed();
    const db = as("eve");
    const b = writeBatch(db);
    b.update(D(db, "members", "mC"), { authUid: "eve" });
    b.set(D(db, "memberLinks", "eve"), { memberId: "mC", claimedAt: 1 });
    await assertSucceeds(b.commit());
  });
  test("can't claim a member that is already claimed", async () => {
    await seed();
    await assertFails(updateDoc(D(as("eve"), "members", "mA"), { authUid: "eve" }));
  });
  test("can't create a link to a member you did not claim (identity theft)", async () => {
    await seed();
    await assertFails(setDoc(D(as("eve"), "memberLinks", "eve"), { memberId: "mA" }));
    await assertFails(setDoc(D(as("eve"), "memberLinks", "eve"), { memberId: "mC" })); // unclaimed, not yet claimed by eve
  });
  test("can't create a link under someone else's uid", async () => {
    await seed();
    await assertFails(setDoc(D(as("eve"), "memberLinks", "bob2"), { memberId: "mC" }));
  });
  test("a link can't be rewritten", async () => {
    await seed();
    await assertFails(setDoc(D(as("ali"), "memberLinks", "ali"), { memberId: "mB" }));
  });
  test("add yourself as a brand-new member and link in one batch", async () => {
    await seed();
    const db = as("eve");
    const b = writeBatch(db);
    b.set(D(db, "members", "mNew"), { name: "Eve", active: true, createdAt: 9, authUid: "eve" });
    b.set(D(db, "memberLinks", "eve"), { memberId: "mNew" });
    await assertSucceeds(b.commit());
  });
  test("a member can't reassign their own authUid", async () => {
    await seed();
    await assertFails(updateDoc(D(as("ali"), "members", "mA"), { authUid: "eve" }));
  });
  test("a member can rename themself, not someone else", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("ali"), "members", "mA"), { name: "Alice B" }));
    await assertFails(updateDoc(D(as("ali"), "members", "mB"), { name: "Hacked" }));
  });
});

describe("expenses", () => {
  test("add an expense as yourself", async () => {
    await seed();
    await assertSucceeds(setDoc(D(as("ali"), "expenses", "n1"), { type: "expense", description: "Tea", amount: 10, payerId: "mB", participantIds: ["mA", "mB"], createdAt: 1, addedBy: "mA" }));
  });
  test("can't add an expense in someone else's name", async () => {
    await seed();
    await assertFails(setDoc(D(as("ali"), "expenses", "n2"), { type: "expense", description: "Tea", amount: 10, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mB" }));
  });
  test("a signed-in non-member can't add expenses", async () => {
    await seed();
    await assertFails(setDoc(D(as("eve"), "expenses", "n3"), { type: "expense", description: "x", amount: 10, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mA" }));
  });
  test("amount must be a positive number", async () => {
    await seed();
    const base = { type: "expense", description: "x", payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mA" };
    await assertFails(setDoc(D(as("ali"), "expenses", "z0"), { ...base, amount: 0 }));
    await assertFails(setDoc(D(as("ali"), "expenses", "zs"), { ...base, amount: "10" }));
  });
  test("author can edit and soft-delete; others can't", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("ali"), "expenses", "e1"), { description: "Dinner!", amount: 320 }));
    await assertSucceeds(updateDoc(D(as("ali"), "expenses", "e1"), { deleted: true, deletedBy: "mA", deletedAt: 9 }));
    await assertFails(updateDoc(D(as("bob"), "expenses", "e1"), { amount: 1 }));
    await assertFails(updateDoc(D(as("eve"), "expenses", "e1"), { deleted: true }));
  });
  test("author can't change authorship or inject settlement fields", async () => {
    await seed();
    await assertFails(updateDoc(D(as("ali"), "expenses", "e1"), { addedBy: "mB" }));
    await assertFails(updateDoc(D(as("ali"), "expenses", "e1"), { confirmedBy: "mA" }));
    await assertFails(updateDoc(D(as("ali"), "expenses", "e1"), { type: "settlement" }));
  });
  test("trip owner can edit anyone's expense", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("own"), "expenses", "e1"), { amount: 301 }));
  });
  test("nobody can hard-delete", async () => {
    await seed();
    const { deleteDoc } = await import("firebase/firestore");
    await assertFails(deleteDoc(D(as("ali"), "expenses", "e1")));
    await assertFails(deleteDoc(D(as("own"), "expenses", "e1")));
  });
});

describe("settlements: two-step confirmation", () => {
  const settle = (over = {}) => ({ type: "settlement", description: "Settlement", amount: 100, payerId: "mB", participantIds: ["mA"], createdAt: 1, addedBy: "mB", confirmedBy: null, confirmedAt: null, ...over });

  test("the payer can raise a settlement", async () => {
    await seed();
    await assertSucceeds(setDoc(D(as("bob"), "expenses", "s2"), settle()));
  });
  test("can't raise a settlement as someone else", async () => {
    await seed();
    await assertFails(setDoc(D(as("eve"), "expenses", "s3"), settle()));
    await assertFails(setDoc(D(as("ali"), "expenses", "s4"), settle({ payerId: "mB", addedBy: "mA" })));
  });
  test("can't raise a pre-confirmed settlement", async () => {
    await seed();
    await assertFails(setDoc(D(as("bob"), "expenses", "s5"), settle({ confirmedBy: "mA", confirmedAt: 1 })));
  });
  test("only the creditor can confirm", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("ali"), "expenses", "s1"), { confirmedBy: "mA", confirmedAt: 9 }));
  });
  test("the payer can't confirm their own payment", async () => {
    await seed();
    await assertFails(updateDoc(D(as("bob"), "expenses", "s1"), { confirmedBy: "mB", confirmedAt: 9 }));
  });
  test("a bystander can't confirm", async () => {
    await seed();
    await assertFails(updateDoc(D(as("eve"), "expenses", "s1"), { confirmedBy: "mA", confirmedAt: 9 }));
  });
  test("confirm works on legacy settlements that have no confirmedBy field", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("ali"), "expenses", "sLegacy"), { confirmedBy: "mA", confirmedAt: 9 }));
  });
  test("creditor can dispute; payer can't", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("ali"), "expenses", "s1"), { disputed: true, disputedBy: "mA", disputedAt: 9 }));
    await assertFails(updateDoc(D(as("bob"), "expenses", "sLegacy"), { disputed: true, disputedBy: "mB", disputedAt: 9 }));
  });
  test("a confirmation can't be overwritten", async () => {
    await seed();
    await env.withSecurityRulesDisabled(async ctx => { await updateDoc(D(ctx.firestore(), "expenses", "s1"), { confirmedBy: "mA", confirmedAt: 7 }); });
    await assertFails(updateDoc(D(as("ali"), "expenses", "s1"), { confirmedBy: "mA", confirmedAt: 99 }));
  });
  test("the payer can't edit the amount or recipient of a settlement", async () => {
    await seed();
    await assertFails(updateDoc(D(as("bob"), "expenses", "s1"), { amount: 1 }));
    await assertFails(updateDoc(D(as("bob"), "expenses", "s1"), { participantIds: ["mB"] }));
  });
  test("the payer can withdraw a pending settlement but not a confirmed one", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("bob"), "expenses", "s1"), { deleted: true, deletedBy: "mB", deletedAt: 9 }));
    await env.withSecurityRulesDisabled(async ctx => { await updateDoc(D(ctx.firestore(), "expenses", "sLegacy"), { confirmedBy: "mA", confirmedAt: 7 }); });
    await assertFails(updateDoc(D(as("bob"), "expenses", "sLegacy"), { deleted: true, deletedBy: "mB", deletedAt: 9 }));
  });
});

describe("closed trip", () => {
  test("a closed trip refuses new expenses and new repeating templates", async () => {
    await seed({ closed: true });
    await assertFails(setDoc(D(as("ali"), "expenses", "c1"), { type: "expense", description: "x", amount: 10, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mA" }));
    await assertFails(setDoc(D(as("ali"), "recurring", "rc"), { description: "x", amount: 5, payerId: "mA", participantIds: ["mA"], interval: "weekly", startDate: 1, active: true, createdBy: "mA" }));
  });
  test("settling up still works on a closed trip", async () => {
    await seed({ closed: true });
    await assertSucceeds(setDoc(D(as("bob"), "expenses", "c2"), { type: "settlement", description: "Settlement", amount: 10, payerId: "mB", participantIds: ["mA"], createdAt: 1, addedBy: "mB", confirmedBy: null, confirmedAt: null }));
    await assertSucceeds(updateDoc(D(as("ali"), "expenses", "s1"), { confirmedBy: "mA", confirmedAt: 9 }));
  });
  test("only the owner can close or reopen", async () => {
    await seed();
    await assertFails(updateDoc(D(as("ali"), "settings", "trip"), { closed: true }));
    await assertSucceeds(updateDoc(D(as("own"), "settings", "trip"), { closed: true }));
    await assertSucceeds(updateDoc(D(as("own"), "settings", "trip"), { closed: false }));
  });
  test("a trip with no closed field stays open", async () => {
    await seed();
    await assertSucceeds(setDoc(D(as("ali"), "expenses", "o1"), { type: "expense", description: "x", amount: 10, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mA" }));
  });
});

describe("repeating expenses", () => {
  const rec = (over = {}) => ({ description: "Gym", amount: 20, payerId: "mA", participantIds: ["mA", "mB"], interval: "weekly", startDate: 1, active: true, createdBy: "mA", createdAt: 1, ...over });
  test("a member can create a template as themself", async () => {
    await seed();
    await assertSucceeds(setDoc(D(as("ali"), "recurring", "r2"), rec()));
    await assertFails(setDoc(D(as("ali"), "recurring", "r3"), rec({ createdBy: "mB" })));
    await assertFails(setDoc(D(as("ali"), "recurring", "r4"), rec({ interval: "daily" })));
    await assertFails(setDoc(D(as("ali"), "recurring", "r5"), rec({ amount: -1 })));
  });
  test("only pause/resume, only by the creator or owner", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("ali"), "recurring", "r1"), { active: false }));
    await assertSucceeds(updateDoc(D(as("own"), "recurring", "r1"), { active: true }));
    await assertFails(updateDoc(D(as("bob"), "recurring", "r1"), { active: false }));
    await assertFails(updateDoc(D(as("ali"), "recurring", "r1"), { amount: 1 }));
  });
  test("any member's device may materialise an occurrence for the template's creator", async () => {
    await seed();
    await assertSucceeds(setDoc(D(as("bob"), "expenses", "rec_r1_20260101"), { type: "expense", description: "Rent", amount: 900, payerId: "mA", participantIds: ["mA", "mB"], createdAt: 1, addedBy: "mA", recurringId: "r1" }));
  });
  test("…but can't use a template to attribute an expense to someone else", async () => {
    await seed();
    await assertFails(setDoc(D(as("bob"), "expenses", "rec_x"), { type: "expense", description: "Rent", amount: 900, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mB", recurringId: "r1" }));
    await assertFails(setDoc(D(as("bob"), "expenses", "rec_y"), { type: "expense", description: "x", amount: 9, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mA", recurringId: "nope" }));
  });
});

describe("trip settings and ownership", () => {
  test("only the owner changes trip name/currency", async () => {
    await seed();
    await assertSucceeds(updateDoc(D(as("own"), "settings", "trip"), { name: "New" }));
    await assertFails(updateDoc(D(as("ali"), "settings", "trip"), { name: "Mine" }));
  });
  test("ownership can be claimed once on a legacy trip with no owner, never taken", async () => {
    await env.withSecurityRulesDisabled(async ctx => { await setDoc(D(ctx.firestore(), "settings", "trip"), { name: "Old", currency: "PKR" }); });
    await assertSucceeds(updateDoc(D(as("ali"), "settings", "trip"), { ownerUid: "ali" }));
    await assertFails(updateDoc(D(as("bob"), "settings", "trip"), { ownerUid: "bob" }));
  });
});

describe("per-user data", () => {
  test("a user reads and writes only their own users/ doc", async () => {
    await seed();
    await assertSucceeds(setDoc(D(as("ali"), "users", "ali"), { trips: { default: { name: "T", id: null, lastSeen: 1 } } }));
    await assertSucceeds(getDoc(D(as("ali"), "users", "ali")));
    await assertFails(getDoc(D(as("bob"), "users", "ali")));
    await assertFails(setDoc(D(as("bob"), "users", "ali"), { trips: {} }));
  });
});

describe("created trips (nested paths)", () => {
  async function seedTrip({ closed = false } = {}) {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await setDoc(D(db, "trips", "t1"), { name: "Hunza", currency: "PKR", ownerUid: "own", ...(closed ? { closed: true } : {}) });
      await setDoc(D(db, "trips", "t1", "members", "mA"), { name: "Alice", active: true, authUid: "ali" });
      await setDoc(D(db, "trips", "t1", "members", "mB"), { name: "Bob", active: true, authUid: "bob" });
      await setDoc(D(db, "trips", "t1", "memberLinks", "ali"), { memberId: "mA" });
      await setDoc(D(db, "trips", "t1", "memberLinks", "bob"), { memberId: "mB" });
      await setDoc(D(db, "trips", "t1", "expenses", "s1"), { type: "settlement", amount: 100, payerId: "mB", participantIds: ["mA"], addedBy: "mB", createdAt: 1 });
    });
  }
  test("same rules apply: creditor confirms, payer can't", async () => {
    await seedTrip();
    await assertFails(updateDoc(D(as("bob"), "trips", "t1", "expenses", "s1"), { confirmedBy: "mB", confirmedAt: 1 }));
    await assertSucceeds(updateDoc(D(as("ali"), "trips", "t1", "expenses", "s1"), { confirmedBy: "mA", confirmedAt: 1 }));
  });
  test("link hijack is refused here too", async () => {
    await seedTrip();
    await assertFails(setDoc(D(as("eve"), "trips", "t1", "memberLinks", "eve"), { memberId: "mA" }));
  });
  test("closed trip refuses new expenses but not settlements", async () => {
    await seedTrip({ closed: true });
    await assertFails(setDoc(D(as("ali"), "trips", "t1", "expenses", "n"), { type: "expense", description: "x", amount: 5, payerId: "mA", participantIds: ["mA"], createdAt: 1, addedBy: "mA" }));
    await assertSucceeds(setDoc(D(as("bob"), "trips", "t1", "expenses", "n2"), { type: "settlement", description: "Settlement", amount: 5, payerId: "mB", participantIds: ["mA"], createdAt: 1, addedBy: "mB", confirmedBy: null }));
  });
  test("a new trip can be created and its first members seeded by its creator", async () => {
    const db = as("own");
    await assertSucceeds(setDoc(D(db, "trips", "t2"), { name: "New", currency: "PKR", createdAt: 1, ownerUid: "own" }));
    await assertSucceeds(setDoc(D(db, "trips", "t2", "members", "m1"), { name: "Zed", active: true, createdAt: 1 })); // no authUid field
  });
});
