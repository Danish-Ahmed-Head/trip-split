// One-off, read-only audit before publishing the 2026-10-15 rules.
// Prints counts and yes/no answers only: Actions logs on a public repo are
// public, so no names, emails, uids or amounts are printed.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore(initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }));
const SAFE = /^[A-Za-z0-9_-]{1,100}$/;

async function auditTrip(label, base, tripDocPath) {
  const t = await db.doc(tripDocPath).get();
  const owner = t.exists ? t.data().ownerUid || null : null;
  const members = (await db.collection(base + "members").get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const links = (await db.collection(base + "memberLinks").get()).docs.map(d => ({ uid: d.id, ...d.data() }));
  const expenses = (await db.collection(base + "expenses").get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const byId = new Map(members.map(m => [m.id, m]));
  const linkedUids = new Set(members.filter(m => m.authUid).map(m => m.authUid));
  const out = {
    trip: label,
    tripDocExists: t.exists,
    hasOwner: !!owner,
    ownerIsLinkedMember: !!owner && members.some(m => m.authUid === owner),
    tripDocKeys: t.exists ? Object.keys(t.data()).sort().join(",") : "",
    members: members.length,
    activeMembers: members.filter(m => m.active).length,
    membersWithAccount: members.filter(m => m.authUid).length,
    distinctAccounts: linkedUids.size,
    accountsOnMoreThanOneName: [...linkedUids].filter(u => members.filter(m => m.authUid === u).length > 1).length,
    unsafeMemberIds: members.filter(m => !SAFE.test(m.id)).length,
    longNames: members.filter(m => typeof m.name !== "string" || m.name.length > 40).length,
    links: links.length,
    linksMatchingMember: links.filter(l => byId.get(l.memberId)?.authUid === l.uid).length,
    expenses: expenses.length,
    unsafeExpenseIds: expenses.filter(e => !SAFE.test(e.id)).length,
    settlementsToSelf: expenses.filter(e => e.type === "settlement" && (e.participantIds || []).includes(e.payerId)).length,
    settlementsToSeveral: expenses.filter(e => e.type === "settlement" && (e.participantIds || []).length !== 1).length,
    sharesNotAddingUp: expenses.filter(e => e.shares && typeof e.shares === "object"
      && Math.abs(Object.values(e.shares).reduce((a, b) => a + (Number(b) || 0), 0) - e.amount) > 0.01).length,
    unknownExpenseKeys: [...new Set(expenses.flatMap(e => Object.keys(e)).filter(k => !["id", "type", "description", "amount", "payerId",
      "participantIds", "category", "shares", "splitMode", "hasReceipt", "createdAt", "addedBy", "recurringId", "confirmedBy",
      "confirmedAt", "disputed", "disputedBy", "disputedAt", "deleted", "deletedBy", "deletedAt", "editedAt", "editedBy"].includes(k)))].join(","),
    unknownMemberKeys: [...new Set(members.flatMap(m => Object.keys(m)).filter(k => !["id", "name", "active", "createdAt", "authUid", "claimedAt"].includes(k)))].join(","),
  };
  console.log(JSON.stringify(out));
}

await auditTrip("default", "", "settings/trip");
const trips = await db.collection("trips").get();
console.log(JSON.stringify({ otherTrips: trips.size }));
for (const t of trips.docs) await auditTrip("other trip #" + (trips.docs.indexOf(t) + 1), `trips/${t.id}/`, `trips/${t.id}`);
