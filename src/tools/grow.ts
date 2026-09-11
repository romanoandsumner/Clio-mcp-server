import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENV } from "../utils/env";
import {
  growGetSingle,
  growFetchAllPages,
  growPostSingle,
  growDeleteSingle,
  resolveGrowBearer,
} from "../clio/grow";

// MCP tools for the Clio Grow API v2 (intake/CRM), covering every endpoint in
// docs/clio-grow.openapi.yaml. Grow is a separate product surface from Manage:
// its contacts/matters are intake-pipeline records that carry a `clio_id`
// pointing at the synced Clio Manage record, which is the join key back to the
// Manage tools in the rest of this server.

// Shared list-filter inputs (Grow supports these on every list endpoint).
const sinceFilters = {
  created_since: z
    .string()
    .optional()
    .describe("Only results created on/after this ISO-8601 timestamp, e.g. 2026-01-01T00:00:00Z"),
  updated_since: z
    .string()
    .optional()
    .describe("Only results updated on/after this ISO-8601 timestamp"),
  ids: z
    .array(z.number())
    .optional()
    .describe("Filter to specific Grow resource IDs (max 50)"),
  max_results: z
    .number()
    .optional()
    .describe("Cap the number of returned rows (default: all pages)"),
};

// `ids` is applied client-side (filterByIds) - Grow expects repeated ids[]
// params, which the shared buildQueryString can't express.
/**
 * Shared `include_custom_fields` argument. Grow exposes custom fields as an
 * expansion on the matter/contact payload (`include=custom_field_values`), not
 * as its own collection — there is no /custom_fields endpoint on the Grow API.
 */
const includeCustomFieldsArg = z
  .boolean()
  .optional()
  .describe(
    "Also return custom_field_values on each record (Grow's include=custom_field_values). Requires the grow_custom_field_read scope; without it the field is null and listed in redacted_fields."
  );

/**
 * Builds the `include` query param. Grow ignores unrecognised include values,
 * and custom_field_values is currently the only one it supports, so this stays
 * a single boolean rather than a free-text passthrough.
 */
export function growIncludeParams(includeCustomFields?: boolean): Record<string, string> {
  return includeCustomFields ? { include: "custom_field_values" } : {};
}

export function growListParams(args: {
  created_since?: string;
  updated_since?: string;
  ids?: number[];
}): Record<string, any> {
  const params: Record<string, any> = {};
  if (args.created_since) params.created_since = args.created_since;
  if (args.updated_since) params.updated_since = args.updated_since;
  return params;
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function growError(err: any) {
  const status = err.response?.status;
  const redirectLocation = err.response?.redirectLocation ?? err.response?.headers?.location;
  const authHint =
    status === 401 || status === 403
      ? "If every Grow tool returns 401/403, run grow_who_am_i for a diagnosis — most likely the Grow Platform app hasn't been connected for your user yet (visit /grow/oauth/start on this server). See docs/clio-grow-api-reference.md."
      : redirectLocation && /\/oauth\/authorize|auth\.api\.clio\.com/.test(String(redirectLocation))
        ? "This endpoint redirected to the auth host — the token is missing the scope it requires. Add the matching grow_* scope (e.g. a sources/settings scope) to the app's permissions and to GROW_OAUTH_SCOPE, then reconnect at /grow/oauth/start."
        : undefined;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: true,
          message: err.message,
          status,
          grow_error: err.response?.data,
          ...(redirectLocation ? { redirect_location: redirectLocation } : {}),
          ...(authHint ? { hint: authHint } : {}),
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Best-effort readout of the scopes a Grow access token actually carries.
 * Grow authorizes through the API Hub (ORY Hydra), whose access tokens are
 * typically JWTs listing granted scopes as `scp` (array) or `scope`
 * (space-delimited string). Opaque tokens can't be introspected locally, so
 * this returns null in that case (caller distinguishes "can't tell" from "[]").
 */
export function readTokenScopes(token: string | undefined): string[] | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null; // not a JWT → opaque token, can't decode
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (Array.isArray(payload.scp)) return payload.scp.map(String);
    if (typeof payload.scope === "string") return payload.scope.split(/\s+/).filter(Boolean);
    return [];
  } catch {
    return null;
  }
}

/**
 * Diagnostics comparing the scopes the app *requests* (GROW_OAUTH_SCOPE) with
 * the scopes the current token actually *carries*. `missing_scope` is the set a
 * re-consent at /grow/oauth/start would add — the direct explanation for a 403
 * on a note/custom-action endpoint. `token_scope` is null for opaque tokens.
 */
export const GROW_LEAD_INBOX_ALL_READ = "grow_lead_inbox_all_read";

/**
 * One-line reauthorization nudge for the lead-inbox-all scope. Added 2026-09:
 * without it, inbox leads submitted by other apps come back with
 * `inbox_lead_id` in `redacted_fields` rather than erroring, so the gap is
 * invisible. Surfaced whenever the scope is requested but the stored token
 * either lacks it or is opaque (can't be checked).
 */
const LEAD_INBOX_ALL_REAUTH_NOTE =
  `Reauthorize at /grow/oauth/start — the stored token is missing ${GROW_LEAD_INBOX_ALL_READ}, so inbox leads submitted by other applications return with inbox_lead_id in redacted_fields instead of populated.`;

export function growScopeReport(token: string | undefined) {
  const requested = (ENV.GROW_OAUTH_SCOPE ?? "").split(/\s+/).filter(Boolean);
  const granted = readTokenScopes(token);
  const missing = granted === null ? null : requested.filter((s) => !granted.includes(s));
  // Requested-but-unconfirmed: either explicitly absent, or unknowable (opaque).
  const leadInboxAllUnconfirmed =
    requested.includes(GROW_LEAD_INBOX_ALL_READ) &&
    (granted === null || !granted.includes(GROW_LEAD_INBOX_ALL_READ));
  return {
    requested_scope: requested,
    token_scope: granted,
    missing_scope: missing,
    ...(leadInboxAllUnconfirmed ? { lead_inbox_all_note: LEAD_INBOX_ALL_REAUTH_NOTE } : {}),
    ...(granted === null
      ? {
          scope_note:
            "The stored access token is opaque (not a JWT), so its granted scopes can't be read here. If a grow_* endpoint returns 403 after deploying new scopes, reconnect at /grow/oauth/start — existing tokens keep the scopes they were consented for.",
        }
      : {}),
  };
}

/** Client-side ids[] filter (Grow repeats the param; simpler to filter here). */
function filterByIds<T extends { id?: number }>(rows: T[], ids?: number[]): T[] {
  if (!ids?.length) return rows;
  const wanted = new Set(ids);
  return rows.filter((r) => r.id != null && wanted.has(r.id));
}

/** Aggregate Grow matters + leads into an intake-funnel summary (pure, unit-tested). */
export function summarizeGrowPipeline(
  matters: any[],
  leads: { untriaged: number; ignored: number } | null
) {
  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let hired = 0;
  for (const m of matters) {
    const cat = m.status_category ?? "unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const status = m.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const type = m.type ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (m.hired_date) hired += 1;
  }
  return {
    matters_total: matters.length,
    by_status_category: byCategory,
    by_status: byStatus,
    by_matter_type: byType,
    with_hired_date: hired,
    inbox_leads: leads,
  };
}

export function registerGrowTools(server: McpServer): void {
  // grow_who_am_i — doubles as the auth probe for the Grow API. Manage and
  // Grow share Clio's unified login, but Grow access must be enabled on the
  // OAuth app; this tool proves out the token against Grow in one call.
  server.tool(
    "grow_who_am_i",
    "Verify Clio Grow API access and return the current Grow user + firm (GET /users/who_am_i on the Grow API). Reports token_source: 'grow_oauth' (you connected the Grow Platform app at /grow/oauth/start) or 'manage_fallback' (no Grow tokens stored; trying the Manage token), plus a scopes block (requested_scope vs the token's actual token_scope, and missing_scope). Use this FIRST if any other grow_* tool errors — a 401/403 with manage_fallback means you need to connect at /grow/oauth/start; a non-empty missing_scope means the stored token predates a scope change and you must reconnect to re-consent. A lead_inbox_all_note in the scopes block means the token lacks grow_lead_inbox_all_read, so inbox leads submitted by other applications come back with inbox_lead_id redacted.",
    {},
    async () => {
      let tokenSource: string | undefined;
      let scopes: ReturnType<typeof growScopeReport> | undefined;
      try {
        const bearer = await resolveGrowBearer();
        tokenSource = bearer.source;
        scopes = growScopeReport(bearer.token);
        const me = await growGetSingle("/users/who_am_i");
        return ok({
          grow_api_base_url: ENV.GROW_API_BASE_URL,
          grow_access: "confirmed",
          token_source: tokenSource,
          scopes,
          user: me?.data ?? me,
        });
      } catch (err: any) {
        const status = err.response?.status;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                grow_api_base_url: ENV.GROW_API_BASE_URL,
                grow_access: "FAILED",
                token_source: tokenSource,
                scopes,
                status,
                grow_error: err.response?.data,
                diagnosis:
                  status === 401 || status === 403
                    ? tokenSource === "grow_oauth"
                      ? "Your stored Grow tokens were rejected. Reconnect the Grow app at /grow/oauth/start; if it persists, check the Platform app's Grow permissions in developers.api.clio.com."
                      : "The Manage token was rejected by the Grow API (expected when the Grow Platform app hasn't been connected). Visit /grow/oauth/start on this server to authorize the Grow app, then retry. If the firm's Grow account is in another region, also set GROW_API_BASE_URL (eu./ca./au. prefix)."
                    : status === 404
                      ? "Endpoint not found — GROW_API_BASE_URL may be wrong for this account's region."
                      : `Unexpected failure: ${err.message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_grow_contacts",
    "List/search Clio Grow (intake CRM) contacts, or fetch one by contact_id. Returns name, emails, phone_numbers, type (Person/Company), intake status (e.g. Unassigned/Intake/Hired/Did Not Hire), associated Grow matter ids, addresses, and clio_id (the synced Clio Manage contact ID — use it to join to Manage tools like get_contacts). Set include_custom_fields to also return custom_field_values (needs the grow_custom_field_read scope; without it the field comes back null and listed in redacted_fields).",
    {
      contact_id: z.number().optional().describe("Fetch a single Grow contact by ID (ignores other filters)"),
      query: z.string().optional().describe("Search across contact names, emails, and phone numbers"),
      include_custom_fields: includeCustomFieldsArg,
      ...sinceFilters,
    },
    async ({ contact_id, query, include_custom_fields, created_since, updated_since, ids, max_results }) => {
      try {
        const includeParams = growIncludeParams(include_custom_fields);
        if (contact_id) {
          const res = await growGetSingle(`/contacts/${contact_id}`, includeParams);
          return ok({ contact: res?.data ?? res });
        }
        const params = { ...growListParams({ created_since, updated_since }), ...includeParams };
        if (query) params.query = query;
        const rows = filterByIds(
          await growFetchAllPages<any>("/contacts", params, max_results),
          ids
        );
        return ok({ count: rows.length, contacts: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_matters",
    "List Clio Grow (intake CRM) matters, or fetch one by matter_id. Grow matters are pipeline records: status_category (intake/hired/declined), status, matter type, hired_date, location, client summary, assignee user ids, inbox_lead_id, is_locked, and clio_id (the synced Clio Manage matter ID — join key to Manage tools like get_matter / get_matter_financial_summary). Filter by inbox_lead_id to find the matter created from a lead, or submitted_only for matters submitted by this app.",
    {
      matter_id: z.number().optional().describe("Fetch a single Grow matter by ID (ignores other filters)"),
      inbox_lead_id: z.number().optional().describe("Only matters created from this inbox lead"),
      submitted_only: z.boolean().optional().describe("Only matters submitted by the current application"),
      include_custom_fields: includeCustomFieldsArg,
      ...sinceFilters,
    },
    async ({ matter_id, inbox_lead_id, submitted_only, include_custom_fields, created_since, updated_since, ids, max_results }) => {
      try {
        const includeParams = growIncludeParams(include_custom_fields);
        if (matter_id) {
          const res = await growGetSingle(`/matters/${matter_id}`, includeParams);
          return ok({ matter: res?.data ?? res });
        }
        const params = { ...growListParams({ created_since, updated_since }), ...includeParams };
        if (inbox_lead_id) params.inbox_lead_id = inbox_lead_id;
        if (submitted_only !== undefined) params.submitted_only = submitted_only;
        const rows = filterByIds(
          await growFetchAllPages<any>("/matters", params, max_results),
          ids
        );
        return ok({ count: rows.length, matters: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_matter_types",
    "List the Clio Grow account's matter types (the intake pipeline taxonomy), or fetch one by matter_type_id. Returns id, name, default (the account's fallback type for matters created without one), and timestamps. The `type` string on get_grow_matters records is one of these names. Requires the grow_matter_type_read scope.",
    {
      matter_type_id: z.number().optional().describe("Fetch a single matter type by ID (ignores other filters)"),
      ...sinceFilters,
    },
    async ({ matter_type_id, created_since, updated_since, ids, max_results }) => {
      try {
        if (matter_type_id) {
          const res = await growGetSingle(`/matter_types/${matter_type_id}`);
          return ok({ matter_type: res?.data ?? res });
        }
        const rows = filterByIds(
          await growFetchAllPages<any>(
            "/matter_types",
            growListParams({ created_since, updated_since }),
            max_results
          ),
          ids
        );
        return ok({ count: rows.length, matter_types: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_locations",
    "List the Clio Grow account's office locations, or fetch one by location_id. Returns id, name, and timestamps. The `location` string on get_grow_matters records is one of these names. Requires the grow_location_read scope.",
    {
      location_id: z.number().optional().describe("Fetch a single location by ID (ignores other filters)"),
      ...sinceFilters,
    },
    async ({ location_id, created_since, updated_since, ids, max_results }) => {
      try {
        if (location_id) {
          const res = await growGetSingle(`/locations/${location_id}`);
          return ok({ location: res?.data ?? res });
        }
        const rows = filterByIds(
          await growFetchAllPages<any>(
            "/locations",
            growListParams({ created_since, updated_since }),
            max_results
          ),
          ids
        );
        return ok({ count: rows.length, locations: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_notes",
    "List notes on a Clio Grow contact or matter (the Grow-side notes, separate from Clio Manage notes). Returns id, subject, body, timestamps.",
    {
      parent_type: z.enum(["contact", "matter"]).describe("Whether parent_id is a Grow contact or Grow matter"),
      parent_id: z.number().describe("The Grow contact ID or matter ID"),
      ...sinceFilters,
    },
    async ({ parent_type, parent_id, created_since, updated_since, ids, max_results }) => {
      try {
        const path = parent_type === "contact" ? `/contacts/${parent_id}/notes` : `/matters/${parent_id}/notes`;
        const params = growListParams({ created_since, updated_since });
        const rows = filterByIds(await growFetchAllPages<any>(path, params, max_results), ids);
        return ok({ parent_type, parent_id, count: rows.length, notes: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "create_grow_note",
    "Create a note on a Clio Grow contact or matter (e.g. an intake follow-up note). subject max 255 chars, body max 65535.",
    {
      parent_type: z.enum(["contact", "matter"]).describe("Whether parent_id is a Grow contact or Grow matter"),
      parent_id: z.number().describe("The Grow contact ID or matter ID"),
      subject: z.string().max(255).describe("Subject line of the note"),
      body: z.string().max(65535).describe("Body content of the note"),
    },
    async ({ parent_type, parent_id, subject, body }) => {
      try {
        const path = parent_type === "contact" ? `/contacts/${parent_id}/notes` : `/matters/${parent_id}/notes`;
        const res = await growPostSingle(path, { data: { subject, body } });
        return ok({ created: true, parent_type, parent_id, note: res?.data ?? res });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_inbox_leads",
    "List Clio Grow inbox leads (new/unprocessed intake leads), or fetch one by lead_id. state is required by the API: 'untriaged' (default — awaiting triage) or 'ignored'. Returns name, email, phone_number, state, timestamps. Note: leads already converted to matters no longer appear here — use get_grow_matters with inbox_lead_id instead.",
    {
      lead_id: z.number().optional().describe("Fetch a single inbox lead by ID (ignores other filters)"),
      state: z.enum(["untriaged", "ignored"]).optional().describe("Lead state to list (default 'untriaged')"),
      query: z.string().optional().describe("Search string for filtering leads"),
      ...sinceFilters,
    },
    async ({ lead_id, state, query, created_since, updated_since, ids, max_results }) => {
      try {
        if (lead_id) {
          const res = await growGetSingle(`/inbox_leads/${lead_id}`);
          return ok({ inbox_lead: res?.data ?? res });
        }
        const params = growListParams({ created_since, updated_since });
        params.state = state ?? "untriaged";
        if (query) params.query = query;
        const rows = filterByIds(
          await growFetchAllPages<any>("/inbox_leads", params, max_results),
          ids
        );
        return ok({ state: params.state, count: rows.length, inbox_leads: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "create_grow_inbox_lead",
    "Submit a new lead into the Clio Grow lead inbox (the API successor to the legacy grow.clio.com/inbox_leads form endpoint). Required: first_name, last_name, from_message, referring_url, from_source. Optionally attach email, phone_number, and a marketing_source_id (a Grow Source id from get_grow_sources).",
    {
      first_name: z.string().describe("First name of the lead"),
      last_name: z.string().describe("Last name of the lead"),
      from_message: z.string().describe("Message content from the lead"),
      referring_url: z.string().describe("URL the lead came from"),
      from_source: z.string().describe("Source of the lead, e.g. 'website_chat'"),
      email: z.string().optional().describe("Email address of the lead"),
      phone_number: z.string().optional().describe("Phone number of the lead"),
      marketing_source_id: z
        .number()
        .optional()
        .describe("ID of the Grow Source (marketing source) to associate — see get_grow_sources"),
    },
    async ({ first_name, last_name, from_message, referring_url, from_source, email, phone_number, marketing_source_id }) => {
      try {
        const data: Record<string, any> = { first_name, last_name, from_message, referring_url, from_source };
        if (email) data.email = email;
        if (phone_number) data.phone_number = phone_number;
        if (marketing_source_id) data.marketing_source = { id: marketing_source_id };
        const res = await growPostSingle("/inbox_leads", { data });
        return ok({ created: true, inbox_lead: res?.data ?? res });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_sources",
    "List the firm's Clio Grow lead sources (marketing sources) — id, name, category (standard | clio_email_marketing), is_editable.",
    { ...sinceFilters },
    async ({ created_since, updated_since, ids, max_results }) => {
      try {
        const params = growListParams({ created_since, updated_since });
        const rows = filterByIds(await growFetchAllPages<any>("/sources", params, max_results), ids);
        return ok({ count: rows.length, sources: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "create_grow_source",
    "Create a new Clio Grow lead source (marketing source). Name must be unique per account (case-insensitive).",
    { name: z.string().max(255).describe("Name of the lead source") },
    async ({ name }) => {
      try {
        const res = await growPostSingle("/sources", { data: { name } });
        return ok({ created: true, source: res?.data ?? res });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_users",
    "List users in the firm's Clio Grow account — id, name, email, and the account (firm) they belong to. Grow user IDs are what get_grow_matters returns in matter_assignee_ids.",
    { ...sinceFilters },
    async ({ created_since, updated_since, ids, max_results }) => {
      try {
        const params = growListParams({ created_since, updated_since });
        const rows = filterByIds(await growFetchAllPages<any>("/users", params, max_results), ids);
        return ok({ count: rows.length, users: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_custom_actions",
    "List this app's Clio Grow custom actions (links injected into Grow UI dropdowns; currently only on the matter page).",
    { ...sinceFilters },
    async ({ created_since, updated_since, ids, max_results }) => {
      try {
        const params = growListParams({ created_since, updated_since });
        const rows = filterByIds(await growFetchAllPages<any>("/custom_actions", params, max_results), ids);
        return ok({ count: rows.length, custom_actions: rows });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "create_grow_custom_action",
    "Create a Clio Grow custom action: a labeled link (6-32 chars) shown in the Grow matter page dropdown that opens target_url (must be https). Clio appends a single-use custom_action_nonce (60s expiry) to the URL for validating the click server-side.",
    {
      label: z.string().min(6).max(32).describe("Label shown in the Grow UI (6-32 chars)"),
      target_url: z.string().describe("HTTPS URL opened when the action is clicked"),
      ui_reference: z
        .enum(["matters/show"])
        .optional()
        .describe("Where the action appears; only 'matters/show' is supported (default)"),
    },
    async ({ label, target_url, ui_reference }) => {
      try {
        const res = await growPostSingle("/custom_actions", {
          data: { label, target_url, ui_reference: ui_reference ?? "matters/show" },
        });
        return ok({ created: true, custom_action: res?.data ?? res });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "delete_grow_custom_action",
    "Delete a Clio Grow custom action by ID (removes the link from the Grow UI).",
    { custom_action_id: z.number().describe("The custom action ID to delete") },
    async ({ custom_action_id }) => {
      try {
        await growDeleteSingle(`/custom_actions/${custom_action_id}`);
        return ok({ deleted: true, custom_action_id });
      } catch (err: any) {
        return growError(err);
      }
    }
  );

  server.tool(
    "get_grow_pipeline_report",
    "Intake pipeline snapshot from Clio Grow: matter counts by status_category (intake/hired/declined), by status, by matter type, count with a hired_date, plus untriaged/ignored inbox lead counts. Scope with created_since/updated_since (e.g. this quarter's intake). Join hired matters back to Manage revenue via each matter's clio_id.",
    {
      created_since: sinceFilters.created_since,
      updated_since: sinceFilters.updated_since,
      include_leads: z
        .boolean()
        .optional()
        .describe("Also count untriaged/ignored inbox leads (default true)"),
      include_matters: z
        .boolean()
        .optional()
        .describe("Include the underlying matter rows in the response (default false — summary only)"),
    },
    async ({ created_since, updated_since, include_leads, include_matters }) => {
      try {
        const params = growListParams({ created_since, updated_since });
        const matters = await growFetchAllPages<any>("/matters", params);

        let leads: { untriaged: number; ignored: number } | null = null;
        if (include_leads !== false) {
          const leadParams = growListParams({ created_since, updated_since });
          const [untriaged, ignored] = await Promise.all([
            growFetchAllPages<any>("/inbox_leads", { ...leadParams, state: "untriaged" }),
            growFetchAllPages<any>("/inbox_leads", { ...leadParams, state: "ignored" }),
          ]);
          leads = { untriaged: untriaged.length, ignored: ignored.length };
        }

        const summary = summarizeGrowPipeline(matters, leads);
        return ok({
          window: { created_since: created_since ?? null, updated_since: updated_since ?? null },
          ...summary,
          ...(include_matters ? { matters } : {}),
        });
      } catch (err: any) {
        return growError(err);
      }
    }
  );
}
