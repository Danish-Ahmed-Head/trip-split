// Decides who gets a background alert for one event, and what it says.
// Pure: plain data in, plain data out, so it is unit-tested without Firebase.
//
// An event is only a marker ("expense X changed, kind K, by Firebase user U").
// Everything else is re-derived from the expense itself, so a client can't make
// the job say something that didn't happen or tell someone who isn't involved.

import { expenseShares } from "../logic.js";

export const EVENT_KINDS = ["expense_added", "settlement_marked", "settlement_confirmed", "settlement_disputed"];

function money(n, currency) {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// -> { ok: true, messages: [{ uid, title, body, tag, link }] } or { ok: false, reason }
export function planPush({ event, expense, members, trip }) {
  const skip = reason => ({ ok: false, reason });
  if (!event || !EVENT_KINDS.includes(event.kind)) return skip("unknown kind");
  if (!expense) return skip("expense missing");
  if (expense.deleted) return skip("expense deleted");

  const live = members.filter(m => m.active);
  const actor = live.find(m => m.authUid && m.authUid === event.fromUid);
  if (!actor) return skip("sender is not a linked member");

  const nameOf = id => clip((members.find(m => m.id === id) || {}).name || "Someone", 40);
  const tripName = clip((trip && trip.name) || "Trip Split", 60);
  const currency = (trip && trip.currency) || "PKR";
  const tag = `${event.tripKey}_${event.expenseId}_${event.kind}`;
  const link = event.tripKey && event.tripKey !== "default" ? `?trip=${encodeURIComponent(event.tripKey)}` : "";
  const make = (memberId, body) => {
    const m = live.find(x => x.id === memberId);
    if (!m || !m.authUid || m.id === actor.id) return null;
    return { uid: m.authUid, title: tripName, body, tag, link };
  };
  const done = list => {
    const seen = new Set();
    const messages = list.filter(Boolean).filter(x => (seen.has(x.uid) ? false : seen.add(x.uid)));
    return messages.length ? { ok: true, messages } : skip("nobody to tell");
  };

  const creditor = (expense.participantIds || [])[0];
  const isSettlement = expense.type === "settlement";

  if (event.kind === "expense_added") {
    if (isSettlement) return skip("not an expense");
    if (expense.addedBy !== actor.id) return skip("sender did not add this expense");
    const shares = expenseShares(expense);
    const targets = new Set([...Object.keys(shares), expense.payerId]);
    return done([...targets].map(id => {
      const mine = shares[id];
      const tail = mine ? ` Your share: ${money(mine, currency)}.` : " You paid for it.";
      return make(id, `${nameOf(actor.id)} added "${clip(expense.description, 60)}" (${money(expense.amount, currency)}).${tail}`);
    }));
  }

  if (!isSettlement) return skip("not a settlement");

  if (event.kind === "settlement_marked") {
    if (expense.payerId !== actor.id) return skip("sender is not the payer");
    if (expense.confirmedBy) return skip("already confirmed");
    return done([make(creditor, `${nameOf(actor.id)} says they paid you ${money(expense.amount, currency)}. Open Trip Split to confirm it.`)]);
  }

  if (creditor !== actor.id) return skip("sender is not the person paid");

  if (event.kind === "settlement_confirmed") {
    if (expense.confirmedBy !== actor.id) return skip("not confirmed by sender");
    return done([make(expense.payerId, `${nameOf(actor.id)} confirmed your ${money(expense.amount, currency)} payment.`)]);
  }

  // settlement_disputed
  if (expense.disputed !== true || expense.disputedBy !== actor.id) return skip("not disputed by sender");
  return done([make(expense.payerId, `${nameOf(actor.id)} disputed your ${money(expense.amount, currency)} payment. Please sort it out with them.`)]);
}
