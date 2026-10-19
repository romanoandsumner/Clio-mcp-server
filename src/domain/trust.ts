// ============================================================
// Trust (IOLTA) ledger math, shared by get_trust_balances and
// get_matter_financial_summary.
//
// SOURCE OF TRUTH: /bank_transactions on trust bank accounts. Each row is a real
// movement of money (signed `amount`: deposits positive, disbursements and
// transfers-to-operating negative), so a matter's trust balance is the sum of
// its rows. This is what the Clio UI shows.
//
// NOT /trust_line_items. Those are the line items on trust REQUESTS (asks for a
// client to fund trust), not deposits or disbursements. Summing them reported
// $2.17M "held" firm-wide on 2026-10-19 against $786,745 actually in the trust
// accounts, and Almadani (03171) at $85,593.74 when its ledger was $40,000 in,
// $40,000 out.
// ============================================================
import { round2 } from "../utils/num";

export interface TrustAccountLike {
  id?: number | null;
  name?: string | null;
  type?: string | null;
}

/** A bank account is a trust account when Clio types it so, or its name says so. */
export function isTrustAccount(a: TrustAccountLike | null | undefined): boolean {
  if (!a) return false;
  const t = (a.type || "").toLowerCase();
  const n = (a.name || "").toLowerCase();
  return t === "trust" || n.includes("iolta") || n.includes("trust");
}

export interface TrustTransaction {
  id?: number;
  date?: string | null;
  amount?: number | null;
  matter?: { id?: number | null; display_number?: string | null } | null;
  bank_account?: { id?: number | null } | null;
}

export interface MatterTrustSummary {
  matter_id: number;
  matter_number: string | null;
  balance: number;
  funds_in: number;
  funds_out: number;
  last_deposit_date: string | null;
  last_disbursement_date: string | null;
  last_activity_date: string | null;
  transaction_count: number;
  /** Newest first. */
  transactions: TrustTransaction[];
}

/**
 * Group trust transactions by matter. Rows with no matter are totalled
 * separately: they are real money in the account (often an unassigned deposit)
 * and must be counted for the account-level reconciliation to close.
 */
export function summarizeTrustByMatter(txns: TrustTransaction[]): {
  matters: MatterTrustSummary[];
  unassigned_total: number;
  unassigned_count: number;
} {
  const sorted = [...txns].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const byMatter = new Map<number, MatterTrustSummary>();
  let unassigned = 0;
  let unassignedCount = 0;

  for (const t of sorted) {
    const amount = typeof t.amount === "number" ? t.amount : 0;
    const mid = t.matter?.id;
    if (mid == null) {
      unassigned += amount;
      unassignedCount++;
      continue;
    }
    let m = byMatter.get(mid);
    if (!m) {
      m = {
        matter_id: mid,
        matter_number: t.matter?.display_number ?? null,
        balance: 0,
        funds_in: 0,
        funds_out: 0,
        last_deposit_date: null,
        last_disbursement_date: null,
        last_activity_date: t.date ?? null,
        transaction_count: 0,
        transactions: [],
      };
      byMatter.set(mid, m);
    }
    m.balance += amount;
    if (amount > 0) {
      m.funds_in += amount;
      if (!m.last_deposit_date) m.last_deposit_date = t.date ?? null;
    } else if (amount < 0) {
      m.funds_out += -amount;
      if (!m.last_disbursement_date) m.last_disbursement_date = t.date ?? null;
    }
    m.transaction_count++;
    m.transactions.push(t);
  }

  const matters = [...byMatter.values()].map((m) => ({
    ...m,
    balance: round2(m.balance),
    funds_in: round2(m.funds_in),
    funds_out: round2(m.funds_out),
  }));
  return { matters, unassigned_total: round2(unassigned), unassigned_count: unassignedCount };
}

/**
 * Per-account check: the ledger rows for an account should sum to the balance
 * Clio reports for that account. A mismatch means the ledger pull is incomplete
 * (or Clio's account balance includes something the rows don't), so the
 * per-matter figures should not be relied on until it is explained.
 */
export function reconcileTrustAccounts(
  accounts: { id: number; name?: string | null; balance?: number | null }[],
  txns: TrustTransaction[],
): { accounts: { id: number; name: string | null; clio_balance: number; ledger_sum: number; difference: number; ok: boolean }[]; ok: boolean } {
  const sums = new Map<number, number>();
  for (const t of txns) {
    const aid = t.bank_account?.id;
    if (aid == null) continue;
    sums.set(aid, (sums.get(aid) ?? 0) + (typeof t.amount === "number" ? t.amount : 0));
  }
  const rows = accounts.map((a) => {
    const clio = round2(a.balance ?? 0);
    const ledger = round2(sums.get(a.id) ?? 0);
    const difference = round2(clio - ledger);
    return { id: a.id, name: a.name ?? null, clio_balance: clio, ledger_sum: ledger, difference, ok: Math.abs(difference) < 0.01 };
  });
  return { accounts: rows, ok: rows.every((r) => r.ok) };
}
