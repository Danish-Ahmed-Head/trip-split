// Pure logic for Trip Split. No DOM, no Firebase: everything here takes plain
// data in and returns plain data out, so it can be unit-tested with `npm test`.

export const CATEGORIES = ["Food", "Transport", "Stay", "Shopping", "Fun", "Bills", "Other"];
export const UNCATEGORISED = "Uncategorised";

const isLive = e => !e.deleted;
const isSettlement = e => e.type === "settlement";

const cents = n => Math.round(n * 100) / 100;

// Who owes how much for one expense. Expenses saved with an explicit `shares`
// map (exact amounts, percentages or shares) use it; everything else, including
// every expense written before unequal splits existed, splits evenly.
export function expenseShares(e) {
  if (e.shares && typeof e.shares === "object" && Object.keys(e.shares).length) {
    return { ...e.shares };
  }
  const ids = e.participantIds || [];
  const out = {};
  if (!ids.length) return out;
  const each = e.amount / ids.length;
  ids.forEach(id => { out[id] = (out[id] || 0) + each; });
  return out;
}

export const SPLIT_MODES = ["equal", "exact", "percent", "shares"];

// Turn what the person typed into per-member amounts that add up to `total`.
// inputs: { memberId: number } for exact (amounts), percent (percentages) or
// shares (parts). Returns { ok, shares, error }. Rounded to cents; any rounding
// remainder goes to the largest share so the parts always sum to the total.
export function buildShares(mode, total, ids, inputs = {}) {
  const fail = error => ({ ok: false, shares: null, error });
  if (!(total > 0)) return fail("Enter an amount first");
  if (!ids.length) return fail("Pick at least one person to split with");
  if (mode === "equal") {
    const base = Math.floor((total * 100) / ids.length) / 100;
    const shares = {};
    ids.forEach(id => { shares[id] = base; });
    shares[ids[0]] = cents(shares[ids[0]] + (total - base * ids.length));
    return { ok: true, shares, error: null };
  }
  const vals = ids.map(id => Number(inputs[id]));
  if (vals.some(v => !Number.isFinite(v) || v < 0)) return fail("Every number must be zero or more");
  const sum = vals.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return fail("Enter at least one amount above zero");
  let amounts;
  if (mode === "exact") {
    if (Math.abs(sum - total) > 0.005) return fail(`Amounts add up to ${cents(sum)}, but the total is ${cents(total)}`);
    amounts = vals.map(cents);
  } else if (mode === "percent") {
    if (Math.abs(sum - 100) > 0.01) return fail(`Percentages add up to ${cents(sum)}, not 100`);
    amounts = vals.map(v => cents((v / 100) * total));
  } else if (mode === "shares") {
    amounts = vals.map(v => cents((v / sum) * total));
  } else {
    return fail("Unknown split type");
  }
  const diff = cents(total - amounts.reduce((a, b) => a + b, 0));
  if (diff !== 0) {
    let k = 0;
    amounts.forEach((a, i) => { if (a > amounts[k]) k = i; });
    amounts[k] = cents(amounts[k] + diff);
  }
  const shares = {};
  ids.forEach((id, i) => { if (amounts[i] > 0) shares[id] = amounts[i]; });
  return { ok: true, shares, error: null };
}

// Net balance per member. A settlement only counts once the creditor confirmed it.
export function computeBalances(members, expenses) {
  const net = {};
  members.forEach(m => { net[m.id] = 0; });
  expenses.filter(e => isLive(e) && (!isSettlement(e) || e.confirmedBy)).forEach(e => {
    if (!(e.payerId in net)) net[e.payerId] = 0;
    net[e.payerId] += e.amount;
    Object.entries(expenseShares(e)).forEach(([pid, share]) => {
      if (!(pid in net)) net[pid] = 0;
      net[pid] -= share;
    });
  });
  return net;
}

// One signed-in person's standing in a trip, found through their Google account
// link. net > 0 means the group owes them; net < 0 means they owe the group.
export function myStanding(members, expenses, uid) {
  const me = members.find(m => m.active && m.authUid === uid);
  if (!me) return { linked: false, memberId: null, net: 0 };
  const net = computeBalances(members, expenses)[me.id] || 0;
  return { linked: true, memberId: me.id, net: cents(net) };
}

// Minimal set of payments that zero everyone out.
export function computeSettlements(net) {
  const creditors = [], debtors = [];
  Object.entries(net).forEach(([id, amt]) => {
    if (amt > 0.01) creditors.push({ id, amount: amt });
    else if (amt < -0.01) debtors.push({ id, amount: -amt });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);
  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    out.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }
  return out;
}

export function pendingSettlementBetween(expenses, fromId, toId) {
  return expenses.find(e => isLive(e) && isSettlement(e) && !e.confirmedBy && !e.disputed
    && e.payerId === fromId && (e.participantIds || [])[0] === toId);
}

export function myPendingConfirmations(expenses, meId) {
  return expenses.filter(e => isLive(e) && isSettlement(e) && !e.confirmedBy && !e.disputed
    && (e.participantIds || [])[0] === meId);
}

// Per-counterparty picture for one member. net > 0 means they owe forId.
export function computePairwiseBalances(expenses, forId) {
  const pair = {};
  function bump(otherId, delta, item) {
    if (!otherId || otherId === forId) return;
    if (!pair[otherId]) pair[otherId] = { net: 0, items: [] };
    pair[otherId].net += delta;
    pair[otherId].items.push(item);
  }
  expenses.filter(isLive).forEach(e => {
    if (isSettlement(e)) {
      if (!e.confirmedBy) return;
      const debtor = e.payerId, creditor = (e.participantIds || [])[0];
      if (forId === creditor) bump(debtor, -e.amount, { desc: "Settlement received", amount: -e.amount, date: e.confirmedAt || e.createdAt });
      else if (forId === debtor) bump(creditor, +e.amount, { desc: "Settlement paid", amount: +e.amount, date: e.confirmedAt || e.createdAt });
    } else {
      const shares = expenseShares(e);
      if (!Object.keys(shares).length) return;
      if (forId === e.payerId) {
        Object.entries(shares).forEach(([pid, share]) => {
          if (pid !== forId) bump(pid, +share, { desc: e.description, amount: share, date: e.createdAt });
        });
      } else if (forId in shares) {
        bump(e.payerId, -shares[forId], { desc: e.description, amount: -shares[forId], date: e.createdAt });
      }
    }
  });
  return pair;
}

// Spending by category over live, non-settlement expenses, largest first.
export function categoryTotals(expenses) {
  const map = {};
  expenses.filter(e => isLive(e) && !isSettlement(e)).forEach(e => {
    const c = e.category || UNCATEGORISED;
    if (!map[c]) map[c] = { category: c, total: 0, count: 0 };
    map[c].total += e.amount;
    map[c].count += 1;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

// Ledger filter. f = { q, category, fromMs, toMs }; helpers = { nameOf, fmtMoney }.
export function matchesLedgerFilter(e, f, helpers) {
  const q = (f.q || "").trim().toLowerCase();
  if (q) {
    const hay = [
      e.description,
      helpers.nameOf(e.payerId),
      (e.participantIds || []).map(helpers.nameOf).join(" "),
      e.category,
      String(e.amount),
      helpers.fmtMoney(e.amount),
    ];
    if (!hay.some(s => String(s || "").toLowerCase().includes(q))) return false;
  }
  if (f.category) {
    const c = isSettlement(e) ? null : (e.category || UNCATEGORISED);
    if (c !== f.category) return false;
  }
  const t = e.createdAt || 0;
  if (f.fromMs && t < f.fromMs) return false;
  if (f.toMs && t > f.toMs) return false;
  return true;
}

// ---- recurring expenses -----------------------------------------------------
// Occurrences are derived from the start date alone and keyed by UTC date, so
// every device computes the same ids and a duplicate create is harmless.

const DAY = 86400000;

function ymd(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function occurrenceMs(startMs, interval, i) {
  if (interval === "weekly") return startMs + i * 7 * DAY;
  const s = new Date(startMs);
  const target = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + i, 1,
    s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()));
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(s.getUTCDate(), dim));
  return target.getTime();
}

// All occurrences due at or before nowMs, oldest first, capped.
export function recurrenceOccurrences(rec, nowMs, cap = 60) {
  const out = [];
  if (!rec || !rec.startDate || (rec.interval !== "weekly" && rec.interval !== "monthly")) return out;
  for (let i = 0; i < cap; i++) {
    const dueMs = occurrenceMs(rec.startDate, rec.interval, i);
    if (dueMs > nowMs) break;
    out.push({ key: ymd(dueMs), dueMs, expenseId: `rec_${rec.id}_${ymd(dueMs)}` });
  }
  return out;
}

export function nextOccurrenceMs(rec, nowMs) {
  for (let i = 0; i < 100000; i++) {
    const dueMs = occurrenceMs(rec.startDate, rec.interval, i);
    if (dueMs > nowMs) return dueMs;
  }
  return null;
}
