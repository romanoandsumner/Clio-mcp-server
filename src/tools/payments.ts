// ============================================================
// Payment-level tool: get_payments.
//
// Fills the gap left by get_bills (which only exposes bill-level paid/outstanding
// TOTALS) and the Fee Allocation report (current-state collections only). Each row
// from Clio's /allocations endpoint is ONE payment (or credit) applied to ONE bill:
// the queryable per-payment record.
//
// Voids/reversals: when a payment is voided in Clio its allocations are reversed,
// which surfaces here as reversing rows (negative `amount`). Pass
// include_reversals=false to drop non-positive rows when you only want money that
// actually landed.
//
// Trust-side cash movement (IOLTA deposits/withdrawals) is a SEPARATE surface — see
// get_matter_financial_summary / get_trust_balances, which read /bank_transactions.
//
// FIELD SET: verified against the live Clio /allocations endpoint. Clio 400s the
// WHOLE request if any single field is invalid, so only fields confirmed valid are
// requested. `type` and `payment` are NOT valid allocation fields (Clio: "type,
// payment are not valid fields"), so the parent-payment grouping isn't available
// here — `is_reversal` is derived from the amount sign instead.
//
// Deleted bill versions: when a bill is regenerated, Clio keeps the prior versions
// as `deleted` bills under the same number, and the payment's allocation surfaces
// once per version. Counting all of them inflates totals (e.g. one payment showing
// as four identical rows), so allocations on deleted bills are dropped by default.
// ============================================================
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const ALLOCATION_FIELDS =
  "id,date,amount,bill{id,number,state}," +
  "matter{id,display_number},contact{id,name}";

/** Drop allocations against deleted bill versions (see header). */
export function excludeDeletedBillAllocations<T extends { bill?: { state?: string | null } | null }>(
  allocations: T[]
): { kept: T[]; excluded: number } {
  const kept = allocations.filter((a) => a.bill?.state !== "deleted");
  return { kept, excluded: allocations.length - kept.length };
}

export function registerPaymentTools(server: McpServer): void {
  server.tool(
    "get_payments",
    "Query INDIVIDUAL payments/credits applied to bills (Clio allocations) — the per-payment detail get_bills doesn't expose. Each row is one payment applied to one bill, with `amount`, `date`, and the `bill`/`matter`/`contact`. Filter by matter, contact, bill, or date range. Voided/reversed payments surface as reversing rows (negative `amount`, flagged `is_reversal`); set include_reversals=false to drop them. Allocations against deleted bill versions (prior drafts of a regenerated bill) are excluded by default; set include_deleted_bills=true to see them. Note: rows do not distinguish cash payments from credits applied to a bill — check get_bills `credits_issued` before treating a row as cash received.",
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
        .describe("Include reversing/voided rows (non-positive amounts). Default true."),
      include_deleted_bills: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include allocations against deleted bill versions. Default false — they duplicate the live bill's payment."),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: ALLOCATION_FIELDS,
          order: "date(desc)",
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.bill_id) queryParams.bill_id = params.bill_id;

        let allocations = await fetchAllPages<any>("/allocations", queryParams);

        let excludedDeletedBills = 0;
        if (!params.include_deleted_bills) {
          const { kept, excluded } = excludeDeletedBillAllocations(allocations);
          allocations = kept;
          excludedDeletedBills = excluded;
        }

        // Date range filtered client-side on the allocation `date` (mirrors get_expenses):
        // avoids depending on a server-side date param whose name varies by resource.
        if (params.start_date) allocations = allocations.filter((a: any) => a.date >= params.start_date!);
        if (params.end_date) allocations = allocations.filter((a: any) => a.date <= params.end_date!);
        if (params.include_reversals === false) allocations = allocations.filter((a: any) => (a.amount ?? 0) > 0);

        const formatted = allocations.map((a: any) => ({
          id: a.id,
          date: a.date,
          amount: a.amount,
          is_reversal: (a.amount ?? 0) < 0,
          bill: a.bill ? { id: a.bill.id, number: a.bill.number ?? null, state: a.bill.state ?? null } : null,
          matter: a.matter ?? null,
          contact: a.contact ?? null,
        }));

        const total = Math.round(
          formatted.reduce((s: number, a: any) => s + (a.amount || 0), 0) * 100
        ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: formatted.length,
                  total_amount: total,
                  excluded_deleted_bill_rows: excludedDeletedBills,
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
