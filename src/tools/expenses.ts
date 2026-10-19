import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawPostSingle, rawDeleteSingle } from "../clio/pagination";
import { deleteActivity } from "../clio/lineItems";
import { resolveActingUserId, AttributionError } from "../clio/actingUser";

const EXPENSE_FIELDS =
  "id,date,price,note,type,billed,matter{id,display_number,client},user{id,name},expense_category{name}";

export interface ExpenseCategoryRef {
  id: number;
  name: string;
}

// Resolve an expense category from the firm's category list by id or name.
// Name matching is case-insensitive exact first, then unique substring —
// so "filing" resolves to "Filing Fees" as long as no other category also
// contains "filing". Ambiguous or missing names throw with the available
// category names so the caller can retry with an exact one. Pure function,
// exported for unit tests.
export function resolveExpenseCategory(
  categories: ExpenseCategoryRef[],
  opts: { id?: number; name?: string },
): ExpenseCategoryRef {
  if (opts.id !== undefined) {
    const byId = categories.find((c) => c.id === opts.id);
    if (byId) return byId;
    throw new Error(
      `Expense category id ${opts.id} not found. Available: ${categories.map((c) => `${c.name} (${c.id})`).join(", ") || "(none)"}. Use list_expense_categories.`,
    );
  }
  const name = (opts.name || "").trim();
  if (!name) {
    throw new Error("resolveExpenseCategory: provide expense_category_id or expense_category_name.");
  }
  const lower = name.toLowerCase();
  const exact = categories.filter((c) => (c.name || "").toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = categories.filter((c) => (c.name || "").toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Expense category name "${name}" is ambiguous — matches: ${partial.map((c) => `${c.name} (${c.id})`).join(", ")}. Use the exact name or the id.`,
    );
  }
  throw new Error(
    `Expense category "${name}" not found. Available: ${categories.map((c) => `${c.name} (${c.id})`).join(", ") || "(none)"}. Use list_expense_categories.`,
  );
}

// Default expense amount when converting a time entry: the entry's billed
// value (rounded hours × rate). /activities quantities are SECONDS. Pure
// function, exported for unit tests.
export function deriveConversionAmount(activity: {
  quantity?: number;
  rounded_quantity?: number;
  price?: number;
}): number {
  const seconds = activity.rounded_quantity ?? activity.quantity ?? 0;
  const hours = seconds / 3600;
  return Math.round(hours * (activity.price || 0) * 100) / 100;
}

async function fetchExpenseCategories(): Promise<ExpenseCategoryRef[]> {
  const cats = await fetchAllPages<any>("/expense_categories", { fields: "id,name" });
  return cats.map((c: any) => ({ id: c.id, name: c.name }));
}

export function registerExpenseTools(server: McpServer): void {
  // get_expenses
  server.tool(
    "get_expenses",
    "Get expense entries with optional filters",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      user_id: z.coerce.number().optional().describe("Filter by user ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      billed: z
        .enum(["true", "false", "all"])
        .optional()
        .default("all")
        .describe("Filter by billed status"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "ExpenseEntry",
          fields: EXPENSE_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        if (params.start_date) queryParams.created_since = `${params.start_date}T00:00:00+00:00`;
        if (params.billed !== "all") queryParams.billed = params.billed === "true";

        let entries = await fetchAllPages<any>("/activities", queryParams);
        if (params.start_date) entries = entries.filter((e: any) => e.date >= params.start_date!);
        if (params.end_date) entries = entries.filter((e: any) => e.date <= params.end_date!);

        const formatted = entries.map((e: any) => ({
          id: e.id,
          date: e.date,
          amount: e.price,
          category: e.expense_category?.name ?? null,
          description: e.note,
          billed: e.billed,
          matter: e.matter,
          user: e.user,
        }));

        const total = Math.round(
          formatted.reduce((s: number, e: any) => s + (e.amount || 0), 0) * 100
        ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: formatted.length, total_amount: total, expenses: formatted },
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

  // get_unbilled_expenses
  server.tool(
    "get_unbilled_expenses",
    "Get all unbilled expenses grouped by matter with totals. Use for entry-level detail; for WIP totals and aging use get_wip_report.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      user_id: z.coerce.number().optional().describe("Filter by user ID"),
    },
    async (params) => {
      try {
        const defaultStart = new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0];
        const queryParams: Record<string, any> = {
          type: "ExpenseEntry",
          billed: false,
          fields: EXPENSE_FIELDS,
          created_since: `${defaultStart}T00:00:00+00:00`,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;

        const entries = await fetchAllPages<any>("/activities", queryParams);

        const byMatter: Record<
          number,
          { matter: any; expenses: any[]; total: number }
        > = {};

        for (const e of entries) {
          const mid = e.matter?.id ?? 0;
          if (!byMatter[mid]) {
            byMatter[mid] = { matter: e.matter, expenses: [], total: 0 };
          }
          byMatter[mid].expenses.push({
            id: e.id,
            date: e.date,
            amount: e.price,
            category: e.expense_category?.name ?? null,
            description: e.note,
            user: e.user,
          });
          byMatter[mid].total += e.price || 0;
        }

        const matterGroups = Object.values(byMatter).map((g) => ({
          matter: g.matter,
          expense_count: g.expenses.length,
          total: Math.round(g.total * 100) / 100,
          expenses: g.expenses,
        }));

        matterGroups.sort((a, b) => b.total - a.total);

        const firmTotal =
          Math.round(matterGroups.reduce((s, g) => s + g.total, 0) * 100) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  firm_total: firmTotal,
                  total_entries: entries.length,
                  matter_count: matterGroups.length,
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

  // ============================================================
  //  list_expense_categories — firm's expense category list
  // ============================================================
  server.tool(
    "list_expense_categories",
    "List the firm's Clio expense categories (id, name, rate). Use this to find the expense_category_id/name that create_expense and convert_time_entry_to_expense need.",
    {},
    async () => {
      try {
        const cats = await fetchAllPages<any>("/expense_categories", {
          fields: "id,name,rate,entry_type",
        });
        const formatted = cats
          .map((c: any) => ({ id: c.id, name: c.name, rate: c.rate ?? null, entry_type: c.entry_type ?? null }))
          .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: formatted.length, categories: formatted }, null, 2),
          }],
        };
      } catch (err: any) {
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
    }
  );

  // ============================================================
  //  create_expense — POST /activities with type=ExpenseEntry
  // ============================================================
  server.tool(
    "create_expense",
    "Create a new expense entry in Clio (POST /activities, type=ExpenseEntry). Requires a date, matter, and amount. The expense is attributed to YOU (the acting attorney) by default — to record it under a DIFFERENT user, pass their user_id AND set on_behalf_of=true (same guard as create_time_entry). Category can be given by id or by name (name is matched case-insensitively against list_expense_categories; Clio generally requires a category on expenses). Total = amount × quantity; quantity defaults to 1, so amount is usually just the dollar total.",
    {
      date: z.string().describe("Date of the expense (YYYY-MM-DD)"),
      matter_id: z.coerce.number().describe("Clio matter ID to record the expense against"),
      amount: z.coerce.number().describe("Expense amount in dollars (Clio's price, i.e. per-unit cost; total = amount × quantity)"),
      quantity: z.coerce.number().optional().default(1).describe("Number of units (default 1 — the usual case, where amount is the full expense total)"),
      note: z.string().optional().describe("Description of the expense (e.g. 'Filing fee — Application for Probate')"),
      expense_category_id: z.coerce.number().optional().describe("Clio expense category ID (see list_expense_categories). Provide this or expense_category_name."),
      expense_category_name: z.string().optional().describe("Expense category name, matched case-insensitively (e.g. 'Filing Fees'). Provide this or expense_category_id."),
      user_id: z.coerce.number().optional().describe("Clio user ID to attribute the expense to. Omit to record it as yourself (default). To record for someone else, pass their id AND set on_behalf_of=true."),
      on_behalf_of: z.boolean().optional().default(false).describe("Set true to deliberately record the expense under a user OTHER than yourself (requires user_id)."),
    },
    async (params) => {
      try {
        if (!(params.amount > 0)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `amount must be greater than 0 (got ${params.amount}).` }) }],
            isError: true,
          };
        }
        if (!(params.quantity > 0)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `quantity must be greater than 0 (got ${params.quantity}).` }) }],
            isError: true,
          };
        }

        // Attribute to the acting attorney by default; a different user
        // requires on_behalf_of=true (same guard as create_time_entry).
        let userId: number;
        try {
          userId = await resolveActingUserId(params.user_id, params.on_behalf_of);
        } catch (e: any) {
          if (e instanceof AttributionError) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: e.message }) }], isError: true };
          }
          throw e;
        }

        // Resolve category (by id or case-insensitive name). Clio generally
        // requires expense_category on ExpenseEntry creates; if neither param
        // was given we attempt the create anyway and surface Clio's own
        // validation error verbatim (some configurations may allow it).
        let category: ExpenseCategoryRef | null = null;
        // Blank/whitespace names are treated as "not provided" — LLM clients
        // sometimes fill optional string params with "" (and z.coerce would
        // otherwise send it into resolution, wasting a category fetch and
        // producing a confusing error).
        const categoryName = params.expense_category_name?.trim();
        if (params.expense_category_id !== undefined || categoryName) {
          const cats = await fetchExpenseCategories();
          category = resolveExpenseCategory(cats, {
            id: params.expense_category_id,
            name: categoryName,
          });
        }

        const body: any = {
          data: {
            type: "ExpenseEntry",
            date: params.date,
            quantity: params.quantity,
            price: params.amount,
            matter: { id: params.matter_id },
            user: { id: userId },
          },
        };
        if (params.note) body.data.note = params.note;
        if (category) body.data.expense_category = { id: category.id };

        const result = await rawPostSingle("/activities", body);
        const created = result.data;
        if (!created?.id) {
          throw new Error("Expense create returned no ID — Clio may not have created the expense.");
        }

        // Read back what actually stuck. Clio returns 201/200 even when it
        // silently drops unrecognized or invalid fields from a POST body, so
        // report from a fresh GET with explicit fields rather than trusting
        // the POST echo. Read-back failure is non-fatal (fall back to echo).
        let saved = created;
        let readbackOk = false;
        try {
          const readback = await rawGetSingle(`/activities/${created.id}`, {
            fields: "id,type,date,quantity,price,total,note,expense_category{id,name},matter{id,display_number},user{id,name}",
          });
          if (readback.data?.id) {
            saved = readback.data;
            readbackOk = true;
          }
        } catch { /* non-fatal: report from the POST echo */ }

        const categoryDropped = readbackOk && category && saved.expense_category?.id !== category.id;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              activity_id: saved.id,
              date: saved.date,
              amount: saved.price,
              quantity: saved.quantity,
              total: saved.total ?? Math.round(params.amount * params.quantity * 100) / 100,
              category: saved.expense_category?.name ?? (category ? category.name : null),
              note: saved.note ?? params.note ?? null,
              matter_id: params.matter_id,
              user_id: userId,
              ...(categoryDropped
                ? { warning: `Clio accepted the create but the expense_category ("${category!.name}") did not persist on the expense — set it in Clio UI or retry.` }
                : {}),
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
              hint: err.response?.status === 422
                ? "Clio rejected the expense. If the error mentions expense_category, pass expense_category_id or expense_category_name (see list_expense_categories)."
                : undefined,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  //  convert_time_entry_to_expense — replace a TimeEntry with an
  //  ExpenseEntry (Clio has no API to change an activity's type)
  // ============================================================
  server.tool(
    "convert_time_entry_to_expense",
    "Convert a time entry into an expense (e.g. a filing fee that was logged as time). Clio's API cannot change an activity's type, so this creates a new ExpenseEntry (same matter/date/user as the time entry, note preserved unless overridden) and then deletes the original time entry. Amount defaults to the entry's billed value (hours × rate); pass amount to override. If the time entry is on a DRAFT bill, its line is removed as part of the delete and the new expense sits unbilled — regenerate the draft in Clio UI to pull it onto the bill. Refuses if the entry is on a non-draft bill. If deleting the original fails, the tool re-reads the entry's actual state: when the entry survived, the new expense is rolled back and the error reports any partial bill change with recovery steps; when the entry turns out to be deleted despite the error, the conversion is reported complete with a warning.",
    {
      activity_id: z.coerce.number().describe("Clio activity ID of the TimeEntry to convert"),
      amount: z.coerce.number().optional().describe("Expense amount in dollars. Defaults to the time entry's billed value (hours × rate). Required if that value is 0."),
      expense_category_id: z.coerce.number().optional().describe("Clio expense category ID (see list_expense_categories). Provide this or expense_category_name."),
      expense_category_name: z.string().optional().describe("Expense category name, matched case-insensitively. Provide this or expense_category_id."),
      note: z.string().optional().describe("Description for the expense. Defaults to the time entry's note."),
      date: z.string().optional().describe("Date for the expense (YYYY-MM-DD). Defaults to the time entry's date."),
    },
    async (params) => {
      try {
        // Validate an explicitly-provided amount up front. z.coerce maps
        // ''/null to 0, and without this check that 0 would fall through to
        // the derivation-failure error below — which blames the derivation
        // and tells a caller who DID pass amount to pass it explicitly.
        if (params.amount !== undefined && !(params.amount > 0)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `amount must be greater than 0 (got ${params.amount}). Omit amount to default to the entry's hours × rate.` }) }],
            isError: true,
          };
        }

        // Step 1: Read the time entry, including bill routing, so we can
        // refuse BEFORE creating anything if the conversion can't complete.
        const actResp = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,type,date,note,price,quantity,rounded_quantity,billed,bill{id,state,number},matter{id,display_number},user{id,name}",
        });
        const act = actResp.data;
        if (!act) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Activity ${params.activity_id} not found.` }) }],
            isError: true,
          };
        }
        if (act.type !== "TimeEntry") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Activity ${params.activity_id} is a ${act.type}, not a TimeEntry — nothing to convert.` }) }],
            isError: true,
          };
        }
        if (act.bill?.id && act.bill.state !== "draft") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Refusing to convert: time entry ${params.activity_id} is on bill ${act.bill.number || act.bill.id} (state="${act.bill.state}"). Only unbilled entries or entries on DRAFT bills can be converted — the original must be deleted, and touching issued/paid bills would corrupt accounting.`,
                context: "activity_on_non_draft_bill",
                bill_state: act.bill.state,
              }),
            }],
            isError: true,
          };
        }
        if (!act.matter?.id) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Could not resolve matter for activity ${params.activity_id}.` }) }],
            isError: true,
          };
        }
        // Same guard prepareLineSplit uses: without it, a missing user would
        // serialize as "user":{} and Clio would either 422 or silently
        // attribute the new expense to the OAuth token owner — breaking the
        // "conversion preserves attribution" contract.
        if (!act.user?.id) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Could not resolve the timekeeper (user) for activity ${params.activity_id} — cannot preserve attribution on the converted expense.` }) }],
            isError: true,
          };
        }

        // Step 2: Amount — explicit param, else the entry's billed value.
        const derived = deriveConversionAmount(act);
        const amount = params.amount ?? derived;
        if (!(amount > 0)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Cannot derive a positive expense amount from this time entry (hours × rate = $${derived}). Pass amount explicitly.`,
              }),
            }],
            isError: true,
          };
        }

        // Step 3: Resolve category (same semantics as create_expense).
        let category: ExpenseCategoryRef | null = null;
        // Blank/whitespace names are treated as "not provided" — LLM clients
        // sometimes fill optional string params with "" (and z.coerce would
        // otherwise send it into resolution, wasting a category fetch and
        // producing a confusing error).
        const categoryName = params.expense_category_name?.trim();
        if (params.expense_category_id !== undefined || categoryName) {
          const cats = await fetchExpenseCategories();
          category = resolveExpenseCategory(cats, {
            id: params.expense_category_id,
            name: categoryName,
          });
        }

        // Step 4: Create the ExpenseEntry FIRST (create-then-delete, like
        // prepare_line_split: a failure here leaves the original untouched).
        // The expense inherits the ORIGINAL entry's user — this is a
        // conversion, not new attribution, so no on_behalf_of guard applies.
        const expenseNote = params.note ?? act.note ?? undefined;
        const body: any = {
          data: {
            type: "ExpenseEntry",
            date: params.date ?? act.date,
            quantity: 1,
            price: amount,
            matter: { id: act.matter.id },
            user: { id: act.user.id },
          },
        };
        if (expenseNote) body.data.note = expenseNote;
        if (category) body.data.expense_category = { id: category.id };

        const createResp = await rawPostSingle("/activities", body);
        const expense = createResp.data;
        if (!expense?.id) {
          throw new Error("Expense create returned no ID — aborting before deleting the time entry.");
        }

        // Step 5: Delete the original time entry. deleteActivity auto-removes
        // the draft-bill line first when there is one, and refuses non-draft
        // bills (we already pre-checked, but the state could have changed).
        //
        // deleteActivity is TWO sequential writes (DELETE the bill line, then
        // DELETE the activity), so a thrown error does not tell us how far it
        // got — and an ambiguous failure (e.g. timeout) may even mean the
        // delete actually committed. Blindly rolling back the new expense on
        // any error would (a) falsely promise "nothing changed" when the
        // draft bill already lost its line, or (b) destroy BOTH records when
        // the delete committed despite the error. So on failure we re-read
        // the entry's actual state and branch:
        //   - entry gone            → conversion complete; keep the expense,
        //                             report success with a warning
        //   - entry survived        → roll back the expense; if its bill line
        //                             was already removed, raise a rich error
        //                             with recovery steps (same shape as
        //                             prepareHourChange's step2 error)
        let removedFromBill: { line_item_id?: number; bill: any } | undefined;
        let deleteWarning: string | undefined;
        try {
          const delResult = await deleteActivity(params.activity_id);
          removedFromBill = delResult.removed_from_bill;
        } catch (delErr: any) {
          let originalExists = true;
          let stillOnBill = !!act.bill?.id;
          try {
            const checkResp = await rawGetSingle(`/activities/${params.activity_id}`, {
              fields: "id,bill{id,state,number}",
            });
            originalExists = !!checkResp.data?.id;
            stillOnBill = !!checkResp.data?.bill?.id;
          } catch (checkErr: any) {
            if (checkErr.response?.status === 404) originalExists = false;
            // Any other failure: state unknown — assume the entry survived.
            // That path rolls back the expense and reports the raw error,
            // which is the conservative default.
          }

          if (!originalExists) {
            // The delete committed despite the error. The conversion is
            // complete — keep the expense and report success.
            deleteWarning = `deleteActivity reported an error ("${delErr.message}") but the time entry is confirmed deleted — the conversion completed. Verify the draft bill state in Clio if the entry was on one.`;
            if (act.bill?.id) removedFromBill = { bill: act.bill };
          } else {
            // The entry survived → roll back the new expense.
            try {
              await rawDeleteSingle(`/activities/${expense.id}`);
            } catch (rbErr: any) {
              console.error(`[convert_time_entry_to_expense] rollback delete /activities/${expense.id} failed: ${rbErr.message}. Orphan expense may exist.`);
              delErr.message = `${delErr.message} — AND rollback of the new expense (activity ${expense.id}) ALSO failed; delete it manually in Clio.`;
            }
            if (act.bill?.id && !stillOnBill) {
              // Partial deleteActivity: the draft-bill line was removed but
              // the activity itself survived (now unbilled). The bill is
              // short one line until the user acts — say so explicitly.
              const richErr: any = new Error(
                `Conversion failed midway: time entry ${params.activity_id}'s line was already removed from draft bill ${act.bill.number || act.bill.id}, but the entry itself could not be deleted (it still exists, now unbilled). The new expense was rolled back. To recover: retry convert_time_entry_to_expense (the entry is now unbilled, so the retry has no bill step), or open bill ${act.bill.number || act.bill.id} in Clio UI and click "Regenerate Draft" to restore the line at its original hours. Underlying error: ${delErr.message}`,
              );
              richErr.response = {
                status: delErr.response?.status || 500,
                data: {
                  context: "line_removed_but_activity_survived",
                  bill_id: act.bill.id,
                  bill_number: act.bill.number,
                  activity_id: params.activity_id,
                  rolled_back_expense: true,
                  clio_error: delErr.response?.data,
                },
              };
              throw richErr;
            }
            throw delErr;
          }
        }

        // Read back the expense to report what actually stuck (Clio returns
        // 201/200 even when it silently drops fields from a POST body).
        let savedExpense = expense;
        let readbackOk = false;
        try {
          const rb = await rawGetSingle(`/activities/${expense.id}`, {
            fields: "id,type,date,quantity,price,total,note,expense_category{id,name},matter{id,display_number},user{id,name}",
          });
          if (rb.data?.id) {
            savedExpense = rb.data;
            readbackOk = true;
          }
        } catch { /* non-fatal: report from the POST echo */ }
        const categoryDropped = readbackOk && category && savedExpense.expense_category?.id !== category.id;

        const wasOnDraft = !!removedFromBill;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              converted_from: {
                activity_id: params.activity_id,
                type: "TimeEntry",
                date: act.date,
                hours: Math.round(((act.rounded_quantity ?? act.quantity ?? 0) / 3600) * 100) / 100,
                rate: act.price ?? null,
                note: act.note ?? null,
                was_on_draft_bill: wasOnDraft ? removedFromBill!.bill : null,
              },
              expense: {
                activity_id: savedExpense.id,
                type: "ExpenseEntry",
                date: savedExpense.date,
                amount: savedExpense.price,
                total: savedExpense.total ?? amount,
                category: savedExpense.expense_category?.name ?? (category ? category.name : null),
                note: savedExpense.note ?? expenseNote ?? null,
                matter: act.matter,
                user: act.user ?? null,
              },
              ...(deleteWarning ? { warning: deleteWarning } : {}),
              ...(categoryDropped
                ? { category_warning: `Clio accepted the create but the expense_category ("${category!.name}") did not persist on the expense — set it in Clio UI or retry.` }
                : {}),
              ui_instruction: wasOnDraft
                ? `Time entry ${params.activity_id} was removed from draft bill ${removedFromBill!.bill.number || removedFromBill!.bill.id} and deleted; expense ${expense.id} was created unbilled. To put the expense on the bill: open Clio UI → bill ${removedFromBill!.bill.number || removedFromBill!.bill.id} → "Regenerate Draft" (or delete_draft_bill + "Generate Bill" on matter ${act.matter.display_number || act.matter.id}).`
                : `Time entry ${params.activity_id} deleted; expense ${expense.id} created unbilled on matter ${act.matter.display_number || act.matter.id}. It will be picked up on the matter's next generated bill.`,
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
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
