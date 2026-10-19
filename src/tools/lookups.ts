import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

// =====================================================================
// Read-only relationship lookups + first-party AR balances.
//
// Cheap GETs that remove multi-step lookups the model otherwise has to
// improvise: who's on a matter, a contact's email/phone, and Clio's own
// outstanding-balance-by-client report.
// =====================================================================

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

export function registerLookupTools(server: McpServer): void {
  // get_matter_contacts — the contacts associated with a matter.
  server.tool(
    "get_matter_contacts",
    "List the contacts associated with a matter (GET /matters/{id}/contacts), including each one's relationship to the matter (e.g. Client, Opposing Counsel), whether they're the client, and their primary email/phone.",
    {
      matter_id: z.coerce.number().describe("Clio matter ID"),
      limit: z.coerce.number().optional().default(200).describe("Max contacts to return"),
    },
    async (params) => {
      try {
        const contacts = await fetchAllPages<any>(
          `/matters/${params.matter_id}/contacts`,
          {
            fields:
              "id,name,first_name,last_name,type,is_client,relationship_name," +
              "primary_email_address,primary_phone_number",
          },
          params.limit
        );
        return ok({
          matter_id: params.matter_id,
          count: contacts.length,
          contacts: contacts.map((c: any) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            is_client: c.is_client,
            relationship: c.relationship_name,
            email: c.primary_email_address,
            phone: c.primary_phone_number,
          })),
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_matter_related_contacts — the related-contacts view for a matter.
  server.tool(
    "get_matter_related_contacts",
    "List a matter's related contacts (GET /matters/{id}/related_contacts) — the contact records linked to the matter, with the underlying contact_id, whether each is the matter client, and primary email/phone.",
    {
      matter_id: z.coerce.number().describe("Clio matter ID"),
      limit: z.coerce.number().optional().default(200).describe("Max contacts to return"),
    },
    async (params) => {
      try {
        const contacts = await fetchAllPages<any>(
          `/matters/${params.matter_id}/related_contacts`,
          {
            fields:
              "id,contact_id,name,first_name,last_name,type,is_matter_client," +
              "primary_email_address,primary_phone_number",
          },
          params.limit
        );
        return ok({
          matter_id: params.matter_id,
          count: contacts.length,
          contacts: contacts.map((c: any) => ({
            id: c.id,
            contact_id: c.contact_id,
            name: c.name,
            type: c.type,
            is_matter_client: c.is_matter_client,
            email: c.primary_email_address,
            phone: c.primary_phone_number,
          })),
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_matter_client — the client contact for a matter.
  server.tool(
    "get_matter_client",
    "Get the client contact for a matter (GET /matters/{id}/client).",
    { matter_id: z.coerce.number().describe("Clio matter ID") },
    async (params) => {
      try {
        const res = await rawGetSingle(`/matters/${params.matter_id}/client`, {
          fields: "id,name,type,first_name,last_name",
        });
        return ok({ matter_id: params.matter_id, client: res.data ?? null });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_contact_email_addresses
  server.tool(
    "get_contact_email_addresses",
    "List a contact's email addresses (GET /contacts/{id}/email_addresses), each with its label (name), address, and whether it's the primary.",
    {
      contact_id: z.coerce.number().describe("Clio contact ID"),
      limit: z.coerce.number().optional().default(100).describe("Max addresses to return"),
    },
    async (params) => {
      try {
        const rows = await fetchAllPages<any>(
          `/contacts/${params.contact_id}/email_addresses`,
          { fields: "id,name,address,primary" },
          params.limit
        );
        return ok({
          contact_id: params.contact_id,
          count: rows.length,
          email_addresses: rows.map((e: any) => ({
            id: e.id, label: e.name, address: e.address, primary: e.primary,
          })),
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_contact_phone_numbers
  server.tool(
    "get_contact_phone_numbers",
    "List a contact's phone numbers (GET /contacts/{id}/phone_numbers), each with its label (name), number, and whether it's the primary.",
    {
      contact_id: z.coerce.number().describe("Clio contact ID"),
      limit: z.coerce.number().optional().default(100).describe("Max numbers to return"),
    },
    async (params) => {
      try {
        const rows = await fetchAllPages<any>(
          `/contacts/${params.contact_id}/phone_numbers`,
          { fields: "id,name,number,primary" },
          params.limit
        );
        return ok({
          contact_id: params.contact_id,
          count: rows.length,
          phone_numbers: rows.map((p: any) => ({
            id: p.id, label: p.name, number: p.number, primary: p.primary,
          })),
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_outstanding_client_balances — Clio's first-party AR-by-client report.
  server.tool(
    "get_outstanding_client_balances",
    "Get outstanding client balances (GET /outstanding_client_balances) — Clio's first-party report of how much each client owes across their bills, with pending payments, last payment date, and newest bill due date. Filter by contact, responsible/originating attorney, and bill-due/last-paid date ranges. Use as a cross-check on get_ar_aging (the canonical AR tool), not as the primary AR figure.",
    {
      contact_id: z.coerce.number().optional().describe("Only this client's balance"),
      responsible_attorney_id: z.coerce.number().optional().describe("Only matters with this responsible attorney"),
      originating_attorney_id: z.coerce.number().optional().describe("Only matters with this originating attorney"),
      newest_bill_due_start_date: z.string().optional().describe("Newest bill due on/after this date (YYYY-MM-DD)"),
      newest_bill_due_end_date: z.string().optional().describe("Newest bill due on/before this date (YYYY-MM-DD)"),
      last_paid_start_date: z.string().optional().describe("Bills last paid on/after this date (YYYY-MM-DD)"),
      last_paid_end_date: z.string().optional().describe("Bills last paid on/before this date (YYYY-MM-DD)"),
      limit: z.coerce.number().optional().default(200).describe("Max balances to return"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields:
            "id,total_outstanding_balance,pending_payments_total,last_payment_date," +
            "newest_issued_bill_due_date,reminders_enabled,associated_matter_ids," +
            "contact{id,name},currency{id,code}",
        };
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.responsible_attorney_id) queryParams.responsible_attorney_id = params.responsible_attorney_id;
        if (params.originating_attorney_id) queryParams.originating_attorney_id = params.originating_attorney_id;
        if (params.newest_bill_due_start_date) queryParams.newest_bill_due_start_date = params.newest_bill_due_start_date;
        if (params.newest_bill_due_end_date) queryParams.newest_bill_due_end_date = params.newest_bill_due_end_date;
        if (params.last_paid_start_date) queryParams.last_paid_start_date = params.last_paid_start_date;
        if (params.last_paid_end_date) queryParams.last_paid_end_date = params.last_paid_end_date;

        const rows = await fetchAllPages<any>("/outstanding_client_balances", queryParams, params.limit);
        const balances = rows.map((b: any) => ({
          id: b.id,
          contact: b.contact,
          total_outstanding_balance: b.total_outstanding_balance,
          pending_payments_total: b.pending_payments_total,
          last_payment_date: b.last_payment_date,
          newest_issued_bill_due_date: b.newest_issued_bill_due_date,
          associated_matter_ids: b.associated_matter_ids,
          reminders_enabled: b.reminders_enabled,
          currency: b.currency?.code,
        }));
        const total = balances.reduce(
          (sum: number, b: any) => sum + (Number(b.total_outstanding_balance) || 0),
          0
        );
        return ok({ count: balances.length, total_outstanding: Math.round(total * 100) / 100, balances });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
