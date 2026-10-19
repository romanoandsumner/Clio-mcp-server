import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawDeleteSingle } from "../clio/pagination";

// =====================================================================
// Billing extras — credit memos and interest charges.
//
// These complete the billing picture the bill audit tooling can't see
// today: credits sitting against a contact, and interest accrued on
// overdue bills. Both are read-only here except delete_interest_charge
// (the only write the API exposes for either resource).
// =====================================================================

const CREDIT_MEMO_FIELDS =
  "id,date,amount,description,discount,voided_at,created_at,updated_at," +
  "contact{id,name},user{id,name}";

const INTEREST_FIELDS =
  "id,date,description,total,created_at,updated_at," +
  "bill{id,number},matters{id,display_number}";

function ok(payload: any) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: any) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: true,
        message: err.message,
        status: err.response?.status,
        clio_error: err.response?.data,
      }),
    }],
    isError: true,
  };
}

export function registerBillingExtrasTools(server: McpServer): void {
  // get_credit_memos — credits held against contacts.
  server.tool(
    "get_credit_memos",
    "USE FOR: what the firm forgave or credited a client. Lists credit memos (GET /credit_memos) — credits held against a contact that can be applied to their bills. Filter by contact. Each shows the amount, date, whether it's a discount, and any void date. A credit applied to a bill is NOT a payment: get_payments tags those rows source=credit and keeps them out of total_paid. For write-offs by timekeeper use get_monthly_revenue.",
    {
      contact_id: z.coerce.number().optional().describe("Only credit memos for this contact"),
      limit: z.coerce.number().optional().default(200).describe("Max credit memos to return (default 200)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: CREDIT_MEMO_FIELDS, order: "date(desc)" };
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        const rows = await fetchAllPages<any>("/credit_memos", queryParams, params.limit);
        const memos = rows.map((m: any) => ({
          id: m.id,
          date: m.date,
          amount: m.amount,
          description: m.description,
          is_discount: m.discount,
          voided_at: m.voided_at,
          contact: m.contact,
          user: m.user,
        }));
        const total = memos.reduce((s: number, m: any) => s + (Number(m.amount) || 0), 0);
        return ok({ count: memos.length, total_amount: Math.round(total * 100) / 100, credit_memos: memos });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_interest_charges — interest accrued on bills.
  server.tool(
    "get_interest_charges",
    "List interest charges (GET /interest_charges) — interest accrued on overdue bills. Filter by bill. Each shows the charge date, description, total, and the bill/matters it applies to.",
    {
      bill_id: z.coerce.number().optional().describe("Only interest charges on this bill"),
      limit: z.coerce.number().optional().default(200).describe("Max interest charges to return (default 200)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: INTEREST_FIELDS };
        if (params.bill_id) queryParams.bill_id = params.bill_id;
        const rows = await fetchAllPages<any>("/interest_charges", queryParams, params.limit);
        const charges = rows.map((c: any) => ({
          id: c.id,
          date: c.date,
          description: c.description,
          total: c.total,
          bill: c.bill,
          matters: c.matters,
        }));
        const total = charges.reduce((s: number, c: any) => s + (Number(c.total) || 0), 0);
        return ok({ count: charges.length, total_interest: Math.round(total * 100) / 100, interest_charges: charges });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // delete_interest_charge — remove an interest charge (the only write available).
  server.tool(
    "delete_interest_charge",
    "Delete an interest charge (DELETE /interest_charges/{id}) — e.g. to waive interest accrued on a bill. Permanent.",
    { interest_charge_id: z.coerce.number().describe("Clio interest charge ID to delete") },
    async (params) => {
      try {
        await rawDeleteSingle(`/interest_charges/${params.interest_charge_id}`);
        return ok({ deleted: true, id: params.interest_charge_id });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
