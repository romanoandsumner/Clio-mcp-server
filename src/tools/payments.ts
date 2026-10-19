// ============================================================
// Payment-level tool: get_payments.
//
// Fills the gap left by get_bills (which only exposes bill-level paid/outstanding
// TOTALS) and the Fee Allocation report (current-state collections only). Each row
// from Clio's /allocations endpoint is ONE payment (or credit) applied to ONE bill:
// the queryable per-payment record.
//
// TWO THINGS MAKE RAW ALLOCATIONS OVERSTATE WHAT A CLIENT PAID (both seen live on
// 2026-10-19):
//  1. VOIDED allocations stay in the list. Showers (01444) bill 15323 was paid
//     once ($171,064.80 on 9/13/2023, per get_bills) but has four allocation rows
//     of that amount against the same bill. A voided row carries `voided_at`, so
//     rows with it set are dropped by default.
//  2. CREDITS applied to a bill are allocations too. Showers bills 19141 ($54) and
//     20186 ($1,245.70), and Gholston (02681) bills 20359/21438 ($2,445/$964),
//     show paid=0 and credits_issued=<amount> on get_bills but an allocation row
//     each. An allocation's `parent` is the Payment or CreditMemo it came from,
//     so each row is tagged with a `source` and credits are kept out of total_paid.
//
// Reversals: a reversed payment can also surface as a negative row (`is_reversal`);
// include_reversals=false drops non-positive rows.
//
// FIELD SET: Clio 400s the WHOLE request if any single field is invalid. `type`
// and `payment` are NOT valid allocation fields. The classification fields below
// (voided_at, parent, source_bank_account, has_online_payment) are in Clio's v4
// Allocation schema but were added without a live test, so a 400/422 on them
// falls back to the base field set and the result says classification was
// unavailable rather than failing the call.
// ============================================================
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import { round2 } from "../utils/num";
import { isTrustAccount } from "../domain/trust";

const ALLOCATION_BASE_FIELDS =
  "id,date,amount,bill{id,number,state}," +
  "matter{id,display_number},contact{id,name}";
const ALLOCATION_CLASSIFY_FIELDS =
  ",voided_at,parent{id,type},source_bank_account{id,name,type},has_online_payment";

export type PaymentSource = "direct" | "trust" | "online" | "credit" | "unknown";

/**
 * Where the money on an allocation came from.
 *  - credit: applied from a credit memo. Not money received.
 *  - trust:  paid by transfer out of a trust account (the client's money, received
 *            earlier as a trust deposit).
 *  - online: paid through Clio Payments (card/eCheck).
 *  - direct: any other payment (check, wire, cash) into operating.
 *  - unknown: Clio didn't say (classification fields unavailable).
 */
export function classifyAllocation(a: any): PaymentSource {
  const parentType = String(a?.parent?.type ?? "").toLowerCase();
  if (parentType.includes("credit")) return "credit";
  if (a?.source_bank_account && isTrustAccount(a.source_bank_account)) return "trust";
  if (a?.has_online_payment) return "online";
  if (parentType === "payment") return "direct";
  return "unknown";
}

export interface AllocationQuery {
  matter_id?: number;
  contact_id?: number;
  bill_id?: number;
}

/** Fetch allocations, with classification fields when Clio accepts them. */
export async function fetchAllocations(q: AllocationQuery): Promise<{
  rows: any[];
  classified: boolean;
  fallback_reason?: string;
}> {
  const base: Record<string, any> = { order: "date(desc)" };
  if (q.matter_id) base.matter_id = q.matter_id;
  if (q.contact_id) base.contact_id = q.contact_id;
  if (q.bill_id) base.bill_id = q.bill_id;
  try {
    const rows = await fetchAllPages<any>("/allocations", {
      ...base,
      fields: ALLOCATION_BASE_FIELDS + ALLOCATION_CLASSIFY_FIELDS,
    });
    return { rows, classified: true };
  } catch (err: any) {
    const status = err.response?.status;
    if (status !== 400 && status !== 422) throw err;
    const rows = await fetchAllPages<any>("/allocations", { ...base, fields: ALLOCATION_BASE_FIELDS });
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    return { rows, classified: false, fallback_reason: `Clio rejected the classification fields (${status}): ${detail}` };
  }
}

export interface PaymentSummary {
  /** Money the client actually paid: every non-credit row. Use this for "how much did they pay". */
  total_paid: number;
  total_credits: number;
  by_source: Record<PaymentSource, number>;
  last_payment_date: string | null;
  payment_count: number;
  credit_count: number;
}

/** Totals over already-filtered allocation rows (each with a `source`). */
export function summarizePayments(rows: { amount?: number | null; date?: string | null; source: PaymentSource }[]): PaymentSummary {
  const by: Record<PaymentSource, number> = { direct: 0, trust: 0, online: 0, credit: 0, unknown: 0 };
  let last: string | null = null;
  let payments = 0;
  let credits = 0;
  for (const r of rows) {
    const amt = r.amount ?? 0;
    by[r.source] += amt;
    if (r.source === "credit") {
      credits++;
    } else {
      payments++;
      if (amt > 0 && r.date && (!last || r.date > last)) last = r.date;
    }
  }
  const rounded = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, round2(v)])) as Record<PaymentSource, number>;
  return {
    total_paid: round2(by.direct + by.trust + by.online + by.unknown),
    total_credits: rounded.credit,
    by_source: rounded,
    last_payment_date: last,
    payment_count: payments,
    credit_count: credits,
  };
}

/**
 * Check allocation rows against the bills they were applied to: per bill, the
 * non-credit rows should sum to Clio's bill `paid` and the credit rows to its
 * `credits_issued`. A mismatch means rows are being double-counted (or missed)
 * and the totals should not be trusted. Only meaningful over a bill's full
 * history, so callers skip it when a date filter is applied.
 */
export function checkAgainstBills(
  rows: { amount?: number | null; source: PaymentSource; bill?: { id?: number | null; number?: string | null } | null }[],
  bills: { id: number; number?: string | null; paid?: number | null; credits_issued?: number | null }[],
): { ok: boolean; bills_checked: number; mismatches: { bill_id: number; bill_number: string | null; allocations_paid: number; bill_paid: number; allocations_credits: number; bill_credits_issued: number }[] } {
  const sums = new Map<number, { paid: number; credits: number }>();
  for (const r of rows) {
    const id = r.bill?.id;
    if (id == null) continue;
    const s = sums.get(id) ?? { paid: 0, credits: 0 };
    if (r.source === "credit") s.credits += r.amount ?? 0;
    else s.paid += r.amount ?? 0;
    sums.set(id, s);
  }
  const mismatches = [];
  let checked = 0;
  for (const b of bills) {
    const s = sums.get(b.id) ?? { paid: 0, credits: 0 };
    // Without classification every row lands in paid, so compare the combined figure.
    const combined = rows.every((r) => r.source === "unknown");
    const allocPaid = round2(combined ? s.paid + s.credits : s.paid);
    const billPaid = round2(combined ? (b.paid ?? 0) + (b.credits_issued ?? 0) : b.paid ?? 0);
    const allocCredits = round2(s.credits);
    const billCredits = round2(b.credits_issued ?? 0);
    if (allocPaid === 0 && billPaid === 0 && allocCredits === 0 && billCredits === 0) continue;
    checked++;
    if (Math.abs(allocPaid - billPaid) >= 0.01 || (!combined && Math.abs(allocCredits - billCredits) >= 0.01)) {
      mismatches.push({
        bill_id: b.id,
        bill_number: b.number ?? null,
        allocations_paid: allocPaid,
        bill_paid: billPaid,
        allocations_credits: allocCredits,
        bill_credits_issued: billCredits,
      });
    }
  }
  return { ok: mismatches.length === 0, bills_checked: checked, mismatches };
}

async function fetchBillsForCheck(q: AllocationQuery): Promise<any[] | null> {
  const fields = "id,number,state,paid,credits_issued";
  if (q.bill_id) {
    const res = await rawGetSingle(`/bills/${q.bill_id}`, { fields });
    return res?.data ? [res.data] : [];
  }
  if (q.matter_id) return fetchAllPages<any>("/bills", { matter_id: q.matter_id, fields });
  if (q.contact_id) return fetchAllPages<any>("/bills", { client_id: q.contact_id, fields });
  return null;
}

export function registerPaymentTools(server: McpServer): void {
  server.tool(
    "get_payments",
    "USE FOR: what a client actually paid, and when — one row per payment or credit applied to a bill (Clio allocations), filterable by matter, contact, bill, or date range. Each row has a `source`: direct (check/wire/cash), trust (transferred from the client's trust funds), online (Clio Payments), or credit (a credit memo applied; NOT money received). `total_paid` excludes credits and is the figure to use for amounts paid; `total_credits` and `by_source` break out the rest. Voided allocations are excluded by default (include_voided=true to see them); reversals surface as negative rows (include_reversals=false drops them). NOT FOR: who gets credit for collections (use get_fee_allocation), money sitting in trust (use get_trust_balances), or what is still owed (use get_ar_aging / get_bills).",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      contact_id: z.coerce.number().optional().describe("Filter by contact/client ID"),
      bill_id: z.coerce.number().optional().describe("Filter to allocations against a single bill ID"),
      start_date: z.string().optional().describe("Only allocations dated on/after this date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("Only allocations dated on/before this date (YYYY-MM-DD)"),
      include_reversals: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include reversing rows (non-positive amounts). Default true."),
      include_voided: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include voided allocations (default false). Voided rows stay in Clio's list and would otherwise count a payment more than once."),
      include_credits: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include credit-memo rows (default true; they are tagged source=credit and kept out of total_paid)."),
    },
    async (params) => {
      try {
        const { rows, classified, fallback_reason } = await fetchAllocations(params);
        let allocations = rows;

        let excludedVoided = 0;
        if (classified && !params.include_voided) {
          const kept = allocations.filter((a: any) => !a.voided_at);
          excludedVoided = allocations.length - kept.length;
          allocations = kept;
        }

        // Date range filtered client-side on the allocation `date` (mirrors get_expenses):
        // avoids depending on a server-side date param whose name varies by resource.
        if (params.start_date) allocations = allocations.filter((a: any) => a.date >= params.start_date!);
        if (params.end_date) allocations = allocations.filter((a: any) => a.date <= params.end_date!);
        if (params.include_reversals === false) allocations = allocations.filter((a: any) => (a.amount ?? 0) > 0);

        let formatted = allocations.map((a: any) => ({
          id: a.id,
          date: a.date,
          amount: a.amount,
          source: classifyAllocation(a),
          is_reversal: (a.amount ?? 0) < 0,
          voided_at: a.voided_at ?? null,
          bill: a.bill ? { id: a.bill.id, number: a.bill.number ?? null, state: a.bill.state ?? null } : null,
          matter: a.matter ?? null,
          contact: a.contact ?? null,
        }));
        if (params.include_credits === false) formatted = formatted.filter((a) => a.source !== "credit");

        const summary = summarizePayments(formatted);
        const total = round2(formatted.reduce((s: number, a: any) => s + (a.amount || 0), 0));

        // Self-check against the bills, when the rows cover whole bill histories.
        const filtersRows =
          params.start_date || params.end_date || params.include_reversals === false ||
          params.include_voided || params.include_credits === false;
        let billCheck: ReturnType<typeof checkAgainstBills> | string;
        if (filtersRows) {
          billCheck = "skipped (a date, reversal, voided or credit filter changes which rows are counted)";
        } else {
          const bills = await fetchBillsForCheck(params).catch(() => null);
          billCheck = bills ? checkAgainstBills(formatted, bills) : "skipped (needs matter_id, contact_id or bill_id)";
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: formatted.length,
                  ...summary,
                  // Sum of every returned row, credits included. Kept for older callers; use total_paid.
                  total_amount: total,
                  excluded_voided_count: excludedVoided,
                  classification_available: classified,
                  bill_check: billCheck,
                  ...(classified
                    ? {}
                    : {
                        warning:
                          "Could not read voided_at/parent from Clio, so voided allocations are NOT excluded and credits are NOT separated (every row is source=unknown). Cross-check against get_bills `paid` and `credits_issued` before relying on totals.",
                        fallback_reason,
                      }),
                  payments: formatted,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
