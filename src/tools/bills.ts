import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawGetBinarySingle, rawPostSingle, rawPatchSingle, rawDeleteSingle } from "../clio/pagination";
import { looksLikePdf } from "../clio/billPdf";
import { renderBillPdf } from "../clio/billRender";
import { registerDownload } from "../utils/downloadStore";
import { diagnosticTool } from "../utils/diagnostics";
import { runBulk, parseIdList, BULK_MAX_ITEMS, BULK_DEFAULT_BUDGET_SECONDS, BULK_MAX_BUDGET_SECONDS } from "../clio/bulk";
import { fetchSubmissions, indexSubmissions, lookupSubmission } from "./billSent";
import JSZip from "jszip";

const BILL_FIELDS =
  "id,number,subject,memo,kind,type,state,available_state_transitions,can_update," +
  "issued_at,due_at,start_at,end_at,created_at,updated_at,last_sent_at," +
  "total,due,balance,paid,pending,paid_at,credits_issued,shared,matters," +
  "client{id,name,primary_email_address,type}";

// Field selector for get_bill_line_items. /line_items supports top-level
// user{id,name} (1-level nesting, same selector AUDIT_LINE_ITEM_FIELDS in
// audit.ts relies on), so the timekeeper comes back on the line item itself.
// Do NOT resolve timekeepers via per-activity GETs: on bills with >~50 lines
// the resulting fan-out hits Clio's rate limit and the 429 backoff pushes the
// call past the connector gateway timeout (reported 2026-07-02 on a 167-line
// bill). Exported for the regression test in test/billLineItemFields.test.ts.
export const BILL_LINE_ITEM_FIELDS =
  "id,type,kind,description,note,date,quantity,price,total,group_ordering,discount{rate,type},activity{id},user{id,name}";

export type BillTargetState = "draft" | "awaiting_approval" | "awaiting_payment" | "paid" | "void";

export interface SetBillStateOutcome {
  payload: Record<string, unknown>;
  isError: boolean;
  /** Pretty-print the payload (preserves the single-bill tool's original output). */
  pretty: boolean;
}

/**
 * Read → PATCH state → read-back for one bill. Shared by set_bill_state and
 * bulk_set_bill_state. Never throws: failures come back as an isError payload
 * so a bulk caller can keep going.
 */
export async function setBillState(
  billId: number,
  targetState: BillTargetState,
): Promise<SetBillStateOutcome> {
  try {
    // Step 1: Read current state.
    const beforeResp = await rawGetSingle(`/bills/${billId}`, { fields: BILL_FIELDS });
    const beforeBill = beforeResp.data;
    if (!beforeBill) {
      return {
        payload: { success: false, message: `Bill ${billId} not found` },
        isError: true,
        pretty: false,
      };
    }

    const before = {
      state: beforeBill.state,
      total: beforeBill.total,
      balance: beforeBill.balance,
      number: beforeBill.number,
    };

    // No-op shortcut: don't bother PATCHing if already in target state.
    if (before.state === targetState) {
      return {
        payload: {
          success: true,
          no_change: true,
          bill_id: billId,
          message: `Bill ${beforeBill.number || billId} already in state "${targetState}" — no PATCH sent.`,
          state: before.state,
        },
        isError: false,
        pretty: true,
      };
    }

    // Step 2: Attempt the PATCH.
    const patchBody = { data: { state: targetState } };
    try {
      await rawPatchSingle(`/bills/${billId}`, patchBody);
    } catch (err: any) {
      const status = err.response?.status || err.statusCode;
      let interpretation = "Unknown error";
      if (status === 422) interpretation = "Clio rejected the state transition — the requested change may not be allowed from the current state, or additional fields (e.g. voided_at, voided_reason) may be required.";
      else if (status === 403) interpretation = "Forbidden — insufficient permissions for this state change.";
      else if (status === 404) interpretation = "Bill not found.";
      else if (status === 400) interpretation = "Bad request — check the field shape Clio expects.";
      return {
        payload: {
          success: false,
          bill_id: billId,
          attempted_transition: `${before.state} → ${targetState}`,
          status,
          interpretation,
          message: err.message,
          clio_error: err.response?.data,
          request_body: patchBody,
        },
        isError: true,
        pretty: true,
      };
    }

    // Step 3: Read again to confirm.
    const afterResp = await rawGetSingle(`/bills/${billId}`, { fields: BILL_FIELDS });
    const afterBill = afterResp.data;
    const after = {
      state: afterBill?.state,
      total: afterBill?.total,
      balance: afterBill?.balance,
      number: afterBill?.number,
    };

    return {
      payload: {
        success: true,
        bill_id: billId,
        transition: `${before.state} → ${after.state}`,
        before,
        after,
        message: `Bill ${afterBill?.number || billId} state changed: ${before.state} → ${after.state}.`,
      },
      isError: false,
      pretty: true,
    };
  } catch (err: any) {
    return {
      payload: {
        success: false,
        bill_id: billId,
        message: err.message,
        status: err.response?.status,
        clio_error: err.response?.data,
      },
      isError: true,
      pretty: false,
    };
  }
}

export function registerBillTools(server: McpServer): void {
  server.tool(
    "get_bills",
    "Get bills with filters. Flags aging: outstanding > 30, 60, 90 days. Returns payment detail (`paid`, `pending`, `paid_at`, `due`, `credits_issued`), routing info (`client`, `shared`), bill metadata (`subject`, `memo`, `kind`, `type`, `start_at`, `end_at`, `created_at`, `updated_at`), state machine (`available_state_transitions`, `can_update`), and sent indicators (`sent`, `last_sent_at`) so callers can distinguish bills that have been emailed/shared to the client from approved bills still sitting in the drawer.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      client_id: z.coerce.number().optional().describe("Filter by client ID"),
      state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "all"])
        .optional()
        .default("all")
        .describe("Filter by bill state"),
      issued_after: z.string().optional().describe("Issued after date (YYYY-MM-DD)"),
      issued_before: z.string().optional().describe("Issued before date (YYYY-MM-DD)"),
      verify_submissions: z.boolean().optional().default(false).describe(
        "Join each bill against the submission ledger written by mark_bill_sent and add `submitted_at`, " +
        "`submission_method`, `submission_recipient`, `submission_logged_by` and `sent_or_submitted`. " +
        "Set this in the unsent-invoice report: Clio has no send route, so invoices emailed to a court or " +
        "mailed to a client keep sent=false, and `sent_or_submitted` is what tells a bill that genuinely " +
        "never went out apart from one Clio merely has no record of sending.",
      ),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: BILL_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.client_id) queryParams.client_id = params.client_id;
        if (params.state !== "all") queryParams.state = params.state;
        if (params.issued_after) queryParams.issued_after = params.issued_after;
        if (params.issued_before) queryParams.issued_before = params.issued_before;

        const bills = await fetchAllPages<any>("/bills", queryParams);
        const today = new Date();

        // Bills delivered outside Clio (no send route exists in v4) are only
        // distinguishable from never-sent bills via the submission ledger.
        const submissionIndex = params.verify_submissions
          ? indexSubmissions(
              await fetchSubmissions({ matter_id: params.matter_id, limit: 1000 }),
            )
          : null;

        const formatted = bills.map((b: any) => {
          const dueDate = b.due_at ? new Date(b.due_at) : null;
          const daysOutstanding = dueDate
            ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
            : null;

          let aging_flag: string | null = null;
          if (b.state === "outstanding" && daysOutstanding !== null) {
            if (daysOutstanding > 90) aging_flag = "90+ days";
            else if (daysOutstanding > 60) aging_flag = "60+ days";
            else if (daysOutstanding > 30) aging_flag = "30+ days";
          }

          const last_sent_at = b.last_sent_at ?? null;
          const sent = !!last_sent_at;

          const submission = submissionIndex
            ? lookupSubmission(submissionIndex, { id: b.id, number: b.number })
            : null;

          return {
            id: b.id,
            number: b.number,
            subject: b.subject ?? null,
            memo: b.memo ?? null,
            kind: b.kind ?? null,
            type: b.type ?? null,
            state: b.state,
            available_state_transitions: b.available_state_transitions ?? [],
            can_update: b.can_update ?? null,
            issued_at: b.issued_at,
            due_at: b.due_at,
            start_at: b.start_at ?? null,
            end_at: b.end_at ?? null,
            created_at: b.created_at ?? null,
            updated_at: b.updated_at ?? null,
            total: b.total,
            due: b.due ?? null,
            balance: b.balance,
            paid: b.paid ?? null,
            pending: b.pending ?? null,
            paid_at: b.paid_at ?? null,
            credits_issued: b.credits_issued ?? null,
            shared: b.shared ?? null,
            matter: b.matters?.[0] ?? null,
            client: b.client ?? null,
            days_outstanding: daysOutstanding,
            aging_flag,
            sent,
            last_sent_at,
            ...(submissionIndex
              ? {
                  submitted_at: submission?.sent_at ?? null,
                  submission_method: submission?.method ?? null,
                  submission_recipient: submission?.recipient ?? null,
                  submission_logged_by: submission?.logged_by ?? null,
                  sent_or_submitted: sent || submission != null,
                }
              : {}),
          };
        });

        const totalBalance =
          Math.round(
            formatted.reduce((s: number, b: any) => s + (b.balance || 0), 0) * 100
          ) / 100;

        // When verifying, lead with the number that matters: bills with no
        // sent flag AND no submission entry — the ones nobody can show went out.
        const unverified = submissionIndex
          ? formatted.filter((b: any) => !b.sent_or_submitted)
          : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: formatted.length,
                  total_balance: totalBalance,
                  ...(unverified
                    ? {
                        unverified_count: unverified.length,
                        unverified_balance:
                          Math.round(unverified.reduce((s: number, b: any) => s + (b.balance || 0), 0) * 100) / 100,
                      }
                    : {}),
                  bills: formatted,
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
  //  debug_bill_fields — verify Clio returns each requested field
  // ============================================================
  // Hits /bills/{id} with the same field set get_bills uses, then dumps
  // (a) the raw Clio response, (b) the get_bills-shaped output for that
  // bill, and (c) a presence check showing which of the tracked fields
  // came back populated vs null/missing. Useful for confirming Clio
  // actually supports each name in BILL_FIELDS before relying on it.
  diagnosticTool(server).tool(
    "debug_bill_fields",
    "Debug helper: fetch one bill with the full get_bills field set and report which fields Clio returned. Use this after editing BILL_FIELDS to confirm Clio accepts each field name and to see the actual shape of nested objects (client, matters).",
    {
      bill_id: z.coerce.number().describe("Clio bill ID to inspect"),
    },
    async (params) => {
      try {
        const resp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: BILL_FIELDS,
        });
        const b = resp.data;
        if (!b) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: `Bill ${params.bill_id} not found` }),
            }],
            isError: true,
          };
        }

        const today = new Date();
        const dueDate = b.due_at ? new Date(b.due_at) : null;
        const daysOutstanding = dueDate
          ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const last_sent_at = b.last_sent_at ?? null;

        const mapped = {
          id: b.id,
          number: b.number,
          subject: b.subject ?? null,
          memo: b.memo ?? null,
          kind: b.kind ?? null,
          type: b.type ?? null,
          state: b.state,
          available_state_transitions: b.available_state_transitions ?? [],
          can_update: b.can_update ?? null,
          issued_at: b.issued_at,
          due_at: b.due_at,
          start_at: b.start_at ?? null,
          end_at: b.end_at ?? null,
          created_at: b.created_at ?? null,
          updated_at: b.updated_at ?? null,
          total: b.total,
          due: b.due ?? null,
          balance: b.balance,
          paid: b.paid ?? null,
          pending: b.pending ?? null,
          paid_at: b.paid_at ?? null,
          credits_issued: b.credits_issued ?? null,
          shared: b.shared ?? null,
          matter: b.matters?.[0] ?? null,
          client: b.client ?? null,
          days_outstanding: daysOutstanding,
          sent: !!last_sent_at,
          last_sent_at,
        };

        const tracked = [
          "subject",
          "memo",
          "kind",
          "type",
          "available_state_transitions",
          "can_update",
          "start_at",
          "end_at",
          "created_at",
          "updated_at",
          "last_sent_at",
          "due",
          "paid",
          "pending",
          "paid_at",
          "credits_issued",
          "shared",
          "client",
        ];
        const field_presence = Object.fromEntries(
          tracked.map((k) => {
            const v = (b as any)[k];
            const present = v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
            return [k, { present, value: v ?? null }];
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              bill_id: params.bill_id,
              fields_requested: BILL_FIELDS,
              field_presence,
              mapped_output: mapped,
              raw_clio_response: b,
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
              status: err.response?.status,
              clio_error: err.response?.data,
              hint: err.response?.status === 400
                ? "Clio rejected the request — likely an unsupported field name in BILL_FIELDS. Check clio_error for the offending field."
                : undefined,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  //  get_bill_line_items — list all line items on a specific bill
  // ============================================================
  // Use this when you need exactly the lines on bill X for an invoice
  // review. get_time_entries filters by matter/user and sweeps in
  // prior-bill entries plus unbilled activities; this tool filters by
  // bill_id directly via Clio's /line_items?bill_id=X — so you get
  // ONLY the lines currently sitting on the requested bill, in the
  // order they appear (group_ordering, then date, then id).
  server.tool(
    "get_bill_line_items",
    "Get all line items on a specific Clio bill, ordered as they appear on the bill. Use this — NOT get_time_entries — when you want exactly the lines on bill X for an invoice review. get_time_entries filters by matter or user, which sweeps in prior-bill entries and unbilled activities; this tool filters by bill_id directly. Returns each line's line_item_id, activity_id, date, hours, rate, total, note, timekeeper, type (ActivityLineItem / NoChargeLineItem / SummaryLineItem), and any discount applied. `sum_hours` counts SERVICE lines only: an expense line reports hours=1 with rate=total, so including them inflates the figure (bill 23521 read 4.2 hrs against 1.2 hrs of real service time) - expense lines are summed separately as `sum_expense_amount` / `expense_count`, and each carries `is_expense: true`. Detect expenses by `kind == \"Expense\"`, NOT by `type`: across a 724-line scan every line reported type=\"ActivityLineItem\", so type-keyed detection never fires. Includes the bill's number, state, total, balance, and matter for context.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
      include_hidden: z.boolean().optional().default(false).describe("If true, include line items that are present on the bill but hidden (Clio's display=false). Default false matches what the user sees on the rendered bill."),
    },
    async (params) => {
      try {
        // Read the bill metadata for context (matter, state, totals).
        const billResp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: "id,number,subject,state,issued_at,due_at,total,balance,matters{id,display_number}",
        });
        const bill = billResp.data;
        if (!bill) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: `Bill ${params.bill_id} not found.` }),
            }],
            isError: true,
          };
        }

        // Fetch all line items on this bill, timekeeper included — see the
        // BILL_LINE_ITEM_FIELDS comment for why there is no per-activity
        // enrichment step here.
        const queryParams: Record<string, any> = {
          fields: BILL_LINE_ITEM_FIELDS,
          bill_id: params.bill_id,
        };
        if (!params.include_hidden) queryParams.display = true;

        const lineItems = await fetchAllPages<any>("/line_items", queryParams);

        // Sort by Clio's bill ordering: group_ordering, then date, then id.
        lineItems.sort((a: any, b: any) => {
          const ga = a.group_ordering ?? Number.MAX_SAFE_INTEGER;
          const gb = b.group_ordering ?? Number.MAX_SAFE_INTEGER;
          if (ga !== gb) return ga - gb;
          if (a.date !== b.date) return (a.date || "").localeCompare(b.date || "");
          return (a.id || 0) - (b.id || 0);
        });

        const formatted = lineItems.map((li: any) => ({
          line_item_id: li.id,
          activity_id: li.activity?.id ?? null,
          type: li.type ?? null,
          kind: li.kind ?? null,
          date: li.date ?? null,
          hours: li.quantity ?? null,
          rate: li.price ?? null,
          total: li.total ?? null,
          note: li.note ?? null,
          description: li.description ?? null,
          timekeeper:
            li.user && typeof li.user.id === "number"
              ? { id: li.user.id, name: li.user.name }
              : null,
          discount:
            li.discount && (li.discount.rate != null || li.discount.type)
              ? { rate: li.discount.rate, type: li.discount.type }
              : null,
          group_ordering: li.group_ordering ?? null,
          // Expense lines are ActivityLineItem like everything else; `kind`
          // is the only field that distinguishes them (verified across 724
          // lines / 73 draft bills, 2026-09).
          is_expense: li.kind === "Expense",
        }));

        // An expense line reports quantity=1 and price=total, so it adds a
        // phantom "1 hour" to any naive sum. Anything consuming sum_hours as
        // billable service time is wrong on every bill carrying an expense,
        // so service hours and expense dollars are reported separately.
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const sumHours = round2(
          formatted.reduce(
            (s, li) => s + (!li.is_expense && typeof li.hours === "number" ? li.hours : 0),
            0,
          ),
        );
        const expenseLines = formatted.filter((li) => li.is_expense);
        const sumExpenseAmount = round2(
          expenseLines.reduce((s, li) => s + (typeof li.total === "number" ? li.total : 0), 0),
        );
        const sumTotal =
          Math.round(
            formatted.reduce(
              (s, li) => s + (typeof li.total === "number" ? li.total : 0),
              0,
            ) * 100,
          ) / 100;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                bill: {
                  id: bill.id,
                  number: bill.number,
                  subject: bill.subject ?? null,
                  state: bill.state,
                  issued_at: bill.issued_at,
                  due_at: bill.due_at,
                  total: bill.total,
                  balance: bill.balance,
                  matter: bill.matters?.[0] ?? null,
                },
                count: formatted.length,
                // Service lines only — see is_expense / sum_expense_amount.
                sum_hours: sumHours,
                expense_count: expenseLines.length,
                sum_expense_amount: sumExpenseAmount,
                sum_total: sumTotal,
                line_items: formatted,
              },
              null,
              2,
            ),
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
    },
  );

  // ============================================================
  //  render_bill_pdf — Render a bill to PDF from its preview HTML
  // ============================================================
  // Clio's OAuth API does not serve rendered bill PDFs (see billPdf.ts), so
  // this renders the invoice ourselves: GET /bills/{id}/preview → strip the
  // Clio Payments stub (page-break divider + repeated header + "Pay online"/QR
  // block) → inline the firm logo → headless-Chromium render → a short-lived
  // download URL the caller can hand to an email/attachment tool. Replaces the
  // old download_bill_pdf, which could only fail-fast against Clio's API gap.
  server.tool(
    "render_bill_pdf",
    "Render a single bill/invoice to a PDF and return a short-lived download URL (the same download-store mechanism as get_bill_preview). Clio's OAuth API does NOT serve bill PDFs, so this builds one from the rendered preview HTML (GET /bills/{id}/preview) with a headless browser: the firm logo is fetched and embedded so the PDF is self-contained, and the Clio Payments stub the preview appends after the invoice (a 'Page Break' divider, a repeated firm-address/invoice-number header, and the 'Pay your invoice online' block with its QR placeholder) is stripped so the PDF ends cleanly on the invoice with no spurious trailing page. Use the returned direct_download_url to attach the invoice to an email or save it. Works for any non-draft bill (drafts have no issued invoice to render). Requires Chromium on the server (PUPPETEER_EXECUTABLE_PATH).",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
    },
    async (params) => {
      try {
        // Fetch bill metadata for filename and state check.
        const billData = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: "id,number,state,issued_at",
        });
        const bill = billData.data;

        if (!bill) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Bill ${params.bill_id} not found` }) }],
            isError: true,
          };
        }

        if (bill.state === "draft") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Bill ${bill.number || params.bill_id} is a draft — issue the bill in Clio first, then render its invoice.` }) }],
            isError: true,
          };
        }

        const { buffer, inlined, skipped } = await renderBillPdf(params.bill_id);
        const filename = `Bill-${bill.number || params.bill_id}.pdf`;
        const reg = registerDownload(buffer, filename, "application/pdf");

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              bill_id: params.bill_id,
              bill_number: bill.number ?? null,
              filename,
              format: "pdf",
              size_kb: Math.round(buffer.length / 1024),
              direct_download_url: reg.url,
              expires_at: reg.expires_at,
              assets: { logo_inlined: inlined.length, skipped },
              usage_hint: "Fetch direct_download_url to attach this invoice PDF to an email or save it.",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data ?? err.clioBody }) }],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  //  set_bill_state — change a bill's state (e.g. void, back to draft)
  // ============================================================
  // Wraps PATCH /bills/{id} with a target state. Common use cases:
  //   awaiting_payment → void   (firm-error fix; client won't be billed)
  //   awaiting_payment → draft  (move back for further editing)
  // Some transitions are restricted by Clio (e.g. you can't un-pay a paid
  // bill, and voiding may require additional fields like voided_at). Errors
  // are surfaced verbatim so the caller sees exactly what Clio rejected.
  server.tool(
    "set_bill_state",
    "Change a bill's state. Useful for voiding a bill that won't be issued, or moving an issued bill back to draft for editing. Wraps PATCH /bills/{id} with the target state. Reads before/after for audit. Some transitions may be restricted by Clio (e.g. paid → anything-else); Clio errors are surfaced verbatim. If the bill is already in the target state, no PATCH is sent.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
      target_state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void"])
        .describe(
          "Target state. Common transitions: awaiting_payment → void (firm-error fix), awaiting_payment → draft (re-edit), draft → awaiting_payment (issue).",
        ),
    },
    async (params) => {
      const out = await setBillState(params.bill_id, params.target_state);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out.payload, null, out.pretty ? 2 : undefined) }],
        ...(out.isError ? { isError: true } : {}),
      };
    },
  );

  // bulk_set_bill_state — set_bill_state over a list of bills in one call.
  // Per-bill failures are isolated; a time budget keeps the call under the
  // connector gateway timeout and returns the unstarted remainder.
  server.tool(
    "bulk_set_bill_state",
    `Change the state of many bills in one call (e.g. approve a batch: awaiting_approval → awaiting_payment, or void several). Same semantics as set_bill_state applied to each bill: reads before/after, no PATCH if already in the target state, Clio errors surfaced verbatim per bill. Per-bill failures never abort the rest. Up to ${BULK_MAX_ITEMS} bills per call. A time budget (max_seconds, default ${BULK_DEFAULT_BUDGET_SECONDS}) stops new bills from starting before the connector times out; anything not started comes back in not_attempted — re-call with just those IDs. Order of processing is not guaranteed.`,
    {
      bill_ids_csv: z.string().describe("Comma-separated Clio bill IDs, e.g. '101,102,103'. Duplicates are dropped."),
      target_state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void"])
        .describe("Target state applied to every bill in the list."),
      max_seconds: z.coerce.number().optional().describe(`Time budget before no new bills are started (default ${BULK_DEFAULT_BUDGET_SECONDS}, max ${BULK_MAX_BUDGET_SECONDS}).`),
    },
    async (params) => {
      let ids: number[];
      try {
        ids = parseIdList(params.bill_ids_csv);
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: err.message }) }],
          isError: true,
        };
      }
      const outcome = await runBulk(
        ids,
        async (id) => {
          const out = await setBillState(id, params.target_state);
          if (out.isError) {
            const e: any = new Error(String(out.payload.message ?? "set_bill_state failed"));
            e.response = { status: out.payload.status, data: out.payload.clio_error };
            throw e;
          }
          return out.payload;
        },
        { budgetSeconds: params.max_seconds },
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: outcome.summary.failed === 0 && outcome.summary.not_attempted === 0,
            target_state: params.target_state,
            ...outcome,
          }, null, 2),
        }],
        ...(outcome.summary.failed > 0 ? { isError: true } : {}),
      };
    },
  );

  // ============================================================
  //  delete_draft_bill — DELETE a draft bill via /bills/{id}
  // ============================================================
  // Underlying activities are NOT deleted; they revert to unbilled and
  // will be picked up by Clio's "Generate Bill" / "Regenerate Draft" flow
  // in the matter's UI. Use case: cleaning up a stale draft after
  // prepare_line_split / prepare_hard_combine when Clio UI doesn't expose
  // a Regenerate Draft option for the bill in question (varies by plan).
  // Refuses if the bill is not in 'draft' state — deleting issued/paid/
  // void bills affects accounting and isn't supported here.
  server.tool(
    "delete_draft_bill",
    "Delete a draft bill via DELETE /bills/{id}. Refuses if the bill is not in 'draft' state. The underlying activities are NOT deleted — they revert to unbilled and will appear on the next bill cycle for the matter, OR you can immediately recreate a draft via Clio UI ('Generate Bill' on the matter). Use case: cleaning up a stale draft after prepare_line_split / prepare_hard_combine when Clio UI doesn't expose a per-bill Regenerate Draft option (varies by Clio plan). Reads the bill's pre-delete state for audit; returns an explicit ui_instruction for the next step.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID. Must currently be in 'draft' state."),
    },
    async (params) => {
      try {
        // Step 1: Read the bill to verify state before deleting.
        const beforeResp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: BILL_FIELDS,
        });
        const before = beforeResp.data;
        if (!before) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, message: `Bill ${params.bill_id} not found.` }),
            }],
            isError: true,
          };
        }
        if (before.state !== "draft") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                bill_id: params.bill_id,
                bill_state: before.state,
                message: `Refusing to delete: bill ${before.number || params.bill_id} is in state "${before.state}", not "draft". Only draft bills can be deleted via this tool. To void an issued bill, use set_bill_state with target_state="void".`,
                context: "bill_not_draft",
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Step 2: DELETE the bill.
        await rawDeleteSingle(`/bills/${params.bill_id}`);

        const matterDisplay = before.matters?.[0]?.display_number ?? `matter ${before.matters?.[0]?.id ?? "?"}`;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              deleted_bill: {
                id: params.bill_id,
                number: before.number,
                total: before.total,
                balance: before.balance,
                state: "draft",
                matter: before.matters?.[0] ?? null,
              },
              ui_instruction: `Bill ${before.number || params.bill_id} (draft, was \$${before.total ?? 0}) has been deleted. The underlying activities are now unbilled. To bring them back onto a fresh draft on ${matterDisplay}, open Clio UI → that matter → click "Generate Bill" (or "Create Bill"). The new draft will include all unbilled activities for the matter within the relevant date range — including any you just created via prepare_line_split / prepare_hard_combine / etc.`,
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
              bill_id: params.bill_id,
              status,
              message: err.message,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  //  download_bills_pdf — Bulk download bills as a zip of PDFs
  // ============================================================
  server.tool(
    "download_bills_pdf",
    "Render multiple bills to PDFs and return a short-lived download URL for a zip of them. Filters bills by state, matter, client, or date range. Each invoice is rendered from its preview HTML (same engine as render_bill_pdf: logo embedded, Clio Payments stub — page-break divider, repeated header, and 'Pay online'/QR block — stripped). Draft bills are skipped (no issued invoice to render). Per-bill render failures are collected without sinking the batch. Requires Chromium on the server (PUPPETEER_EXECUTABLE_PATH).",
    {
      state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "all"])
        .optional()
        .default("all")
        .describe("Filter by bill state"),
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      client_id: z.coerce.number().optional().describe("Filter by client ID"),
      issued_after: z.string().optional().describe("Issued after date (YYYY-MM-DD)"),
      issued_before: z.string().optional().describe("Issued before date (YYYY-MM-DD)"),
    },
    async (params) => {
      try {
        // Fetch matching bills
        const queryParams: Record<string, any> = {
          fields: "id,number,state,issued_at",
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.client_id) queryParams.client_id = params.client_id;
        if (params.state !== "all") queryParams.state = params.state;
        if (params.issued_after) queryParams.issued_after = params.issued_after;
        if (params.issued_before) queryParams.issued_before = params.issued_before;

        const bills = await fetchAllPages<any>("/bills", queryParams);

        if (bills.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "No bills matched the provided filters." }) }],
            isError: true,
          };
        }

        // Separate downloadable bills from drafts
        const drafts = bills.filter((b: any) => b.state === "draft");
        const downloadable = bills.filter((b: any) => b.state !== "draft");

        if (downloadable.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `All ${drafts.length} matching bill(s) are drafts — PDFs are only available for issued bills.` }) }],
            isError: true,
          };
        }

        // Render each issued bill's invoice to PDF from its preview HTML.
        // Rendered sequentially so we never run more than one headless browser
        // at a time; per-bill failures are collected without sinking the batch.
        const zip = new JSZip();
        let downloaded = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const bill of downloadable) {
          try {
            const { buffer } = await renderBillPdf(bill.id);
            zip.file(`Bill-${bill.number || bill.id}.pdf`, buffer);
            downloaded++;
          } catch (e: any) {
            failed++;
            errors.push(`Bill ${bill.number || bill.id}: ${e?.message ?? "render failed"}`);
          }
        }

        if (downloaded === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Failed to render all ${downloadable.length} bill PDFs. Errors: ${errors.join("; ")}` }) }],
            isError: true,
          };
        }

        const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

        const filterDesc = [
          params.state !== "all" ? params.state : null,
          params.matter_id ? `matter-${params.matter_id}` : null,
          params.client_id ? `client-${params.client_id}` : null,
        ].filter(Boolean).join("_") || "filtered";

        const filename = `Bills-${filterDesc}.zip`;
        const reg = registerDownload(zipBuffer, filename, "application/zip");

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "zip",
              size_kb: Math.round(zipBuffer.length / 1024),
              direct_download_url: reg.url,
              expires_at: reg.expires_at,
              summary: {
                total_matched: bills.length,
                downloaded,
                skipped_drafts: drafts.length,
                failed,
                errors: errors.length > 0 ? errors : undefined,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  //  probe_billing_write_apis — DIAGNOSTIC, non-destructive
  // ============================================================
  // Question this answers: does Clio's v4 API expose ANY endpoint that
  // generates/creates a bill (so we could build a "generate a bill" tool),
  // and what does POST /matters require (so we can build create_matter
  // correctly, incl. the matter-level custom-rate field)?
  //
  // SAFETY: this NEVER creates a real bill or matter. It probes existence
  // by reading HTTP status codes, not by submitting valid payloads:
  //   - Bill-generation candidates are POSTed an intentionally INVALID body
  //     (empty data, or a nonexistent matter id -1). Clio's response tells
  //     us about the ROUTE, not about any created object:
  //       404 → route does not exist (no such endpoint)
  //       405 → route exists but POST is not allowed (read-only resource)
  //       422 / 400 → route EXISTS and reached validation (proves it's real),
  //                   but our deliberately-bad payload was rejected → nothing made
  //   - The matter-create probe POSTs `{data:{}}` (no client). Clio requires a
  //     client, so this 422s and surfaces the required/accepted field names in
  //     the error body — without creating a matter.
  //   - The matter-schema read is a plain GET of one existing matter to reveal
  //     the real field names (custom_rate, billing fields, etc.).
  diagnosticTool(server).tool(
    "probe_billing_write_apis",
    "Diagnostic (non-destructive). Probes whether Clio's v4 API exposes any bill-generation/creation endpoint, and discovers what POST /matters requires. Reads HTTP status codes from deliberately-invalid payloads (empty body / nonexistent matter id) so NO bill or matter is ever created: 404 = route absent, 405 = route exists but not POST-able, 422/400 = route exists and reached validation. Also GETs one existing matter to reveal the real field schema (custom_rate, billing fields) for building create_matter. Run this before building matter/bill write tools.",
    {
      existing_matter_id: z
        .coerce
        .number()
        .optional()
        .describe("Optional: a real matter ID to (a) read its full field schema and (b) test the /matters/{id}/bills POST route. If omitted, the first matter returned by /matters is used."),
    },
    async (params) => {
      const out: any = {
        note: "Non-destructive. POST probes use invalid payloads; a 422/400 means the ROUTE EXISTS but nothing was created. 404 = no such route, 405 = route exists but POST not allowed.",
        bill_generation_candidates: [],
        matter_create_probe: null,
        matter_schema: null,
      };

      // Resolve a matter id for the per-matter bill route + schema read.
      let matterId = params.existing_matter_id ?? null;
      if (matterId === null) {
        try {
          const matters = await fetchAllPages<any>("/matters", { fields: "id" }, 1);
          matterId = matters[0]?.id ?? null;
        } catch {
          /* leave null; per-matter probe will be skipped */
        }
      }

      // 1) Candidate bill-generation/creation routes. Empty/invalid bodies only.
      const billCandidates: Array<{ path: string; body: any }> = [
        { path: "/bills", body: { data: {} } },
        { path: "/bill_generation_requests", body: { data: { matter: { id: -1 } } } },
        { path: "/bill_generations", body: { data: { matter: { id: -1 } } } },
        { path: "/draft_bills", body: { data: { matter: { id: -1 } } } },
      ];
      if (matterId !== null) {
        billCandidates.push({ path: `/matters/${matterId}/bills`, body: { data: {} } });
      }

      for (const c of billCandidates) {
        try {
          const res = await rawPostSingle(c.path, c.body);
          // A 2xx here would be surprising — surface it loudly so we can
          // immediately clean up if anything was actually created.
          out.bill_generation_candidates.push({
            path: c.path,
            status: 200,
            route_exists: true,
            WARNING: "Returned 2xx to an invalid payload — inspect response; a bill/object MAY have been created.",
            response: res?.data ?? res,
          });
        } catch (e: any) {
          const status = e?.response?.status ?? null;
          out.bill_generation_candidates.push({
            path: c.path,
            status,
            route_exists: status !== 404 && status !== null,
            interpretation:
              status === 404 ? "No such route — endpoint does not exist."
              : status === 405 ? "Route exists but POST is not allowed (read-only resource)."
              : status === 422 || status === 400 ? "Route EXISTS and reached validation — bill generation MAY be possible with a valid payload."
              : status === 403 ? "Route exists but forbidden for this token's permissions."
              : "Unexpected — see clio_error.",
            clio_error:
              typeof e?.response?.data === "string"
                ? e.response.data.slice(0, 400)
                : e?.response?.data,
          });
        }
      }

      // 2) POST /matters with no client → 422 reveals required/accepted fields.
      try {
        const res = await rawPostSingle("/matters", { data: {} });
        out.matter_create_probe = {
          status: 200,
          route_exists: true,
          WARNING: "POST /matters with empty data returned 2xx — a matter MAY have been created; inspect/delete.",
          response: res?.data ?? res,
        };
      } catch (e: any) {
        const status = e?.response?.status ?? null;
        out.matter_create_probe = {
          status,
          route_exists: status !== 404 && status !== null,
          interpretation:
            status === 422 || status === 400 ? "POST /matters EXISTS — create_matter is buildable. The clio_error below lists required/accepted fields."
            : status === 404 ? "No POST /matters route (unexpected)."
            : status === 405 ? "Route exists but POST not allowed (unexpected)."
            : "See clio_error.",
          clio_error:
            typeof e?.response?.data === "string"
              ? e.response.data.slice(0, 600)
              : e?.response?.data,
        };
      }

      // 3) Read one existing matter (no fields param = Clio's default set) to
      // reveal real field names for create_matter (custom_rate, billing, etc.).
      if (matterId !== null) {
        try {
          const res = await rawGetSingle(`/matters/${matterId}`);
          const data = res?.data ?? res;
          out.matter_schema = {
            sampled_matter_id: matterId,
            default_field_keys: data && typeof data === "object" ? Object.keys(data) : null,
            sample: data,
          };
        } catch (e: any) {
          out.matter_schema = {
            sampled_matter_id: matterId,
            error: e?.response?.status ?? String(e),
          };
        }
      } else {
        out.matter_schema = { error: "No matter id available to sample." };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    },
  );

  // ============================================================
  //  probe_bill_pdf_apis — DIAGNOSTIC for the bill-PDF download path
  // ============================================================
  // Why: live testing (2026-07-13, bill 1323892745) showed GET /bills/{id}.pdf
  // returning the bill's default-field JSON (id/etag/number/state) on every
  // poll for 90s — i.e. the .pdf suffix behaves like .json for OAuth API
  // clients and never starts a render job. The Clio web app serves rendered
  // bills from a first-party bill_printings route (session-cookie auth), so
  // the supported API path may be a generate-then-fetch endpoint PAIR rather
  // than repeated GETs on /bills/{id}.pdf. This probe hits every candidate
  // route against a REAL bill and reports status/content-type/full body, so
  // one run against live data settles which route actually serves the file.
  //
  // SAFETY: read-only by default. The only writes are gated behind
  // generate_printing=true, which POSTs /bill_printings — that renders a PDF
  // of an existing bill (what the web UI's Download button does) and creates
  // no billing records. Route-existence POSTs use an intentionally INVALID
  // empty body (404 = no route, 405 = no POST, 422/400 = route exists,
  // nothing created).
  diagnosticTool(server).tool(
    "probe_bill_pdf_apis",
    "Diagnostic for bill PDF download. Probes every candidate route for fetching a bill's rendered PDF via the API — GET /bills/{id}.pdf, content negotiation (Accept: application/pdf), /bills/{id}/download(.pdf), and the bill_printings generate-then-fetch pair — reporting status, content-type, and the FULL response body for each. Read-only by default; set generate_printing=true to also POST /bill_printings for this bill (renders a PDF, creates no billing records) and poll the resulting printing for a downloadable file. Use an issued (non-draft) bill_id.",
    {
      bill_id: z.coerce.number().describe("A real, issued bill ID to probe against (use get_bills to find one)."),
      generate_printing: z.coerce.boolean().optional().default(false)
        .describe("Also POST /bill_printings for this bill and poll the created printing for a PDF. Renders a PDF of the existing bill; creates no billing records."),
    },
    async (params) => {
      const id = params.bill_id;
      const out: any = {
        note:
          "Each probe reports status, content_type, is_pdf, and the raw body so the working route is identifiable from one run. " +
          "Redirects (303→S3) are followed automatically, so a working redirect route shows up as is_pdf=true.",
        get_probes: [],
        bill_printings: {},
      };

      const probeGet = async (label: string, path: string, headers?: Record<string, string>, query: Record<string, any> = {}) => {
        try {
          const res = await rawGetBinarySingle(path, query, headers);
          const isPdf = looksLikePdf(res.buffer, res.contentType);
          return {
            probe: label, status: 200, content_type: res.contentType, is_pdf: isPdf, bytes: res.buffer.length,
            body: isPdf ? `(PDF bytes, ${res.buffer.length} bytes)` : res.buffer.toString("utf8").slice(0, 1500),
            interpretation: isPdf ? "SUCCESS — this route serves the PDF." : "Route exists but returned non-PDF content — see body.",
          };
        } catch (e: any) {
          const status = e?.response?.status ?? null;
          return {
            probe: label, status, is_pdf: false,
            body: typeof e?.response?.data === "string" ? e.response.data.slice(0, 800) : e?.response?.data,
            interpretation:
              status === 404 ? "No such route."
              : status === 406 ? "Route exists but this Accept type is not supported."
              : status === 403 ? "Forbidden — token lacks permission for this route."
              : `Request failed: ${e?.message}`,
          };
        }
      };

      out.get_probes.push(await probeGet(`GET /bills/${id}.pdf`, `/bills/${id}.pdf`));
      out.get_probes.push(await probeGet(`GET /bills/${id} (Accept: application/pdf)`, `/bills/${id}`, { Accept: "application/pdf" }));
      out.get_probes.push(await probeGet(`GET /bills/${id}/download`, `/bills/${id}/download`));
      out.get_probes.push(await probeGet(`GET /bills/${id}/download.pdf`, `/bills/${id}/download.pdf`));
      out.get_probes.push(await probeGet(`GET /bill_printings?bill_id=${id}`, `/bill_printings`, undefined, { bill_id: id }));

      // Route-existence probe: POST /bill_printings with an INVALID empty body.
      try {
        const res = await rawPostSingle("/bill_printings", { data: {} });
        out.bill_printings.post_route_probe = {
          status: 200, route_exists: true,
          WARNING: "POST /bill_printings accepted an empty body — inspect the response; a printing may have been created.",
          response: res?.data ?? res,
        };
      } catch (e: any) {
        const status = e?.response?.status ?? null;
        out.bill_printings.post_route_probe = {
          status, route_exists: status !== 404 && status !== null,
          interpretation:
            status === 404 ? "No POST /bill_printings route in API v4 — the generate-then-fetch pair is not exposed here."
            : status === 405 ? "Route exists but POST is not allowed."
            : status === 422 || status === 400 ? "Route EXISTS and reached validation — a valid {data:{bill:{id}}} payload may create a printing. Re-run with generate_printing=true."
            : status === 403 ? "Route exists but forbidden for this token."
            : "Unexpected — see clio_error.",
          clio_error: typeof e?.response?.data === "string" ? e.response.data.slice(0, 600) : e?.response?.data,
        };
      }

      // Delivery-route candidates: if Clio's SEND-BILL flow (web UI "Send bill",
      // which emails a secure PDF link/attachment) is API-triggerable, the PDF
      // can be obtained by sending the bill to a firm inbox and pulling the
      // attachment there. Route existence only — every POST uses an INVALID
      // empty body so no email is ever sent: 404 = no route, 405 = no POST,
      // 422/400 = route exists and validated our bad payload (nothing sent).
      out.delivery_routes = [];
      const deliveryCandidates = [
        `/bills/${id}/deliveries`,
        "/bill_deliveries",
        `/bills/${id}/send`,
        `/bills/${id}/share`,
        "/outbound_shares",
      ];
      for (const path of deliveryCandidates) {
        try {
          const res = await rawPostSingle(path, { data: {} });
          out.delivery_routes.push({
            path, status: 200, route_exists: true,
            WARNING: "POST accepted an empty body — inspect the response; a delivery/share MAY have been created.",
            response: res?.data ?? res,
          });
        } catch (e: any) {
          const status = e?.response?.status ?? null;
          out.delivery_routes.push({
            path, status, route_exists: status !== 404 && status !== null,
            interpretation:
              status === 404 ? "No such route."
              : status === 405 ? "Route exists but POST is not allowed."
              : status === 422 || status === 400 ? "Route EXISTS and reached validation — bill sending is likely API-triggerable with a valid payload (recipient etc.). Nothing was sent."
              : status === 403 ? "Route exists but forbidden for this token."
              : "Unexpected — see clio_error.",
            clio_error: typeof e?.response?.data === "string" ? e.response.data.slice(0, 400) : e?.response?.data,
          });
        }
      }

      // Read-only: does the rendered invoice ever land in Clio Documents?
      // (Some flows save sent invoices as matter documents, which ARE
      // downloadable via the API's /documents S3-redirect path.)
      try {
        const bill = (await rawGetSingle(`/bills/${id}`, { fields: "id,number,shared,last_sent_at,matters" }))?.data;
        out.bill_send_state = { number: bill?.number, shared: bill?.shared, last_sent_at: bill?.last_sent_at };
        if (bill?.number != null) {
          const docs = await fetchAllPages<any>("/documents", {
            query: String(bill.number),
            fields: "id,name,content_type,date,matter{id,display_number}",
          }, 10);
          out.documents_matching_bill_number = docs.map((d: any) => ({
            id: d.id, name: d.name, content_type: d.content_type, date: d.date, matter: d.matter?.display_number,
          }));
        }
      } catch (e: any) {
        out.documents_matching_bill_number = { error: e?.response?.status ?? e?.message };
      }

      if (params.generate_printing) {
        // Try the payload shapes Clio uses elsewhere for associations.
        const payloads = [{ data: { bill: { id } } }, { data: { bill_id: id } }];
        for (const body of payloads) {
          try {
            const res = await rawPostSingle("/bill_printings", body);
            const printing = res?.data ?? res;
            out.bill_printings.create = { sent: body, status: 200, response: printing };
            const pid = printing?.id;
            if (pid) {
              // Poll the printing briefly, then try to fetch its file.
              let state = printing?.state;
              const deadline = Date.now() + 30_000;
              while (!["completed", "complete", "finished", "failed", "error"].includes(String(state ?? "")) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2000));
                try {
                  const s = await rawGetSingle(`/bill_printings/${pid}`);
                  state = (s?.data ?? s)?.state;
                  out.bill_printings.last_poll = s?.data ?? s;
                } catch (pollErr: any) {
                  out.bill_printings.poll_error = pollErr?.response?.status ?? pollErr?.message;
                  break;
                }
              }
              out.bill_printings.final_state = state ?? "unknown";
              out.bill_printings.fetch_pdf = await probeGet(`GET /bill_printings/${pid}.pdf`, `/bill_printings/${pid}.pdf`);
              if (!out.bill_printings.fetch_pdf.is_pdf) {
                out.bill_printings.fetch_download = await probeGet(`GET /bill_printings/${pid}/download`, `/bill_printings/${pid}/download`);
              }
            }
            break; // a payload shape worked — don't create a second printing
          } catch (e: any) {
            (out.bill_printings.create_attempts ??= []).push({
              sent: body, status: e?.response?.status ?? null,
              clio_error: typeof e?.response?.data === "string" ? e.response.data.slice(0, 600) : e?.response?.data,
            });
          }
        }
      }

      // One-line verdict so the caller doesn't have to eyeball every probe.
      const winner = out.get_probes.find((p: any) => p.is_pdf) ?? (out.bill_printings.fetch_pdf?.is_pdf ? out.bill_printings.fetch_pdf : null) ?? (out.bill_printings.fetch_download?.is_pdf ? out.bill_printings.fetch_download : null);
      const sendable = (out.delivery_routes as any[]).filter((r) => r.route_exists);
      out.verdict = winner
        ? `PDF obtained via: ${winner.probe}. Wire download_bill_pdf to this route.`
        : sendable.length > 0
          ? `No route returns the PDF directly, but delivery route(s) exist: ${sendable.map((r: any) => r.path).join(", ")}. ` +
            `Bill sending may be API-triggerable — send to a firm inbox and pull the attachment there.`
          : "No probed route returned a PDF and no delivery/send route exists. The OAuth API does not expose rendered bill PDFs — use the Clio web UI download or reconstruct-from-line-items.";

      return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
    },
  );
}
