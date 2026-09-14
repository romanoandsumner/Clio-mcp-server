import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle, rawPatchSingle, rawGetSingle } from "../clio/pagination";
import { patchTimeEntrySmart, resolveActivityRouting, removeFromDraftBill, deleteActivity, discountLineItem, prepareLineSplit, mergeLineItems, prepareHourChange, prepareHardCombine, assertNewHoursSane } from "../clio/lineItems";
import { resolveActingUserId, AttributionError } from "../clio/actingUser";
import { diagnosticTool } from "../utils/diagnostics";

const TIME_ENTRY_FIELDS =
  "id,date,created_at,updated_at,quantity,rounded_quantity,price,total,note,type,billed,matter{id,display_number,description,client},user{id,name}";

// Clio's GET /activities has no `billed` query param — its documented filter
// is `status`. Note the enum distinguishes "draft" (entry sits on an
// unfinalized draft bill) from "unbilled" (entry on no bill at all): a plain
// status="unbilled" query does NOT return draft-bill entries, and Clio marks
// draft-bill entries billed=true in the response body. That combination is
// why billed="false" (strictly unbilled) can legitimately return 0 entries
// for a matter whose draft bill is full — callers wanting a draft bill's
// entries must ask for status="draft" (reported 2026-07-02).
export const TIME_ENTRY_STATUSES = [
  "draft",
  "unbilled",
  "billed",
  "billable",
  "non_billable",
  "written_off",
] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export class NarrativeConflictError extends Error {}

/**
 * Resolve the time-entry narrative from the two accepted spellings. Pure —
 * unit-tested in test/timeEntryNarrative.test.ts.
 *
 * Clio's UI labels this field "Description", so callers reach for
 * `description`; the Clio API (and this tool's original schema) calls it
 * `note`. An unrecognized key is stripped by the schema before the handler
 * runs, so a `description` passed against a note-only schema vanished
 * silently and the entry was created with a blank narrative while the tool
 * reported success. Accept both spellings, and refuse rather than guess when
 * they disagree.
 */
export function resolveNarrative(params: { note?: string; description?: string }): string | undefined {
  const { note, description } = params;
  if (note !== undefined && description !== undefined && note.trim() !== description.trim()) {
    throw new NarrativeConflictError(
      "Both `note` and `description` were supplied with different text. They are the same field — pass only one."
    );
  }
  return note ?? description;
}

/**
 * True when a narrative was requested but the entry read back from Clio does
 * not carry it. Pure — unit-tested in test/timeEntryNarrative.test.ts.
 *
 * Only meaningful against a fresh GET: Clio's POST echo is not a reliable
 * record of what persisted, so `readbackOk=false` reports no drop rather than
 * a false alarm.
 */
export function narrativeDropped(
  requested: string | undefined,
  saved: string | null | undefined,
  readbackOk: boolean
): boolean {
  if (!readbackOk || !requested) return false;
  return (saved ?? "").trim() !== requested.trim();
}

/**
 * Resolve the billed/status params into (a) the server-side Clio `status`
 * filter and (b) the client-side `billed` flag filter. Pure — unit-tested in
 * test/timeEntryScope.test.ts.
 *
 * - `status` set: passed straight through to Clio; the client-side billed
 *   filter is SKIPPED (draft entries carry billed=true — filtering on the
 *   flag would empty a status="draft" pull).
 * - billed="false": strictly unbilled (server status="unbilled" + client
 *   billed!==true) — explicitly excludes draft-bill entries.
 * - billed="true": client-side flag filter only (a server status="billed"
 *   filter would miss draft-bill entries, which read billed=true).
 */
export function resolveTimeEntryScope(
  billed: "true" | "false" | "all",
  status?: TimeEntryStatus,
): { serverStatus?: string; clientBilled?: boolean } {
  if (status) {
    if (billed !== "all") {
      throw new Error(
        `Ambiguous filter: status="${status}" cannot be combined with billed="${billed}". ` +
          `Use status alone (it is the precise Clio-side filter), or billed alone.`,
      );
    }
    return { serverStatus: status };
  }
  if (billed === "false") return { serverStatus: "unbilled", clientBilled: false };
  if (billed === "true") return { clientBilled: true };
  return {};
}

export function registerTimeTools(server: McpServer): void {
  // get_time_entries
  server.tool(
    "get_time_entries",
    "Get time entries with filters. Hours use Clio rounded_quantity (billed hours, rounded to billing increment). To pull the entries sitting on a matter's DRAFT bill, use status=\"draft\" — billed=\"false\" means strictly unbilled (on no bill at all) and deliberately EXCLUDES draft-bill entries. For the lines on one specific bill, prefer get_bill_line_items. status=\"unbilled\" covers BILLABLE unbilled time only — entries created with non_billable=true are excluded from it and appear under status=\"non_billable\", so an \"unbilled entries\" count taken here will be lower than a count of every not-yet-billed entry on the matter.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      user_id: z.coerce.number().optional().describe("Filter by user/timekeeper ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      billed: z
        .enum(["true", "false", "all"])
        .optional()
        .default("all")
        .describe("Filter by billed flag. \"false\" = strictly unbilled — excludes entries on draft bills (use status=\"draft\" for those). Cannot be combined with status."),
      status: z
        .enum(TIME_ENTRY_STATUSES)
        .optional()
        .describe("Clio-native status filter, passed through server-side. \"draft\" returns entries sitting on unfinalized draft bills — the supported way to pull a draft bill's entries per matter. \"unbilled\" EXCLUDES non-billable entries (they come back only under \"non_billable\"); pull both if you need every not-yet-billed entry. Cannot be combined with billed."),
    },
    async (params) => {
      try {
        // Resolve billed/status into the server-side Clio filter + the
        // client-side flag filter (and reject ambiguous combinations).
        let scope: { serverStatus?: string; clientBilled?: boolean };
        try {
          scope = resolveTimeEntryScope(params.billed, params.status);
        } catch (scopeErr: any) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: scopeErr.message }) }],
            isError: true,
          };
        }

        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          fields: TIME_ENTRY_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        // Clio ignores date_from/date_to — use created_since for server-side filtering
        if (params.start_date) queryParams.created_since = `${params.start_date}T00:00:00+00:00`;
        if (scope.serverStatus) queryParams.status = scope.serverStatus;

        let entries = await fetchAllPages<any>("/activities", queryParams);

        // Client-side billed-flag filter (see resolveTimeEntryScope for when
        // it applies — never on a status pull).
        if (scope.clientBilled === true) entries = entries.filter((e: any) => e.billed === true);
        else if (scope.clientBilled === false) entries = entries.filter((e: any) => e.billed !== true);

        // Client-side date filtering (created_since filters by creation, not activity date)
        if (params.start_date) entries = entries.filter((e: any) => e.date >= params.start_date!);
        if (params.end_date) entries = entries.filter((e: any) => e.date <= params.end_date!);

        const formatted = entries.map((e: any) => ({
          id: e.id,
          date: e.date,
          created_at: e.created_at ?? null,
          updated_at: e.updated_at ?? null,
          hours: Math.round(((e.rounded_quantity || e.quantity) / 3600) * 100) / 100,
          rate: e.price,
          amount: Math.round((((e.rounded_quantity || e.quantity) / 3600) * (e.price || 0)) * 100) / 100,
          description: e.note,
          billed: e.billed,
          matter: e.matter
            ? {
                id: e.matter.id,
                number: e.matter.display_number,
                description: e.matter.description,
                client: e.matter.client,
              }
            : null,
          timekeeper: e.user,
        }));

        const totalHours =
          Math.round(formatted.reduce((s: number, e: any) => s + e.hours, 0) * 100) / 100;
        const totalValue =
          Math.round(formatted.reduce((s: number, e: any) => s + e.amount, 0) * 100) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: formatted.length,
                  total_hours: totalHours,
                  total_value: totalValue,
                  // Echo the scope that was actually applied so batch callers
                  // can verify each response against the request they sent.
                  applied_filters: {
                    matter_id: params.matter_id ?? null,
                    user_id: params.user_id ?? null,
                    start_date: params.start_date ?? null,
                    end_date: params.end_date ?? null,
                    billed: params.billed,
                    status: params.status ?? null,
                  },
                  entries: formatted,
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

  // get_unbilled_time
  server.tool(
    "get_unbilled_time",
    "Get all unbilled time entries grouped by matter with subtotals and firm-wide totals. Requires user_id or matter_id to keep response sizes manageable.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      user_id: z.coerce.number().optional().describe("Filter by user/timekeeper ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD) — defaults to last 90 days if no user/matter filter"),
    },
    async (params) => {
      try {
        if (!params.user_id && !params.matter_id) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide user_id or matter_id to filter unbilled time. Use get_user_productivity for firm-wide summaries." }),
            }],
            isError: true,
          };
        }

        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          // Clio's GET /activities has no `billed` query param (verified
          // 2026-05-05 via OpenAPI). The documented filter is `status` with
          // enum value "unbilled". The previous `billed: false` here was
          // silently dropped by Clio, so this tool was returning ALL entries
          // for the matter — including ones marked billed=true on prior
          // periods' bills. Reported on matter 1780206739 (Hlavinka Gift
          // Planning): 109 entries returned, 30 of them billed=true.
          status: "unbilled",
          fields: TIME_ENTRY_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        // Default to last 90 days if no start_date provided, to prevent timeouts
        const effectiveStart = params.start_date ?? new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
        queryParams.created_since = `${effectiveStart}T00:00:00+00:00`;

        let entries = await fetchAllPages<any>("/activities", queryParams);
        // Defensive client-side filter — status="unbilled" should already
        // exclude billed entries, but belt-and-suspenders against any future
        // Clio behavior change.
        entries = entries.filter((e: any) => e.billed !== true);
        entries = entries.filter((e: any) => e.date >= effectiveStart);

        // Group by matter
        const byMatter: Record<
          number,
          { matter: any; entries: any[]; total_hours: number; total_value: number }
        > = {};

        for (const e of entries) {
          const mid = e.matter?.id ?? 0;
          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter: e.matter,
              entries: [],
              total_hours: 0,
              total_value: 0,
            };
          }
          const hours = (e.rounded_quantity || e.quantity) / 3600;
          const value = hours * (e.price || 0);
          byMatter[mid].entries.push({
            id: e.id,
            date: e.date,
            created_at: e.created_at ?? null,
            updated_at: e.updated_at ?? null,
            hours: Math.round(hours * 100) / 100,
            rate: e.price,
            amount: Math.round(value * 100) / 100,
            description: e.note,
            timekeeper: e.user,
          });
          byMatter[mid].total_hours += hours;
          byMatter[mid].total_value += value;
        }

        const matterGroups = Object.values(byMatter).map((g) => ({
          matter: g.matter,
          entry_count: g.entries.length,
          total_hours: Math.round(g.total_hours * 100) / 100,
          total_value: Math.round(g.total_value * 100) / 100,
          entries: g.entries,
        }));

        matterGroups.sort((a, b) => b.total_value - a.total_value);

        const firmTotalHours =
          Math.round(matterGroups.reduce((s, g) => s + g.total_hours, 0) * 100) / 100;
        const firmTotalValue =
          Math.round(matterGroups.reduce((s, g) => s + g.total_value, 0) * 100) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  firm_totals: {
                    total_entries: entries.length,
                    total_hours: firmTotalHours,
                    total_value: firmTotalValue,
                    matter_count: matterGroups.length,
                  },
                  by_matter: matterGroups,
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

  // test_update_time_entry — test whether Clio allows PATCH on a time entry (including on draft bills)
  diagnosticTool(server).tool(
    "test_update_time_entry",
    "Test tool: attempts to update a single time entry's description in Clio via PATCH. Use this to verify whether Clio allows modifications to time entries that are already on draft bills. Reads the entry first, applies the change, then reads again to confirm. Pass dry_run=true to just read the entry without modifying it.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID to update"),
      new_note: z.string().optional().describe("New description/note text for the entry. Required unless dry_run=true."),
      new_rate: z.coerce.number().optional().describe("Optional: new hourly rate to set"),
      new_hours: z.coerce.number().optional().describe("Optional: new hours (will be converted to seconds for Clio)"),
      dry_run: z.enum(["true", "false"]).optional().default("false").describe("If true, just reads the entry without modifying it"),
    },
    async (params) => {
      try {
        // Step 1: Read the current state
        const before = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,date,quantity,rounded_quantity,price,total,note,type,billed,matter{id,display_number},user{id,name}",
        });

        const entry = before.data;
        const beforeState = {
          id: entry.id,
          date: entry.date,
          hours: Math.round(((entry.rounded_quantity || entry.quantity) / 3600) * 100) / 100,
          rate: entry.price,
          note: entry.note,
          billed: entry.billed,
          matter: entry.matter?.display_number,
          timekeeper: entry.user?.name,
        };

        if (params.dry_run === "true") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ dry_run: true, current_entry: beforeState }, null, 2),
            }],
          };
        }

        if (!params.new_note && params.new_rate === undefined && params.new_hours === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide new_note, new_rate, or new_hours (or set dry_run=true to just read)." }),
            }],
            isError: true,
          };
        }

        // Step 2: Attempt the PATCH
        const patchBody: Record<string, any> = {};
        if (params.new_note) patchBody.note = params.new_note;
        if (params.new_rate !== undefined) patchBody.price = params.new_rate;
        if (params.new_hours !== undefined) patchBody.quantity = Math.round(params.new_hours * 3600);

        const patchResult = await rawPatchSingle(`/activities/${params.activity_id}`, {
          data: patchBody,
        });

        // Step 3: Read again to confirm
        const after = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,date,quantity,rounded_quantity,price,total,note,type,billed,matter{id,display_number},user{id,name}",
        });

        const afterEntry = after.data;
        const afterState = {
          id: afterEntry.id,
          date: afterEntry.date,
          hours: Math.round(((afterEntry.rounded_quantity || afterEntry.quantity) / 3600) * 100) / 100,
          rate: afterEntry.price,
          note: afterEntry.note,
          billed: afterEntry.billed,
          matter: afterEntry.matter?.display_number,
          timekeeper: afterEntry.user?.name,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: "PATCH succeeded — Clio allowed the update.",
              before: beforeState,
              after: afterState,
              changes_applied: patchBody,
              on_draft_bill: beforeState.billed ? "Entry was marked as billed" : "Entry was unbilled",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        const clioError = err.response?.data || err.body;

        let interpretation = "Unknown error";
        if (status === 422) interpretation = "Clio rejected the update — entry may be locked (on a finalized bill or otherwise protected).";
        else if (status === 403) interpretation = "Forbidden — insufficient permissions or entry is locked.";
        else if (status === 404) interpretation = "Activity not found — check the ID.";
        else if (status === 400) interpretation = "Bad request — check the field values.";

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              message: `PATCH failed with status ${status}`,
              interpretation,
              status,
              clio_error: clioError,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // apply_entry_revision — apply a single revision to a time entry in Clio.
  // Routes to /line_items when the entry is on a bill (Clio locks /activities
  // PATCH for any billed entry, including draft bills).
  server.tool(
    "apply_entry_revision",
    "Apply a single revision to a Clio time entry. Used during interactive audit review to update one entry at a time. Can modify the description (note), hourly rate, and/or date; hours only while the entry is unbilled. Transparently routes through /line_items when the entry is on a bill (draft or otherwise) — Clio locks PATCH /activities for billed entries, so the line_item is the editable surface for note/rate/date. An hours change on a billed entry is refused with 422 `billed_quantity_silently_ignored` (Clio accepts `quantity` on /line_items and does not apply it; sibling note/rate writes are rolled back) — use prepare_hour_change for that. Returns before/after state plus which path was used.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID to update"),
      new_note: z.string().optional().describe("Revised description/note for the entry"),
      new_rate: z.coerce.number().optional().describe("Revised hourly rate"),
      new_hours: z.coerce.number().optional().describe("Revised hours (decimal). Applies only while the entry is UNBILLED. On a billed entry (draft bills included) this is refused with 422 `billed_quantity_silently_ignored` and nothing in the call is applied; use prepare_hour_change."),
      new_date: z.string().optional().describe("Revised date in YYYY-MM-DD format. Use this instead of strip-and-recreate when only the date is changing."),
      update_original_record: z.enum(["true", "false"]).optional().describe("When the entry is on a bill, controls whether Clio also updates the underlying activity record with the same values. Default true (keep records in sync). Set to false if you want bill-line edits without altering the time-entry record."),
    },
    async (params) => {
      if (!params.new_note && params.new_rate === undefined && params.new_hours === undefined && params.new_date === undefined) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: "Provide at least one of: new_note, new_rate, new_hours, new_date" }),
          }],
          isError: true,
        };
      }

      const patch: Record<string, any> = {};
      if (params.new_note) patch.note = params.new_note;
      if (params.new_rate !== undefined) patch.price = params.new_rate;
      if (params.new_hours !== undefined) patch.hours = params.new_hours;
      if (params.new_date !== undefined) patch.date = params.new_date;
      if (params.update_original_record !== undefined) patch.update_original_record = params.update_original_record === "true";

      try {
        const result = await patchTimeEntrySmart(params.activity_id, patch);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              path: result.path,
              activity_id: result.activity_id,
              line_item_id: result.line_item_id,
              bill: result.bill,
              before: result.before,
              after: result.after,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              activity_id: params.activity_id,
              status,
              message: err.message,
              clio_error: err.response?.data || err.body,
              request_body: err.response?.request_body,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // find_line_item_for_activity — resolve the line_item record (if any) that
  // shadows a given activity on a bill. Diagnostic helper for the line_items
  // PATCH path.
  server.tool(
    "find_line_item_for_activity",
    "Find the line_item record that shadows a time entry once it's been added to a bill. Returns the line_item ID and current fields, or null if the entry is unbilled. Activities on bills (even draft) are locked by Clio's API for direct PATCH /activities/{id}; the line_item is the editable surface.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID"),
    },
    async (params) => {
      try {
        const routing = await resolveActivityRouting(params.activity_id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              activity_id: routing.activity.id,
              billed_flag: routing.activity.billed,
              bill: routing.bill,
              line_item: routing.line_item,
              edit_path: routing.bill
                ? (routing.line_item
                  ? `PATCH /line_items/${routing.line_item.id} — use update_billed_time_entry or test_update_line_item`
                  : "Activity is on a bill but no matching line_item was found — investigate")
                : "PATCH /activities/{id} — entry is unbilled, direct activity edits work",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              status: err.response?.status,
              message: err.message,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // test_update_line_item — diagnostic: PATCH a single line_item with the
  // fields you specify and report Clio's response verbatim. Used to discover
  // which fields are writable on /line_items (the API reference is
  // auth-walled, so empirical probing is the practical path).
  diagnosticTool(server).tool(
    "test_update_line_item",
    "Diagnostic: PATCH a single line_item directly with the fields you specify and report Clio's response verbatim. Confirmed-writable fields: note, price, quantity, date. Read-only / computed (Clio rejects with 422): rounded_quantity, total, type, billed. Pass dry_run=true to just read the line_item.",
    {
      line_item_id: z.coerce.number().describe("The line_item ID (use find_line_item_for_activity to resolve from an activity_id)"),
      new_note: z.string().optional().describe("Activity narrative / line text (writable)"),
      new_description: z.string().optional().describe("Probe-only: try writing 'description' (read field name; may not be writable)"),
      new_quantity_hours: z.coerce.number().optional().describe("Decimal hours, written directly to /line_items.quantity (no unit conversion — Clio's /line_items endpoint takes hours, unlike /activities which takes seconds)."),
      new_price: z.coerce.number().optional().describe("Hourly rate (writable)"),
      new_date: z.string().optional().describe("Date YYYY-MM-DD (writable)"),
      new_total: z.coerce.number().optional().describe("Probe-only: try 'total' (likely read-only)"),
      new_discount_total: z.coerce.number().optional().describe("Probe-only: try 'discount_total' (writability uncertain)"),
      dry_run: z.enum(["true", "false"]).optional().default("false").describe("If true, just reads the line_item"),
    },
    async (params) => {
      const readFields =
        "id,description,note,quantity,rounded_quantity,price,total,discount_total,activity{id,note},bill{id,state,number}";
      try {
        const before = await rawGetSingle(`/line_items/${params.line_item_id}`, { fields: readFields });
        if (params.dry_run === "true") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ dry_run: true, current: before.data }, null, 2),
            }],
          };
        }

        const body: Record<string, any> = {};
        if (params.new_note !== undefined) body.note = params.new_note;
        if (params.new_description !== undefined) body.description = params.new_description;
        if (params.new_quantity_hours !== undefined) body.quantity = params.new_quantity_hours;
        if (params.new_price !== undefined) body.price = params.new_price;
        if (params.new_date !== undefined) body.date = params.new_date;
        if (params.new_total !== undefined) body.total = params.new_total;
        if (params.new_discount_total !== undefined) body.discount_total = params.new_discount_total;

        if (Object.keys(body).length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide at least one new_* field, or set dry_run=true." }),
            }],
            isError: true,
          };
        }

        await rawPatchSingle(`/line_items/${params.line_item_id}`, { data: body });
        const after = await rawGetSingle(`/line_items/${params.line_item_id}`, { fields: readFields });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              line_item_id: params.line_item_id,
              fields_attempted: body,
              before: before.data,
              after: after.data,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        let interpretation = "Unknown error";
        if (status === 422) interpretation = "Clio rejected one or more fields — check clio_error for which.";
        else if (status === 403) interpretation = "Forbidden — line_item may be locked (bill issued/finalized) or insufficient permissions.";
        else if (status === 404) interpretation = "Line item not found.";
        else if (status === 400) interpretation = "Bad request — field shape may be wrong.";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              line_item_id: params.line_item_id,
              status,
              interpretation,
              message: err.message,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // update_billed_time_entry — production tool with smart routing. Use this
  // anywhere we'd previously have called apply_entry_revision; it's the same
  // helper but with a name that signals it handles the billed case.
  server.tool(
    "update_billed_time_entry",
    "Update a time entry's note/rate/date — and its hours ONLY while the entry is unbilled. If unbilled, PATCHes /activities/{id} and every field including hours applies. If on a draft (or any) bill, finds the corresponding line_item and PATCHes /line_items/{id} — the editable surface for note/rate/date on a billed entry, and, on a DRAFT bill, often for hours as well. Hours written this way are SNAPPED UP to the firm's billing increment (read live from GET /settings/billing) before the write, and the applied value is reported back in `quantity_rounding` - ask for 0.25h on a 0.2h grid and the line lands at 0.4h. Clio does not always accept a quantity edit on a billed line (the quantity is sourced from the activity, which is locked while billed); when the read-back shows the line did not reach the snapped value the call is refused with 422 `billed_quantity_silently_ignored`, whose payload states whether the quantity nevertheless persisted and which sibling fields were rolled back. That guard never rewrites quantity. For a predictable hour change on a line already on a DRAFT bill, prefer `prepare_hour_change` — and read its caveat: the line leaves the bill until the draft is regenerated in the Clio UI, which also wipes every line-item discount. Returns which path was used so you can audit.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID"),
      new_note: z.string().optional().describe("Revised description/note"),
      new_rate: z.coerce.number().optional().describe("Hourly rate (dollars)"),
      new_hours: z.coerce.number().optional().describe("Hours (decimal). While UNBILLED, applied as sent (helper converts to the seconds /activities expects). On an entry sitting on a bill - draft included - the value is first snapped UP to the firm's billing increment and the applied value is returned in `quantity_rounding`; if the line does not reach that value the call is refused with 422 `billed_quantity_silently_ignored`, which reports whether the quantity change persisted. prepare_hour_change is the predictable path for billed lines."),
      new_date: z.string().optional().describe("New date YYYY-MM-DD. Use this for date-only changes instead of strip-and-recreate."),
      update_original_record: z.enum(["true", "false"]).optional().describe("When the entry is on a bill, controls whether Clio also updates the underlying activity record. Default true (keep records in sync)."),
    },
    async (params) => {
      if (params.new_note === undefined && params.new_rate === undefined && params.new_hours === undefined && params.new_date === undefined) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: "Provide at least one of: new_note, new_rate, new_hours, new_date" }),
          }],
          isError: true,
        };
      }

      const patch: Record<string, any> = {};
      if (params.new_note !== undefined) patch.note = params.new_note;
      if (params.new_rate !== undefined) patch.price = params.new_rate;
      if (params.new_hours !== undefined) patch.hours = params.new_hours;
      if (params.new_date !== undefined) patch.date = params.new_date;
      if (params.update_original_record !== undefined) patch.update_original_record = params.update_original_record === "true";

      try {
        const result = await patchTimeEntrySmart(params.activity_id, patch);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              path: result.path,
              activity_id: result.activity_id,
              line_item_id: result.line_item_id,
              bill: result.bill,
              before: result.before,
              after: result.after,
              quantity_rounding: result.quantity_rounding,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              activity_id: params.activity_id,
              status,
              message: err.message,
              clio_error: err.response?.data || err.body,
              request_body: err.response?.request_body,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // remove_from_draft_bill — DELETE /line_items/{id} for a draft bill only.
  // Refuses if the bill is in any non-draft state (issued, awaiting_payment,
  // paid, void) — those edits can corrupt accounting. Use this before split
  // or combine when the source entry is on a draft bill.
  server.tool(
    "remove_from_draft_bill",
    "Remove a time entry from a DRAFT bill (unbills it). The underlying activity is preserved — only the bill association is removed. Refuses if the bill is not in 'draft' state. Accepts either line_item_id or activity_id (the line_item is resolved automatically for activity_id). Use this before split/combine when the source entry is on a draft bill.",
    {
      line_item_id: z.coerce.number().optional().describe("Line item ID (preferred if known). Use find_line_item_for_activity to resolve from an activity."),
      activity_id: z.coerce.number().optional().describe("Activity ID. Will be resolved to the line_item on its draft bill."),
    },
    async (params) => {
      if (params.line_item_id === undefined && params.activity_id === undefined) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: "Provide line_item_id or activity_id." }),
          }],
          isError: true,
        };
      }
      try {
        const result = await removeFromDraftBill({
          line_item_id: params.line_item_id,
          activity_id: params.activity_id,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              removed: {
                line_item_id: result.line_item_id,
                activity_id: result.activity_id,
                bill: result.bill,
              },
              note: "Activity preserved; only the bill association was removed. The entry now reads as unbilled and can be edited via PATCH /activities or re-added to a bill.",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              status,
              message: err.message,
              context: err.response?.data?.context,
              bill_state: err.response?.data?.bill_state,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // delete_activity — DELETE /activities/{id}. If the activity is on a
  // draft bill, automatically removes the line_item first (per user
  // direction: "if the user asks to delete rather than remove, you can
  // remove then delete without asking"). Refuses for non-draft bills.
  server.tool(
    "delete_activity",
    "Delete a time entry (activity) from Clio. If the entry is on a DRAFT bill, automatically removes the line_item first, then deletes the activity. Refuses if the entry is on a non-draft bill (issued/awaiting_payment/paid/void) — those touch accounting and require manual handling. Use this for junk-entry cleanup; the line_item removal and activity deletion are reported separately so you can audit.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID to delete"),
    },
    async (params) => {
      try {
        const result = await deleteActivity(params.activity_id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              activity_id: result.activity_id,
              removed_from_bill: result.removed_from_bill,
              deleted_activity: result.deleted_activity,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              activity_id: params.activity_id,
              status,
              message: err.message,
              context: err.response?.data?.context,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // discount_line_item — apply a percentage or dollar discount to a
  // line_item on a DRAFT bill. Preserves the original rate; reduces total
  // via discount_total. Caller picks discount_amount OR discount_pct.
  server.tool(
    "discount_line_item",
    "Apply a discount to a billed line_item on a DRAFT bill. Preserves the original rate (the bill still shows '$X/hr × Y hr = $Z less discount $D = $E') instead of zeroing the rate. Provide exactly one of discount_amount (dollars off) or discount_pct (percentage of current line total, e.g. 25 = 25%). Accepts either line_item_id or activity_id; if activity_id is given, the line_item is resolved automatically. Refuses if the bill is not in draft state.",
    {
      line_item_id: z.coerce.number().optional().describe("Line item ID (preferred if known)"),
      activity_id: z.coerce.number().optional().describe("Activity ID; resolved to line_item on its draft bill"),
      discount_amount: z.coerce.number().optional().describe("Dollars off the line (e.g. 50 for $50 off). Provide this OR discount_pct, not both."),
      discount_pct: z.coerce.number().optional().describe("Percentage discount (e.g. 25 for 25% off). Computed against current line total."),
    },
    async (params) => {
      try {
        const result = await discountLineItem({
          line_item_id: params.line_item_id,
          activity_id: params.activity_id,
          discount_amount: params.discount_amount,
          discount_pct: params.discount_pct,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              line_item_id: result.line_item_id,
              activity_id: result.activity_id,
              bill: result.bill,
              discount_amount_applied: result.discount_amount_applied,
              discount_pct_applied: result.discount_pct_applied,
              before: result.before,
              after: result.after,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              status,
              message: err.message,
              context: err.response?.data?.context,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // prepare_line_split — split a line on a draft bill into multiple
  // sub-entries. API does the prep; user finishes the workflow by
  // clicking "Regenerate Draft" in Clio UI to pull the new activities
  // onto the bill (Clio's API doesn't support adding line items to an
  // existing bill — verified against their full OpenAPI).
  server.tool(
    "prepare_line_split",
    "Split a line item on a DRAFT bill into multiple sub-entries with allocated hours and distinct narratives. Creates N new activities on the matter (one per split, inheriting date/user/rate from the original), then DELETES the original activity (which auto-removes its line from the draft). All new activities sit unbilled — Clio's API does NOT support adding line items to an existing bill, so the caller must click 'Regenerate Draft' in Clio UI to pull the new activities onto the bill. (The delete-then-recreate approach is required because Clio's PATCH /line_items silently ignores `quantity` edits for ActivityLineItem types — there's no API path to shrink an existing billed line in place.) Strict total: split hours must sum to the original line's hours. Refuses if the bill is not in draft state. Use case: splitting a block-billed entry like 0.6h into [0.2h Subtask A, 0.2h Subtask B, 0.2h Subtask C].",
    {
      line_item_id: z.coerce.number().optional().describe("Line item ID (preferred if known)"),
      activity_id: z.coerce.number().optional().describe("Activity ID; resolved to its line_item on a draft bill"),
      splits_json: z
        .string()
        .describe(
          "JSON-encoded array of at least 2 sub-entries, each an object with `hours` (decimal) and `note` (string). Example: '[{\"hours\":0.2,\"note\":\"Subtask A\"},{\"hours\":0.2,\"note\":\"Subtask B\"},{\"hours\":0.2,\"note\":\"Subtask C\"}]'. Sum of hours must equal the original line's hours. (Encoded as a JSON string because the MCP SDK's tool-list serialization rejects nested array-of-object zod schemas in some clients.)",
        ),
    },
    async (params) => {
      try {
        let splits: Array<{ hours: number; note: string }>;
        try {
          const parsed = JSON.parse(params.splits_json);
          if (!Array.isArray(parsed)) {
            throw new Error("splits_json must decode to an array");
          }
          splits = parsed;
        } catch (parseErr: any) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `splits_json could not be parsed as JSON: ${parseErr.message}`,
                hint: "Provide a JSON-encoded array, e.g. '[{\"hours\":0.1,\"note\":\"A\"},{\"hours\":0.1,\"note\":\"B\"}]'",
              }, null, 2),
            }],
            isError: true,
          };
        }

        const result = await prepareLineSplit({
          line_item_id: params.line_item_id,
          activity_id: params.activity_id,
          splits,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              line_item_id: result.line_item_id,
              activity_id: result.activity_id,
              bill: result.bill,
              matter: result.matter,
              original: result.original,
              edited_line: result.edited_line,
              new_activities: result.new_activities,
              ui_instruction: result.ui_instruction,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              status,
              message: err.message,
              context: err.response?.data?.context,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // merge_line_items — soft-merge multiple secondary lines into a primary
  // line on a draft bill. Updates the primary's note (optional), then
  // applies a 100% discount to each secondary so they stay visible at $0
  // on the bill (firm rule: preserve audit trail by discounting rather
  // than deleting). Per-secondary errors are isolated.
  server.tool(
    "merge_line_items",
    "Merge multiple secondary line items into a primary line on a DRAFT bill, per the firm rule (don't delete; discount-to-100% so secondaries stay visible at $0). Optionally updates the primary's note with a merged narrative. Hours roll-up to the primary is NOT supported (Clio's PATCH /line_items silently ignores quantity for ActivityLineItem) — this is the soft-combine path that preserves each secondary's hours but zeroes their dollar contribution. All line items must be on the same draft bill. Per-secondary errors are isolated: a failure on one secondary doesn't abort the others.",
    {
      primary_line_item_id: z.coerce.number().describe("Line item ID of the primary line that absorbs the merge (its note may optionally be updated; its hours and rate are preserved)."),
      secondary_line_item_ids_csv: z.string().describe("Comma-separated line_item IDs to merge into the primary, e.g. '8261110371,8261110372'. Each must be on the same DRAFT bill as the primary. Cannot include the primary's own ID. Cannot contain duplicates."),
      new_note: z.string().optional().describe("Optional. New narrative to set on the primary line (replaces the existing note). Typical use: a merged narrative combining the primary's and secondaries' work descriptions. If omitted, the primary's note is left unchanged."),
    },
    async (params) => {
      try {
        // Parse CSV → number[]
        const idsRaw = params.secondary_line_item_ids_csv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const secondaryIds: number[] = [];
        for (const raw of idsRaw) {
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `secondary_line_item_ids_csv contains invalid ID: "${raw}". Provide a comma-separated list of positive integer IDs.`,
                }, null, 2),
              }],
              isError: true,
            };
          }
          secondaryIds.push(n);
        }
        if (secondaryIds.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `secondary_line_item_ids_csv was empty after parsing.`,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const result = await mergeLineItems({
          primary_line_item_id: params.primary_line_item_id,
          secondary_line_item_ids: secondaryIds,
          new_note: params.new_note,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...result,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              status,
              message: err.message,
              context: err.response?.data?.context,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // prepare_hour_change — workaround for Clio's silent-noop on
  // /line_items.quantity. Removes the line from the draft (unbilling
  // the activity) and PATCHes /activities/{id} with the new quantity.
  // Caller must click "Regenerate Draft" in Clio UI to put the line
  // back on the bill at the new hours.
  server.tool(
    "prepare_hour_change",
    "Change the hours (and optionally the note) on a line item that's on a DRAFT bill. Workaround for Clio's silent-noop on PATCH /line_items.quantity for ActivityLineItem (Clio accepts the field but doesn't apply it). Sequence: (1) remove_from_draft_bill — unbills the activity, /activities is now editable; (2) PATCH /activities/{id} with the new quantity (and optionally new note). The line is GONE from the bill until you click 'Regenerate Draft' on the bill in Clio UI — Clio rebuilds the draft and the activity reappears with its new hours. Multiple prepare_hour_change calls can be batched before a single regenerate-draft click. Refuses if the bill is not in draft state. Use case: invoice review hour reductions (e.g., 0.6h → 0.4h, 1.6h → 0.4h) before issuing the bill.",
    {
      line_item_id: z.coerce.number().optional().describe("Line item ID (preferred if known)"),
      activity_id: z.coerce.number().optional().describe("Activity ID; resolved to its line_item on a draft bill"),
      new_hours: z.coerce.number().describe("New decimal hours for the activity. Must be > 0. Both increases and decreases are supported. Values above 24h/entry are rejected as a fat-finger guard unless force=true."),
      new_note: z.string().optional().describe("Optional new note. If provided, replaces the activity's existing note. If omitted, the note is left unchanged."),
      force: z.coerce.boolean().optional().describe("Override the 24h/entry sanity ceiling. Only set this when a single entry legitimately exceeds 24 hours (essentially never)."),
    },
    async (params) => {
      try {
        const result = await prepareHourChange({
          line_item_id: params.line_item_id,
          activity_id: params.activity_id,
          new_hours: params.new_hours,
          new_note: params.new_note,
          force: params.force,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              status,
              message: err.message,
              context: err.response?.data?.context,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // prepare_hard_combine — hard-combine multiple secondary lines into the
  // primary by setting new hours on the primary and deleting (or 100%-
  // discounting) the secondaries. Companion to merge_line_items (which is
  // soft-combine; preserves all hours but zeroes secondaries' dollars).
  server.tool(
    "prepare_hard_combine",
    "Hard-combine: roll the hours from secondary line items into the primary, then delete (or 100%-discount) the secondaries. Used during invoice review to consolidate same-day work into a single line on the bill (e.g., 4/14 work currently spread across two lines becomes one line at 1.4h with a merged narrative). All lines must be on the same DRAFT bill. Composition: (1) prepare_hour_change on the primary (sets new_primary_hours, optional new_note); (2) per secondary: delete_activity (default) or discount_line_item(100%) per secondary_treatment. Per-secondary errors are isolated. Single Clio UI 'Regenerate Draft' click finalizes everything. Use merge_line_items instead when you want soft-combine (preserve secondaries' hours, just zero their $ contribution per the firm rule).",
    {
      primary_line_item_id: z.coerce.number().describe("Line item ID of the primary line. Its hours will be set to new_primary_hours; its note may optionally be replaced."),
      secondary_line_item_ids_csv: z.string().describe("Comma-separated line_item IDs to combine into the primary, e.g. '8309925665,8261110372'. All must be on the same DRAFT bill as the primary. Cannot include the primary's own ID. Cannot contain duplicates."),
      new_primary_hours: z.coerce.number().describe("New decimal hours for the primary line. Must equal original primary hours + the secondaries' hours being rolled in; a mismatch is rejected unless force=true (guards a mistyped total). Also subject to the 24h/entry ceiling."),
      new_note: z.string().optional().describe("Optional new merged narrative for the primary line."),
      secondary_treatment: z.enum(["delete", "discount_100pct"]).optional().describe("How to handle the secondaries. 'delete' (default) removes the activities entirely. 'discount_100pct' keeps them visible at $0 (firm-rule-friendly when audit trail matters)."),
      force: z.coerce.boolean().optional().describe("Override the hours-conservation check and the 24h/entry ceiling. Set only when you deliberately intend the combined total to differ from primary+secondaries."),
    },
    async (params) => {
      try {
        // Parse CSV → number[]
        const idsRaw = params.secondary_line_item_ids_csv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const secondaryIds: number[] = [];
        for (const raw of idsRaw) {
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `secondary_line_item_ids_csv contains invalid ID: "${raw}".`,
                }, null, 2),
              }],
              isError: true,
            };
          }
          secondaryIds.push(n);
        }
        if (secondaryIds.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `secondary_line_item_ids_csv was empty after parsing.`,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const result = await prepareHardCombine({
          primary_line_item_id: params.primary_line_item_id,
          secondary_line_item_ids: secondaryIds,
          new_primary_hours: params.new_primary_hours,
          new_note: params.new_note,
          secondary_treatment: params.secondary_treatment,
          force: params.force,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              status,
              message: err.message,
              context: err.response?.data?.context,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // create_time_entry
  server.tool(
    "create_time_entry",
    "Create a new time entry in Clio. Requires a date, matter, and duration; the timekeeper defaults to YOU (the acting attorney) — omit user_id to log your own time. To log time for a DIFFERENT timekeeper you must pass their user_id AND set on_behalf_of=true (a guard against accidentally booking time under the wrong person). BILLABLE vs NON-BILLABLE: omitting rate does NOT make the entry non-billable — Clio applies the matter's default rate for the timekeeper and the entry is BILLABLE. To record genuinely non-billable time, set non_billable=true (which marks the entry non-billable regardless of rate). Set an explicit rate to override the default. Hours above 24/day are rejected as a fat-finger guard unless force=true.",
    {
      date: z.string().describe("Date for the time entry (YYYY-MM-DD)"),
      user_id: z.coerce.number().optional().describe("Clio user ID of the timekeeper. Omit to log your own time (default). To log for someone else, pass their id AND set on_behalf_of=true."),
      on_behalf_of: z.boolean().optional().default(false).describe("Set true to deliberately log time for a timekeeper OTHER than yourself (requires user_id). Leave false/omitted for your own time."),
      matter_id: z.coerce.number().describe("Clio matter ID to log time against"),
      hours: z.coerce.number().describe("Duration in decimal hours (e.g. 1.5 for 1h30m). Values above 24 are rejected unless force=true."),
      note: z.string().optional().describe("Description/narrative for the time entry. Accepted as `description` too — the two are the same field."),
      description: z.string().optional().describe("Alias for `note` (Clio's UI labels this field \"Description\"). Pass either one; passing both with different text is rejected."),
      rate: z.coerce.number().optional().describe("Hourly rate in dollars. If omitted, Clio uses the matter's default rate for the timekeeper (the entry is BILLABLE). To make the entry non-billable, use non_billable=true rather than relying on rate."),
      non_billable: z.boolean().optional().describe("Set true to mark the entry non-billable (no charge). When omitted/false the entry is billable at the given or default rate. A non-billable entry does NOT appear under get_time_entries(status=\"unbilled\") — it is returned only by status=\"non_billable\", which is the usual explanation for two different \"unbilled\" counts on the same matter."),
      force: z.coerce.boolean().optional().describe("Override the 24h/day sanity ceiling on hours (essentially never needed)."),
      activity_description_id: z.coerce.number().optional().describe("Clio activity description ID (pre-defined activity type). Optional."),
    },
    async (params) => {
      try {
        let narrative: string | undefined;
        try {
          narrative = resolveNarrative(params);
        } catch (e: any) {
          if (e instanceof NarrativeConflictError) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: e.message }) }],
              isError: true,
            };
          }
          throw e;
        }

        const quantity = Math.round(params.hours * 3600); // Clio stores time in seconds
        if (quantity <= 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "Hours must be greater than 0." }) }],
            isError: true,
          };
        }
        // Fat-finger guard: this POSTs /activities directly (unlike the edit
        // tools, which route through patchTimeEntrySmart's guard), so enforce the
        // 24h/day ceiling here — a "60" typed for "0.6" would create a 60h entry
        // that bills at 60x rate once added to a bill.
        try {
          assertNewHoursSane(params.hours, { force: params.force });
        } catch (guardErr: any) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: guardErr.message }) }],
            isError: true,
          };
        }

        // Attribute to the acting attorney by default; a different timekeeper
        // requires on_behalf_of=true (guards against misattributing billable
        // time to the wrong person).
        let timekeeperId: number;
        try {
          timekeeperId = await resolveActingUserId(params.user_id, params.on_behalf_of);
        } catch (e: any) {
          if (e instanceof AttributionError) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: e.message }) }], isError: true };
          }
          throw e;
        }

        const body: any = {
          data: {
            type: "TimeEntry",
            date: params.date,
            quantity,
            user: { id: timekeeperId },
            matter: { id: params.matter_id },
          },
        };

        if (narrative) body.data.note = narrative;
        if (params.rate !== undefined && params.rate > 0) body.data.price = params.rate;
        // Explicit non-billable flag — the only reliable way to make the entry
        // non-billable (omitting rate applies the matter default and stays
        // billable). When set, also pin price to 0 so no default rate applies.
        if (params.non_billable === true) {
          body.data.non_billable = true;
          body.data.price = 0;
        }
        if (params.activity_description_id) body.data.activity_description = { id: params.activity_description_id };

        const result = await rawPostSingle("/activities", body);
        const created = result.data;
        if (!created?.id) {
          throw new Error("Time entry create returned no ID — Clio may not have created the entry.");
        }

        // Clio returns 201 even when it drops a field from the POST body, so
        // report from a fresh GET with explicit fields rather than the POST
        // echo. Read-back failure is non-fatal (fall back to the echo), but an
        // entry that comes back WITHOUT the narrative that was asked for is a
        // hard error: it exists, it is billable, and left alone it lands on a
        // client bill as an unexplained line item.
        let saved = created;
        let readbackOk = false;
        try {
          const readback = await rawGetSingle(`/activities/${created.id}`, {
            fields: "id,type,date,quantity,rounded_quantity,price,total,note,non_billable,matter{id,display_number},user{id,name}",
          });
          if (readback.data?.id) {
            saved = readback.data;
            readbackOk = true;
          }
        } catch { /* non-fatal: report from the POST echo */ }

        const noteDropped = narrativeDropped(narrative, saved.note, readbackOk);

        const payload = {
          activity_id: saved.id,
          date: saved.date,
          hours: Math.round(((saved.rounded_quantity || saved.quantity) / 3600) * 100) / 100,
          rate: saved.price,
          note: readbackOk ? (saved.note ?? null) : (saved.note ?? narrative ?? null),
          note_verified: readbackOk ? !noteDropped : false,
          matter_id: params.matter_id,
          user_id: timekeeperId,
        };

        if (noteDropped) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Clio created time entry ${saved.id} but did NOT save the narrative — the entry currently reads "${saved.note ?? ""}". It is billable and will appear on the bill as an unexplained line item. Repair it with test_update_time_entry (activity_id ${saved.id}) or delete it with delete_activity before billing.`,
                partial_write: true,
                requested_note: narrative,
                saved_note: saved.note ?? null,
                ...payload,
              }, null, 2),
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...payload,
              ...(readbackOk
                ? {}
                : { warning: "Could not re-read the entry after creating it; the values above come from Clio's create response and are unverified. Confirm with get_time_entries before billing." }),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status || err.statusCode,
              clio_error: err.response?.data || err.body,
              request_body: err.response?.request_body,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
