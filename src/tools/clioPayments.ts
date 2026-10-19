import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  fetchAllPages,
  rawGetSingle,
  rawPostSingle,
  rawPatchSingle,
} from "../clio/pagination";

// =====================================================================
// Clio Payments — hosted pay-now links and the online payments they
// collect (/clio_payments/links, /clio_payments/payments).
//
// Requires Clio Payments to be enabled on the account; if the firm
// processes cards elsewhere these endpoints return errors.
//
// A payment link is an OUTWARD-FACING, client-payable URL. Creating one
// does not move money by itself (the client must pay), but it is the
// collection action that closes the AR loop — the URL is meant to be sent
// to a client. Links can only be expired, not edited, once created.
// =====================================================================

const LINK_FIELDS =
  "id,url,redirect_url,amount,currency,description,active,expires_at,email_address," +
  "is_allocated_as_revenue,created_at," +
  "bill{id,number},contact{id,name},destination_account{id,name}," +
  "clio_payments_payment{id,state,amount}";

const PAYMENT_FIELDS =
  "id,amount,currency,state,confirmation_number,description,email_address," +
  "deposit_as_revenue,created_at,updated_at," +
  "contact{id,name},user{id,name},destination_account{id,name}," +
  "clio_payments_link{id,url}";

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

export function formatLink(l: any) {
  return {
    id: l.id,
    url: l.url,
    amount: l.amount,
    currency: l.currency,
    description: l.description,
    active: l.active,
    expires_at: l.expires_at,
    email_address: l.email_address,
    is_allocated_as_revenue: l.is_allocated_as_revenue,
    bill: l.bill,
    contact: l.contact,
    destination_account: l.destination_account,
    payment: l.clio_payments_payment,
  };
}

function formatPayment(p: any) {
  return {
    id: p.id,
    amount: p.amount,
    currency: p.currency,
    state: p.state,
    confirmation_number: p.confirmation_number,
    description: p.description,
    contact: p.contact,
    user: p.user,
    destination_account: p.destination_account,
    link: p.clio_payments_link,
    created_at: p.created_at,
  };
}

export function registerClioPaymentsTools(server: McpServer): void {
  // get_payment_links — list existing pay-now links.
  server.tool(
    "get_payment_links",
    "List Clio Payments links (GET /clio_payments/links) — the hosted pay-now URLs generated for clients. Each shows its amount, whether it's still active, the bill/contact it's for, and any payment collected through it. Requires Clio Payments enabled on the account.",
    {
      active: z.boolean().optional().describe("Only active (unexpired) links when true; only expired when false"),
      limit: z.coerce.number().optional().default(100).describe("Max links to return (default 100)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: LINK_FIELDS };
        if (params.active !== undefined) queryParams.active = params.active;
        const links = await fetchAllPages<any>("/clio_payments/links", queryParams, params.limit);
        return ok({ count: links.length, links: links.map(formatLink) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_payment_link — single link.
  server.tool(
    "get_payment_link",
    "Get a single Clio Payments link by ID (GET /clio_payments/links/{id}), including its pay-now URL and any payment collected.",
    { link_id: z.coerce.number().describe("Clio Payments link ID") },
    async (params) => {
      try {
        const res = await rawGetSingle(`/clio_payments/links/${params.link_id}`, { fields: LINK_FIELDS });
        return ok({ link: formatLink(res.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // create_payment_link — generate a client-payable URL.
  server.tool(
    "create_payment_link",
    "Generate a Clio Payments pay-now link (POST /clio_payments/links) to send to a client. Provide exactly one target: for_bill_id (pay a specific invoice/trust request), for_contact_id (pay the contact's outstanding invoices), or for_bank_account_id (a direct payment into that account). The returned `url` is client-payable — creating it does not charge anyone; the client pays by opening it. Requires Clio Payments enabled.",
    {
      for_bill_id: z.coerce.number().optional().describe("Bill to be paid (invoice or trust request)"),
      for_contact_id: z.coerce.number().optional().describe("Contact whose outstanding invoices this link pays"),
      for_bank_account_id: z.coerce.number().optional().describe("Bank account for a direct payment link"),
      amount: z.coerce.number().optional().describe("Fixed amount to charge. Omit to let the client enter an amount."),
      currency: z.string().optional().describe("Currency code (defaults to the account's currency)"),
      description: z.string().optional().describe("Short purpose text (direct payments only)"),
      email_address: z.string().optional().describe("Pre-fill the client's email on the payment page"),
      destination_account_id: z.coerce.number().optional().describe("Bank account the payment is deposited into"),
      is_allocated_as_revenue: z.boolean().optional().describe("Direct payments only: allocate the payment as revenue"),
      duration_seconds: z.coerce.number().optional().describe("How long the link stays active, in seconds"),
    },
    async (params) => {
      try {
        const subjects = [
          params.for_bill_id !== undefined ? { id: params.for_bill_id, type: "Bill" } : null,
          params.for_contact_id !== undefined ? { id: params.for_contact_id, type: "Contact" } : null,
          params.for_bank_account_id !== undefined ? { id: params.for_bank_account_id, type: "BankAccount" } : null,
        ].filter(Boolean);
        if (subjects.length !== 1) {
          return fail(new Error("Provide exactly one of for_bill_id, for_contact_id, or for_bank_account_id."));
        }

        const data: any = { subject: subjects[0] };
        if (params.amount !== undefined) data.amount = params.amount;
        if (params.currency !== undefined) data.currency = params.currency;
        if (params.description !== undefined) data.description = params.description;
        if (params.email_address !== undefined) data.email_address = params.email_address;
        if (params.destination_account_id !== undefined) data.destination_account = { id: params.destination_account_id };
        if (params.is_allocated_as_revenue !== undefined) data.is_allocated_as_revenue = params.is_allocated_as_revenue;
        if (params.duration_seconds !== undefined) data.duration = params.duration_seconds;

        const result = await rawPostSingle(
          `/clio_payments/links?${buildQueryString({ fields: LINK_FIELDS })}`,
          { data }
        );
        return ok({ created: true, link: formatLink(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // expire_payment_link — the only mutation Clio allows on a link.
  server.tool(
    "expire_payment_link",
    "Expire (deactivate) a Clio Payments link so it can no longer be paid (PATCH /clio_payments/links/{id}). This is the only change allowed on an existing link — to alter amount/target, expire this one and create a new link.",
    { link_id: z.coerce.number().describe("Clio Payments link ID to expire") },
    async (params) => {
      try {
        const result = await rawPatchSingle(
          `/clio_payments/links/${params.link_id}?${buildQueryString({ fields: LINK_FIELDS })}`,
          { data: { expired: true } }
        );
        return ok({ expired: true, link: formatLink(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_clio_payments — online payments collected through Clio Payments.
  server.tool(
    "get_clio_payments",
    "List online payments collected through Clio Payments (GET /clio_payments/payments). Filter by bill, contact, or state. Use this to reconcile which payment links have actually been paid. Covers online payments ONLY; for everything a client paid (checks, wires, trust transfers, online) use get_payments.",
    {
      bill_id: z.coerce.number().optional().describe("Only payments allocated to this bill"),
      contact_id: z.coerce.number().optional().describe("Only payments from this contact"),
      state: z.string().optional().describe("Filter by payment state"),
      limit: z.coerce.number().optional().default(100).describe("Max payments to return (default 100)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: PAYMENT_FIELDS };
        if (params.bill_id) queryParams.bill_id = params.bill_id;
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.state) queryParams.state = params.state;
        const payments = await fetchAllPages<any>("/clio_payments/payments", queryParams, params.limit);
        return ok({ count: payments.length, payments: payments.map(formatPayment) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
