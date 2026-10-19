import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  fetchAllPages,
  rawGetSingle,
  rawGetBinarySingle,
  rawPatchSingle,
  rawPostSingle,
} from "../clio/pagination";
import { registerDownload } from "../utils/downloadStore";

// =====================================================================
// Bills gap — endpoints the billing tooling never wired:
//   - GET /bills/{id}/preview   rendered invoice HTML
//   - GET /billable_matters, /billable_clients   native WIP lists
//   - GET /settings/billing     firm billing configuration
//   - GET/PATCH /bill_themes     invoice templates/branding
//   - PATCH /trust_line_items/{id}, POST /trust_requests   trust writes
//
// The preview endpoint matters most: download_bill_pdf fails fast because
// Clio's OAuth API doesn't serve rendered PDFs, but /preview returns the
// full invoice as self-contained HTML (inline CSS + DOCTYPE), which can be
// viewed directly or rendered to PDF downstream.
// =====================================================================

// HTML previews are modest but can exceed a comfortable inline size; inline
// only when small, always hand back a download URL.
const MAX_INLINE_HTML_BYTES = 100 * 1024;

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

export function formatBillableMatter(m: any) {
  return {
    id: m.id,
    display_number: m.display_number,
    client: m.client,
    unbilled_hours: m.unbilled_hours,
    unbilled_amount: m.unbilled_amount,
    amount_in_trust: m.amount_in_trust,
    currency: m.currency_code,
  };
}

export function registerBillsGapTools(server: McpServer): void {
  // get_bill_preview — the rendered invoice HTML (the PDF-gap workaround).
  server.tool(
    "get_bill_preview",
    "Get the fully rendered HTML of a bill/invoice (GET /bills/{id}/preview) — self-contained HTML with inline CSS, exactly what Clio shows in its bill preview. This is the way to obtain a rendered invoice via the API (Clio's OAuth API does NOT serve bill PDFs, which is why download_bill_pdf fails); the returned HTML can be viewed in a browser/iframe or converted to PDF downstream. Returns a short-lived download URL, plus inline HTML when small (≤100 KB).",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
      include_html: z.boolean().optional().default(false)
        .describe("Also inline the HTML in the response (only when ≤100 KB)"),
    },
    async (params) => {
      try {
        // Bill number for a friendly filename (best-effort; preview works regardless).
        let number: string | number | undefined;
        try {
          const meta = await rawGetSingle(`/bills/${params.bill_id}`, { fields: "id,number" });
          number = meta.data?.number;
        } catch { /* filename fallback below */ }

        const { buffer, contentType } = await rawGetBinarySingle(`/bills/${params.bill_id}/preview`);
        const filename = `Bill-${number ?? params.bill_id}.html`;
        const reg = registerDownload(buffer, filename, "text/html");

        const out: any = {
          bill_id: params.bill_id,
          bill_number: number ?? null,
          filename,
          content_type: contentType || "text/html",
          size_kb: Math.round(buffer.length / 1024),
          direct_download_url: reg.url,
          expires_at: reg.expires_at,
          rendering_hint: "Self-contained HTML (inline CSS + DOCTYPE). Open in a browser/iframe, or render to PDF with a headless browser.",
        };
        if (params.include_html) {
          if (buffer.length <= MAX_INLINE_HTML_BYTES) {
            out.html = buffer.toString("utf8");
          } else {
            out.html_skipped = `preview is ${Math.round(buffer.length / 1024)} KB — over the ${MAX_INLINE_HTML_BYTES / 1024} KB inline limit; use direct_download_url`;
          }
        }
        return ok(out);
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_billable_matters — Clio's native WIP-by-matter list.
  server.tool(
    "get_billable_matters",
    "List billable matters (GET /billable_matters) — Clio's first-party WIP view: matters with unbilled work, each with unbilled hours/amount and amount in trust. An authoritative alternative to computing WIP from raw activities. Filter by client, attorney, matter, status, and date range. Note `amount in trust` here is Clio's figure; for the trust ledger itself use get_trust_balances.",
    {
      client_id: z.coerce.number().optional().describe("Only matters for this client"),
      matter_id: z.coerce.number().optional().describe("Only this matter"),
      responsible_attorney_id: z.coerce.number().optional().describe("Only matters with this responsible attorney"),
      originating_attorney_id: z.coerce.number().optional().describe("Only matters with this originating attorney"),
      status: z.string().optional().describe("Filter by matter status"),
      query: z.string().optional().describe("Wildcard search"),
      start_date: z.string().optional().describe("Unbilled work from this date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("Unbilled work up to this date (YYYY-MM-DD)"),
      limit: z.coerce.number().optional().default(200).describe("Max matters to return"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: "id,display_number,unbilled_hours,unbilled_amount,amount_in_trust,currency_code,client{id,name}",
        };
        for (const k of ["client_id", "matter_id", "responsible_attorney_id", "originating_attorney_id", "status", "query", "start_date", "end_date"] as const) {
          if (params[k] !== undefined) queryParams[k] = params[k];
        }
        const matters = await fetchAllPages<any>("/billable_matters", queryParams, params.limit);
        const rows = matters.map(formatBillableMatter);
        const total = rows.reduce((s: number, m: any) => s + (Number(m.unbilled_amount) || 0), 0);
        return ok({ count: rows.length, total_unbilled_amount: Math.round(total * 100) / 100, billable_matters: rows });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_billable_clients — Clio's native WIP-by-client list.
  server.tool(
    "get_billable_clients",
    "List billable clients (GET /billable_clients) — Clio's first-party roll-up of unbilled work per client (unbilled hours/amount, amount in trust, and how many billable matters each has). Filter by attorney, status, and date range.",
    {
      responsible_attorney_id: z.coerce.number().optional().describe("Only clients with matters under this responsible attorney"),
      originating_attorney_id: z.coerce.number().optional().describe("Only clients with matters under this originating attorney"),
      status: z.string().optional().describe("Filter by matter status"),
      query: z.string().optional().describe("Wildcard search on client name"),
      start_date: z.string().optional().describe("Unbilled work from this date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("Unbilled work up to this date (YYYY-MM-DD)"),
      limit: z.coerce.number().optional().default(200).describe("Max clients to return"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: "id,name,unbilled_hours,unbilled_amount,amount_in_trust,billable_matters_count",
        };
        for (const k of ["responsible_attorney_id", "originating_attorney_id", "status", "query", "start_date", "end_date"] as const) {
          if (params[k] !== undefined) queryParams[k] = params[k];
        }
        const clients = await fetchAllPages<any>("/billable_clients", queryParams, params.limit);
        const rows = clients.map((c: any) => ({
          id: c.id,
          name: c.name,
          unbilled_hours: c.unbilled_hours,
          unbilled_amount: c.unbilled_amount,
          amount_in_trust: c.amount_in_trust,
          billable_matters_count: c.billable_matters_count,
        }));
        const total = rows.reduce((s: number, c: any) => s + (Number(c.unbilled_amount) || 0), 0);
        return ok({ count: rows.length, total_unbilled_amount: Math.round(total * 100) / 100, billable_clients: rows });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_billing_settings — firm billing configuration.
  server.tool(
    "get_billing_settings",
    "Get the firm's billing settings (GET /settings/billing) — rounding rules, default tax rates/names, UTBMS usage, multi-currency config, and notification settings. Useful context for interpreting bills and time entries.",
    {},
    async () => {
      try {
        const res = await rawGetSingle("/settings/billing", {
          fields:
            "id,rounded_duration,rounding,use_decimal_rounding,currency,currency_sign," +
            "tax_rate,tax_name,apply_tax_by_default,use_secondary_tax,secondary_tax_rate," +
            "secondary_tax_name,use_utbms_codes,notify_after_bill_created,multi_currency_billing",
        });
        return ok({ billing_settings: res.data ?? res });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_bill_themes — invoice templates/branding.
  // Theme config blobs are huge (a full theme dump ran ~230 KB live), so the
  // list view returns names only; fetch one theme's config via include_config
  // + theme_id when it's needed (e.g. to feed update_bill_theme).
  server.tool(
    "get_bill_themes",
    "List the firm's bill themes (GET /bill_themes) — the invoice templates/branding presets, including which is the default. Returns id, name, and default flag; theme config blobs are large, so pass include_config=true with theme_id to fetch a single theme's full config (for update_bill_theme).",
    {
      limit: z.coerce.number().optional().default(50).describe("Max themes to return"),
      theme_id: z.coerce.number().optional().describe("Only this theme (required to include config)"),
      include_config: z.boolean().optional().default(false)
        .describe("Include the full config object — only honored when theme_id is given (configs are very large)"),
    },
    async (params) => {
      try {
        if (params.include_config && params.theme_id === undefined) {
          return fail(new Error("include_config requires theme_id — theme configs are too large to return for every theme at once."));
        }
        const withConfig = params.include_config && params.theme_id !== undefined;
        const queryParams: Record<string, any> = {
          fields: withConfig
            ? "id,name,default,config,created_at,updated_at"
            : "id,name,default,created_at,updated_at",
        };
        if (params.theme_id !== undefined) queryParams["ids[]"] = params.theme_id;
        const themes = await fetchAllPages<any>("/bill_themes", queryParams, params.limit);
        return ok({
          count: themes.length,
          bill_themes: themes.map((t: any) => ({
            id: t.id,
            name: t.name,
            default: t.default,
            ...(withConfig ? { config: t.config } : {}),
          })),
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // update_bill_theme — rename / reconfigure a theme.
  server.tool(
    "update_bill_theme",
    "Update a bill theme (PATCH /bill_themes/{id}) — change its name and/or config (invoice template/branding settings).",
    {
      theme_id: z.coerce.number().describe("Bill theme ID to update"),
      name: z.string().optional().describe("New theme name"),
      config: z.record(z.string(), z.any()).optional().describe("Replacement config object for the theme"),
    },
    async (params) => {
      try {
        const data: any = {};
        if (params.name !== undefined) data.name = params.name;
        if (params.config !== undefined) data.config = params.config;
        if (Object.keys(data).length === 0) {
          return fail(new Error("Nothing to update — pass name and/or config."));
        }
        const result = await rawPatchSingle(
          `/bill_themes/${params.theme_id}?${buildQueryString({ fields: "id,name,default,config" })}`,
          { data }
        );
        const t = result.data ?? {};
        return ok({ updated: true, bill_theme: { id: t.id, name: t.name, default: t.default, config: t.config } });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // update_trust_line_item — adjust a trust ledger line (the write side of trust).
  server.tool(
    "update_trust_line_item",
    "Update a trust line item (PATCH /trust_line_items/{id}) — adjust its date, amount (total), or note. Trust-account write; use deliberately.",
    {
      trust_line_item_id: z.coerce.number().describe("Trust line item ID to update"),
      date: z.string().optional().describe("New date (YYYY-MM-DD)"),
      total: z.coerce.number().optional().describe("New amount"),
      note: z.string().optional().describe("New note"),
    },
    async (params) => {
      try {
        const data: any = {};
        if (params.date !== undefined) data.date = params.date;
        if (params.total !== undefined) data.total = params.total;
        if (params.note !== undefined) data.note = params.note;
        if (Object.keys(data).length === 0) {
          return fail(new Error("Nothing to update — pass date, total, and/or note."));
        }
        const result = await rawPatchSingle(
          `/trust_line_items/${params.trust_line_item_id}?${buildQueryString({ fields: "id,date,total,note,matter{id,display_number}" })}`,
          { data }
        );
        return ok({ updated: true, trust_line_item: result.data ?? {} });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // create_trust_request — request a trust deposit from a client.
  server.tool(
    "create_trust_request",
    "Create a trust request (POST /trust_requests) — ask a client to fund their trust/retainer. A client-level request sets trust_type='client' with a total trust_amount; a matter-level request sets trust_type='matter' and itemizes per-matter amounts in `matters`. By default the request is created but NOT auto-approved (set approved=true to approve on creation).",
    {
      trust_type: z.enum(["client", "matter"]).describe("client = one client-level request; matter = itemized per-matter"),
      client_id: z.coerce.number().describe("The client the request is for"),
      trust_amount: z.coerce.number().optional().describe("Total requested amount (client-level requests)"),
      matters: z.array(z.object({
        id: z.coerce.number().describe("Matter id"),
        trust_amount: z.coerce.number().describe("Amount requested for this matter"),
        note: z.string().optional().describe("Matter-level note"),
      })).optional().describe("Per-matter amounts (matter-level requests)"),
      issue_date: z.string().optional().describe("Issue date (YYYY-MM-DD)"),
      due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      note: z.string().optional().describe("Client-level note"),
      currency_id: z.coerce.number().optional().describe("Currency id"),
      approved: z.boolean().optional().default(false).describe("Approve the request on creation (default false)"),
    },
    async (params) => {
      try {
        if (params.trust_type === "matter" && (!params.matters || params.matters.length === 0)) {
          return fail(new Error("trust_type='matter' requires a non-empty `matters` list."));
        }
        if (params.trust_type === "client" && params.trust_amount === undefined) {
          return fail(new Error("trust_type='client' requires trust_amount."));
        }
        const data: any = {
          trust_type: params.trust_type,
          client_id: params.client_id,
          approved: params.approved,
        };
        if (params.trust_amount !== undefined) data.trust_amount = params.trust_amount;
        if (params.matters !== undefined) data.matter = params.matters;
        if (params.issue_date !== undefined) data.issue_date = params.issue_date;
        if (params.due_date !== undefined) data.due_date = params.due_date;
        if (params.note !== undefined) data.note = params.note;
        if (params.currency_id !== undefined) data.currency_id = params.currency_id;

        const result = await rawPostSingle("/trust_requests", { data });
        return ok({ created: true, trust_request: result.data ?? {} });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
