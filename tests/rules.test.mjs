// Security Rules tests. Run with: npm run test:rules
// Needs Java (for the Firestore emulator) and `npm install`.
//
// Every test names the attacker. The point is to try what an outsider, an
// invitee, an ordinary member and the owner could each get away with.
import { test, before, after, beforeEach, describe } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch, collection,
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
// The same people exist in the default trip (base "") and in trip t1 (base "trips/t1/").
//   own  owner, member mO          ali  member mA          bob  member mB
//   cara invited as mC (unclaimed) eve  signed in, not in the trip
const EMAIL = { own: "own@x.com", ali: "ali@x.com", bob: "bob@x.com", cara: "cara@x.com", eve: "eve@x.com" };
const as = (uid, verified = true) => env.authenticatedContext(uid, { email: EMAIL[uid] || `${uid}@x.com`, email_verified: verified }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

async function seed(base = "", { closed = false } = {}) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const p = rest => doc(db, base + rest);
    await setDoc(base ? doc(db, base.slice(0, -1)) : doc(db, "settings/trip"),
      { name: "T", currency: "PKR", ownerUid: "own", ...(closed ? { closed: true } : {}) });
    await setDoc(p("members/mO"), { name: "Owner", active: true, authUid: "own", createdAt: 1 });
    await setDoc(p("members/mA"), { name: "Alice", active: true, authUid: "ali", createdAt: 1 });
    await setDoc(p("members/mB"), { name: "Bob", active: true, authUid: "bob", createdAt: 1 });
    await setDoc(p("members/mC"), { name: "Cara", active: true, createdAt: 1 }); // old shape: no authUid field
    await setDoc(p("memberLinks/own"), { memberId: "mO" });
    await setDoc(p("memberLinks/ali"), { memberId: "mA" });
    await setDoc(p("memberLinks/bob"), { memberId: "mB" });
    await setDoc(p("invites/cara@x.com"), { memberId: "mC", by: "own", createdAt: 1 });
    await setDoc(p("expenses/e1"), { type: "expense", description: "Dinner", amount: 300, payerId: "mA", participantIds: ["mA", "mB"], createdAt: 5, addedBy: "mA" });
    await setDoc(p("expenses/s1"), { type: "settlement", description: "Settlement", amount: 100, payerId: "mB", participantIds: ["mA"], createdAt: 6, addedBy: "mB", confirmedBy: null, confirmedAt: null });
    await setDoc(p("recurring/r1"), { description: "Rent", amount: 900, payerId: "mA", participantIds: ["mA", "mB"], interval: "monthly", startDate: 1, active: true, createdBy: "mA", createdAt: 1 });
    await setDoc(p("receipts/e1"), { data: "data:image/jpeg;base64,AAAA", by: "mA", createdAt: 5 });
    await setDoc(p("paymentInfo/mA"), { jazzcash: "0300", easypaisa: "", bank: "", note: "", by: "mA", updatedAt: 1 });
  });
}

const expense = (o = {}) => ({ type: "expense", description: "Taxi", amount: 50, payerId: "mA", participantIds: ["mA", "mB"], createdAt: 10, addedBy: "mA", ...o });
const settlement = (o = {}) => ({ type: "settlement", description: "Settlement", amount: 40, payerId: "mB", participantIds: ["mA"], createdAt: 10, addedBy: "mB", confirmedBy: null, confirmedAt: null, ...o });

for (const base of ["", "trips/t1/"]) {
  const label = base ? "nested trip" : "default trip";
  const R = (db, rest) => doc(db, base + rest);
  const C = (db, rest) => collection(db, base + rest);

  describe(`${label}: reading`, () => {
    test("signed-out visitors can't read anything", async () => {
      await seed(base);
      await assertFails(getDoc(R(anon(), "members/mA")));
      await assertFails(getDoc(R(anon(), "expenses/e1")));
    });
    test("an outsider (eve) can't read people, expenses, templates, receipts or payment details", async () => {
      await seed(base);
      const db = as("eve");
      await assertFails(getDoc(R(db, "members/mA")));
      await assertFails(getDocs(C(db, "members")));
      await assertFails(getDoc(R(db, "expenses/e1")));
      await assertFails(getDocs(C(db, "expenses")));
      await assertFails(getDoc(R(db, "recurring/r1")));
      await assertFails(getDoc(R(db, "receipts/e1")));
      await assertFails(getDoc(R(db, "paymentInfo/mA")));
    });
    test("an outsider can see the trip doc (name only) but no one can list trips", async () => {
      await seed(base);
      await assertSucceeds(getDoc(base ? doc(as("eve"), "trips/t1") : doc(as("eve"), "settings/trip")));
      await assertFails(getDocs(collection(as("ali"), "trips")));
    });
    test("members and the owner can read the trip", async () => {
      await seed(base);
      await assertSucceeds(getDocs(C(as("ali"), "expenses")));
      await assertSucceeds(getDocs(C(as("own"), "members")));
      await assertSucceeds(getDoc(R(as("bob"), "receipts/e1")));
      await assertSucceeds(getDoc(R(as("bob"), "paymentInfo/mA")));
    });
    test("an invitee can read the people list before claiming, but not receipts or payment details", async () => {
      await seed(base);
      await assertSucceeds(getDocs(C(as("cara"), "members")));
      await assertFails(getDoc(R(as("cara"), "receipts/e1")));
      await assertFails(getDoc(R(as("cara"), "paymentInfo/mA")));
    });
    test("an invitee with an unverified email is treated as an outsider", async () => {
      await seed(base);
      await assertFails(getDocs(C(as("cara", false), "members")));
    });
  });

  describe(`${label}: joining`, () => {
    const claim = (db, memberId, uid) => {
      const batch = writeBatch(db);
      batch.update(R(db, `members/${memberId}`), { authUid: uid });
      batch.set(R(db, `memberLinks/${uid}`), { memberId, claimedAt: 1 });
      return batch.commit();
    };
    test("the invited Google account claims its own name", async () => {
      await seed(base);
      await assertSucceeds(claim(as("cara"), "mC", "cara"));
    });
    test("an invitee can't claim someone else's name", async () => {
      await seed(base);
      await env.withSecurityRulesDisabled(async ctx => {
        await setDoc(doc(ctx.firestore(), base + "members/mD"), { name: "Dan", active: true });
      });
      await assertFails(claim(as("cara"), "mD", "cara"));
    });
    test("an outsider can't claim an unclaimed name, add themself, or link themself", async () => {
      await seed(base);
      const db = as("eve");
      await assertFails(claim(db, "mC", "eve"));
      await assertFails(setDoc(R(db, "members/mE"), { name: "Eve", active: false, authUid: "eve", createdAt: 1 }));
      await assertFails(setDoc(R(db, "memberLinks/eve"), { memberId: "mC" }));
    });
    test("only the owner can invite, and only to a real member, lowercase", async () => {
      await seed(base);
      await assertFails(setDoc(R(as("ali"), "invites/eve@x.com"), { memberId: "mC", by: "ali", createdAt: 1 }));
      await assertSucceeds(setDoc(R(as("own"), "invites/eve@x.com"), { memberId: "mC", by: "own", createdAt: 1 }));
      await assertFails(setDoc(R(as("own"), "invites/zed@x.com"), { memberId: "nope", by: "own", createdAt: 1 }));
      await assertFails(setDoc(R(as("own"), "invites/Eve@X.com"), { memberId: "mC", by: "own", createdAt: 1 }));
    });
    test("an invitee can read their own invite, not anyone else's; only the owner lists them", async () => {
      await seed(base);
      await assertSucceeds(getDoc(R(as("cara"), "invites/cara@x.com")));
      await assertFails(getDoc(R(as("eve"), "invites/cara@x.com")));
      await assertFails(getDocs(C(as("ali"), "invites")));
      await assertSucceeds(getDocs(C(as("own"), "invites")));
    });
    test("only the owner adds people, and never pre-linked to someone else", async () => {
      await seed(base);
      await assertFails(setDoc(R(as("ali"), "members/mN"), { name: "New", active: true, createdAt: 1 }));
      await assertSucceeds(setDoc(R(as("own"), "members/mN"), { name: "New", active: true, createdAt: 1 }));
      await assertFails(setDoc(R(as("own"), "members/mN2"), { name: "New", active: true, authUid: "eve", createdAt: 1 }));
    });
    test("member ids with markup are refused", async () => {
      await seed(base);
      await assertFails(setDoc(R(as("own"), 'members/x"><img src=x>'), { name: "X", active: true, createdAt: 1 }));
    });
  });

  describe(`${label}: unlinking`, () => {
    test("after the owner unlinks Bob, his old link no longer lets him act as Bob", async () => {
      await seed(base);
      await assertSucceeds(updateDoc(R(as("own"), "members/mB"), { authUid: null }));
      await assertFails(setDoc(R(as("bob"), "expenses/x1"), expense({ payerId: "mB", addedBy: "mB" })));
      await assertFails(updateDoc(R(as("bob"), "members/mB"), { name: "Bobby" }));
    });
    test("the owner can unlink but never link a name to another account", async () => {
      await seed(base);
      await assertFails(updateDoc(R(as("own"), "members/mC"), { authUid: "eve" }));
    });
    test("a member can't move their link onto someone else's name", async () => {
      await seed(base);
      await assertFails(setDoc(R(as("bob"), "memberLinks/bob"), { memberId: "mA" }));
    });
    test("people rename themselves; only the owner renames others", async () => {
      await seed(base);
      await assertSucceeds(updateDoc(R(as("bob"), "members/mB"), { name: "Bobby" }));
      await assertFails(updateDoc(R(as("bob"), "members/mA"), { name: "Hacked" }));
      await assertSucceeds(updateDoc(R(as("own"), "members/mA"), { name: "Alice K" }));
      await assertFails(updateDoc(R(as("bob"), "members/mB"), { name: "x".repeat(41) }));
    });
  });

  describe(`${label}: expenses`, () => {
    test("a member adds an expense as themself, not as someone else; outsiders not at all", async () => {
      await seed(base);
      await assertSucceeds(setDoc(R(as("ali"), "expenses/x1"), expense()));
      await assertFails(setDoc(R(as("bob"), "expenses/x2"), expense()));
      await assertFails(setDoc(R(as("eve"), "expenses/x3"), expense()));
    });
    test("bad shapes are refused: unknown fields, odd shares, huge text, markup ids, fake payer", async () => {
      await seed(base);
      const db = as("ali");
      await assertFails(setDoc(R(db, "expenses/x1"), expense({ hacked: true })));
      await assertFails(setDoc(R(db, "expenses/x2"), expense({ shares: { mA: 10, mZ: 40 } })));
      await assertFails(setDoc(R(db, "expenses/x3"), expense({ description: "x".repeat(201) })));
      await assertFails(setDoc(R(db, 'expenses/a"><b'), expense()));
      await assertFails(setDoc(R(db, "expenses/x4"), expense({ payerId: "ghost" })));
      await assertFails(setDoc(R(db, "expenses/x5"), expense({ amount: -5 })));
      await assertSucceeds(setDoc(R(db, "expenses/x6"), expense({ shares: { mA: 10, mB: 40 }, splitMode: "exact" })));
    });
    test("a closed trip refuses new expenses but still takes settlements", async () => {
      await seed(base, { closed: true });
      await assertFails(setDoc(R(as("ali"), "expenses/x1"), expense()));
      await assertSucceeds(setDoc(R(as("bob"), "expenses/x2"), settlement()));
    });
    test("authors and the owner edit an expense; others can't; nobody rewrites authorship", async () => {
      await seed(base);
      await assertSucceeds(updateDoc(R(as("ali"), "expenses/e1"), { amount: 310 }));
      await assertSucceeds(updateDoc(R(as("own"), "expenses/e1"), { description: "Dinner out" }));
      await assertFails(updateDoc(R(as("bob"), "expenses/e1"), { amount: 1 }));
      await assertFails(updateDoc(R(as("own"), "expenses/e1"), { addedBy: "mB" }));
      await assertFails(updateDoc(R(as("ali"), "expenses/e1"), { shares: { mZ: 300 } }));
    });
  });

  describe(`${label}: settlements`, () => {
    test("the payer raises a settlement to one other person", async () => {
      await seed(base);
      await assertSucceeds(setDoc(R(as("bob"), "expenses/x1"), settlement()));
    });
    test("no fake debts: not to yourself, not to two people, not pre-confirmed, not for someone else", async () => {
      await seed(base);
      const db = as("bob");
      await assertFails(setDoc(R(db, "expenses/x1"), settlement({ participantIds: ["mB"] })));
      await assertFails(setDoc(R(db, "expenses/x2"), settlement({ participantIds: ["mB", "mA"] })));
      await assertFails(setDoc(R(db, "expenses/x3"), settlement({ confirmedBy: "mA" })));
      await assertFails(setDoc(R(db, "expenses/x4"), settlement({ payerId: "mA", addedBy: "mA" })));
      await assertFails(setDoc(R(db, "expenses/x5"), settlement({ shares: { mA: 40 } })));
      await assertFails(setDoc(R(db, "expenses/x6"), settlement({ participantIds: ["ghost"] })));
    });
    test("only the person paid confirms, and only as themself", async () => {
      await seed(base);
      await assertFails(updateDoc(R(as("bob"), "expenses/s1"), { confirmedBy: "mA", confirmedAt: 7 }));
      await assertFails(updateDoc(R(as("own"), "expenses/s1"), { confirmedBy: "mA", confirmedAt: 7 }));
      await assertFails(updateDoc(R(as("ali"), "expenses/s1"), { confirmedBy: "mB", confirmedAt: 7 }));
      await assertFails(updateDoc(R(as("ali"), "expenses/s1"), { confirmedBy: "mA", confirmedAt: 7, amount: 1 }));
      await assertSucceeds(updateDoc(R(as("ali"), "expenses/s1"), { confirmedBy: "mA", confirmedAt: 7 }));
      await assertFails(updateDoc(R(as("ali"), "expenses/s1"), { confirmedBy: "mA", confirmedAt: 8 }));
    });
    test("only the person paid disputes; the owner can't", async () => {
      await seed(base);
      await assertFails(updateDoc(R(as("own"), "expenses/s1"), { disputed: true, disputedBy: "mA", disputedAt: 7 }));
      await assertSucceeds(updateDoc(R(as("ali"), "expenses/s1"), { disputed: true, disputedBy: "mA", disputedAt: 7 }));
    });
    test("the payer or the owner withdraws a pending settlement; not once confirmed; not others", async () => {
      await seed(base);
      await assertFails(updateDoc(R(as("ali"), "expenses/s1"), { deleted: true, deletedBy: "mA", deletedAt: 7 }));
      await assertSucceeds(updateDoc(R(as("bob"), "expenses/s1"), { deleted: true, deletedBy: "mB", deletedAt: 7 }));
      await assertSucceeds(updateDoc(R(as("own"), "expenses/s1"), { deleted: false, deletedBy: null, deletedAt: null }));
      await env.withSecurityRulesDisabled(async ctx => {
        await updateDoc(doc(ctx.firestore(), base + "expenses/s1"), { confirmedBy: "mA" });
      });
      await assertFails(updateDoc(R(as("bob"), "expenses/s1"), { deleted: true, deletedBy: "mB", deletedAt: 8 }));
    });
  });

  describe(`${label}: repeating expenses`, () => {
    const occ = (o = {}) => expense({ description: "Rent", amount: 900, payerId: "mA", participantIds: ["mA", "mB"], addedBy: "mA", recurringId: "r1", ...o });
    test("any member can add a due occurrence exactly as the template says", async () => {
      await seed(base);
      await assertSucceeds(setDoc(R(as("bob"), "expenses/rec_r1_20260101"), occ()));
    });
    test("an outsider can't use a template to write expenses", async () => {
      await seed(base);
      await assertFails(setDoc(R(as("eve"), "expenses/rec_r1_20260101"), occ()));
    });
    test("a member can't change the amount, payer, people or id pattern", async () => {
      await seed(base);
      const db = as("bob");
      await assertFails(setDoc(R(db, "expenses/rec_r1_20260102"), occ({ amount: 9000 })));
      await assertFails(setDoc(R(db, "expenses/rec_r1_20260103"), occ({ payerId: "mB" })));
      await assertFails(setDoc(R(db, "expenses/rec_r1_20260104"), occ({ participantIds: ["mB"] })));
      await assertFails(setDoc(R(db, "expenses/anything"), occ()));
    });
    test("templates: only by a member as themself; pause by creator or owner", async () => {
      await seed(base);
      const tmpl = { description: "Gym", amount: 100, payerId: "mB", participantIds: ["mB"], interval: "weekly", startDate: 1, active: true, createdBy: "mB", createdAt: 1 };
      await assertSucceeds(setDoc(R(as("bob"), "recurring/r2"), tmpl));
      await assertFails(setDoc(R(as("eve"), "recurring/r3"), { ...tmpl, createdBy: "mB" }));
      await assertFails(updateDoc(R(as("bob"), "recurring/r1"), { active: false }));
      await assertSucceeds(updateDoc(R(as("own"), "recurring/r1"), { active: false }));
    });
  });

  describe(`${label}: receipts and payment details`, () => {
    test("a receipt is a JPEG written by the expense's author", async () => {
      await seed(base);
      const r = { data: "data:image/jpeg;base64,AAAA", by: "mA", createdAt: 1 };
      await assertSucceeds(setDoc(R(as("ali"), "receipts/e1"), r));
      await assertFails(setDoc(R(as("bob"), "receipts/e1"), { ...r, by: "mB" }));
      await assertFails(setDoc(R(as("ali"), "receipts/e1"), { ...r, data: "https://tracker.example/pixel.gif" }));
    });
    test("payment details: only your own", async () => {
      await seed(base);
      const p = { jazzcash: "0301", easypaisa: "", bank: "", note: "", by: "mB", updatedAt: 2 };
      await assertSucceeds(setDoc(R(as("bob"), "paymentInfo/mB"), p));
      await assertFails(setDoc(R(as("bob"), "paymentInfo/mA"), { ...p, by: "mB" }));
      await assertFails(setDoc(R(as("own"), "paymentInfo/mA"), { ...p, by: "mO" }));
    });
  });

  describe(`${label}: trip settings`, () => {
    const tripRef = db => base ? doc(db, "trips/t1") : doc(db, "settings/trip");
    test("only the owner changes name, currency or closed; nobody changes the owner", async () => {
      await seed(base);
      await assertFails(updateDoc(tripRef(as("ali")), { name: "Mine" }));
      await assertFails(updateDoc(tripRef(as("eve")), { seeded: true }));
      await assertSucceeds(updateDoc(tripRef(as("own")), { name: "Hunza", closed: true }));
      await assertFails(updateDoc(tripRef(as("own")), { ownerUid: "ali" }));
    });
  });
}

describe("creating a trip", () => {
  test("you can create a trip owned by yourself, not by someone else", async () => {
    await assertSucceeds(setDoc(doc(as("ali"), "trips/new1"), { name: "Swat", currency: "PKR", ownerUid: "ali", createdAt: 1 }));
    await assertFails(setDoc(doc(as("ali"), "trips/new2"), { name: "Swat", currency: "PKR", ownerUid: "bob", createdAt: 1 }));
  });
  test("the creator adds themself and the others in one go", async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), "trips/new1"), { name: "Swat", currency: "PKR", ownerUid: "ali", createdAt: 1 });
    });
    const db = as("ali");
    const batch = writeBatch(db);
    batch.set(doc(db, "trips/new1/members/m1"), { name: "Ali", active: true, authUid: "ali", createdAt: 1 });
    batch.set(doc(db, "trips/new1/memberLinks/ali"), { memberId: "m1", claimedAt: 1 });
    batch.set(doc(db, "trips/new1/members/m2"), { name: "Bob", active: true, createdAt: 1 });
    await assertSucceeds(batch.commit());
  });
});

describe("background alerts", () => {
  const ev = (o = {}) => ({ tripKey: "default", expenseId: "e1", kind: "expense_added", fromUid: "ali", processed: false, createdAt: 10, ...o });
  const evId = (o = ev()) => `${o.tripKey}_${o.expenseId}_${o.kind}_${o.fromUid}`;

  test("a linked member writes a marker for their own trip", async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as("ali"), "pushEvents", evId()), ev()));
  });
  test("an outsider, a forged sender, a pre-processed or padded marker are refused", async () => {
    await seed();
    await assertFails(setDoc(doc(as("eve"), "pushEvents", evId(ev({ fromUid: "eve" }))), ev({ fromUid: "eve" })));
    await assertFails(setDoc(doc(as("ali"), "pushEvents", evId(ev({ fromUid: "bob" }))), ev({ fromUid: "bob" })));
    await assertFails(setDoc(doc(as("ali"), "pushEvents", evId()), ev({ processed: true })));
    await assertFails(setDoc(doc(as("ali"), "pushEvents", evId()), ev({ createdAt: "x".repeat(5000) })));
    await assertFails(setDoc(doc(as("ali"), "pushEvents", evId()), ev({ to: "bob" })));
  });
  test("the id must include the sender, so nobody can pre-empt someone else's marker", async () => {
    await seed();
    await assertFails(setDoc(doc(as("ali"), "pushEvents", "default_e1_expense_added"), ev()));
    const bobs = ev({ fromUid: "bob" });
    await assertFails(setDoc(doc(as("ali"), "pushEvents", evId(bobs)), ev()));
  });
  test("markers are create-once and never readable", async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as("ali"), "pushEvents", evId()), ev()));
    await assertFails(setDoc(doc(as("ali"), "pushEvents", evId()), ev({ createdAt: 99 })));
    await assertFails(getDoc(doc(as("ali"), "pushEvents", evId())));
  });
  test("a nested trip needs a link in THAT trip", async () => {
    await seed("trips/t1/");
    const o = ev({ tripKey: "t1", fromUid: "bob" });
    await assertSucceeds(setDoc(doc(as("bob"), "pushEvents", evId(o)), o));
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), "trips/t1/memberLinks/zed"), { memberId: "mA" }); // stale link, member not theirs
    });
    const z = ev({ tripKey: "t1", fromUid: "zed" });
    await assertFails(setDoc(doc(as("zed"), "pushEvents", evId(z)), z));
  });
  test("device tokens: only the owner of the tokens, bounded", async () => {
    await assertSucceeds(setDoc(doc(as("ali"), "pushTokens", "ali"), { tokens: ["t1"], updatedAt: 1 }));
    await assertFails(getDoc(doc(as("bob"), "pushTokens", "ali")));
    await assertFails(setDoc(doc(as("bob"), "pushTokens", "ali"), { tokens: ["evil"], updatedAt: 1 }));
    await assertFails(setDoc(doc(as("ali"), "pushTokens", "ali"), { tokens: Array(11).fill("t"), updatedAt: 1 }));
  });
});
