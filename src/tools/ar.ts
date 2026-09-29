import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ExcelJS from "exceljs";
import { fetchAllPages } from "../clio/pagination";
import { uploadToBox, createBoxFile, findBoxFileId, downloadFromBox } from "../utils/box";
import {
  DISCRETE_BUCKETS,
  CUMULATIVE_THRESHOLDS,
  STALE_THRESHOLD_DAYS,
  BOUNDARY_RULE_TEXT,
  bucketizeAging,
  cumulativeKey,
  discreteBucketLabel,
  reconcileDiscreteBuckets,
  type AgingBuckets,
  type AgingItem,
  type BucketReconciliation,
  type BucketSummary,
} from "../domain/arAging";

// Box folder that holds the AR Scorecard workbook: Traction > Measurables >
// Weekly Measureables (an EOS weekly measurable). The file is versioned in place.
const AR_SCORECARD_FOLDER = "390777368470";
const AR_SCORECARD_FILENAME = "AR Scorecard.xlsx";

const BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,kind,state,matters";

// trust_line_items has limited fields — use defaults + matter association
const TRUST_FIELDS = "id,date,total,matter{id,display_number,client}";

// Scorecard fetch needs matter sub-objects (client/responsible_attorney) plus
// `kind` (revenue_kind = true AR for services; trust_kind = trust/retainer
// funding request — NOT a receivable), `paid`/`paid_at` (whether/when a trust
// request was funded) and `state`.
const SCORECARD_BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,paid,paid_at,kind,state," +
  "matters{id,display_number,description,client,responsible_attorney}";

// Matter fields used to join AR/bill rows to a practice area for the
// Gated/Non-Gated split. status=all is fetched so closed-matter invoices still
// classify; practice_area{name} is the proven form (see audit.ts).
const SCORECARD_MATTER_FIELDS = "id,practice_area{name}";

// Paid bills are fetched ONLY to mark trust requests funded — no AR figure
// reads them. An unfiltered state=paid sweep pulls every fee invoice the firm
// has ever been paid (with matter/client/attorney sub-objects), which is what
// timed the scorecard out; type=trust (GET /bills enum: revenue|trust) drops
// those server-side while keeping the full funded-request history. All AR and
// every unfunded request still come from awaiting_payment, unfiltered.
const SCORECARD_PAID_TRUST_PARAMS = { fields: SCORECARD_BILL_FIELDS, state: "paid", type: "trust" };

// ====================================================================
// AR track classification (Gated vs. Non-Gated)
// --------------------------------------------------------------------
// A large share of firm AR is court-gated appointment work whose aging
// reflects court/estate payment timelines, not collection failure. Splitting
// AR by the matter's practice_area keeps those two tracks from corrupting each
// other's headline aging numbers. This mapping is the one partner-level policy
// choice in the split — it is intentionally kept in ONE place so get_ar_aging
// (or any future tool) can share it.
// ====================================================================
// NOTE: these are matched EXACTLY (trimmed, case-sensitive) against Clio's
// practice_area name, so every entry must be the practice area's literal name in
// Clio — including any parenthetical suffix. A renamed or misspelled entry
// silently matches nothing and sends that whole practice area's AR to the
// Non-Gated (headline) track. `track_config_health` in the scorecard output
// reports any entry here that matched no matter, so that can't stay invisible.
export const GATED_PRACTICE_AREAS = new Set<string>([
  "Appointment",
  // The client serves as dependent administrator; payment is court-approved out
  // of the estate, so aging reflects court/estate timelines, not collection
  // failure. Added per firm policy 2026-08.
  "Dependent Administration (Client Serving)",
  "Guardianship",
  "Mental Comm",
  "Representative (R&S Serving)",
]);
// Guardianship Litigation is deliberately NOT gated: the firm is paid up front
// by the client, who is reimbursed for fees later, so its aging IS a collection
// signal and belongs in the client-pay headline. Kept as an explicit named
// exclusion (rather than just absent) because its name reads gated and it sits
// next to Guardianship, which IS gated. Changed per firm policy 2026-08.
export const NON_GATED_BY_POLICY_PRACTICE_AREAS = new Set<string>([
  "Guardianship Litigation",
]);
// Probate is paced by estate liquidity, but per firm policy it is client-pay
// (Non-Gated) in the general case, so it defaults to the non_gated track. It is
// still its own flag (semi_gated) so probate_treatment="separate" can break it
// out for review, or ="gated" if that ever changes.
export const SEMI_GATED_PRACTICE_AREAS = new Set<string>(["Probate"]);
// Everything else with a known practice area = Non-Gated (client-pay).

// ====================================================================
// Gated-pattern description keywords (tagging-drift heuristic)
// --------------------------------------------------------------------
// Matter DESCRIPTIONS that read like court-gated appointment work. Used only to
// flag likely practice_area tagging drift for human review (two
// "Dependent Administration" matters carrying different practice_area values
// silently move AR between the Gated and Non-Gated tracks). This list never
// reclassifies a matter and never changes a reported figure — classification is
// always driven by practice_area via classifyTrack().
// ====================================================================
// A matter whose practice_area is a DELIBERATE non-gated classification is not
// tagging drift, however gated its description reads — Guardianship Litigation
// is the case in point: it is named like gated work, sits beside Guardianship
// (which is gated), and would otherwise flag on every single matter. Excluded
// from both heuristics below so the flag list stays a real work queue.
export const HEURISTIC_EXEMPT_PRACTICE_AREAS = NON_GATED_BY_POLICY_PRACTICE_AREAS;

export const GATED_DESCRIPTION_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "Dependent Administration", re: /\bdependent\s+administration\b/i },
  { label: "Temporary Administration", re: /\btemporary\s+administration\b/i },
  { label: "Permanent Administration", re: /\bpermanent\s+administration\b/i },
  { label: "Guardianship", re: /\bguardianship\b/i },
  { label: "Ad Litem", re: /\bad\s+litem\b/i },
  { label: "Mental Commitment", re: /\bmental\s+(commitment|comm(?:itment)?)\b/i },
];

export type TrackKey = "gated" | "semi_gated" | "non_gated" | "unclassified";

// Classify a matter's practice_area name into a base track. A null/blank name
// is "unclassified" — never silently bucketed as either track, so null-practice
// -area matters stay visible for backfill.
export function classifyTrack(practiceAreaName: string | null | undefined): TrackKey {
  const name = (practiceAreaName ?? "").trim();
  if (!name) return "unclassified";
  if (GATED_PRACTICE_AREAS.has(name)) return "gated";
  if (SEMI_GATED_PRACTICE_AREAS.has(name)) return "semi_gated";
  return "non_gated";
}

// Display labels for the tracks (workbook tabs).
const trackLabel: Record<TrackKey, string> = { gated: "Gated", semi_gated: "Semi-Gated", non_gated: "Non-Gated", unclassified: "Unclassified" };

export type ProbateTreatment = "gated" | "non_gated" | "separate";

// Apply the configurable probate_treatment to a base track. When Probate is not
// reported separately it is folded into the chosen track and semi_gated is
// dropped from the output.
export function effectiveTrack(base: TrackKey, treatment: ProbateTreatment): TrackKey {
  if (base === "semi_gated" && treatment !== "separate") {
    return treatment === "gated" ? "gated" : "non_gated";
  }
  return base;
}

interface Invoice {
  bill_id: number;
  bill_number: string;
  matter_id: number;
  matter_number: string;
  client_name: string;
  client_email: string | null;
  issued_at: string;
  due_at: string;
  balance: number;
  days_outstanding: number;
  responsible_attorney: string | null;
  // Discrete aging bucket label under the 7/15/30/60/90/120/180/360 scheme
  // (see src/domain/arAging.ts for the boundary rule).
  aging_bucket: string;
}

interface Bucket {
  total: number;
  count: number;
  unique_clients: number;
  invoices: Invoice[];
}

// ====================================================================
// WIP (unbilled time + expenses) per matter
// --------------------------------------------------------------------
// Extracted verbatim from get_wip_report so get_ar_scorecard's optional
// include_wip cross-reference reports the SAME numbers as the WIP tool itself
// (same 90-day created_since window, same rounded_quantity basis, same
// RED/YELLOW ageing flags) rather than a second, subtly different definition.
// ====================================================================
export type WipMatterRow = {
  matter_id: number;
  matter_number: string;
  matter_description: string;
  client: any;
  responsible_attorney: any;
  oldest_entry_date: string;
  days_since_oldest_entry: number;
  unbilled_hours: number;
  unbilled_time_value: number;
  unbilled_expenses: number;
  combined_wip_value: number;
  flag: string | null;
};

export async function computeWipMatters(opts: {
  responsible_attorney_id?: number;
}): Promise<{ matters: WipMatterRow[]; red_flag_count: number }> {
  const defaultStart = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
  const timeParams: Record<string, any> = {
    type: "TimeEntry",
    billed: false,
    fields:
      "id,date,quantity,rounded_quantity,price,matter{id,display_number,description,client,responsible_attorney}",
    created_since: `${defaultStart}T00:00:00+00:00`,
  };
  const expenseParams: Record<string, any> = {
    type: "ExpenseEntry",
    billed: false,
    fields:
      "id,date,price,matter{id,display_number,description,client,responsible_attorney}",
    created_since: `${defaultStart}T00:00:00+00:00`,
  };

  const [timeEntries, expenses] = await Promise.all([
    fetchAllPages<any>("/activities", timeParams),
    fetchAllPages<any>("/activities", expenseParams),
  ]);

  const byMatter: Record<
    number,
    {
      matter: any;
      unbilled_hours: number;
      unbilled_time_value: number;
      unbilled_expenses: number;
      oldest_entry: string;
    }
  > = {};

  for (const e of timeEntries) {
    const mid = e.matter?.id;
    if (!mid) continue;
    if (
      opts.responsible_attorney_id &&
      e.matter?.responsible_attorney?.id !== opts.responsible_attorney_id
    )
      continue;

    if (!byMatter[mid]) {
      byMatter[mid] = {
        matter: e.matter,
        unbilled_hours: 0,
        unbilled_time_value: 0,
        unbilled_expenses: 0,
        oldest_entry: e.date,
      };
    }
    // Use rounded_quantity (billed increment) not raw quantity, so WIP
    // matches what the client will actually see invoiced.
    const hours = (e.rounded_quantity ?? e.quantity) / 3600;
    byMatter[mid].unbilled_hours += hours;
    byMatter[mid].unbilled_time_value += hours * (e.price || 0);
    if (e.date < byMatter[mid].oldest_entry) {
      byMatter[mid].oldest_entry = e.date;
    }
  }

  for (const e of expenses) {
    const mid = e.matter?.id;
    if (!mid) continue;
    if (
      opts.responsible_attorney_id &&
      e.matter?.responsible_attorney?.id !== opts.responsible_attorney_id
    )
      continue;

    if (!byMatter[mid]) {
      byMatter[mid] = {
        matter: e.matter,
        unbilled_hours: 0,
        unbilled_time_value: 0,
        unbilled_expenses: 0,
        oldest_entry: e.date,
      };
    }
    byMatter[mid].unbilled_expenses += e.price || 0;
    if (e.date < byMatter[mid].oldest_entry) {
      byMatter[mid].oldest_entry = e.date;
    }
  }

  const today = new Date();
  let redFlagCount = 0;

  const matters = Object.entries(byMatter).map(([, m]) => {
    const combinedWip = m.unbilled_time_value + m.unbilled_expenses;
    const daysSinceOldest = Math.floor(
      (today.getTime() - new Date(m.oldest_entry).getTime()) / (1000 * 60 * 60 * 24)
    );

    let flag: string | null = null;
    if (daysSinceOldest > 60) {
      flag = "RED";
      redFlagCount++;
    } else if (daysSinceOldest > 30) {
      flag = "YELLOW";
    }

    return {
      matter_id: m.matter.id,
      matter_number: m.matter.display_number,
      matter_description: m.matter.description,
      client: m.matter.client,
      responsible_attorney: m.matter.responsible_attorney,
      oldest_entry_date: m.oldest_entry,
      days_since_oldest_entry: daysSinceOldest,
      unbilled_hours: Math.round(m.unbilled_hours * 100) / 100,
      unbilled_time_value: Math.round(m.unbilled_time_value * 100) / 100,
      unbilled_expenses: Math.round(m.unbilled_expenses * 100) / 100,
      combined_wip_value: Math.round(combinedWip * 100) / 100,
      flag,
    };
  });

  return { matters, red_flag_count: redFlagCount };
}

export function registerARTools(server: McpServer): void {
  // get_ar_aging
  server.tool(
    "get_ar_aging",
    "Full accounts receivable aging report. Counts ONLY revenue_kind fee bills; trust/retainer funding requests (trust_kind) are advance-deposit requests, not receivables, and are excluded. Ages every open invoice by days_outstanding (days past due_at, floored at 0) and reports THREE views of the same dollars: (1) discrete_buckets — mutually exclusive buckets at the 7/15/30/60/90/120/180/360-day thresholds: 0-7, 8-15, 16-30, 31-60, 61-90, 91-120, 121-180, 181-360, 360+; these sum to total_ar to the cent and a reconciliation.reconciliation_ok flag proves it; (2) cumulative_buckets — rollups 7+, 15+, 30+, 60+, 90+, 120+, 180+, 360+, each DERIVED from the discrete buckets (so 360+ is a subset of 180+, and the two views can never drift); (3) buckets / legacy_buckets — the original fixed five-bucket shape (current, days_31_60, days_61_90, days_91_120, over_120) with full invoice detail, kept unchanged for backward compatibility. " + BOUNDARY_RULE_TEXT + " Every invoice also carries its own aging_bucket label. Includes client emails for direct action.",
    {
      responsible_attorney_id: z
        .number()
        .optional()
        .describe("Filter to one attorney's matters"),
      as_of_date: z
        .string()
        .optional()
        .describe("As-of date for aging calc (YYYY-MM-DD, default today)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: BILL_FIELDS,
          state: "awaiting_payment",
        };
        if (params.responsible_attorney_id) {
          queryParams.responsible_attorney_id = params.responsible_attorney_id;
        }

        const bills = await fetchAllPages<any>("/bills", queryParams);
        const asOf = params.as_of_date ? new Date(params.as_of_date) : new Date();

        const buckets: Record<string, Invoice[]> = {
          current: [],
          days_31_60: [],
          days_61_90: [],
          days_91_120: [],
          over_120: [],
        };

        for (const b of bills) {
          // AR = revenue_kind fee bills only. A trust_kind bill is a trust/retainer
          // funding request, not a receivable; any other (unexpected) kind is
          // excluded and surfaced rather than silently aged into AR.
          if (b.kind === "trust_kind") continue;
          if (b.kind !== "revenue_kind") {
            console.warn(`[get_ar_aging] excluding bill ${b.number ?? b.id} from AR — unexpected kind=${JSON.stringify(b.kind)}`);
            continue;
          }
          const dueDate = b.due_at ? new Date(b.due_at) : new Date(b.issued_at);
          const daysOut = Math.floor(
            (asOf.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
          );

          const m = b.matters?.[0];

          const invoice: Invoice = {
            bill_id: b.id,
            bill_number: b.number,
            matter_id: m?.id,
            matter_number: m?.display_number,
            client_name: m?.client?.name ?? "Unknown",
            client_email: null,
            issued_at: b.issued_at,
            due_at: b.due_at,
            balance: b.balance,
            days_outstanding: Math.max(daysOut, 0),
            responsible_attorney: m?.responsible_attorney?.name ?? null,
            aging_bucket: discreteBucketLabel(daysOut),
          };

          if (daysOut <= 30) buckets.current.push(invoice);
          else if (daysOut <= 60) buckets.days_31_60.push(invoice);
          else if (daysOut <= 90) buckets.days_61_90.push(invoice);
          else if (daysOut <= 120) buckets.days_91_120.push(invoice);
          else buckets.over_120.push(invoice);
        }

        // Sort each bucket by balance desc
        for (const key of Object.keys(buckets)) {
          buckets[key].sort((a, b) => b.balance - a.balance);
        }

        const makeBucket = (invoices: Invoice[]): Bucket => ({
          total: Math.round(invoices.reduce((s, i) => s + i.balance, 0) * 100) / 100,
          count: invoices.length,
          unique_clients: new Set(invoices.map((i) => i.client_name)).size,
          invoices,
        });

        const allInvoices = Object.values(buckets).flat();
        const totalAR =
          Math.round(allInvoices.reduce((s, i) => s + i.balance, 0) * 100) / 100;
        const weightedDays = allInvoices.reduce(
          (s, i) => s + i.days_outstanding * i.balance,
          0
        );
        const avgDays =
          totalAR > 0 ? Math.round(weightedDays / totalAR) : 0;
        const largest =
          allInvoices.length > 0
            ? Math.max(...allInvoices.map((i) => i.balance))
            : 0;

        // ---- Configurable-granularity buckets (7/15/30/60/90/120/180/360) ----
        // Discrete buckets are mutually exclusive; the cumulative ("N+") view is
        // derived from them in src/domain/arAging.ts so the two can never drift.
        // Both are summaries only — the full invoice arrays stay in the legacy
        // `buckets` field (every invoice carries days_outstanding and
        // aging_bucket, so a consumer can re-bucket without a second payload).
        const aging = bucketizeAging(
          allInvoices.map<AgingItem>((i) => ({
            days: i.days_outstanding,
            balance: i.balance,
            client: i.client_name,
          }))
        );
        const bucketRecon = reconcileDiscreteBuckets(aging.discrete, totalAR);
        if (!bucketRecon.ok) {
          console.warn(
            `[get_ar_aging] RECONCILIATION FAILED: discrete buckets sum ${bucketRecon.discrete_sum} != total_ar ${totalAR} (delta ${bucketRecon.delta})`
          );
        }
        const legacyBuckets = {
          current: makeBucket(buckets.current),
          days_31_60: makeBucket(buckets.days_31_60),
          days_61_90: makeBucket(buckets.days_61_90),
          days_91_120: makeBucket(buckets.days_91_120),
          over_120: makeBucket(buckets.over_120),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  as_of_date: asOf.toISOString().split("T")[0],
                  summary: {
                    total_ar: totalAR,
                    avg_days_outstanding: avgDays,
                    largest_balance: largest,
                    total_invoices: allInvoices.length,
                  },
                  bucket_rules: BOUNDARY_RULE_TEXT,
                  discrete_buckets: aging.discrete,
                  cumulative_buckets: aging.cumulative,
                  reconciliation: {
                    reconciliation_ok: bucketRecon.ok,
                    discrete_bucket_sum: bucketRecon.discrete_sum,
                    total_ar: bucketRecon.total_ar,
                    delta: bucketRecon.delta,
                  },
                  // Original five-bucket shape, unchanged (full invoice detail).
                  // Exposed under both names: `buckets` for existing consumers,
                  // `legacy_buckets` for new ones that want to be explicit.
                  buckets: legacyBuckets,
                  legacy_buckets: legacyBuckets,
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

  // get_wip_report
  server.tool(
    "get_wip_report",
    "Work-in-progress report: all unbilled time and expenses, how long they have been sitting. Identifies revenue at risk of aging off.",
    {
      responsible_attorney_id: z
        .number()
        .optional()
        .describe("Filter by responsible attorney ID"),
      min_wip_value: z
        .number()
        .optional()
        .describe("Filter matters below this WIP threshold"),
    },
    async (params) => {
      try {
        const { matters: wipMatters, red_flag_count: redFlagCount } = await computeWipMatters({
          responsible_attorney_id: params.responsible_attorney_id,
        });
        let matterResults = wipMatters;

        if (params.min_wip_value) {
          matterResults = matterResults.filter(
            (m) => m.combined_wip_value >= params.min_wip_value!
          );
        }

        matterResults.sort((a, b) => b.combined_wip_value - a.combined_wip_value);

        const totalWip =
          Math.round(
            matterResults.reduce((s, m) => s + m.combined_wip_value, 0) * 100
          ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: {
                    total_firm_wip: totalWip,
                    matters_with_wip: matterResults.length,
                    red_flag_matters: redFlagCount,
                  },
                  matters: matterResults,
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

  // get_trust_balances
  server.tool(
    "get_trust_balances",
    "Trust/IOLTA account balances and recent activity per matter. Flags low balances (<$500) and dormant accounts (90+ days no activity).",
    {
      matter_id: z
        .number()
        .optional()
        .describe("Filter to a specific matter (all matters if omitted)"),
      min_balance: z
        .number()
        .optional()
        .describe("Only show matters with trust balance above this amount"),
    },
    async (params) => {
      try {
        // Get trust bank accounts
        const bankAccounts = await fetchAllPages<any>("/bank_accounts", {
          fields: "id,name,type,balance",
        });

        const trustAccounts = bankAccounts.filter(
          (a: any) => a.type === "trust" || a.type === "Trust"
        );

        // Get trust ledger entries
        const ledgerParams: Record<string, any> = {
          fields: TRUST_FIELDS,
        };
        if (params.matter_id) ledgerParams.matter_id = params.matter_id;

        const ledgerEntries = await fetchAllPages<any>(
          "/trust_line_items",
          ledgerParams
        );

        // Group by matter
        const byMatter: Record<
          number,
          {
            matter: any;
            balance: number;
            entries: any[];
            last_deposit: string | null;
            last_disbursement: string | null;
          }
        > = {};

        for (const entry of ledgerEntries) {
          const mid = entry.matter?.id;
          if (!mid) continue;
          const amount = entry.total || 0;

          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter: entry.matter,
              balance: 0,
              entries: [],
              last_deposit: null,
              last_disbursement: null,
            };
          }

          byMatter[mid].balance += amount;

          byMatter[mid].entries.push({
            id: entry.id,
            date: entry.date,
            amount,
          });

          if (amount > 0 && !byMatter[mid].last_deposit) {
            byMatter[mid].last_deposit = entry.date;
          }
          if (amount < 0 && !byMatter[mid].last_disbursement) {
            byMatter[mid].last_disbursement = entry.date;
          }
        }

        const today = new Date();
        let lowBalanceCount = 0;
        let dormantCount = 0;

        let matterResults = Object.entries(byMatter).map(([, m]) => {
          const lastActivity = m.entries.length > 0 ? m.entries[0].date : null;
          const daysSinceActivity = lastActivity
            ? Math.floor(
                (today.getTime() - new Date(lastActivity).getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            : null;

          const flags: string[] = [];
          if (m.balance < 500) {
            flags.push("LOW_BALANCE");
            lowBalanceCount++;
          }
          if (daysSinceActivity !== null && daysSinceActivity > 90) {
            flags.push("DORMANT");
            dormantCount++;
          }

          return {
            matter_id: m.matter.id,
            matter_number: m.matter.display_number,
            client: m.matter.client,
            current_balance: m.balance,
            last_deposit_date: m.last_deposit,
            last_disbursement_date: m.last_disbursement,
            recent_entries: m.entries.slice(0, 10),
            flags,
          };
        });

        if (params.min_balance !== undefined) {
          matterResults = matterResults.filter(
            (m) => m.current_balance >= params.min_balance!
          );
        }

        const totalTrustHeld =
          Math.round(
            matterResults.reduce((s, m) => s + m.current_balance, 0) * 100
          ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: {
                    total_trust_held: totalTrustHeld,
                    active_trust_matters: matterResults.length,
                    low_balance_flags: lowBalanceCount,
                    dormant_flags: dormantCount,
                    trust_accounts: trustAccounts.map((a: any) => ({
                      id: a.id,
                      name: a.name,
                      balance: a.balance,
                    })),
                  },
                  matters: matterResults,
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
  // get_ar_scorecard
  // ============================================================
  server.tool(
    "get_ar_scorecard",
    "EOS-scorecard AR metrics from live Clio. AR counts ONLY revenue_kind bills (fees for services rendered) in state=awaiting_payment; trust/retainer funding requests (trust_kind) are advance-deposit requests, not receivables, and are excluded from every AR/aging figure and reported separately. Returns compact weekly measurables — total AR, % and $ over 90 and over 120 days, over 60 days, # invoices 90+, # delinquent clients, oldest invoice age, avg days outstanding — plus a per-responsible-attorney breakdown, the top 10 open balances, and a trust_requests summary (requested/funded/unfunded $, unfunded count, fund rate). " +
      "AGING BUCKETS: every scope (firm, firm_by_track, by_attorney) carries discrete_buckets — mutually exclusive buckets at the 7/15/30/60/90/120/180/360-day thresholds: 0-7, 8-15, 16-30, 31-60, 61-90, 91-120, 121-180, 181-360, 360+ — and cumulative_buckets — rollups 7+, 15+, 30+, 60+, 90+, 120+, 180+, 360+ DERIVED from the discrete buckets (so 360+ is a subset of 180+ and the two views can never drift). " + BOUNDARY_RULE_TEXT + " The pre-existing scalar fields are unchanged and now alias the rollups exactly (ar_60plus = over_60, ar_90plus = over_90, ar_120plus = over_120). " +
      "TRACKS: AR splits into Gated vs. Non-Gated by each matter's practice_area (firm_by_track), matched EXACTLY against Clio's practice_area name. Gated = work whose aging reflects court/estate payment timelines rather than collection failure: Appointment, Dependent Administration (Client Serving), Guardianship, Mental Comm, Representative (R&S Serving). Non-Gated = client-pay, the headline collections metric; it includes Probate by firm policy and explicitly includes Guardianship Litigation, which is NOT gated because the firm is paid up front by the client who is reimbursed for fees later, so its aging is a real collection signal. Probate handling is configurable via probate_treatment (default 'non_gated'; 'separate' breaks it out as Semi-Gated, 'gated' folds it into Gated). Unclassified = matters with no practice_area, surfaced with the SPECIFIC matters (firm_by_track.unclassified.matters gives matter_id, matter_number, client_name, description, attorney and $) so they can actually be tagged. A track_config_health section reports any configured practice-area name that matched NO matter in Clio (a rename or typo, which would silently move that work into the Non-Gated headline) plus any practice area carrying AR that no rule names and so defaults to Non-Gated. " +
      "by_attorney entries carry the blended metrics they always did PLUS gated / non_gated / unclassified sub-objects (and semi_gated when probate_treatment='separate') with the same metrics, so per-attorney gated AR needs no second pull. " +
      "stale_ar_365plus is a collectability-review tier (days_outstanding > 360, i.e. exactly the 360+ rollup) reported firm-wide, per track and per attorney with $, invoice count, oldest invoice and a full triage list — these balances are still inside total_ar, they are just no longer invisible inside the 90+/120+ headline. " +
      "tagging_consistency_flags is a HEURISTIC list (never an auto-correction) of matters whose description reads like court-gated work (Dependent/Temporary/Permanent Administration, Guardianship, Ad Litem, Mental Commitment) but whose practice_area does not classify it that way, plus matters that share a description pattern yet disagree on practice_area — so tagging drift between similarly-named matters is caught instead of found by hand. " +
      "gated_trust_correlation lists each Gated matter with an outstanding balance next to its own unfunded trust-request amount (a leading indicator of AR about to age); trust dollars are still never added into AR. " +
      "include_wip=true (default false) adds wip_summary: WIP (unbilled time + expenses, identical to get_wip_report) per attorney and per track, with total_exposure = WIP + AR. " +
      "reconciliation_ok confirms, to the cent, that the tracks sum to firm.total_ar, that the discrete buckets sum to total_ar at EVERY scope (firm, each track, each attorney), and that the legacy 90+/120+ fields match the cumulative buckets; reconciliation.bucket_failures names any scope that fails. " +
      "ALSO maintains a standalone 'AR Scorecard.xlsx' in Box that auto-updates: 'AR by Track' shows the tracks side by side, 'Aging Buckets' shows the discrete and cumulative bucket sets per track, a 'Weekly Scorecard' tab appends one row per run (week-over-week trend, incl. per-track, trust-request and 360+ columns), 'By Attorney' (now with Gated/Non-Gated/360+ columns), 'Stale AR 365+', 'Gated by Attorney', 'Gated by Matter', 'Gated AR vs Trust', 'Top 10 Accounts', 'Trust Requests', 'Unclassified Matters' and 'Tagging Flags' refresh to the current snapshot, and one DETAIL tab per responsible attorney lists their full matter×bill AR. Read-only against Clio; the only write is the AR Scorecard workbook, which by DEFAULT is written in the background so metrics return immediately (the Box write can take minutes and would otherwise time out the whole call); set update_workbook=false to skip it, or await_workbook=true to block on the write and get the Box link in the response.",
    {
      as_of_date: z.string().optional().describe("As-of date for aging (YYYY-MM-DD, default today)"),
      update_workbook: z.boolean().optional().default(true).describe("Also update the AR Scorecard workbook in Box (default true). Set false for metrics-only."),
      await_workbook: z.boolean().optional().default(false).describe("Wait for the Box workbook write to finish and return its result/link inline. Default false: the workbook is written in the BACKGROUND so metrics return immediately. The Box write can take minutes (the Box client alone allows a 5-minute request timeout), which is far longer than the MCP call timeout — awaiting it is what makes the whole call fail on the workbook leg even though every metric is already computed. Set true only when you need the Box link in this response and can tolerate that risk."),
      probate_treatment: z.enum(["gated", "non_gated", "separate"]).optional().default("non_gated").describe("How to treat Probate AR. 'non_gated' (default): Probate is client-pay, folded into non_gated. 'gated': fold into gated. 'separate': break Probate out under semi_gated for review."),
      include_wip: z.boolean().optional().default(false).describe("Also join in WIP (unbilled time + expenses, same definition as get_wip_report) so the response reports TOTAL revenue exposure (WIP + AR) per attorney and per track, not just billed/outstanding AR. Default false: the WIP join needs two extra full /activities sweeps and roughly doubles the call's fetch time, so it is opt-in."),
    },
    async (params) => {
      try {
        const asOf = params.as_of_date ? new Date(params.as_of_date + "T00:00:00") : new Date();
        const asOfStr = asOf.toISOString().split("T")[0];

        // Pull open (awaiting_payment) bills for AR, plus paid bills so that funded
        // trust/retainer requests can be reported alongside the unfunded ones. The
        // matter sub-object form (client/responsible_attorney as full objects) is the
        // proven get_wip_report pattern; the deeper matters{…client{name}} form 400s.
        // The paid-bills fetch is only needed to mark trust requests funded; if it
        // fails, fall back to awaiting_payment only rather than failing the whole AR
        // scorecard (mirrors the resilient paid-bill fetch used elsewhere).
        const probateTreatment: ProbateTreatment = params.probate_treatment ?? "non_gated";

        const includeWip = params.include_wip === true;

        const [awaitingBills, paidBills, allMatters, wipData] = await Promise.all([
          fetchAllPages<any>("/bills", { fields: SCORECARD_BILL_FIELDS, state: "awaiting_payment" }),
          fetchAllPages<any>("/bills", SCORECARD_PAID_TRUST_PARAMS).catch((e: any) => {
            console.warn(`[get_ar_scorecard] paid trust-request fetch failed (${e?.message ?? e}); funded trust requests will be incomplete`);
            return [] as any[];
          }),
          // Join key for the Gated/Non-Gated split. We need ALL matters (open
          // AND closed — closed matters still hold AR), so the `status` param is
          // OMITTED: Clio's /matters only accepts open|closed|pending and 400s on
          // status=all (which previously emptied this join and sent 100% of AR to
          // "unclassified"). Omitting status returns every status, matching the
          // get_matters tool's own "all" handling. If this fails, AR rows fall
          // back to "unclassified" rather than failing the whole scorecard.
          fetchAllPages<any>("/matters", { fields: SCORECARD_MATTER_FIELDS }).catch((e: any) => {
            console.warn(`[get_ar_scorecard] matters fetch failed (${e?.message ?? e}); AR will be reported as unclassified`);
            return [] as any[];
          }),
          // Optional WIP cross-reference (include_wip). Uses the same helper —
          // and therefore the same definition — as get_wip_report. A failure
          // degrades to "no WIP section" rather than failing the scorecard.
          includeWip
            ? computeWipMatters({}).catch((e: any) => {
                console.warn(`[get_ar_scorecard] WIP fetch failed (${e?.message ?? e}); wip_summary will be omitted`);
                return null;
              })
            : Promise.resolve(null),
        ]);

        // matter_id → practice_area name (null when the matter has none). Clio
        // returns matter ids as numbers and bills carry the same numeric
        // matters[].id, so the Map<number> keys line up without coercion.
        const practiceAreaByMatter = new Map<number, string | null>();
        for (const m of allMatters) {
          if (m?.id != null) practiceAreaByMatter.set(m.id, m.practice_area?.name ?? null);
        }
        // Join-health diagnostic: empties here are the difference between a real
        // Gated/Non-Gated split and everything collapsing to "unclassified".
        const mattersWithPa = [...practiceAreaByMatter.values()].filter((v) => v != null).length;
        console.warn(`[get_ar_scorecard] matter→practice_area join: ${practiceAreaByMatter.size} matters, ${mattersWithPa} with a practice_area`);
        if (practiceAreaByMatter.size === 0) {
          console.warn(`[get_ar_scorecard] WARNING: empty matters join — all AR will classify as "unclassified"`);
        }

        const round2 = (n: number) => Math.round(n * 100) / 100;
        const bucketLabel = (d: number) =>
          d <= 0 ? "Current" : d <= 30 ? "1-30" : d <= 60 ? "31-60" : d <= 90 ? "61-90" : d <= 120 ? "91-120" : "120+";
        const daysOutstanding = (b: any) => {
          const due = b.due_at ? new Date(b.due_at) : (b.issued_at ? new Date(b.issued_at) : asOf);
          return Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / 86400000));
        };
        // display_number already includes the matter name (e.g.
        // "02653-Lopez, Juan B. - Estate of"); only append description if it
        // adds something not already present.
        const matterLabel = (m: any) => {
          const dn = String(m?.display_number ?? "").trim();
          const desc = String(m?.description ?? "").trim();
          if (dn && desc && !dn.includes(desc)) return `${dn} — ${desc}`;
          return dn || desc || "—";
        };

        type Row = {
          balance: number; days: number; client: string; matter: string; attorney: string;
          bill: string; issued: string; due: string; bucket: string; track: TrackKey;
          // Added for the unclassified-matter list (Fix 4), the tagging-drift
          // heuristic (Fix 5) and the gated↔trust join (Fix 7): the raw matter
          // identifiers/description and the PRE-folding practice area, so those
          // sections don't have to re-derive them from a display label.
          matter_id: number | null; matter_number: string; matter_description: string;
          practice_area: string | null; base_track: TrackKey;
          // Discrete bucket label under the new 7/15/30/60/90/120/180/360 scheme.
          aging_bucket: string;
        };
        const rows: Row[] = [];

        // --- AR rows: revenue_kind ONLY (whitelist). A trust_kind bill is a
        // trust/retainer funding request, not a receivable, and is captured below.
        // Any other (unexpected) kind is excluded from AR and surfaced via a warning
        // rather than silently summed into receivables. ---
        for (const b of awaitingBills) {
          if (b.kind === "trust_kind") continue; // captured below as a trust request
          if (b.kind !== "revenue_kind") {
            console.warn(`[get_ar_scorecard] excluding bill ${b.number ?? b.id} from AR — unexpected kind=${JSON.stringify(b.kind)}`);
            continue;
          }
          const bal = typeof b.balance === "number" ? b.balance : parseFloat(b.balance) || 0;
          if (bal <= 0) continue;
          const m = b.matters?.[0];
          const days = daysOutstanding(b);
          // Classify by the matter's practice area. Prefer the matters join
          // (covers closed matters); fall back to any practice_area embedded on
          // the bill's matter sub-object. probate_treatment may fold semi_gated.
          const paName =
            (m?.id != null && practiceAreaByMatter.has(m.id)
              ? practiceAreaByMatter.get(m.id)
              : m?.practice_area?.name) ?? null;
          const baseTrack = classifyTrack(paName);
          rows.push({
            balance: bal,
            days,
            client: m?.client?.name ?? "Unknown",
            matter: matterLabel(m),
            attorney: m?.responsible_attorney?.name ?? "(Unassigned)",
            bill: String(b.number ?? b.id ?? ""),
            issued: b.issued_at ? String(b.issued_at).slice(0, 10) : "",
            due: b.due_at ? String(b.due_at).slice(0, 10) : "",
            bucket: bucketLabel(days),
            track: effectiveTrack(baseTrack, probateTreatment),
            matter_id: m?.id ?? null,
            matter_number: String(m?.display_number ?? ""),
            matter_description: String(m?.description ?? ""),
            practice_area: paName,
            base_track: baseTrack,
            aging_bucket: discreteBucketLabel(days),
          });
        }

        // --- Trust requests: every trust_kind bill across awaiting_payment + paid.
        // These never touch any AR metric, the delinquent-client count, or the
        // oldest-invoice calc. Funded if balance is cleared (or state == paid). ---
        const trustRows: TrustRequestRow[] = [];
        for (const b of [...awaitingBills, ...paidBills]) {
          if (b.kind !== "trust_kind") continue;
          const m = b.matters?.[0];
          const requested = typeof b.total === "number" ? b.total : parseFloat(b.total) || 0;
          const balRaw = typeof b.balance === "number" ? b.balance : parseFloat(b.balance) || 0;
          const balance = Math.max(0, balRaw);
          const isFunded = balRaw <= 0 || b.state === "paid";
          trustRows.push({
            matter_id: m?.id ?? null,
            attorney: m?.responsible_attorney?.name ?? "(Unassigned)",
            client: m?.client?.name ?? b.client?.name ?? "Unknown",
            matter: matterLabel(m),
            bill: String(b.number ?? b.id ?? ""),
            issued: b.issued_at ? String(b.issued_at).slice(0, 10) : "",
            due: b.due_at ? String(b.due_at).slice(0, 10) : "",
            days: daysOutstanding(b),
            requested: round2(requested),
            balance: round2(balance),
            funded: round2(Math.max(0, requested - balance)),
            status: isFunded ? "Funded" : "Unfunded",
            dateFunded: isFunded && b.paid_at ? String(b.paid_at).slice(0, 10) : "",
          });
        }
        // Unfunded first, then by Days Outstanding descending.
        trustRows.sort((a, b) => {
          const rank = (s: string) => (s === "Unfunded" ? 0 : 1);
          return rank(a.status) - rank(b.status) || b.days - a.days;
        });

        const sum = (f: (r: Row) => boolean) => round2(rows.filter(f).reduce((s, r) => s + r.balance, 0));
        const totalAR = round2(rows.reduce((s, r) => s + r.balance, 0));
        const ar90 = sum((r) => r.days >= 91);
        const ar120 = sum((r) => r.days >= 121);
        const ar60 = sum((r) => r.days >= 61);
        const inv90 = rows.filter((r) => r.days >= 91).length;
        const clients = new Set(rows.map((r) => r.client)).size;
        const oldest = rows.reduce((mx, r) => Math.max(mx, r.days), 0);
        const avgDays = totalAR > 0 ? Math.round(rows.reduce((s, r) => s + r.days * r.balance, 0) / totalAR) : 0;
        const pct = (n: number) => (totalAR > 0 ? Math.round((n / totalAR) * 1000) / 10 : 0); // one-decimal %

        // ---- Configurable-granularity aging buckets ----
        // One shared definition (src/domain/arAging.ts) drives the firm,
        // per-track, per-attorney and stale-AR views, and the cumulative ("N+")
        // rollups are DERIVED from the discrete buckets so they can never drift.
        const toAgingItems = (rs: Row[]): AgingItem[] =>
          rs.map((r) => ({ days: r.days, balance: r.balance, client: r.client }));
        const bucketsFor = (rs: Row[]): AgingBuckets => bucketizeAging(toAgingItems(rs));
        const firmAging = bucketsFor(rows);

        // ---- Stale AR / collectability review (Fix 3) ----
        // A 95-day invoice and a five-year-old invoice both land in "90+" and
        // "120+", which quietly inflates the headline with balances that are
        // almost certainly uncollectable. This slice pulls the oldest tier out so
        // it can be triaged/written off on a cadence. The threshold is the top
        // discrete bucket boundary (days_outstanding > 360), so a stale slice is
        // always exactly its scope's cumulative "360+" bucket and the two can
        // never disagree.
        const isStale = (r: Row) => r.days > STALE_THRESHOLD_DAYS;
        const staleSlice = (scopeRows: Row[]): StaleSlice => {
          const stale = scopeRows.filter(isStale);
          const scopeTotal = scopeRows.reduce((s, r) => s + r.balance, 0);
          const total = stale.reduce((s, r) => s + r.balance, 0);
          const oldest = stale.reduce<Row | null>((mx, r) => (!mx || r.days > mx.days ? r : mx), null);
          return {
            total_ar: round2(total),
            invoices: stale.length,
            delinquent_clients: new Set(stale.map((r) => r.client)).size,
            pct_of_scope_ar: scopeTotal > 0 ? Math.round((total / scopeTotal) * 1000) / 10 : 0,
            oldest_invoice_days: oldest?.days ?? 0,
            oldest_invoice: oldest
              ? {
                  bill: oldest.bill,
                  client: oldest.client,
                  matter: oldest.matter,
                  matter_id: oldest.matter_id,
                  matter_number: oldest.matter_number,
                  issued: oldest.issued,
                  due: oldest.due,
                  days_past_due: oldest.days,
                  balance: round2(oldest.balance),
                }
              : null,
          };
        };

        const firm = {
          as_of: asOfStr,
          total_ar: totalAR,
          current: sum((r) => r.days <= 0),
          days_1_30: sum((r) => r.days >= 1 && r.days <= 30),
          days_31_60: sum((r) => r.days >= 31 && r.days <= 60),
          days_61_90: sum((r) => r.days >= 61 && r.days <= 90),
          days_91_120: sum((r) => r.days >= 91 && r.days <= 120),
          ar_90plus: ar90,
          ar_90plus_pct: pct(ar90),
          ar_120plus: ar120,
          ar_120plus_pct: pct(ar120),
          ar_60plus: ar60,
          ar_60plus_pct: pct(ar60),
          invoices_90plus: inv90,
          delinquent_clients: clients,
          oldest_invoice_days: oldest,
          avg_days_outstanding: avgDays,
        };

        // ---- Gated vs. Non-Gated split (firm_by_track) ----
        // Every aging field is computed independently per track (pct against the
        // track's own total, never derived from the firm total).
        const trackRows: Record<TrackKey, Row[]> = { gated: [], semi_gated: [], non_gated: [], unclassified: [] };
        for (const r of rows) trackRows[r.track].push(r);

        const computeTrackMetrics = (tr: Row[]): TrackMetrics => {
          const ts = (f: (r: Row) => boolean) => round2(tr.filter(f).reduce((s, r) => s + r.balance, 0));
          const total = round2(tr.reduce((s, r) => s + r.balance, 0));
          const trackBuckets = bucketsFor(tr);
          const t90 = ts((r) => r.days >= 91);
          const t120 = ts((r) => r.days >= 121);
          const tpct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
          return {
            total_ar: total,
            current: ts((r) => r.days <= 0),
            days_1_30: ts((r) => r.days >= 1 && r.days <= 30),
            days_31_60: ts((r) => r.days >= 31 && r.days <= 60),
            days_61_90: ts((r) => r.days >= 61 && r.days <= 90),
            days_91_120: ts((r) => r.days >= 91 && r.days <= 120),
            ar_90plus: t90,
            ar_90plus_pct: tpct(t90),
            ar_120plus: t120,
            ar_120plus_pct: tpct(t120),
            invoices_90plus: tr.filter((r) => r.days >= 91).length,
            delinquent_clients: new Set(tr.map((r) => r.client)).size,
            oldest_invoice_days: tr.reduce((mx, r) => Math.max(mx, r.days), 0),
            avg_days_outstanding: total > 0 ? Math.round(tr.reduce((s, r) => s + r.days * r.balance, 0) / total) : 0,
            invoices: tr.length,
            // Same bucket scheme as the firm view, computed over this track's
            // own rows (never apportioned from the firm figures).
            discrete_buckets: trackBuckets.discrete,
            cumulative_buckets: trackBuckets.cumulative,
          };
        };

        // All four tracks are always computed (the workbook's per-track trend
        // columns track each one); semi_gated is only surfaced in the JSON when
        // probate_treatment is "separate".
        const trackMetrics: Record<TrackKey, TrackMetrics> = {
          gated: computeTrackMetrics(trackRows.gated),
          semi_gated: computeTrackMetrics(trackRows.semi_gated),
          non_gated: computeTrackMetrics(trackRows.non_gated),
          unclassified: computeTrackMetrics(trackRows.unclassified),
        };

        // `unclassified` additionally carries the specific matters (attached
        // below, once the matter list has been built) so the bucket is actionable.
        const firm_by_track: Record<string, TrackMetrics & { matters?: UnclassifiedMatter[] }> = {
          gated: trackMetrics.gated,
        };
        if (probateTreatment === "separate") firm_by_track.semi_gated = trackMetrics.semi_gated;
        firm_by_track.non_gated = trackMetrics.non_gated;
        firm_by_track.unclassified = trackMetrics.unclassified;

        // Reconciliation guardrail: the reported track totals must sum to
        // firm.total_ar to the cent. semi_gated rows always exist as their own
        // partition (folded into gated/non_gated when not separate), so the sum
        // of the four computed tracks is exact regardless of probate_treatment.
        const trackTotalSum = round2(
          trackMetrics.gated.total_ar +
            trackMetrics.semi_gated.total_ar +
            trackMetrics.non_gated.total_ar +
            trackMetrics.unclassified.total_ar
        );
        const reconciliation_delta = round2(trackTotalSum - firm.total_ar);
        const track_totals_ok = Math.abs(reconciliation_delta) <= 0.01;
        if (!track_totals_ok) {
          console.warn(`[get_ar_scorecard] RECONCILIATION FAILED: tracks sum ${trackTotalSum} != firm.total_ar ${firm.total_ar} (delta ${reconciliation_delta})`);
        }

        // ---- Per responsible attorney ----
        // The blended (all-tracks) figures are unchanged — same field names, same
        // arithmetic — and each entry now ALSO carries the same metrics computed
        // per track (gated / non_gated / unclassified, plus semi_gated when
        // probate_treatment="separate"), the new aging buckets, and the attorney's
        // stale-AR slice. The per-track slices sum back to the attorney total, so
        // "what's my gated AR" no longer needs a second pull.
        const attySlice = (rs: Row[]): AttyTrackSlice => {
          const total = rs.reduce((s, r) => s + r.balance, 0);
          const a90 = rs.filter((r) => r.days >= 91).reduce((s, r) => s + r.balance, 0);
          const a120 = rs.filter((r) => r.days >= 121).reduce((s, r) => s + r.balance, 0);
          return {
            total_ar: round2(total),
            ar_90plus: round2(a90),
            ar_90plus_pct: total > 0 ? Math.round((a90 / total) * 1000) / 10 : 0,
            ar_120plus: round2(a120),
            ar_120plus_pct: total > 0 ? Math.round((a120 / total) * 1000) / 10 : 0,
            invoices: rs.length,
          };
        };
        const rowsByAttorney = new Map<string, Row[]>();
        for (const r of rows) {
          const list = rowsByAttorney.get(r.attorney);
          if (list) list.push(r);
          else rowsByAttorney.set(r.attorney, [r]);
        }
        const byAttorney: AttySummary[] = [...rowsByAttorney.entries()]
          .map(([attorney, attRows]) => {
            const buckets = bucketsFor(attRows);
            const ofTrack = (t: TrackKey) => attySlice(attRows.filter((r) => r.track === t));
            const entry: AttySummary = {
              attorney,
              ...attySlice(attRows),
              discrete_buckets: buckets.discrete,
              cumulative_buckets: buckets.cumulative,
              gated: ofTrack("gated"),
              non_gated: ofTrack("non_gated"),
              unclassified: ofTrack("unclassified"),
              stale_ar_365plus: staleSlice(attRows),
            };
            if (probateTreatment === "separate") entry.semi_gated = ofTrack("semi_gated");
            return entry;
          })
          .sort((a, b) => b.total_ar - a.total_ar);

        // ================================================================
        // Stale AR (collectability review) — firm + by track + by attorney
        // ================================================================
        const staleRows = rows.filter(isStale);
        const stale_ar_365plus = {
          threshold_days: STALE_THRESHOLD_DAYS,
          definition:
            `Invoices with days_outstanding > ${STALE_THRESHOLD_DAYS} — the top discrete aging bucket. ` +
            `Reported as the same dollars as cumulative_buckets.${cumulativeKey(STALE_THRESHOLD_DAYS)} at every scope, ` +
            `so the two views can never disagree. These balances are still INSIDE firm.total_ar (nothing is netted ` +
            `out silently); this section exists so they can be triaged or written off on a cadence instead of ` +
            `sitting unnoticed inside the 90+/120+ headline.`,
          firm: staleSlice(rows),
          by_track: (() => {
            const out: Record<string, StaleSlice> = { gated: staleSlice(trackRows.gated) };
            if (probateTreatment === "separate") out.semi_gated = staleSlice(trackRows.semi_gated);
            out.non_gated = staleSlice(trackRows.non_gated);
            out.unclassified = staleSlice(trackRows.unclassified);
            return out;
          })(),
          by_attorney: byAttorney
            .filter((a) => a.stale_ar_365plus.invoices > 0)
            .map((a) => ({ attorney: a.attorney, ...a.stale_ar_365plus }))
            .sort((a, b) => b.total_ar - a.total_ar),
          // Full triage list — this tier is small by construction, and the point
          // of the section is that someone can act on it.
          invoices: [...staleRows]
            .sort((a, b) => b.days - a.days)
            .map((r) => ({
              bill: r.bill,
              client: r.client,
              matter: r.matter,
              matter_id: r.matter_id,
              matter_number: r.matter_number,
              attorney: r.attorney,
              track: r.track,
              issued: r.issued,
              due: r.due,
              days_past_due: r.days,
              balance: round2(r.balance),
            })),
        };

        // ================================================================
        // Unclassified matters (Fix 4) — actionable, not just a total
        // ================================================================
        // $-small but should be zero: these matters have no practice_area, so
        // their AR can't be assigned to the Gated or Non-Gated track. Listing the
        // matter ids/numbers turns "unclassified: $4,607" into a work list.
        const unclassifiedMatters: UnclassifiedMatter[] = (() => {
          const byMatter = new Map<string, UnclassifiedMatter>();
          for (const r of trackRows.unclassified) {
            const key = r.matter_id != null ? `id:${r.matter_id}` : `label:${r.matter}`;
            const existing = byMatter.get(key);
            if (existing) {
              existing.total_ar = round2(existing.total_ar + r.balance);
              existing.invoices += 1;
              existing.oldest_invoice_days = Math.max(existing.oldest_invoice_days, r.days);
            } else {
              byMatter.set(key, {
                matter_id: r.matter_id,
                matter_number: r.matter_number || r.matter,
                client_name: r.client,
                matter_description: r.matter_description,
                responsible_attorney: r.attorney,
                total_ar: round2(r.balance),
                invoices: 1,
                oldest_invoice_days: r.days,
              });
            }
          }
          return [...byMatter.values()].sort((a, b) => b.total_ar - a.total_ar);
        })();
        firm_by_track.unclassified = { ...trackMetrics.unclassified, matters: unclassifiedMatters };

        // ================================================================
        // Tagging consistency flags (Fix 5) — heuristic, never auto-corrected
        // ================================================================
        // Two matters with the same "Dependent Administration"-style description
        // can carry different practice_area values (the Key vs. Shotwell case),
        // which silently moves AR between the Gated and Non-Gated tracks. These
        // two heuristics catch that drift; both are for HUMAN review only —
        // nothing here reclassifies a matter or changes any reported figure.
        const tagging_consistency_flags: TaggingFlag[] = (() => {
          // One record per matter that carries AR, with its description + PA.
          type MatterInfo = {
            matter_id: number | null; matter_number: string; matter: string;
            client: string; description: string; practice_area: string | null;
            base_track: TrackKey; track: TrackKey; ar_balance: number;
          };
          const matters = new Map<string, MatterInfo>();
          for (const r of rows) {
            const key = r.matter_id != null ? `id:${r.matter_id}` : `label:${r.matter}`;
            const existing = matters.get(key);
            if (existing) existing.ar_balance = round2(existing.ar_balance + r.balance);
            else
              matters.set(key, {
                matter_id: r.matter_id,
                matter_number: r.matter_number || r.matter,
                matter: r.matter,
                client: r.client,
                description: r.matter_description,
                practice_area: r.practice_area,
                base_track: r.base_track,
                track: r.track,
                ar_balance: round2(r.balance),
              });
          }

          // Which gated-pattern keyword(s) each matter's description matches.
          // display_number embeds the matter name, so both are searched. A
          // practice_area that is non-gated BY POLICY yields no patterns at all,
          // so it neither gets flagged nor skews the rule-2 majority.
          const patternsOf = (m: MatterInfo) => {
            if (m.practice_area && HEURISTIC_EXEMPT_PRACTICE_AREAS.has(m.practice_area.trim())) return [];
            return GATED_DESCRIPTION_PATTERNS.filter((p) => p.re.test(`${m.description} ${m.matter}`)).map((p) => p.label);
          };

          const reasons = new Map<string, { info: MatterInfo; rules: string[]; why: string[] }>();
          const addReason = (key: string, info: MatterInfo, rule: string, why: string) => {
            const e = reasons.get(key) ?? { info, rules: [], why: [] };
            if (!e.rules.includes(rule)) e.rules.push(rule);
            e.why.push(why);
            reasons.set(key, e);
          };

          // Rule 1 — the description reads like gated (court-appointment) work
          // but the practice_area does not classify it that way.
          for (const [key, m] of matters) {
            const hits = patternsOf(m);
            if (!hits.length) continue;
            if (m.base_track === "gated") continue;
            const paText =
              m.practice_area === null ? "no practice_area is set" : `practice_area is "${m.practice_area}"`;
            addReason(
              key,
              m,
              "gated_keyword_vs_practice_area",
              `description matches gated pattern ${hits.map((h) => `"${h}"`).join(", ")} but ${paText}, ` +
                `which classifies as "${m.base_track}"`
            );
          }

          // Rule 2 — matters sharing the same description pattern are coded to
          // practice_areas that land in DIFFERENT tracks. The modal track is
          // treated as the firm's intent and the odd matters out are flagged.
          // Keyed on track, not on the raw practice_area string, because two
          // gated practice_areas (say Guardianship and Guardianship Litigation)
          // on similarly-named matters is normal taxonomy, not drift — only a
          // disagreement that moves AR between the Gated and Non-Gated tracks
          // changes a reported number. This is also the "vice versa" direction:
          // it catches a gated-PA matter sitting among Probate ones.
          const byPattern = new Map<string, Array<[string, MatterInfo]>>();
          for (const [key, m] of matters) {
            for (const label of patternsOf(m)) {
              const list = byPattern.get(label) ?? [];
              list.push([key, m]);
              byPattern.set(label, list);
            }
          }
          for (const [label, group] of byPattern) {
            if (group.length < 2) continue;
            const trackCounts = new Map<TrackKey, number>();
            for (const [, m] of group) {
              trackCounts.set(m.base_track, (trackCounts.get(m.base_track) ?? 0) + 1);
            }
            if (trackCounts.size < 2) continue; // same track everywhere → no drift
            const [majorityTrack, majorityCount] = [...trackCounts.entries()].sort(
              (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
            )[0];
            // The practice_area(s) the majority is coded to, for the message.
            const majorityPas = [
              ...new Set(
                group.filter(([, m]) => m.base_track === majorityTrack).map(([, m]) => m.practice_area ?? "(none)")
              ),
            ];
            for (const [key, m] of group) {
              if (m.base_track === majorityTrack) continue;
              addReason(
                key,
                m,
                "same_pattern_different_practice_area",
                `${group.length} matters match "${label}" but disagree on track — this one is ` +
                  `practice_area "${m.practice_area ?? "(none)"}" (${m.base_track}) while ${majorityCount} of them ` +
                  `are ${majorityTrack} (${majorityPas.map((pa) => `"${pa}"`).join(", ")})`
              );
            }
          }

          return [...reasons.values()]
            .map(({ info, rules, why }) => ({
              matter_id: info.matter_id,
              matter_number: info.matter_number,
              client_name: info.client,
              matter_description: info.description,
              practice_area: info.practice_area,
              classified_track: info.track,
              ar_balance: info.ar_balance,
              rules,
              suspected_mismatch_reason: why.join("; "),
            }))
            .sort((a, b) => b.ar_balance - a.ar_balance);
        })();

        // ================================================================
        // Gated AR ↔ unfunded trust request correlation (Fix 7)
        // ================================================================
        // For court-gated matters an unfunded trust/retainer request is a leading
        // indicator of AR about to age. The Trust Requests and Gated AR views were
        // previously unjoinable; this section puts the two figures side by side
        // per matter. Trust dollars are still NEVER added into any AR figure.
        const gated_trust_correlation = (() => {
          const unfundedByMatter = new Map<number, { amount: number; requests: number; oldest_days: number }>();
          for (const t of trustRows) {
            if (t.status !== "Unfunded" || t.matter_id == null) continue;
            const e = unfundedByMatter.get(t.matter_id) ?? { amount: 0, requests: 0, oldest_days: 0 };
            e.amount = round2(e.amount + t.balance);
            e.requests += 1;
            e.oldest_days = Math.max(e.oldest_days, t.days);
            unfundedByMatter.set(t.matter_id, e);
          }

          const byMatter = new Map<number | string, {
            matter_id: number | null; matter_number: string; matter: string; client: string;
            attorney: string; ar_balance: number; ar_90plus: number; ar_over_360: number;
            invoices: number; oldest_invoice_days: number;
          }>();
          for (const r of trackRows.gated) {
            const key = r.matter_id ?? `label:${r.matter}`;
            const e = byMatter.get(key) ?? {
              matter_id: r.matter_id, matter_number: r.matter_number || r.matter, matter: r.matter,
              client: r.client, attorney: r.attorney, ar_balance: 0, ar_90plus: 0, ar_over_360: 0,
              invoices: 0, oldest_invoice_days: 0,
            };
            e.ar_balance = round2(e.ar_balance + r.balance);
            if (r.days >= 91) e.ar_90plus = round2(e.ar_90plus + r.balance);
            if (isStale(r)) e.ar_over_360 = round2(e.ar_over_360 + r.balance);
            e.invoices += 1;
            e.oldest_invoice_days = Math.max(e.oldest_invoice_days, r.days);
            byMatter.set(key, e);
          }

          const matters = [...byMatter.values()]
            .filter((m) => m.ar_balance > 0)
            .map((m) => {
              const t = m.matter_id != null ? unfundedByMatter.get(m.matter_id) : undefined;
              return {
                ...m,
                unfunded_trust_amount: t?.amount ?? 0,
                unfunded_trust_requests: t?.requests ?? 0,
                oldest_unfunded_trust_days: t?.oldest_days ?? 0,
              };
            })
            .sort(
              (a, b) =>
                b.unfunded_trust_amount - a.unfunded_trust_amount || b.ar_balance - a.ar_balance
            );

          const withTrust = matters.filter((m) => m.unfunded_trust_amount > 0);
          return {
            note:
              "Gated-track matters with an outstanding AR balance, each shown next to its own unfunded " +
              "trust/retainer request amount. Trust request dollars are advance-deposit requests, NOT " +
              "receivables, and are never included in any AR figure here or elsewhere.",
            summary: {
              gated_matters_with_ar: matters.length,
              gated_matters_with_unfunded_trust: withTrust.length,
              gated_ar_on_matters_with_unfunded_trust: round2(
                withTrust.reduce((s, m) => s + m.ar_balance, 0)
              ),
              unfunded_trust_total_on_gated_matters: round2(
                withTrust.reduce((s, m) => s + m.unfunded_trust_amount, 0)
              ),
            },
            matters,
          };
        })();

        // ================================================================
        // Optional WIP cross-reference (Fix 6) — total revenue exposure
        // ================================================================
        // WIP + AR per attorney and per track. Same WIP definition as
        // get_wip_report (shared helper), so the two tools agree. Omitted unless
        // include_wip=true; null when the WIP fetch failed.
        const wip_summary = (() => {
          if (!includeWip) return undefined;
          if (!wipData) {
            return {
              error: true,
              message: "WIP fetch failed; AR figures above are unaffected. Retry include_wip=true.",
            };
          }
          const arByAttorney = new Map<string, number>();
          for (const r of rows) arByAttorney.set(r.attorney, (arByAttorney.get(r.attorney) ?? 0) + r.balance);
          const arByTrack: Record<TrackKey, number> = { gated: 0, semi_gated: 0, non_gated: 0, unclassified: 0 };
          for (const r of rows) arByTrack[r.track] += r.balance;

          const wipByAttorney = new Map<string, { wip: number; matters: number }>();
          const wipByTrack: Record<TrackKey, number> = { gated: 0, semi_gated: 0, non_gated: 0, unclassified: 0 };
          for (const m of wipData.matters) {
            const attorney = m.responsible_attorney?.name ?? "(Unassigned)";
            const e = wipByAttorney.get(attorney) ?? { wip: 0, matters: 0 };
            e.wip += m.combined_wip_value;
            e.matters += 1;
            wipByAttorney.set(attorney, e);
            // Same matter→practice_area join used for the AR tracks.
            const paName = m.matter_id != null ? practiceAreaByMatter.get(m.matter_id) ?? null : null;
            wipByTrack[effectiveTrack(classifyTrack(paName), probateTreatment)] += m.combined_wip_value;
          }

          const totalWip = round2(wipData.matters.reduce((s, m) => s + m.combined_wip_value, 0));
          const attorneys = [...new Set([...wipByAttorney.keys(), ...arByAttorney.keys()])]
            .map((attorney) => {
              const wip = round2(wipByAttorney.get(attorney)?.wip ?? 0);
              const ar = round2(arByAttorney.get(attorney) ?? 0);
              return {
                attorney,
                wip,
                ar,
                total_exposure: round2(wip + ar),
                matters_with_wip: wipByAttorney.get(attorney)?.matters ?? 0,
              };
            })
            .sort((a, b) => b.total_exposure - a.total_exposure);

          const trackKeys: TrackKey[] =
            probateTreatment === "separate"
              ? ["gated", "semi_gated", "non_gated", "unclassified"]
              : ["gated", "non_gated", "unclassified"];
          const by_track: Record<string, { wip: number; ar: number; total_exposure: number }> = {};
          for (const t of trackKeys) {
            by_track[t] = {
              wip: round2(wipByTrack[t]),
              ar: round2(arByTrack[t]),
              total_exposure: round2(wipByTrack[t] + arByTrack[t]),
            };
          }

          return {
            note:
              "WIP = unbilled time (at rounded_quantity) + unbilled expenses, identical to get_wip_report " +
              "(including its 90-day created_since window). total_exposure = WIP + AR.",
            firm: {
              total_wip: totalWip,
              total_ar: firm.total_ar,
              total_exposure: round2(totalWip + firm.total_ar),
              matters_with_wip: wipData.matters.length,
              red_flag_matters: wipData.red_flag_count,
            },
            by_track,
            by_attorney: attorneys,
          };
        })();

        // ================================================================
        // Track-config health
        // ================================================================
        // The track split matches practice_area names EXACTLY, so a practice area
        // that is renamed in Clio (or mistyped here) stops matching and its AR
        // silently moves into the Non-Gated headline. That is not a hypothetical:
        // "Representative" sat in the gated set while Clio's actual name was
        // "Representative (R&S Serving)", so that work reported as client-pay.
        // This section makes both directions visible every run.
        const track_config_health = (() => {
          const observed = new Set<string>();
          for (const v of practiceAreaByMatter.values()) {
            const n = (v ?? "").trim();
            if (n) observed.add(n);
          }
          const configured = new Map<string, string>();
          for (const n of GATED_PRACTICE_AREAS) configured.set(n, "gated");
          for (const n of SEMI_GATED_PRACTICE_AREAS) configured.set(n, "semi_gated");
          for (const n of NON_GATED_BY_POLICY_PRACTICE_AREAS) configured.set(n, "non_gated (by policy)");

          // Configured names that match no matter in Clio — almost always a
          // rename or a typo, and always a silent misclassification.
          const configured_not_found_in_clio = [...configured.entries()]
            .filter(([name]) => !observed.has(name))
            .map(([name, intended_track]) => ({ name, intended_track }));

          // Practice areas carrying AR that no rule names, so they fall through
          // to Non-Gated by default. Usually correct — surfaced so "correct by
          // default" stays a decision rather than an accident.
          const arByPa = new Map<string, { total_ar: number; invoices: number }>();
          for (const r of rows) {
            const n = (r.practice_area ?? "").trim();
            if (!n || configured.has(n)) continue;
            const e = arByPa.get(n) ?? { total_ar: 0, invoices: 0 };
            e.total_ar = round2(e.total_ar + r.balance);
            e.invoices += 1;
            arByPa.set(n, e);
          }
          const unmapped_practice_areas_with_ar = [...arByPa.entries()]
            .map(([name, v]) => ({ name, defaulted_track: "non_gated" as const, ...v }))
            .sort((a, b) => b.total_ar - a.total_ar);

          if (configured_not_found_in_clio.length) {
            console.warn(`[get_ar_scorecard] TRACK CONFIG WARNING: configured practice areas matched no matter in Clio — ${JSON.stringify(configured_not_found_in_clio)}`);
          }
          return {
            ok: configured_not_found_in_clio.length === 0,
            note:
              "practice_area names are matched exactly (trimmed, case-sensitive). A configured name that " +
              "matches nothing in Clio silently sends that work to the Non-Gated headline track.",
            configured_not_found_in_clio,
            unmapped_practice_areas_with_ar,
          };
        })();

        // ================================================================
        // Reconciliation (extended): tracks AND discrete buckets AND the
        // legacy 90+/120+ fields must all agree, to the cent.
        // ================================================================
        const firmBucketRecon = reconcileDiscreteBuckets(firmAging.discrete, firm.total_ar);
        const bucketFailures: Array<{ scope: string } & BucketReconciliation> = [];
        const checkBuckets = (scope: string, recon: BucketReconciliation) => {
          if (!recon.ok) bucketFailures.push({ scope, ...recon });
          return recon.ok;
        };
        let discrete_buckets_ok = checkBuckets("firm", firmBucketRecon);
        for (const t of ["gated", "semi_gated", "non_gated", "unclassified"] as TrackKey[]) {
          discrete_buckets_ok =
            checkBuckets(
              `track:${t}`,
              reconcileDiscreteBuckets(trackMetrics[t].discrete_buckets, trackMetrics[t].total_ar)
            ) && discrete_buckets_ok;
        }
        for (const a of byAttorney) {
          discrete_buckets_ok =
            checkBuckets(
              `attorney:${a.attorney}`,
              reconcileDiscreteBuckets(a.discrete_buckets, a.total_ar)
            ) && discrete_buckets_ok;
        }
        // The legacy scalar fields must equal the cumulative buckets they now
        // alias (ar_60plus/ar_90plus/ar_120plus = over_60/over_90/over_120), and
        // stale AR must equal the 360+ rollup. If a boundary rule ever changes,
        // this is what catches it.
        const legacyAlignmentChecks: Array<{ field: string; legacy: number; bucket: number }> = [
          { field: "ar_60plus", legacy: firm.ar_60plus, bucket: firmAging.cumulative[cumulativeKey(60)].total },
          { field: "ar_90plus", legacy: firm.ar_90plus, bucket: firmAging.cumulative[cumulativeKey(90)].total },
          { field: "ar_120plus", legacy: firm.ar_120plus, bucket: firmAging.cumulative[cumulativeKey(120)].total },
          {
            field: "stale_ar_365plus.firm.total_ar",
            legacy: stale_ar_365plus.firm.total_ar,
            bucket: firmAging.cumulative[cumulativeKey(STALE_THRESHOLD_DAYS)].total,
          },
        ];
        const legacyAlignmentFailures = legacyAlignmentChecks.filter(
          (c) => Math.abs(round2(c.legacy - c.bucket)) > 0.01
        );
        const legacy_alignment_ok = legacyAlignmentFailures.length === 0;

        const reconciliation_ok = track_totals_ok && discrete_buckets_ok && legacy_alignment_ok;
        if (!discrete_buckets_ok) {
          console.warn(`[get_ar_scorecard] RECONCILIATION FAILED: discrete buckets do not sum to total_ar — ${JSON.stringify(bucketFailures)}`);
        }
        if (!legacy_alignment_ok) {
          console.warn(`[get_ar_scorecard] RECONCILIATION FAILED: legacy 90+/120+ fields disagree with the cumulative buckets — ${JSON.stringify(legacyAlignmentFailures)}`);
        }
        const reconciliation = {
          reconciliation_ok,
          // --- track split (unchanged keys) ---
          track_totals_ok,
          track_total_sum: trackTotalSum,
          firm_total_ar: firm.total_ar,
          delta: reconciliation_delta,
          // --- new: discrete bucket exclusivity/exhaustiveness ---
          discrete_buckets_ok,
          firm_discrete_bucket_sum: firmBucketRecon.discrete_sum,
          firm_discrete_bucket_delta: firmBucketRecon.delta,
          scopes_checked: 1 + 4 + byAttorney.length,
          bucket_failures: bucketFailures,
          // --- new: legacy field ↔ cumulative bucket alignment ---
          legacy_alignment_ok,
          legacy_alignment_failures: legacyAlignmentFailures,
          // --- unclassified visibility (unchanged keys) ---
          unclassified_total_ar: trackMetrics.unclassified.total_ar,
          unclassified_invoices: trackMetrics.unclassified.invoices,
          unclassified_matters: unclassifiedMatters.length,
        };

        const top10 = [...rows]
          .sort((a, b) => b.balance - a.balance)
          .slice(0, 10)
          .map((r) => ({ client: r.client, matter: r.matter, attorney: r.attorney, balance: round2(r.balance), days_past_due: r.days, track: r.track }));

        // Full per-attorney bill detail (matter × bill) for the workbook tabs.
        const detail = byAttorney.map((a) => ({
          attorney: a.attorney,
          bills: rows
            .filter((r) => r.attorney === a.attorney)
            .sort((x, y) => y.balance - x.balance)
            .map((r) => ({ client: r.client, matter: r.matter, bill: r.bill, issued: r.issued, due: r.due, days_past_due: r.days, bucket: r.bucket, balance: round2(r.balance) })),
        }));

        // ---- Gated-only breakdowns (dedicated workbook tabs) ----
        // The Gated track is court-appointment work; partners want to see it on
        // its own, split by responsible attorney and (under each attorney) by
        // matter. trackRows.gated already reflects probate_treatment (Probate is
        // folded into Gated only when probate_treatment="gated").
        const gatedRows = trackRows.gated;
        const gatedAttMap = new Map<string, { total: number; ar90: number; ar120: number; count: number }>();
        for (const r of gatedRows) {
          const a = gatedAttMap.get(r.attorney) ?? { total: 0, ar90: 0, ar120: 0, count: 0 };
          a.total += r.balance;
          if (r.days >= 91) a.ar90 += r.balance;
          if (r.days >= 121) a.ar120 += r.balance;
          a.count += 1;
          gatedAttMap.set(r.attorney, a);
        }
        const gatedByAttorney = [...gatedAttMap.entries()]
          .map(([attorney, v]) => ({
            attorney,
            total_ar: round2(v.total),
            ar_90plus: round2(v.ar90),
            ar_90plus_pct: v.total > 0 ? Math.round((v.ar90 / v.total) * 1000) / 10 : 0,
            ar_120plus: round2(v.ar120),
            ar_120plus_pct: v.total > 0 ? Math.round((v.ar120 / v.total) * 1000) / 10 : 0,
            invoices: v.count,
          }))
          .sort((a, b) => b.total_ar - a.total_ar);

        // Per attorney → matter (matter-level summary rows under each attorney).
        const gatedByMatter = gatedByAttorney.map((a) => {
          const attRows = gatedRows.filter((r) => r.attorney === a.attorney);
          const matterMap = new Map<string, { client: string; total: number; ar90: number; ar120: number; count: number }>();
          for (const r of attRows) {
            const mm = matterMap.get(r.matter) ?? { client: r.client, total: 0, ar90: 0, ar120: 0, count: 0 };
            mm.total += r.balance;
            if (r.days >= 91) mm.ar90 += r.balance;
            if (r.days >= 121) mm.ar120 += r.balance;
            mm.count += 1;
            matterMap.set(r.matter, mm);
          }
          const matters = [...matterMap.entries()]
            .map(([matter, v]) => ({ matter, client: v.client, total_ar: round2(v.total), ar_90plus: round2(v.ar90), ar_120plus: round2(v.ar120), invoices: v.count }))
            .sort((x, y) => y.total_ar - x.total_ar);
          return { attorney: a.attorney, total_ar: a.total_ar, ar_90plus: a.ar_90plus, ar_120plus: a.ar_120plus, invoices: a.invoices, matters };
        });

        // ---- Trust request summary (parallel to `firm`; never mixed into AR) ----
        const trustRequested = round2(trustRows.reduce((s, r) => s + r.requested, 0));
        const trustUnfunded = round2(trustRows.reduce((s, r) => s + r.balance, 0));
        const trustFunded = round2(trustRequested - trustUnfunded);
        const trust: TrustSummary = {
          requested_total: trustRequested,
          funded_total: trustFunded,
          unfunded_total: trustUnfunded,
          unfunded_count: trustRows.filter((r) => r.status === "Unfunded").length,
          fund_rate_pct: trustRequested > 0 ? Math.round((trustFunded / trustRequested) * 1000) / 10 : 0,
        };

        // ---- Maintain the AR Scorecard workbook in Box ----
        // The Box write (download prior file + build workbook + version-upload)
        // can take minutes — the Box client alone allows a 5-minute request
        // timeout — which is far longer than the MCP call timeout. Awaiting it
        // here is what made the whole scorecard call fail on the workbook leg even
        // though every metric was already computed. So by DEFAULT we detach the
        // write: metrics return immediately and the workbook is written in the
        // background (the server is long-lived, so the task finishes after this
        // response is sent). Pass await_workbook=true to block and get the link.
        let workbook_result: any = { skipped: true };
        if (params.update_workbook !== false) {
          const runWrite = () =>
            updateARScorecardWorkbook(firm, byAttorney, top10, detail, trust, trustRows, trackMetrics, probateTreatment, reconciliation, gatedByAttorney, gatedByMatter, {
              firmAging,
              stale: stale_ar_365plus,
              unclassifiedMatters,
              taggingFlags: tagging_consistency_flags,
              gatedTrust: gated_trust_correlation,
            });
          if (params.await_workbook === true) {
            try {
              workbook_result = await runWrite();
            } catch (e: any) {
              workbook_result = { error: e?.message ?? String(e) };
            }
          } else {
            // Fire-and-forget. Catch everything so a slow or failed Box write can
            // never reject into the event loop (an unhandled rejection would crash
            // the long-lived server) and never blocks this response.
            void runWrite()
              .then((r) => console.log(`[get_ar_scorecard] background workbook write complete: ${JSON.stringify(r)}`))
              .catch((e: any) => console.error(`[get_ar_scorecard] background workbook write FAILED: ${e?.message ?? e}`));
            workbook_result = {
              status: "writing_in_background",
              note: "Metrics returned immediately; the AR Scorecard workbook is being written to Box in the background. Re-run with await_workbook=true to get the Box link in the response.",
            };
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  // Bucket semantics travel with the payload so a downstream
                  // reader never has to guess whether day 30 is 16-30 or 31-60.
                  bucket_rules: BOUNDARY_RULE_TEXT,
                  // `firm` keeps every field it had; discrete_buckets /
                  // cumulative_buckets are additive.
                  firm: {
                    ...firm,
                    discrete_buckets: firmAging.discrete,
                    cumulative_buckets: firmAging.cumulative,
                  },
                  firm_by_track,
                  reconciliation_ok,
                  reconciliation,
                  track_config_health,
                  probate_treatment: probateTreatment,
                  stale_ar_365plus,
                  tagging_consistency_flags,
                  tagging_consistency_note:
                    "Heuristic flags for human review only. Nothing here reclassifies a matter or changes any " +
                    "reported figure — classification is always driven by the matter's practice_area.",
                  gated_trust_correlation,
                  trust_requests: trust,
                  by_attorney: byAttorney,
                  top_10_accounts: top10,
                  // Present only when include_wip=true.
                  wip_summary,
                  workbook: workbook_result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );
}

// ====================================================================
// AR Scorecard workbook — standalone, auto-updating Box file.
// Weekly Scorecard tab appends one row per as-of date (trend); By Attorney,
// Top 10 and Trust Requests tabs are refreshed to the current snapshot each run.
// Built fresh with ExcelJS (a brand-new file we fully control, so formatting is
// clean). AR tabs reflect revenue_kind bills only; Trust Requests holds the
// trust_kind funding requests that must never be counted as AR.
// ====================================================================
type FirmMetrics = {
  as_of: string; total_ar: number; current: number; days_1_30: number; days_31_60: number;
  days_61_90: number; days_91_120: number; ar_90plus: number; ar_90plus_pct: number;
  ar_120plus: number; ar_120plus_pct: number; ar_60plus: number;
  ar_60plus_pct: number; invoices_90plus: number; delinquent_clients: number;
  oldest_invoice_days: number; avg_days_outstanding: number;
};

// Per-track AR metrics (Gated / Semi-Gated / Non-Gated / Unclassified). Same
// aging schema as `firm` minus the 60+ fields, plus a plain invoice count so the
// unclassified bucket's size is always explicit.
type TrackMetrics = {
  total_ar: number; current: number; days_1_30: number; days_31_60: number;
  days_61_90: number; days_91_120: number; ar_90plus: number; ar_90plus_pct: number;
  ar_120plus: number; ar_120plus_pct: number; invoices_90plus: number;
  delinquent_clients: number; oldest_invoice_days: number; avg_days_outstanding: number;
  invoices: number;
  // Configurable-granularity aging (7/15/30/60/90/120/180/360). Discrete
  // buckets are mutually exclusive and sum to total_ar; cumulative buckets are
  // derived from them. Keyed by bucket key (days_16_30 / over_90).
  discrete_buckets: Record<string, BucketSummary>;
  cumulative_buckets: Record<string, BucketSummary>;
};

// Per-attorney metrics. `AttyTrackSlice` is the metric set that was previously
// only reported blended across tracks; an AttySummary now carries it once at the
// top level (unchanged field names) and once per track.
type AttyTrackSlice = {
  total_ar: number; ar_90plus: number; ar_90plus_pct: number;
  ar_120plus: number; ar_120plus_pct: number; invoices: number;
};
type AttySummary = AttyTrackSlice & {
  attorney: string;
  discrete_buckets: Record<string, BucketSummary>;
  cumulative_buckets: Record<string, BucketSummary>;
  gated: AttyTrackSlice;
  non_gated: AttyTrackSlice;
  unclassified: AttyTrackSlice;
  /** Only present when probate_treatment="separate". */
  semi_gated?: AttyTrackSlice;
  stale_ar_365plus: StaleSlice;
};

// Stale-AR (collectability-review) slice for one scope: firm, a track, or an
// attorney. days_outstanding > STALE_THRESHOLD_DAYS.
type StaleSlice = {
  total_ar: number; invoices: number; delinquent_clients: number;
  /** Stale AR as a % of the AR of the scope it was computed over. */
  pct_of_scope_ar: number;
  oldest_invoice_days: number;
  oldest_invoice: {
    bill: string; client: string; matter: string; matter_id: number | null;
    matter_number: string; issued: string; due: string; days_past_due: number; balance: number;
  } | null;
};

// A matter carrying AR with no practice_area set — surfaced with identifiers so
// it can actually be tagged, not just counted.
type UnclassifiedMatter = {
  matter_id: number | null; matter_number: string; client_name: string;
  matter_description: string; responsible_attorney: string;
  total_ar: number; invoices: number; oldest_invoice_days: number;
};

// A heuristic tagging-drift flag for human review. Never an auto-correction.
type TaggingFlag = {
  matter_id: number | null; matter_number: string; client_name: string;
  matter_description: string; practice_area: string | null;
  classified_track: TrackKey; ar_balance: number;
  rules: string[]; suspected_mismatch_reason: string;
};

// Shapes handed to the workbook builder for the new tabs.
type StaleInvoiceRow = {
  bill: string; client: string; matter: string; matter_id: number | null; matter_number: string;
  attorney: string; track: TrackKey; issued: string; due: string; days_past_due: number; balance: number;
};
type StaleSection = {
  threshold_days: number;
  firm: StaleSlice;
  by_track: Record<string, StaleSlice>;
  by_attorney: Array<{ attorney: string } & StaleSlice>;
  invoices: StaleInvoiceRow[];
};
type GatedTrustRow = {
  matter_id: number | null; matter_number: string; matter: string; client: string; attorney: string;
  ar_balance: number; ar_90plus: number; ar_over_360: number; invoices: number;
  oldest_invoice_days: number; unfunded_trust_amount: number; unfunded_trust_requests: number;
  oldest_unfunded_trust_days: number;
};
type ScorecardExtras = {
  firmAging: AgingBuckets;
  stale: StaleSection;
  unclassifiedMatters: UnclassifiedMatter[];
  taggingFlags: TaggingFlag[];
  gatedTrust: { matters: GatedTrustRow[] };
};

type TrustSummary = {
  requested_total: number; funded_total: number; unfunded_total: number;
  unfunded_count: number; fund_rate_pct: number;
};
type TrustRequestRow = {
  attorney: string; client: string; matter: string; bill: string;
  // Join key for the Gated-AR ↔ unfunded-trust-request correlation.
  matter_id: number | null;
  issued: string; due: string; days: number;
  requested: number; balance: number; funded: number;
  status: "Funded" | "Unfunded"; dateFunded: string;
};

// Weekly trend row = firm AR metrics + trust-request tracking columns + the
// Gated/Non-Gated per-track tracking columns (appended to the right so the
// trend line follows both tracks over time). Trust and per-track figures are
// tracked alongside AR so they're visible week-over-week without ever being
// conflated with the firm headline.
type WeeklyRecord = FirmMetrics & {
  trust_outstanding: number; trust_unfunded_count: number;
  non_gated_total_ar: number; non_gated_ar90: number; non_gated_ar90_pct: number;
  gated_total_ar: number; gated_ar90: number; gated_ar90_pct: number;
  unclassified_total_ar: number;
  // Stale-AR trend (the 360+ collectability-review tier).
  ar_over_360: number; stale_invoices: number;
};

const WEEKLY_COLS: Array<{ key: keyof WeeklyRecord; header: string; fmt?: string; width: number }> = [
  { key: "as_of", header: "As Of", width: 12 },
  { key: "total_ar", header: "Total AR", fmt: '"$"#,##0', width: 14 },
  { key: "ar_120plus", header: "120+ $", fmt: '"$"#,##0', width: 13 },
  { key: "ar_120plus_pct", header: "120+ %", fmt: '0.0"%"', width: 9 },
  { key: "ar_90plus", header: "90+ $", fmt: '"$"#,##0', width: 13 },
  { key: "ar_90plus_pct", header: "90+ %", fmt: '0.0"%"', width: 9 },
  { key: "ar_60plus", header: "60+ $", fmt: '"$"#,##0', width: 13 },
  { key: "ar_60plus_pct", header: "60+ %", fmt: '0.0"%"', width: 9 },
  { key: "current", header: "Current $", fmt: '"$"#,##0', width: 13 },
  { key: "invoices_90plus", header: "# Inv 90+", width: 10 },
  { key: "delinquent_clients", header: "# Clients", width: 10 },
  { key: "oldest_invoice_days", header: "Oldest (days)", width: 13 },
  { key: "avg_days_outstanding", header: "Avg Days O/S", width: 13 },
  { key: "trust_outstanding", header: "Trust Requests Outstanding ($)", fmt: '"$"#,##0', width: 28 },
  { key: "trust_unfunded_count", header: "Trust Requests Unfunded (#)", width: 26 },
  // --- Gated/Non-Gated per-track trend columns (appended to the right) ---
  { key: "non_gated_total_ar", header: "Non-Gated Total AR", fmt: '"$"#,##0', width: 18 },
  { key: "non_gated_ar90", header: "Non-Gated 90+ $", fmt: '"$"#,##0', width: 16 },
  { key: "non_gated_ar90_pct", header: "Non-Gated 90+ %", fmt: '0.0"%"', width: 16 },
  { key: "gated_total_ar", header: "Gated Total AR", fmt: '"$"#,##0', width: 16 },
  { key: "gated_ar90", header: "Gated 90+ $", fmt: '"$"#,##0', width: 14 },
  { key: "gated_ar90_pct", header: "Gated 90+ %", fmt: '0.0"%"', width: 14 },
  { key: "unclassified_total_ar", header: "Unclassified Total AR", fmt: '"$"#,##0', width: 20 },
  // --- Stale AR (360+) trend columns ---
  { key: "ar_over_360", header: "360+ $", fmt: '"$"#,##0', width: 13 },
  { key: "stale_invoices", header: "# Inv 360+", width: 11 },
];

type AttyDetail = { attorney: string; bills: Array<{ client: string; matter: string; bill: string; issued: string; due: string; days_past_due: number; bucket: string; balance: number }> };
// Gated-only breakdowns for the dedicated Gated tabs.
type GatedAttySummary = { attorney: string; total_ar: number; ar_90plus: number; ar_90plus_pct: number; ar_120plus: number; ar_120plus_pct: number; invoices: number };
type GatedMatterRow = { matter: string; client: string; total_ar: number; ar_90plus: number; ar_120plus: number; invoices: number };
type GatedByMatterGroup = { attorney: string; total_ar: number; ar_90plus: number; ar_120plus: number; invoices: number; matters: GatedMatterRow[] };
async function updateARScorecardWorkbook(
  firm: FirmMetrics,
  byAttorney: AttySummary[],
  top10: Array<{ client: string; matter: string; attorney: string; balance: number; days_past_due: number; track: TrackKey }>,
  detail: AttyDetail[],
  trust: TrustSummary,
  trustRows: TrustRequestRow[],
  tracks: Record<TrackKey, TrackMetrics>,
  probateTreatment: ProbateTreatment,
  reconciliation: { reconciliation_ok: boolean; track_total_sum: number; firm_total_ar: number; delta: number; unclassified_total_ar: number; unclassified_invoices: number },
  gatedByAttorney: GatedAttySummary[],
  gatedByMatter: GatedByMatterGroup[],
  extras: ScorecardExtras,
): Promise<any> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // 1. Read prior weekly history (if the file already exists).
  const existingId = await findBoxFileId(AR_SCORECARD_FOLDER, AR_SCORECARD_FILENAME);
  const history: Record<string, any>[] = [];
  if (existingId) {
    try {
      const buf = await downloadFromBox(existingId);
      const prev = new ExcelJS.Workbook();
      await prev.xlsx.load(buf as any);
      const ws = prev.getWorksheet("Weekly Scorecard");
      if (ws) {
        // Map prior columns by HEADER text (row 2), not position — so reordering
        // or adding columns can't mismap an existing week's values.
        const headerToCol: Record<string, number> = {};
        ws.getRow(2).eachCell((cell, col) => { const h = String(cell.value ?? "").trim(); if (h) headerToCol[h] = col; });
        const asOfCol = headerToCol["As Of"] ?? 1;
        ws.eachRow((row, n) => {
          if (n <= 2) return; // title + header
          const asOf = row.getCell(asOfCol).value;
          if (asOf == null || String(asOf).trim() === "") return;
          const rec: Record<string, any> = {};
          WEEKLY_COLS.forEach((c) => {
            const col = headerToCol[c.header];
            rec[c.key] = col ? row.getCell(col).value : (c.key === "as_of" ? "" : 0);
          });
          rec.as_of = String(asOf instanceof Date ? asOf.toISOString().split("T")[0] : asOf);
          history.push(rec);
        });
      }
    } catch { /* prior file unreadable — start fresh history */ }
  }
  // 2. Append/replace this run's row (dedupe by as_of). The weekly row carries
  // firm AR metrics plus the two trust-request tracking columns.
  const merged = history.filter((h) => h.as_of !== firm.as_of);
  const currentRecord: WeeklyRecord = {
    ...firm,
    trust_outstanding: trust.unfunded_total,
    trust_unfunded_count: trust.unfunded_count,
    non_gated_total_ar: tracks.non_gated.total_ar,
    non_gated_ar90: tracks.non_gated.ar_90plus,
    non_gated_ar90_pct: tracks.non_gated.ar_90plus_pct,
    gated_total_ar: tracks.gated.total_ar,
    gated_ar90: tracks.gated.ar_90plus,
    gated_ar90_pct: tracks.gated.ar_90plus_pct,
    unclassified_total_ar: tracks.unclassified.total_ar,
    ar_over_360: extras.stale.firm.total_ar,
    stale_invoices: extras.stale.firm.invoices,
  };
  merged.push(currentRecord as any);
  merged.sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));

  // 3. Build the workbook fresh.
  const wb = new ExcelJS.Workbook();
  wb.creator = "Clio MCP — AR Scorecard";
  const bold = { bold: true } as const;

  // ---- AR by Track (primary snapshot) ----
  // Added FIRST so the Gated/Non-Gated split is the first thing visible. Shows
  // the three (+ unclassified) tracks side by side with the full aging
  // breakdown, plus a reconciliation line proving the tracks sum to firm total.
  const moneyFmt2 = '"$"#,##0.00';
  const pctFmt = '0.0"%"';
  const trackSheet = wb.addWorksheet("AR by Track", { views: [{ state: "frozen" as const, ySplit: 3, xSplit: 1 }] });
  // The Semi-Gated (Probate) column is intentionally not shown. Probate AR is
  // folded into Gated/Non-Gated per probate_treatment (default Non-Gated); the
  // semi_gated partition is still computed internally for reconciliation and the
  // firm-total invoice count, just never rendered as its own column.
  const trackCols: Array<{ header: string; key: TrackKey | "firm" }> = [
    { header: "Gated", key: "gated" },
    { header: "Non-Gated (headline)", key: "non_gated" },
    { header: "Unclassified", key: "unclassified" },
    { header: "Firm Total", key: "firm" },
  ];
  trackSheet.mergeCells(1, 1, 1, trackCols.length + 1);
  trackSheet.getCell(1, 1).value = `AR by Track — as of ${firm.as_of}`;
  trackSheet.getCell(1, 1).font = { bold: true, size: 13 };
  trackSheet.mergeCells(2, 1, 2, trackCols.length + 1);
  trackSheet.getCell(2, 1).value =
    `Probate treatment: ${probateTreatment}.  Reconciliation: tracks sum ${reconciliation.track_total_sum.toFixed(2)} ` +
    `vs firm total ${reconciliation.firm_total_ar.toFixed(2)} (delta ${reconciliation.delta.toFixed(2)}) — ${reconciliation.reconciliation_ok ? "OK" : "MISMATCH"}.`;
  trackSheet.getCell(2, 1).font = { italic: true, color: reconciliation.reconciliation_ok ? { argb: "FF006100" } : { argb: "FF9C0006" } } as any;
  // Header row (row 3): metric label + one column per track.
  trackSheet.getColumn(1).width = 24;
  trackSheet.getCell(3, 1).value = "Metric"; trackSheet.getCell(3, 1).font = bold;
  trackCols.forEach((c, i) => { const cell = trackSheet.getCell(3, i + 2); cell.value = c.header; cell.font = bold; trackSheet.getColumn(i + 2).width = Math.max(16, c.header.length + 2); });

  const allInvoices = tracks.gated.invoices + tracks.semi_gated.invoices + tracks.non_gated.invoices + tracks.unclassified.invoices;
  const trackMetricRows: Array<{ label: string; key: keyof TrackMetrics; fmt?: string; firm: number }> = [
    { label: "Total AR", key: "total_ar", fmt: moneyFmt2, firm: firm.total_ar },
    { label: "Current", key: "current", fmt: moneyFmt2, firm: firm.current },
    { label: "1–30 days", key: "days_1_30", fmt: moneyFmt2, firm: firm.days_1_30 },
    { label: "31–60 days", key: "days_31_60", fmt: moneyFmt2, firm: firm.days_31_60 },
    { label: "61–90 days", key: "days_61_90", fmt: moneyFmt2, firm: firm.days_61_90 },
    { label: "91–120 days", key: "days_91_120", fmt: moneyFmt2, firm: firm.days_91_120 },
    { label: "90+ $", key: "ar_90plus", fmt: moneyFmt2, firm: firm.ar_90plus },
    { label: "90+ %", key: "ar_90plus_pct", fmt: pctFmt, firm: firm.ar_90plus_pct },
    { label: "120+ $", key: "ar_120plus", fmt: moneyFmt2, firm: firm.ar_120plus },
    { label: "120+ %", key: "ar_120plus_pct", fmt: pctFmt, firm: firm.ar_120plus_pct },
    { label: "# Invoices 90+", key: "invoices_90plus", firm: firm.invoices_90plus },
    { label: "# Delinquent Clients", key: "delinquent_clients", firm: firm.delinquent_clients },
    { label: "Oldest Invoice (days)", key: "oldest_invoice_days", firm: firm.oldest_invoice_days },
    { label: "Avg Days Outstanding", key: "avg_days_outstanding", firm: firm.avg_days_outstanding },
    { label: "# Invoices (total)", key: "invoices", firm: allInvoices },
  ];
  trackMetricRows.forEach((m, ri) => {
    const row = 4 + ri;
    const lbl = trackSheet.getCell(row, 1); lbl.value = m.label; lbl.font = bold;
    trackCols.forEach((c, ci) => {
      const cell = trackSheet.getCell(row, ci + 2);
      cell.value = c.key === "firm" ? m.firm : (tracks[c.key as TrackKey][m.key] as number);
      if (m.fmt) cell.numFmt = m.fmt;
      if (c.key === "firm") cell.font = bold;
    });
  });

  // ---- Aging Buckets (7/15/30/60/90/120/180/360) ----
  // The discrete block is mutually exclusive and foots to Total AR; the
  // cumulative block below it is derived from the discrete rows, so 360+ is a
  // subset of 180+ and so on. Both are shown per track and for the firm.
  const bucketSheet = wb.addWorksheet("Aging Buckets", { views: [{ state: "frozen" as const, ySplit: 4, xSplit: 1 }] });
  const bucketCols: Array<{ header: string; key: TrackKey | "firm" }> = [
    { header: "Gated", key: "gated" },
    { header: "Non-Gated (headline)", key: "non_gated" },
    { header: "Unclassified", key: "unclassified" },
    { header: "Firm Total", key: "firm" },
  ];
  bucketSheet.mergeCells(1, 1, 1, bucketCols.length + 2);
  bucketSheet.getCell(1, 1).value = `AR Aging Buckets — as of ${firm.as_of}`;
  bucketSheet.getCell(1, 1).font = { bold: true, size: 13 };
  bucketSheet.mergeCells(2, 1, 3, bucketCols.length + 2);
  bucketSheet.getCell(2, 1).value = BOUNDARY_RULE_TEXT;
  bucketSheet.getCell(2, 1).font = { italic: true, size: 9 } as any;
  bucketSheet.getCell(2, 1).alignment = { wrapText: true, vertical: "top" } as any;
  bucketSheet.getColumn(1).width = 16;
  bucketSheet.getColumn(2).width = 12;
  const bucketHeaders = ["Bucket", "# Invoices", ...bucketCols.map((c) => c.header)];
  bucketHeaders.forEach((h, i) => {
    const cell = bucketSheet.getCell(4, i + 1);
    cell.value = h; cell.font = bold;
    if (i >= 2) bucketSheet.getColumn(i + 1).width = Math.max(16, h.length + 2);
  });
  const bucketValue = (key: TrackKey | "firm", scopeKey: string, view: "discrete" | "cumulative") =>
    key === "firm"
      ? extras.firmAging[view][scopeKey]?.total ?? 0
      : (view === "discrete" ? tracks[key].discrete_buckets : tracks[key].cumulative_buckets)[scopeKey]?.total ?? 0;
  let bkr = 5;
  const bucketSectionHeader = (title: string) => {
    bucketSheet.mergeCells(bkr, 1, bkr, bucketHeaders.length);
    const c = bucketSheet.getCell(bkr, 1);
    c.value = title; c.font = bold;
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } } as any;
    bkr++;
  };
  bucketSectionHeader("Discrete (mutually exclusive — sums to Total AR)");
  for (const b of DISCRETE_BUCKETS) {
    bucketSheet.getCell(bkr, 1).value = b.label;
    bucketSheet.getCell(bkr, 2).value = extras.firmAging.discrete[b.key]?.count ?? 0;
    bucketCols.forEach((c, ci) => {
      const cell = bucketSheet.getCell(bkr, ci + 3);
      cell.value = bucketValue(c.key, b.key, "discrete");
      cell.numFmt = moneyFmt2;
      if (c.key === "firm") cell.font = bold;
    });
    bkr++;
  }
  bucketSheet.getCell(bkr, 1).value = "Total AR"; bucketSheet.getCell(bkr, 1).font = bold;
  bucketCols.forEach((c, ci) => {
    const cell = bucketSheet.getCell(bkr, ci + 3);
    cell.value = c.key === "firm" ? firm.total_ar : tracks[c.key].total_ar;
    cell.numFmt = moneyFmt2; cell.font = bold;
  });
  bkr += 2;
  bucketSectionHeader("Cumulative rollups (derived — each is a subset of the one above)");
  for (const t of CUMULATIVE_THRESHOLDS) {
    const key = cumulativeKey(t);
    bucketSheet.getCell(bkr, 1).value = `${t}+`;
    bucketSheet.getCell(bkr, 2).value = extras.firmAging.cumulative[key]?.count ?? 0;
    bucketCols.forEach((c, ci) => {
      const cell = bucketSheet.getCell(bkr, ci + 3);
      cell.value = bucketValue(c.key, key, "cumulative");
      cell.numFmt = moneyFmt2;
      if (c.key === "firm") cell.font = bold;
    });
    bkr++;
  }

  const weekly = wb.addWorksheet("Weekly Scorecard", { views: [{ state: "frozen" as const, ySplit: 2, xSplit: 1 }] });
  weekly.mergeCells(1, 1, 1, WEEKLY_COLS.length);
  weekly.getCell(1, 1).value = "AR Scorecard — Weekly (EOS)";
  weekly.getCell(1, 1).font = { bold: true, size: 13 };
  WEEKLY_COLS.forEach((c, i) => {
    const cell = weekly.getCell(2, i + 1);
    cell.value = c.header; cell.font = bold;
    weekly.getColumn(i + 1).width = c.width;
    if (c.fmt) weekly.getColumn(i + 1).numFmt = c.fmt;
  });
  merged.forEach((rec, ri) => {
    WEEKLY_COLS.forEach((c, i) => {
      const v = rec[c.key];
      weekly.getCell(3 + ri, i + 1).value = c.key === "as_of" ? String(v) : (typeof v === "number" ? v : Number(v) || 0);
    });
  });

  const att = wb.addWorksheet("By Attorney");
  att.getCell(1, 1).value = `By Responsible Attorney — as of ${firm.as_of}`;
  att.getCell(1, 1).font = { bold: true, size: 13 };
  // Blended columns first (unchanged), then the Gated / Non-Gated split so
  // "what's my gated AR" is answerable on this one tab, then the 360+ tier.
  const attHeaders = [
    "Attorney", "Total AR", "120+ $", "120+ %", "90+ $", "90+ %", "# Invoices",
    "Gated AR", "Gated 90+ $", "Non-Gated AR", "Non-Gated 90+ $", "Unclassified AR",
    "360+ $", "# Inv 360+",
  ];
  const attFmt = [
    "", '"$"#,##0', '"$"#,##0', '0.0"%"', '"$"#,##0', '0.0"%"', "",
    '"$"#,##0', '"$"#,##0', '"$"#,##0', '"$"#,##0', '"$"#,##0',
    '"$"#,##0', "",
  ];
  const attWidth = [26, 14, 13, 9, 13, 9, 11, 14, 14, 15, 17, 16, 13, 11];
  attHeaders.forEach((h, i) => { const c = att.getCell(2, i + 1); c.value = h; c.font = bold; att.getColumn(i + 1).width = attWidth[i]; if (attFmt[i]) att.getColumn(i + 1).numFmt = attFmt[i]; });
  byAttorney.forEach((a, ri) => {
    att.getCell(3 + ri, 1).value = a.attorney;
    att.getCell(3 + ri, 2).value = a.total_ar;
    att.getCell(3 + ri, 3).value = a.ar_120plus;
    att.getCell(3 + ri, 4).value = a.ar_120plus_pct;
    att.getCell(3 + ri, 5).value = a.ar_90plus;
    att.getCell(3 + ri, 6).value = a.ar_90plus_pct;
    att.getCell(3 + ri, 7).value = a.invoices;
    att.getCell(3 + ri, 8).value = a.gated.total_ar;
    att.getCell(3 + ri, 9).value = a.gated.ar_90plus;
    att.getCell(3 + ri, 10).value = a.non_gated.total_ar;
    att.getCell(3 + ri, 11).value = a.non_gated.ar_90plus;
    att.getCell(3 + ri, 12).value = a.unclassified.total_ar;
    att.getCell(3 + ri, 13).value = a.stale_ar_365plus.total_ar;
    att.getCell(3 + ri, 14).value = a.stale_ar_365plus.invoices;
  });
  const totRow = 3 + byAttorney.length;
  att.getCell(totRow, 1).value = "Firm Total"; att.getCell(totRow, 1).font = bold;
  att.getCell(totRow, 2).value = firm.total_ar; att.getCell(totRow, 2).font = bold;
  att.getCell(totRow, 3).value = firm.ar_120plus; att.getCell(totRow, 3).font = bold;
  att.getCell(totRow, 4).value = firm.ar_120plus_pct; att.getCell(totRow, 4).font = bold;
  att.getCell(totRow, 5).value = firm.ar_90plus; att.getCell(totRow, 5).font = bold;
  att.getCell(totRow, 6).value = firm.ar_90plus_pct; att.getCell(totRow, 6).font = bold;
  att.getCell(totRow, 8).value = tracks.gated.total_ar; att.getCell(totRow, 8).font = bold;
  att.getCell(totRow, 9).value = tracks.gated.ar_90plus; att.getCell(totRow, 9).font = bold;
  att.getCell(totRow, 10).value = tracks.non_gated.total_ar; att.getCell(totRow, 10).font = bold;
  att.getCell(totRow, 11).value = tracks.non_gated.ar_90plus; att.getCell(totRow, 11).font = bold;
  att.getCell(totRow, 12).value = tracks.unclassified.total_ar; att.getCell(totRow, 12).font = bold;
  att.getCell(totRow, 13).value = extras.stale.firm.total_ar; att.getCell(totRow, 13).font = bold;
  att.getCell(totRow, 14).value = extras.stale.firm.invoices; att.getCell(totRow, 14).font = bold;

  // ---- Stale AR (360+) — collectability review ----
  // Balances older than the top bucket boundary. Still inside Total AR; broken
  // out here so they get triaged/written off on a cadence instead of quietly
  // inflating the 90+/120+ headline.
  const staleWs = wb.addWorksheet("Stale AR 365+", { views: [{ state: "frozen" as const, ySplit: 4 }] });
  const staleHeaders = ["Responsible Attorney", "Client", "Matter", "Matter #", "Bill #", "Track", "Issued", "Due", "Days Past Due", "Balance"];
  const staleWidth = [24, 26, 40, 14, 10, 14, 12, 12, 14, 14];
  staleWs.mergeCells(1, 1, 1, staleHeaders.length);
  staleWs.getCell(1, 1).value = `Stale AR — collectability review (over ${extras.stale.threshold_days} days) — as of ${firm.as_of}`;
  staleWs.getCell(1, 1).font = { bold: true, size: 13 };
  staleWs.mergeCells(2, 1, 2, staleHeaders.length);
  staleWs.getCell(2, 1).value =
    `${extras.stale.firm.invoices} invoice(s) / $${extras.stale.firm.total_ar.toFixed(2)} — ` +
    `${extras.stale.firm.pct_of_scope_ar.toFixed(1)}% of Total AR. Oldest: ${extras.stale.firm.oldest_invoice_days} days. ` +
    `Gated $${(extras.stale.by_track.gated?.total_ar ?? 0).toFixed(2)} / ` +
    `Non-Gated $${(extras.stale.by_track.non_gated?.total_ar ?? 0).toFixed(2)} / ` +
    `Unclassified $${(extras.stale.by_track.unclassified?.total_ar ?? 0).toFixed(2)}. ` +
    `These balances are still counted inside Total AR — nothing is netted out here.`;
  staleWs.getCell(2, 1).font = { italic: true } as any;
  // Per-attorney summary (rows 4..), then the invoice detail below it.
  staleHeaders.forEach((h, i) => { const c = staleWs.getCell(4, i + 1); c.value = h; c.font = bold; staleWs.getColumn(i + 1).width = staleWidth[i]; });
  staleWs.getColumn(10).numFmt = moneyFmt2;
  let srr = 5;
  if (extras.stale.by_attorney.length) {
    staleWs.mergeCells(srr, 1, srr, staleHeaders.length);
    const c = staleWs.getCell(srr, 1);
    c.value = "By responsible attorney — total $, # invoices, oldest invoice";
    c.font = bold;
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } } as any;
    srr++;
    for (const a of extras.stale.by_attorney) {
      staleWs.getCell(srr, 1).value = a.attorney;
      staleWs.getCell(srr, 2).value = `${a.invoices} invoice(s)`;
      staleWs.getCell(srr, 3).value = a.oldest_invoice ? `oldest: ${a.oldest_invoice.matter}` : "";
      staleWs.getCell(srr, 4).value = a.oldest_invoice?.matter_number ?? "";
      staleWs.getCell(srr, 5).value = a.oldest_invoice?.bill ?? "";
      staleWs.getCell(srr, 9).value = a.oldest_invoice_days;
      staleWs.getCell(srr, 10).value = a.total_ar;
      srr++;
    }
    srr++;
  }
  staleWs.mergeCells(srr, 1, srr, staleHeaders.length);
  const sdc = staleWs.getCell(srr, 1);
  sdc.value = "Invoice detail — oldest first";
  sdc.font = bold;
  sdc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } } as any;
  srr++;
  for (const inv of extras.stale.invoices) {
    staleWs.getCell(srr, 1).value = inv.attorney;
    staleWs.getCell(srr, 2).value = inv.client;
    staleWs.getCell(srr, 3).value = inv.matter;
    staleWs.getCell(srr, 4).value = inv.matter_number;
    staleWs.getCell(srr, 5).value = inv.bill;
    staleWs.getCell(srr, 6).value = trackLabel[inv.track];
    staleWs.getCell(srr, 7).value = inv.issued;
    staleWs.getCell(srr, 8).value = inv.due;
    staleWs.getCell(srr, 9).value = inv.days_past_due;
    staleWs.getCell(srr, 10).value = inv.balance;
    srr++;
  }
  staleWs.getCell(srr, 1).value = "Total"; staleWs.getCell(srr, 1).font = bold;
  staleWs.getCell(srr, 10).value = extras.stale.firm.total_ar; staleWs.getCell(srr, 10).font = bold;

  // ---- Gated AR: by responsible attorney (summary) ----
  // Same shape as "By Attorney" but restricted to the Gated track, so partners
  // can see court-appointment AR per attorney without the client-pay noise.
  const gAtt = wb.addWorksheet("Gated by Attorney");
  gAtt.getCell(1, 1).value = `Gated AR by Responsible Attorney — as of ${firm.as_of}`;
  gAtt.getCell(1, 1).font = { bold: true, size: 13 };
  const gAttHeaders = ["Attorney", "Total AR", "120+ $", "120+ %", "90+ $", "90+ %", "# Invoices"];
  const gAttFmt = ["", '"$"#,##0', '"$"#,##0', '0.0"%"', '"$"#,##0', '0.0"%"', ""];
  const gAttWidth = [26, 14, 13, 9, 13, 9, 11];
  gAttHeaders.forEach((h, i) => { const c = gAtt.getCell(2, i + 1); c.value = h; c.font = bold; gAtt.getColumn(i + 1).width = gAttWidth[i]; if (gAttFmt[i]) gAtt.getColumn(i + 1).numFmt = gAttFmt[i]; });
  gatedByAttorney.forEach((a, ri) => {
    gAtt.getCell(3 + ri, 1).value = a.attorney;
    gAtt.getCell(3 + ri, 2).value = a.total_ar;
    gAtt.getCell(3 + ri, 3).value = a.ar_120plus;
    gAtt.getCell(3 + ri, 4).value = a.ar_120plus_pct;
    gAtt.getCell(3 + ri, 5).value = a.ar_90plus;
    gAtt.getCell(3 + ri, 6).value = a.ar_90plus_pct;
    gAtt.getCell(3 + ri, 7).value = a.invoices;
  });
  const gTotRow = 3 + gatedByAttorney.length;
  gAtt.getCell(gTotRow, 1).value = "Gated Total"; gAtt.getCell(gTotRow, 1).font = bold;
  gAtt.getCell(gTotRow, 2).value = tracks.gated.total_ar; gAtt.getCell(gTotRow, 2).font = bold;
  gAtt.getCell(gTotRow, 3).value = tracks.gated.ar_120plus; gAtt.getCell(gTotRow, 3).font = bold;
  gAtt.getCell(gTotRow, 4).value = tracks.gated.ar_120plus_pct; gAtt.getCell(gTotRow, 4).font = bold;
  gAtt.getCell(gTotRow, 5).value = tracks.gated.ar_90plus; gAtt.getCell(gTotRow, 5).font = bold;
  gAtt.getCell(gTotRow, 6).value = tracks.gated.ar_90plus_pct; gAtt.getCell(gTotRow, 6).font = bold;
  gAtt.getCell(gTotRow, 7).value = tracks.gated.invoices; gAtt.getCell(gTotRow, 7).font = bold;

  // ---- Gated AR: by responsible attorney → matter ----
  // Gated matters grouped under each responsible attorney (an attorney group
  // header, one summary row per matter, then an attorney subtotal). Matters and
  // attorneys are both ordered by gated AR exposure (largest first).
  const gMat = wb.addWorksheet("Gated by Matter", { views: [{ state: "frozen" as const, ySplit: 2 }] });
  const gMatHeaders = ["Client", "Matter", "# Invoices", "90+ $", "120+ $", "Total AR"];
  const gMatFmt = ["", "", "", '"$"#,##0.00', '"$"#,##0.00', '"$"#,##0.00'];
  const gMatWidth = [26, 44, 11, 14, 14, 14];
  gMat.mergeCells(1, 1, 1, gMatHeaders.length);
  gMat.getCell(1, 1).value = `Gated AR by Responsible Attorney → Matter — as of ${firm.as_of}`;
  gMat.getCell(1, 1).font = { bold: true, size: 13 };
  gMatHeaders.forEach((h, i) => { const c = gMat.getCell(2, i + 1); c.value = h; c.font = bold; gMat.getColumn(i + 1).width = gMatWidth[i]; if (gMatFmt[i]) gMat.getColumn(i + 1).numFmt = gMatFmt[i]; });
  let gmr = 3;
  for (const g of gatedByMatter) {
    if (!g.matters.length) continue;
    gMat.mergeCells(gmr, 1, gmr, gMatHeaders.length);
    const hc = gMat.getCell(gmr, 1);
    hc.value = `${g.attorney} — ${g.matters.length} matter(s) — $${g.total_ar.toFixed(2)}`;
    hc.font = bold;
    hc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } } as any;
    gmr++;
    for (const m of g.matters) {
      gMat.getCell(gmr, 1).value = m.client;
      gMat.getCell(gmr, 2).value = m.matter;
      gMat.getCell(gmr, 3).value = m.invoices;
      gMat.getCell(gmr, 4).value = m.ar_90plus;
      gMat.getCell(gmr, 5).value = m.ar_120plus;
      gMat.getCell(gmr, 6).value = m.total_ar;
      gmr++;
    }
    gMat.getCell(gmr, 2).value = `  Subtotal — ${g.attorney}`; gMat.getCell(gmr, 2).font = bold;
    gMat.getCell(gmr, 3).value = g.invoices; gMat.getCell(gmr, 3).font = bold;
    gMat.getCell(gmr, 4).value = g.ar_90plus; gMat.getCell(gmr, 4).font = bold;
    gMat.getCell(gmr, 5).value = g.ar_120plus; gMat.getCell(gmr, 5).font = bold;
    gMat.getCell(gmr, 6).value = g.total_ar; gMat.getCell(gmr, 6).font = bold;
    gmr++;
  }
  gMat.getCell(gmr, 1).value = "Gated Total"; gMat.getCell(gmr, 1).font = bold;
  gMat.getCell(gmr, 3).value = tracks.gated.invoices; gMat.getCell(gmr, 3).font = bold;
  gMat.getCell(gmr, 4).value = tracks.gated.ar_90plus; gMat.getCell(gmr, 4).font = bold;
  gMat.getCell(gmr, 5).value = tracks.gated.ar_120plus; gMat.getCell(gmr, 5).font = bold;
  gMat.getCell(gmr, 6).value = tracks.gated.total_ar; gMat.getCell(gmr, 6).font = bold;

  // ---- Gated AR vs. unfunded trust requests ----
  // The Trust Requests and Gated AR views used to live on separate tabs with no
  // join key. For gated matters an unfunded trust/retainer request is a leading
  // indicator of AR about to age, so the two figures belong on one row. Trust
  // dollars are NEVER added into any AR figure.
  const gtWs = wb.addWorksheet("Gated AR vs Trust", { views: [{ state: "frozen" as const, ySplit: 3 }] });
  const gtHeaders = ["Responsible Attorney", "Client", "Matter", "Matter #", "# Invoices", "Gated AR", "AR 90+ $", "AR 360+ $", "Oldest AR (days)", "Unfunded Trust $", "# Trust Requests", "Oldest Request (days)"];
  const gtFmt = ["", "", "", "", "", moneyFmt2, moneyFmt2, moneyFmt2, "", moneyFmt2, "", ""];
  const gtWidth = [24, 26, 40, 14, 11, 14, 14, 14, 16, 17, 16, 20];
  gtWs.mergeCells(1, 1, 1, gtHeaders.length);
  gtWs.getCell(1, 1).value = `Gated AR vs. Unfunded Trust Requests — as of ${firm.as_of}`;
  gtWs.getCell(1, 1).font = { bold: true, size: 13 };
  gtWs.mergeCells(2, 1, 2, gtHeaders.length);
  gtWs.getCell(2, 1).value =
    "Gated-track matters with an outstanding AR balance, each next to its own unfunded trust/retainer " +
    "request. Trust requests are advance-deposit requests, not receivables — they are never included in " +
    "any AR column here. Sorted by unfunded trust $, then AR.";
  gtWs.getCell(2, 1).font = { italic: true } as any;
  gtHeaders.forEach((h, i) => { const c = gtWs.getCell(3, i + 1); c.value = h; c.font = bold; gtWs.getColumn(i + 1).width = gtWidth[i]; if (gtFmt[i]) gtWs.getColumn(i + 1).numFmt = gtFmt[i]; });
  let gtr = 4;
  for (const m of extras.gatedTrust.matters) {
    gtWs.getCell(gtr, 1).value = m.attorney;
    gtWs.getCell(gtr, 2).value = m.client;
    gtWs.getCell(gtr, 3).value = m.matter;
    gtWs.getCell(gtr, 4).value = m.matter_number;
    gtWs.getCell(gtr, 5).value = m.invoices;
    gtWs.getCell(gtr, 6).value = m.ar_balance;
    gtWs.getCell(gtr, 7).value = m.ar_90plus;
    gtWs.getCell(gtr, 8).value = m.ar_over_360;
    gtWs.getCell(gtr, 9).value = m.oldest_invoice_days;
    gtWs.getCell(gtr, 10).value = m.unfunded_trust_amount;
    gtWs.getCell(gtr, 11).value = m.unfunded_trust_requests;
    gtWs.getCell(gtr, 12).value = m.oldest_unfunded_trust_days;
    gtr++;
  }
  gtWs.getCell(gtr, 1).value = "Total"; gtWs.getCell(gtr, 1).font = bold;
  gtWs.getCell(gtr, 6).value = r2(extras.gatedTrust.matters.reduce((s, m) => s + m.ar_balance, 0)); gtWs.getCell(gtr, 6).font = bold;
  gtWs.getCell(gtr, 10).value = r2(extras.gatedTrust.matters.reduce((s, m) => s + m.unfunded_trust_amount, 0)); gtWs.getCell(gtr, 10).font = bold;

  const top = wb.addWorksheet("Top 10 Accounts");
  top.getCell(1, 1).value = `Top 10 Open Balances — as of ${firm.as_of}`;
  top.getCell(1, 1).font = { bold: true, size: 13 };
  const topHeaders = ["Client", "Matter", "Responsible Attorney", "Balance", "Days Past Due", "Track"];
  const topWidth = [28, 36, 24, 14, 13, 14];
  topHeaders.forEach((h, i) => { const c = top.getCell(2, i + 1); c.value = h; c.font = bold; top.getColumn(i + 1).width = topWidth[i]; });
  top.getColumn(4).numFmt = '"$"#,##0';
  top10.forEach((t, ri) => {
    top.getCell(3 + ri, 1).value = t.client;
    top.getCell(3 + ri, 2).value = t.matter;
    top.getCell(3 + ri, 3).value = t.attorney;
    top.getCell(3 + ri, 4).value = t.balance;
    top.getCell(3 + ri, 5).value = t.days_past_due;
    top.getCell(3 + ri, 6).value = trackLabel[t.track];
  });

  // ---- Trust Requests tab ----
  // trust_kind bills only — advance-deposit / retainer funding requests, NOT
  // accounts receivable. Reports funded vs. unfunded so the firm can chase
  // outstanding replenishment requests without polluting AR. Title (row 1),
  // summary block (rows 2–6), detail header (row 8, frozen), rows from 9.
  const trustWs = wb.addWorksheet("Trust Requests", { views: [{ state: "frozen" as const, ySplit: 8 }] });
  const trustHeaders = ["Responsible Attorney", "Client", "Matter", "Bill #", "Issued", "Due", "Days Outstanding", "Amount Requested", "Status", "Date Funded"];
  const trustWidth = [24, 26, 42, 10, 12, 12, 16, 16, 11, 12];
  const moneyFmt = '"$"#,##0.00';
  trustWs.mergeCells(1, 1, 1, trustHeaders.length);
  trustWs.getCell(1, 1).value = `Trust / Retainer Replenishment Requests — as of ${firm.as_of}`;
  trustWs.getCell(1, 1).font = { bold: true, size: 13 };
  const trustSummary: Array<{ label: string; value: number; fmt?: string }> = [
    { label: "Requests Sent", value: trustRows.length },
    { label: "Total Requested", value: trust.requested_total, fmt: moneyFmt },
    { label: "Funded", value: trust.funded_total, fmt: moneyFmt },
    { label: "Unfunded", value: trust.unfunded_total, fmt: moneyFmt },
    { label: "Fund Rate", value: trust.fund_rate_pct, fmt: '0.0"%"' },
  ];
  trustSummary.forEach((s, i) => {
    const lbl = trustWs.getCell(2 + i, 1); lbl.value = s.label; lbl.font = bold;
    const val = trustWs.getCell(2 + i, 2); val.value = s.value; if (s.fmt) val.numFmt = s.fmt;
  });
  trustHeaders.forEach((h, i) => { const c = trustWs.getCell(8, i + 1); c.value = h; c.font = bold; trustWs.getColumn(i + 1).width = trustWidth[i]; });
  trustWs.getColumn(8).numFmt = moneyFmt; // Amount Requested
  let trr = 9;
  for (const t of trustRows) {
    trustWs.getCell(trr, 1).value = t.attorney;
    trustWs.getCell(trr, 2).value = t.client;
    trustWs.getCell(trr, 3).value = t.matter;
    trustWs.getCell(trr, 4).value = t.bill;
    trustWs.getCell(trr, 5).value = t.issued;
    trustWs.getCell(trr, 6).value = t.due;
    trustWs.getCell(trr, 7).value = t.days;
    trustWs.getCell(trr, 8).value = t.requested;
    trustWs.getCell(trr, 9).value = t.status;
    trustWs.getCell(trr, 10).value = t.dateFunded;
    trr++;
  }
  trustWs.getCell(trr, 1).value = "Total"; trustWs.getCell(trr, 1).font = bold;
  trustWs.getCell(trr, 8).value = trust.requested_total; trustWs.getCell(trr, 8).font = bold;

  // ---- Unclassified Matters (a work list, not just a total) ----
  // Matters carrying AR with no practice_area set. Should be zero: until they're
  // tagged their AR can't be assigned to the Gated or Non-Gated track.
  const ucWs = wb.addWorksheet("Unclassified Matters", { views: [{ state: "frozen" as const, ySplit: 3 }] });
  const ucHeaders = ["Matter ID", "Matter #", "Client", "Matter Description", "Responsible Attorney", "# Invoices", "Oldest (days)", "Total AR"];
  const ucWidth = [12, 16, 26, 40, 24, 11, 13, 14];
  ucWs.mergeCells(1, 1, 1, ucHeaders.length);
  ucWs.getCell(1, 1).value = `Matters with NO practice_area — as of ${firm.as_of}`;
  ucWs.getCell(1, 1).font = { bold: true, size: 13 };
  ucWs.mergeCells(2, 1, 2, ucHeaders.length);
  ucWs.getCell(2, 1).value =
    `${extras.unclassifiedMatters.length} matter(s) / $${tracks.unclassified.total_ar.toFixed(2)} of AR cannot be ` +
    `assigned to the Gated or Non-Gated track. Set practice_area on each matter below and this tab empties out.`;
  ucWs.getCell(2, 1).font = { italic: true } as any;
  ucHeaders.forEach((h, i) => { const c = ucWs.getCell(3, i + 1); c.value = h; c.font = bold; ucWs.getColumn(i + 1).width = ucWidth[i]; });
  ucWs.getColumn(8).numFmt = moneyFmt2;
  let ucr = 4;
  for (const m of extras.unclassifiedMatters) {
    ucWs.getCell(ucr, 1).value = m.matter_id;
    ucWs.getCell(ucr, 2).value = m.matter_number;
    ucWs.getCell(ucr, 3).value = m.client_name;
    ucWs.getCell(ucr, 4).value = m.matter_description;
    ucWs.getCell(ucr, 5).value = m.responsible_attorney;
    ucWs.getCell(ucr, 6).value = m.invoices;
    ucWs.getCell(ucr, 7).value = m.oldest_invoice_days;
    ucWs.getCell(ucr, 8).value = m.total_ar;
    ucr++;
  }
  ucWs.getCell(ucr, 1).value = "Total"; ucWs.getCell(ucr, 1).font = bold;
  ucWs.getCell(ucr, 6).value = tracks.unclassified.invoices; ucWs.getCell(ucr, 6).font = bold;
  ucWs.getCell(ucr, 8).value = tracks.unclassified.total_ar; ucWs.getCell(ucr, 8).font = bold;

  // ---- Tagging Flags (heuristic, for human review) ----
  const tfWs = wb.addWorksheet("Tagging Flags", { views: [{ state: "frozen" as const, ySplit: 3 }] });
  const tfHeaders = ["Matter ID", "Matter #", "Client", "Matter Description", "practice_area", "Classified Track", "AR Balance", "Suspected Mismatch"];
  const tfWidth = [12, 16, 26, 38, 20, 16, 14, 80];
  tfWs.mergeCells(1, 1, 1, tfHeaders.length);
  tfWs.getCell(1, 1).value = `Practice-area tagging consistency flags — as of ${firm.as_of}`;
  tfWs.getCell(1, 1).font = { bold: true, size: 13 };
  tfWs.mergeCells(2, 1, 2, tfHeaders.length);
  tfWs.getCell(2, 1).value =
    "HEURISTIC — for human review only. Nothing here reclassifies a matter or changes any figure in this " +
    "workbook. Two rules: (1) the matter description reads like court-gated work but its practice_area does " +
    "not classify it as Gated; (2) matters sharing the same description pattern disagree on practice_area.";
  tfWs.getCell(2, 1).font = { italic: true } as any;
  tfWs.getCell(2, 1).alignment = { wrapText: true, vertical: "top" } as any;
  tfHeaders.forEach((h, i) => { const c = tfWs.getCell(3, i + 1); c.value = h; c.font = bold; tfWs.getColumn(i + 1).width = tfWidth[i]; });
  tfWs.getColumn(7).numFmt = moneyFmt2;
  let tfr = 4;
  for (const f of extras.taggingFlags) {
    tfWs.getCell(tfr, 1).value = f.matter_id;
    tfWs.getCell(tfr, 2).value = f.matter_number;
    tfWs.getCell(tfr, 3).value = f.client_name;
    tfWs.getCell(tfr, 4).value = f.matter_description;
    tfWs.getCell(tfr, 5).value = f.practice_area ?? "(none)";
    tfWs.getCell(tfr, 6).value = trackLabel[f.classified_track];
    tfWs.getCell(tfr, 7).value = f.ar_balance;
    tfWs.getCell(tfr, 8).value = f.suspected_mismatch_reason;
    tfr++;
  }
  if (!extras.taggingFlags.length) {
    tfWs.getCell(4, 1).value = "No tagging inconsistencies detected.";
  }

  // Detail tabs per responsible attorney: TWO views each —
  //   "{Attorney}"            : every bill, largest balance first
  //   "{Attorney} by Matter"  : bills grouped/sorted by matter, with a subtotal
  //                             row per matter (total AR exposure per matter)
  const usedNames = new Set<string>();
  const sheetName = (name: string): string => {
    let base = (name || "Unknown").replace(/[:\\/?*\[\]]/g, "-").slice(0, 31).trim() || "Unknown";
    let candidate = base, i = 2;
    while (usedNames.has(candidate.toLowerCase())) { const suf = `~${i++}`; candidate = base.slice(0, 31 - suf.length) + suf; }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };
  const detHeaders = ["Client", "Matter", "Bill #", "Issued", "Due", "Days Past Due", "Bucket", "Balance"];
  const detWidth = [26, 42, 10, 12, 12, 13, 10, 14];
  type DetBill = AttyDetail["bills"][number];
  const writeDetailTab = (tabName: string, title: string, bills: DetBill[], groupByMatter: boolean) => {
    const ws = wb.addWorksheet(sheetName(tabName), { views: [{ state: "frozen" as const, ySplit: 2 }] });
    ws.mergeCells(1, 1, 1, detHeaders.length);
    ws.getCell(1, 1).value = title;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    detHeaders.forEach((h, i) => { const c = ws.getCell(2, i + 1); c.value = h; c.font = bold; ws.getColumn(i + 1).width = detWidth[i]; });
    ws.getColumn(8).numFmt = '"$"#,##0.00';
    let rr = 3;
    const writeBill = (b: DetBill) => {
      ws.getCell(rr, 1).value = b.client;
      ws.getCell(rr, 2).value = b.matter;
      ws.getCell(rr, 3).value = b.bill;
      ws.getCell(rr, 4).value = b.issued;
      ws.getCell(rr, 5).value = b.due;
      ws.getCell(rr, 6).value = b.days_past_due;
      ws.getCell(rr, 7).value = b.bucket;
      ws.getCell(rr, 8).value = b.balance;
      rr++;
    };
    if (groupByMatter) {
      let curMatter: string | null = null, matterSum = 0;
      const flush = () => {
        if (curMatter === null) return;
        ws.getCell(rr, 2).value = `  Subtotal — ${curMatter}`; ws.getCell(rr, 2).font = bold;
        ws.getCell(rr, 8).value = r2(matterSum); ws.getCell(rr, 8).font = bold;
        rr++;
      };
      for (const b of bills) {
        if (b.matter !== curMatter) { flush(); curMatter = b.matter; matterSum = 0; }
        writeBill(b);
        matterSum += b.balance;
      }
      flush();
    } else {
      for (const b of bills) writeBill(b);
    }
    ws.getCell(rr, 1).value = "Total"; ws.getCell(rr, 1).font = bold;
    ws.getCell(rr, 8).value = r2(bills.reduce((s, b) => s + b.balance, 0)); ws.getCell(rr, 8).font = bold;
  };
  for (const d of detail) {
    if (!d.bills.length) continue;
    const stamp = `as of ${firm.as_of} (${d.bills.length} bills)`;
    // By amount (bills arrive sorted largest-first from the caller).
    writeDetailTab(d.attorney, `AR Detail — ${d.attorney} — by amount — ${stamp}`, d.bills, false);
    // By matter: matters ordered by total amount due (summed balance) descending —
    // the matter with the largest AR exposure first. Bills of a matter are kept
    // contiguous (the subtotal logic depends on it; ties broken by matter name) and
    // largest bill first within a matter.
    const matterDue = new Map<string, number>();
    for (const b of d.bills) matterDue.set(b.matter, (matterDue.get(b.matter) ?? 0) + b.balance);
    const byMatter = [...d.bills].sort((a, b) =>
      (matterDue.get(b.matter)! - matterDue.get(a.matter)!) ||
      a.matter.localeCompare(b.matter) ||
      b.balance - a.balance
    );
    writeDetailTab(`${d.attorney} by Matter`, `AR Detail — ${d.attorney} — by matter — ${stamp}`, byMatter, true);
  }

  const out = Buffer.from(await wb.xlsx.writeBuffer());

  // 4. Version the existing file, or create it the first time.
  const result = existingId
    ? await uploadToBox({ buffer: out, filename: AR_SCORECARD_FILENAME, folderId: AR_SCORECARD_FOLDER, overwriteFileId: existingId })
    : await createBoxFile({ buffer: out, filename: AR_SCORECARD_FILENAME, folderId: AR_SCORECARD_FOLDER });

  return {
    created: !existingId,
    weeks_tracked: merged.length,
    ...(result.uploaded
      ? { uploaded: true, box_file_id: result.box_file_id, box_url: result.box_url }
      : { uploaded: false, direct_download_url: (result as any).direct_download_url, reason: (result as any).reason }),
  };
}
