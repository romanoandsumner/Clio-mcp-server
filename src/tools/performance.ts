import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport, rawPostSingle, rawGetSingle } from "../clio/pagination";
import { getFeeAllocationCSV, genFeeAllocationByMonth, assertReportPeriod, parseCSV } from "../clio/reportCsv";

const TIME_FIELDS =
  "id,date,quantity,rounded_quantity,price,total,note,billed,matter{id,display_number,description},user{id,name}";


/**
 * List all completed Fee Allocation Reports in Clio.
 */
async function listFeeAllocationReports(): Promise<any[]> {
  const reports = await fetchAllPages<any>("/reports", {
    fields: "id,name,state,kind,format",
    order: "name(asc)",
  });

  return reports.filter((r: any) =>
    r.kind === "fee_allocation" && r.state === "completed" && r.format === "csv"
  );
}


/**
 * Rows for a Fee Allocation tool, and an honest account of what they cover.
 *
 * These tools used to require start_date/end_date, read the LATEST scheduled
 * report regardless, and echo the requested dates back as the `period` — so the
 * output looked scoped to a period it wasn't. Now:
 *  - dates given, no report_id → a report is GENERATED for exactly that window
 *    (payment-date basis by default, same engine as get_monthly_fee_allocation);
 *  - report_id given → that report is used as-is and its own period is read back
 *    from Clio and reported; any dates passed are flagged as ignored.
 */
export async function loadFeeAllocationRows(p: {
  start_date?: string;
  end_date?: string;
  report_id?: number;
  basis?: "payment" | "issue";
}): Promise<{ rows: Record<string, string>[]; source: Record<string, unknown> }> {
  const basis = p.basis ?? "payment";
  if (p.report_id) {
    const { rows, report } = await getFeeAllocationCSV(p.report_id);
    let period: { start: string | null; end: string | null } = { start: null, end: null };
    try {
      const meta = await rawGetSingle(`/reports/${p.report_id}`, { fields: "id,start_date,end_date" });
      const m = meta?.data ?? meta;
      period = { start: m?.start_date ? String(m.start_date).slice(0, 10) : null, end: m?.end_date ? String(m.end_date).slice(0, 10) : null };
    } catch { /* period unknown; reported as null */ }
    return {
      rows,
      source: {
        kind: "existing_report",
        report: { id: report.id, name: report.name },
        period,
        ...(p.start_date || p.end_date
          ? { warning: "start_date/end_date were ignored because report_id was given; `period` is the report's own range." }
          : {}),
      },
    };
  }
  if (!p.start_date || !p.end_date) {
    throw new Error("Pass start_date and end_date (a report is generated for that window), or a report_id from list_fee_allocation_reports.");
  }
  const [y, mo] = p.start_date.split("-").map(Number);
  const rows = await genFeeAllocationByMonth(y, mo, {
    filterByPayment: basis !== "issue",
    startOverride: p.start_date,
    endOverride: p.end_date,
  });
  return {
    rows,
    source: {
      kind: "generated_report",
      basis,
      period: { start: p.start_date, end: p.end_date },
    },
  };
}

/**
 * Count working days (Mon-Fri) between two dates inclusive.
 */
function getWorkingDays(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  let count = 0;
  const current = new Date(startDate);
  while (current <= endDate) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

/**
 * Get ISO week number for a date.
 */
function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24));
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function registerPerformanceTools(server: McpServer): void {
  // get_user_productivity
  server.tool(
    "get_user_productivity",
    "Timekeeper productivity report: total hours, billed/unbilled split, top matters by hours per timekeeper",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      user_id: z
        .number()
        .optional()
        .describe("Filter to a specific user (all users if omitted)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          fields: TIME_FIELDS,
          created_since: `${params.start_date}T00:00:00+00:00`,
        };
        if (params.user_id) queryParams.user_id = params.user_id;

        let entries = await fetchAllPages<any>("/activities", queryParams);
        entries = entries.filter((e: any) => e.date >= params.start_date && e.date <= params.end_date);

        const byUser: Record<
          number,
          {
            name: string;
            total_hours: number;
            billed_hours: number;
            unbilled_hours: number;
            total_value: number;
            matterHours: Record<number, { matter: any; hours: number }>;
          }
        > = {};

        for (const e of entries) {
          const uid = e.user?.id ?? 0;
          if (!byUser[uid]) {
            byUser[uid] = {
              name: e.user?.name ?? "Unknown",
              total_hours: 0,
              billed_hours: 0,
              unbilled_hours: 0,
              total_value: 0,
              matterHours: {},
            };
          }
          const hours = (e.rounded_quantity || e.quantity) / 3600;
          const value = hours * (e.price || 0);
          byUser[uid].total_hours += hours;
          byUser[uid].total_value += value;
          if (e.billed) byUser[uid].billed_hours += hours;
          else byUser[uid].unbilled_hours += hours;

          const mid = e.matter?.id ?? 0;
          if (!byUser[uid].matterHours[mid]) {
            byUser[uid].matterHours[mid] = { matter: e.matter, hours: 0 };
          }
          byUser[uid].matterHours[mid].hours += hours;
        }

        const results = Object.entries(byUser)
          .map(([uid, u]) => {
            const topMatters = Object.values(u.matterHours)
              .sort((a, b) => b.hours - a.hours)
              .slice(0, 5)
              .map((m) => ({
                matter: m.matter,
                hours: Math.round(m.hours * 100) / 100,
              }));

            return {
              user_id: parseInt(uid, 10),
              name: u.name,
              total_hours: Math.round(u.total_hours * 100) / 100,
              billed_hours: Math.round(u.billed_hours * 100) / 100,
              unbilled_hours: Math.round(u.unbilled_hours * 100) / 100,
              total_value: Math.round(u.total_value * 100) / 100,
              top_5_matters: topMatters,
            };
          })
          .sort((a, b) => b.total_hours - a.total_hours);

        const firmTotals = {
          total_hours:
            Math.round(results.reduce((s, r) => s + r.total_hours, 0) * 100) / 100,
          billed_hours:
            Math.round(results.reduce((s, r) => s + r.billed_hours, 0) * 100) / 100,
          unbilled_hours:
            Math.round(results.reduce((s, r) => s + r.unbilled_hours, 0) * 100) / 100,
          total_value:
            Math.round(results.reduce((s, r) => s + r.total_value, 0) * 100) / 100,
          timekeeper_count: results.length,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: {
                    start: params.start_date,
                    end: params.end_date,
                  },
                  firm_totals: firmTotals,
                  timekeepers: results,
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

  // get_billable_target_report (formerly get_utilization_report — renamed because
  // this is NOT the dashboard's utilization metric: it measures billable hours vs a
  // daily TARGET (default 6.0 hrs/working day), not billable ÷ available hours
  // (1880/12), and it counts ALL time entries in the numerator, not just billable.
  // Comparable numbers to the dashboard's Utilization tab come from the weekly
  // goals sheets / dashboard, not this tool.)
  server.tool(
    "get_billable_target_report",
    "Hours worked vs a daily billable TARGET per timekeeper (default 6.0 hrs/working day). NOT the dashboard's utilization rate (billable ÷ available 1880-hr basis) — percentages here run higher and include all tracked time. Flags timekeepers below 80% of target. Includes weekly trend if period > 4 weeks.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      target_hours_per_day: z
        .number()
        .optional()
        .default(6.0)
        .describe("Target billable hours per working day (default 6.0)"),
    },
    async (params) => {
      try {
        let entries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: TIME_FIELDS,
          created_since: `${params.start_date}T00:00:00+00:00`,
        });
        entries = entries.filter((e: any) => e.date >= params.start_date && e.date <= params.end_date);

        const workingDays = getWorkingDays(params.start_date, params.end_date);
        const targetHours = workingDays * params.target_hours_per_day;

        // Check if period > 4 weeks for trend
        const startMs = new Date(params.start_date).getTime();
        const endMs = new Date(params.end_date).getTime();
        const periodWeeks = (endMs - startMs) / (1000 * 60 * 60 * 24 * 7);
        const showTrend = periodWeeks > 4;

        const byUser: Record<
          number,
          {
            name: string;
            billable_hours: number;
            weekly: Record<string, number>;
          }
        > = {};

        for (const e of entries) {
          const uid = e.user?.id ?? 0;
          if (!byUser[uid]) {
            byUser[uid] = {
              name: e.user?.name ?? "Unknown",
              billable_hours: 0,
              weekly: {},
            };
          }
          const hours = (e.rounded_quantity || e.quantity) / 3600;
          byUser[uid].billable_hours += hours;

          if (showTrend) {
            const wk = getWeekKey(e.date);
            byUser[uid].weekly[wk] = (byUser[uid].weekly[wk] || 0) + hours;
          }
        }

        const results = Object.entries(byUser)
          .map(([uid, u]) => {
            const avgPerDay =
              workingDays > 0 ? u.billable_hours / workingDays : 0;
            const pctOfTarget =
              targetHours > 0
                ? (u.billable_hours / targetHours) * 100
                : 0;
            const variance = u.billable_hours - targetHours;

            const result: any = {
              user_id: parseInt(uid, 10),
              name: u.name,
              total_billable_hours:
                Math.round(u.billable_hours * 100) / 100,
              working_days: workingDays,
              avg_hours_per_day: Math.round(avgPerDay * 100) / 100,
              target_hours_per_day: params.target_hours_per_day,
              pct_of_target: Math.round(pctOfTarget * 10) / 10,
              variance_from_target: Math.round(variance * 100) / 100,
              flag: pctOfTarget < 80 ? "BELOW_TARGET" : null,
            };

            if (showTrend) {
              result.weekly_breakdown = Object.entries(u.weekly)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([week, hrs]) => ({
                  week,
                  hours: Math.round(hrs * 100) / 100,
                }));
            }

            return result;
          })
          .sort((a, b) => b.pct_of_target - a.pct_of_target);

        const firmAvgPctOfTarget =
          results.length > 0
            ? Math.round(
                (results.reduce((s, r) => s + r.pct_of_target, 0) /
                  results.length) *
                  10
              ) / 10
            : 0;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: {
                    start: params.start_date,
                    end: params.end_date,
                    working_days: workingDays,
                    target_hours_per_day: params.target_hours_per_day,
                    total_target_hours: targetHours,
                  },
                  summary: {
                    firm_avg_pct_of_target: firmAvgPctOfTarget,
                    highest_performer: results[0]?.name ?? "N/A",
                    lowest_performer:
                      results[results.length - 1]?.name ?? "N/A",
                    timekeepers_below_target: results.filter(
                      (r) => r.flag === "BELOW_TARGET"
                    ).length,
                  },
                  timekeepers: results,
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

  // get_realization_rate
  server.tool(
    "get_realization_rate",
    "Realization rate: billed value / worked value, by timekeeper and/or matter. Shows where time is being written off. For billed vs collected per attorney use get_timekeeper_realization.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      group_by: z
        .enum(["timekeeper", "matter", "both"])
        .optional()
        .default("both")
        .describe("Group results by timekeeper, matter, or both"),
    },
    async (params) => {
      try {
        const [rawTimeEntries, rawBills] = await Promise.all([
          fetchAllPages<any>("/activities", {
            type: "TimeEntry",
            fields: TIME_FIELDS,
            created_since: `${params.start_date}T00:00:00+00:00`,
          }),
          fetchAllPages<any>("/bills", {
            fields:
              "id,number,issued_at,total,kind,state,matters",
            issued_after: params.start_date,
            issued_before: params.end_date,
          }),
        ]);
        const timeEntries = rawTimeEntries.filter((e: any) => e.date >= params.start_date && e.date <= params.end_date);
        // Realization compares FEE billings to worked value. Trust/retainer funding
        // requests (trust_kind) are advance deposits, not billed fees, and would
        // inflate billed value — count revenue_kind bills only.
        const bills = rawBills.filter((b: any) => b.kind === "revenue_kind");

        // Firm-wide worked value
        const totalWorkedValue = timeEntries.reduce(
          (s: number, e: any) => s + ((e.rounded_quantity || e.quantity) / 3600) * (e.price || 0),
          0
        );
        const totalBilledValue = bills.reduce(
          (s: number, b: any) => s + (b.total || 0),
          0
        );
        const firmRealization =
          totalWorkedValue > 0 ? totalBilledValue / totalWorkedValue : 0;

        const result: any = {
          period: { start: params.start_date, end: params.end_date },
          firm_summary: {
            total_worked_value:
              Math.round(totalWorkedValue * 100) / 100,
            total_billed_value:
              Math.round(totalBilledValue * 100) / 100,
            realization_rate_pct:
              Math.round(firmRealization * 1000) / 10,
            total_write_downs:
              Math.round((totalWorkedValue - totalBilledValue) * 100) / 100,
          },
        };

        // By timekeeper
        if (
          params.group_by === "timekeeper" ||
          params.group_by === "both"
        ) {
          const byUser: Record<
            number,
            { name: string; worked_hours: number; worked_value: number }
          > = {};

          for (const e of timeEntries) {
            const uid = e.user?.id ?? 0;
            if (!byUser[uid]) {
              byUser[uid] = {
                name: e.user?.name ?? "Unknown",
                worked_hours: 0,
                worked_value: 0,
              };
            }
            const hours = (e.rounded_quantity || e.quantity) / 3600;
            byUser[uid].worked_hours += hours;
            byUser[uid].worked_value += hours * (e.price || 0);
          }

          // Note: Clio bills are per-matter, not per-user. Billed value by timekeeper
          // would require line-item attribution. We approximate from time entries marked as billed.
          const billedByUser: Record<
            number,
            { billed_hours: number; billed_value: number }
          > = {};
          for (const e of timeEntries) {
            if (!e.billed) continue;
            const uid = e.user?.id ?? 0;
            if (!billedByUser[uid]) {
              billedByUser[uid] = { billed_hours: 0, billed_value: 0 };
            }
            const hours = (e.rounded_quantity || e.quantity) / 3600;
            billedByUser[uid].billed_hours += hours;
            billedByUser[uid].billed_value += hours * (e.price || 0);
          }

          result.by_timekeeper = Object.entries(byUser)
            .map(([uid, u]) => {
              const billed = billedByUser[parseInt(uid, 10)] ?? {
                billed_hours: 0,
                billed_value: 0,
              };
              const rate =
                u.worked_value > 0
                  ? billed.billed_value / u.worked_value
                  : 0;
              let flag: string | null = null;
              if (rate < 0.7) flag = "RED";
              else if (rate < 0.85) flag = "YELLOW";

              return {
                user_id: parseInt(uid, 10),
                name: u.name,
                worked_hours: Math.round(u.worked_hours * 100) / 100,
                worked_value: Math.round(u.worked_value * 100) / 100,
                billed_value:
                  Math.round(billed.billed_value * 100) / 100,
                realization_rate_pct: Math.round(rate * 1000) / 10,
                write_down_amount:
                  Math.round(
                    (u.worked_value - billed.billed_value) * 100
                  ) / 100,
                flag,
              };
            })
            .sort((a, b) => b.worked_value - a.worked_value);
        }

        // By matter
        if (params.group_by === "matter" || params.group_by === "both") {
          const byMatter: Record<
            number,
            {
              matter: any;
              worked_hours: number;
              worked_value: number;
            }
          > = {};

          for (const e of timeEntries) {
            const mid = e.matter?.id ?? 0;
            if (!byMatter[mid]) {
              byMatter[mid] = {
                matter: e.matter,
                worked_hours: 0,
                worked_value: 0,
              };
            }
            const hours = (e.rounded_quantity || e.quantity) / 3600;
            byMatter[mid].worked_hours += hours;
            byMatter[mid].worked_value += hours * (e.price || 0);
          }

          const billedByMatter: Record<number, number> = {};
          for (const b of bills) {
            const mid = b.matters?.[0]?.id ?? 0;
            billedByMatter[mid] = (billedByMatter[mid] || 0) + (b.total || 0);
          }

          result.by_matter = Object.entries(byMatter)
            .map(([mid, m]) => {
              const billed = billedByMatter[parseInt(mid, 10)] ?? 0;
              const rate =
                m.worked_value > 0 ? billed / m.worked_value : 0;
              let flag: string | null = null;
              if (rate < 0.7) flag = "RED";
              else if (rate < 0.85) flag = "YELLOW";

              return {
                matter_id: parseInt(mid, 10),
                matter: m.matter,
                worked_hours: Math.round(m.worked_hours * 100) / 100,
                worked_value: Math.round(m.worked_value * 100) / 100,
                billed_value: Math.round(billed * 100) / 100,
                realization_rate_pct: Math.round(rate * 1000) / 10,
                write_down_amount:
                  Math.round((m.worked_value - billed) * 100) / 100,
                flag,
              };
            })
            .sort((a, b) => b.worked_value - a.worked_value);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
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

  // get_timekeeper_realization
  server.tool(
    "get_timekeeper_realization",
    "Deep per-attorney breakdown: worked, billed, collected, effective hourly rate. Associate management report. Supports monthly or yearly breakdowns. Requires user_id for per-timekeeper detail.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID (required)"),
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      breakdown: z
        .enum(["none", "monthly", "yearly"])
        .optional()
        .default("none")
        .describe("Break results into monthly or yearly periods"),
    },
    async (params) => {
      try {
        // Only fetch this user's time entries — no bills needed
        const rawEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: TIME_FIELDS,
          user_id: params.user_id,
          created_since: `${params.start_date}T00:00:00+00:00`,
        });
        const entries = rawEntries.filter(
          (e: any) => e.date >= params.start_date && e.date <= params.end_date
        );

        // Compute realization from time entries alone (billed flag = was it invoiced)
        function computeStats(items: any[]) {
          let worked_hours = 0, worked_value = 0, billed_hours = 0, billed_value = 0;
          let standard_rate = 0;

          for (const e of items) {
            const hours = (e.rounded_quantity || e.quantity) / 3600;
            const value = hours * (e.price || 0);
            worked_hours += hours;
            worked_value += value;
            if (e.price && e.price > standard_rate) standard_rate = e.price;
            if (e.billed) {
              billed_hours += hours;
              billed_value += value;
            }
          }

          const realizationPct = worked_value > 0 ? (billed_value / worked_value) * 100 : 0;

          return {
            standard_rate,
            worked_hours: Math.round(worked_hours * 100) / 100,
            worked_value: Math.round(worked_value * 100) / 100,
            billed_hours: Math.round(billed_hours * 100) / 100,
            billed_value: Math.round(billed_value * 100) / 100,
            unbilled_hours: Math.round((worked_hours - billed_hours) * 100) / 100,
            unbilled_value: Math.round((worked_value - billed_value) * 100) / 100,
            realization_pct: Math.round(realizationPct * 10) / 10,
          };
        }

        function periodKey(dateStr: string): string {
          if (params.breakdown === "monthly") return dateStr.slice(0, 7);
          if (params.breakdown === "yearly") return dateStr.slice(0, 4);
          return "total";
        }

        if (params.breakdown === "none") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                period: { start: params.start_date, end: params.end_date },
                ...computeStats(entries),
              }, null, 2),
            }],
          };
        }

        // Group by period
        const buckets: Record<string, any[]> = {};
        for (const e of entries) {
          const key = periodKey(e.date);
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(e);
        }

        const periods = Object.keys(buckets).sort().map((key) => ({
          period: key,
          ...computeStats(buckets[key]),
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              date_range: { start: params.start_date, end: params.end_date },
              breakdown: params.breakdown,
              overall: computeStats(entries),
              periods,
            }, null, 2),
          }],
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

  // list_fee_allocation_reports
  server.tool(
    "list_fee_allocation_reports",
    "List all completed Fee Allocation Reports in Clio with their IDs and names. Pass a report ID to get_fee_allocation or get_responsible_collections to read that report as-is instead of generating one for a date range; get_attributable_collections reads the latest report unless given one.",
    {},
    async () => {
      try {
        const reports = await listFeeAllocationReports();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: reports.length,
              reports: reports
                .sort((a: any, b: any) => b.id - a.id)
                .map((r: any) => ({ id: r.id, name: r.name, state: r.state, format: r.format })),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // get_fee_allocation
  server.tool(
    "get_fee_allocation",
    "USE FOR: who gets credit for money collected (or billed) in a date range, per timekeeper, from Clio's own Fee Allocation Report. Generates a report for exactly start_date..end_date: basis='payment' (default) = money received in the window; basis='issue' = time on invoices issued in the window. Pass report_id instead to read an existing report as-is (its own period is reported). Optional user_name filter. For one month use get_monthly_fee_allocation; for per-invoice rows use get_fee_allocation_detail; for roll-up by responsible attorney use get_responsible_collections; for what one client paid use get_payments.",
    {
      start_date: z.string().optional().describe("Start of the window (YYYY-MM-DD). Required unless report_id is given."),
      end_date: z.string().optional().describe("End of the window (YYYY-MM-DD). Required unless report_id is given."),
      basis: z.enum(["payment", "issue"]).optional().default("payment").describe("payment = money received in the window (default); issue = time on invoices issued in the window"),
      user_name: z.string().optional().describe("Filter by timekeeper name (partial match)"),
      report_id: z.coerce.number().optional().describe("Read this existing report (from list_fee_allocation_reports) instead of generating one; dates are then ignored."),
    },
    async (params) => {
      try {
        const { rows, source } = await loadFeeAllocationRows(params);

        const filtered = params.user_name
          ? rows.filter((r) => (r["User"] ?? "").toLowerCase().includes(params.user_name!.toLowerCase()))
          : rows;

        // Aggregate by user
        const userTotals: Record<string, {
          billed_hours: number;
          billed_time: number;
          time_collected: number;
          time_outstanding: number;
          expense_collected: number;
          expense_outstanding: number;
          total_collected: number;
          total_outstanding: number;
          invoice_count: number;
        }> = {};

        for (const r of filtered) {
          const user = r["User"] ?? "Unknown";
          if (params.user_name && !user.toLowerCase().includes(params.user_name.toLowerCase())) continue;

          if (!userTotals[user]) {
            userTotals[user] = {
              billed_hours: 0, billed_time: 0,
              time_collected: 0, time_outstanding: 0,
              expense_collected: 0, expense_outstanding: 0,
              total_collected: 0, total_outstanding: 0,
              invoice_count: 0,
            };
          }
          const u = userTotals[user];
          u.billed_hours += parseFloat(r["Billed Hours"] || "0");
          u.billed_time += parseFloat(r["Billed Time"] || "0");
          u.time_collected += parseFloat(r["Billed Time Collected"] || "0");
          u.time_outstanding += parseFloat(r["Billed Time Outstanding"] || "0");
          u.expense_collected += parseFloat(r["Expense Amount Collected"] || "0");
          u.expense_outstanding += parseFloat(r["Expense Amount Outstanding"] || "0");
          u.total_collected += parseFloat(r["Total Funds Collected"] || "0");
          u.total_outstanding += parseFloat(r["Total Funds Outstanding"] || "0");
          u.invoice_count++;
        }

        const results = Object.entries(userTotals).map(([name, u]) => ({
          name,
          billed_hours: Math.round(u.billed_hours * 100) / 100,
          billed_time_value: Math.round(u.billed_time * 100) / 100,
          time_collected: Math.round(u.time_collected * 100) / 100,
          time_outstanding: Math.round(u.time_outstanding * 100) / 100,
          expense_collected: Math.round(u.expense_collected * 100) / 100,
          total_collected: Math.round(u.total_collected * 100) / 100,
          total_outstanding: Math.round(u.total_outstanding * 100) / 100,
          invoices: u.invoice_count,
        })).sort((a, b) => b.total_collected - a.total_collected);

        const firmTotal = Math.round(results.reduce((s, r) => s + r.total_collected, 0) * 100) / 100;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: "Clio Fee Allocation Report",
              ...source,
              total_collected: firmTotal,
              rows_in_report: rows.length,
              rows_in_period: filtered.length,
              timekeeper_count: results.length,
              timekeepers: results,
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
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // get_monthly_fee_allocation
  // Unlike get_fee_allocation (which reads the latest CUMULATIVE scheduled report and
  // ignores the date range), this GENERATES a fresh Fee Allocation report scoped to a
  // single month, so per-month numbers are real. Built for reconciling month-specific
  // collections (e.g. a payment-date boundary) — wraps the same genFeeAllocationByMonth
  // the dashboard uses for its collections/billed columns.
  server.tool(
    "get_monthly_fee_allocation",
    "Per-month Fee Allocation by timekeeper from a FRESHLY GENERATED report scoped to ONE calendar month (for an arbitrary date range use get_fee_allocation, which now generates a report for exactly that window). basis='payment' (default) = money RECEIVED that month (payment date); basis='issue' = time BILLED on invoices issued that month (issue date). Returns per-timekeeper collected, billed $, and billed hours.",
    {
      year: z.coerce.number().describe("Year, e.g. 2026"),
      month: z.coerce.number().describe("Month, 1-12"),
      basis: z.enum(["payment", "issue"]).optional().default("payment").describe("payment = received that month; issue = billed on invoices issued that month"),
      user_name: z.string().optional().describe("Filter to a timekeeper by partial name match"),
    },
    async (params) => {
      try {
        const rows = await genFeeAllocationByMonth(params.year, params.month, { filterByPayment: params.basis !== "issue" });
        const filtered = params.user_name
          ? rows.filter((r) => (r["User"] ?? "").toLowerCase().includes(params.user_name!.toLowerCase()))
          : rows;
        const num = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;
        const totals: Record<string, { billed_hours: number; billed_time: number; time_collected: number; total_collected: number; invoices: number }> = {};
        for (const r of filtered) {
          const user = r["User"] ?? "Unknown";
          const u = (totals[user] ??= { billed_hours: 0, billed_time: 0, time_collected: 0, total_collected: 0, invoices: 0 });
          u.billed_hours += num(r["Billed Hours"]);
          u.billed_time += num(r["Billed Time"]);
          u.time_collected += num(r["Billed Time Collected"]);
          u.total_collected += num(r["Total Funds Collected"]);
          u.invoices++;
        }
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const timekeepers = Object.entries(totals)
          .map(([name, u]) => ({
            name,
            billed_hours: round2(u.billed_hours),
            billed_time_value: round2(u.billed_time),
            time_collected: round2(u.time_collected),
            total_collected: round2(u.total_collected),
            invoices: u.invoices,
          }))
          .sort((a, b) => (params.basis === "issue" ? b.billed_time_value - a.billed_time_value : b.total_collected - a.total_collected));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: `Clio Fee Allocation Report (freshly generated, ${params.basis === "issue" ? "issue-date" : "payment-date"} basis)`,
              basis: params.basis ?? "payment",
              period: { year: params.year, month: params.month },
              rows_in_period: filtered.length,
              firm_time_collected: round2(timekeepers.reduce((s, t) => s + t.time_collected, 0)),
              firm_total_collected: round2(timekeepers.reduce((s, t) => s + t.total_collected, 0)),
              firm_billed_time: round2(timekeepers.reduce((s, t) => s + t.billed_time_value, 0)),
              timekeeper_count: timekeepers.length,
              timekeepers,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }], isError: true };
      }
    }
  );

  // get_fee_allocation_detail
  // The ROW-LEVEL companion to get_monthly_fee_allocation. That tool collapses the
  // Fee Allocation Report into per-timekeeper totals; this one returns the underlying
  // rows VERBATIM — one row per (timekeeper × invoice) — so the report can be diffed
  // line-by-line against an external source (e.g. the Box fee-allocation workbook) to
  // find exactly which invoices are present/missing/off. Same freshly-generated,
  // single-month report as get_monthly_fee_allocation (basis='payment' = money received
  // that month by payment date; basis='issue' = time billed on invoices issued that
  // month). The full CSV column set is returned untouched (invoice number, matter,
  // responsible/originating attorney, issue date, etc.) plus summed totals for the
  // numeric columns so a reconciliation total is available without re-summing.
  server.tool(
    "get_fee_allocation_detail",
    "Row-level Fee Allocation Report for ONE month — the per-invoice detail behind get_monthly_fee_allocation (which only returns per-timekeeper totals). Each row is one timekeeper's allocation on one invoice, returned VERBATIM with every CSV column (invoice number, matter, User, Responsible/Originating Attorney, Billed Hours, Billed Time, Billed Time Collected, Total Funds Collected, Issue Date). Use this to reconcile the report line-by-line against an external file and find which invoices are missing or off. basis='payment' (default) = money RECEIVED that month (payment date); basis='issue' = time BILLED on invoices issued that month (issue date). Optionally filter to one timekeeper by partial name match.",
    {
      year: z.coerce.number().describe("Year, e.g. 2026"),
      month: z.coerce.number().describe("Month, 1-12"),
      basis: z.enum(["payment", "issue"]).optional().default("payment").describe("payment = received that month; issue = billed on invoices issued that month"),
      user_name: z.string().optional().describe("Filter to a timekeeper by partial name match (matches the report's 'User' column)"),
    },
    async (params) => {
      try {
        const rows = await genFeeAllocationByMonth(params.year, params.month, { filterByPayment: params.basis !== "issue" });
        const filtered = params.user_name
          ? rows.filter((r) => (r["User"] ?? "").toLowerCase().includes(params.user_name!.toLowerCase()))
          : rows;
        const columns = rows.length ? Object.keys(rows[0]) : [];
        // Sum every column that parses as a number (currency/parenthesized-negative
        // aware) so a reconciliation control total is available for each numeric column
        // without the caller re-summing. Non-numeric columns are simply absent here.
        const num = (x: string | undefined) => parseFloat((x ?? "").replace(/[$,()]/g, "")) || 0;
        const isNumeric = (x: string | undefined) => x != null && x.trim() !== "" && /^[-(]?\$?[\d,]+(\.\d+)?\)?$/.test(x.trim());
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const column_totals: Record<string, number> = {};
        for (const col of columns) {
          let any = false, sum = 0;
          for (const r of filtered) {
            if (isNumeric(r[col])) { any = true; sum += num(r[col]); }
          }
          if (any) column_totals[col] = round2(sum);
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: `Clio Fee Allocation Report (freshly generated, ${params.basis === "issue" ? "issue-date" : "payment-date"} basis)`,
              basis: params.basis ?? "payment",
              period: { year: params.year, month: params.month },
              user_name_filter: params.user_name ?? null,
              columns,
              row_count: filtered.length,
              column_totals,
              rows: filtered,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }], isError: true };
      }
    }
  );

  // get_monthly_revenue
  // Generates a fresh classic Revenue Report scoped to ONE timekeeper + month and returns
  // the write-offs (Credit Notes) vs line-discounts (Discounted Time) split — the source
  // of the dashboard's col L/M. Built for reconciling write-off divergences (whether an
  // amount is a credit note / write-off vs a line-level discount).
  server.tool(
    "get_monthly_revenue",
    "Per-month classic Revenue Report for ONE timekeeper: billed $, billable hours, write-offs (Credit Notes) and line discounts (Discounted Time). This is the source of the dashboard's Write-offs (col L) and Discounts (col M). Use to reconcile a write-off divergence (credit-note vs line-discount classification). Scoped to a single user to stay fast.",
    {
      year: z.coerce.number().describe("Year, e.g. 2026"),
      month: z.coerce.number().describe("Month, 1-12"),
      user_id: z.coerce.number().describe("Timekeeper user ID (required)"),
    },
    async (params) => {
      try {
        const monthStart = `${params.year}-${String(params.month).padStart(2, "0")}-01`;
        const endDay = new Date(params.year, params.month, 0).getDate();
        const monthEnd = `${params.year}-${String(params.month).padStart(2, "0")}-${endDay}`;
        const gen = await rawPostSingle("/reports", { data: { kind: "revenue", format: "csv", start_date: monthStart, end_date: monthEnd, user: { id: params.user_id } } });
        const rep = gen?.data ?? gen;
        const rid = rep?.id;
        let state = rep?.state;
        const deadline = Date.now() + 150000;
        while (rid && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4000));
          try { const s = await rawGetSingle(`/reports/${rid}`, { fields: "id,state" }); state = (s?.data ?? s)?.state; }
          catch { /* transient — keep polling */ }
        }
        if (state !== "completed") throw new Error(`revenue report ${rid} did not complete (state=${state})`);
        await assertReportPeriod(rid, monthStart, `revenue report (user ${params.user_id})`);
        const rows = parseCSV(await downloadReport(rid));
        const num = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;
        let billedDollars = 0, billedHours = 0, unbilledHours = 0, writeOffs = 0, lineDiscounts = 0;
        const matters: Array<{ matter: string; billed_time: number; credit_notes: number; discounted_time: number }> = [];
        for (const row of rows) {
          if (!row["Matter Number"]) continue; // skip TOTAL row
          const bt = num(row["Billed Time"]), cn = num(row["Credit Notes"]), dt = num(row["Discounted Time"]);
          billedDollars += bt;
          billedHours += num(row["Billed Hours"]);
          unbilledHours += num(row["Unbilled Hours"]);
          writeOffs += cn;
          lineDiscounts += dt;
          if (cn || dt) matters.push({ matter: `${row["Matter Number"]} ${row["Matter Description"] ?? ""}`.trim(), billed_time: Math.round(bt * 100) / 100, credit_notes: Math.round(cn * 100) / 100, discounted_time: Math.round(dt * 100) / 100 });
        }
        const round2 = (n: number) => Math.round(n * 100) / 100;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: "Clio classic Revenue Report (freshly generated, activity-month basis)",
              period: { year: params.year, month: params.month },
              user_id: params.user_id,
              billed_dollars: round2(billedDollars),
              billable_hours: round2(billedHours + unbilledHours),
              billed_hours: round2(billedHours),
              unbilled_hours: round2(unbilledHours),
              write_offs_credit_notes: round2(writeOffs),
              line_discounts_discounted_time: round2(lineDiscounts),
              matters_with_writeoff_or_discount: matters,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }], isError: true };
      }
    }
  );

  // get_responsible_collections
  server.tool(
    "get_responsible_collections",
    "USE FOR: money collected in a date range rolled up to the responsible attorney on each matter, with the timekeepers under each. Generates a Fee Allocation Report for exactly start_date..end_date on a payment-date basis (money received in the window); pass report_id instead to read an existing report as-is. The monthly breakdown buckets by invoice ISSUE date, as the report rows carry no payment date. For per-timekeeper credit use get_fee_allocation.",
    {
      start_date: z.string().optional().describe("Start of the window (YYYY-MM-DD). Required unless report_id is given."),
      end_date: z.string().optional().describe("End of the window (YYYY-MM-DD). Required unless report_id is given."),
      report_id: z.coerce.number().optional().describe("Read this existing report (from list_fee_allocation_reports) instead of generating one; dates are then ignored."),
      breakdown: z
        .enum(["none", "monthly"])
        .optional()
        .default("none")
        .describe("Break results into monthly periods"),
    },
    async (params) => {
      try {
        const { rows, source } = await loadFeeAllocationRows(params);
        const filtered = rows;

        // Helper to get period key
        function getPeriodKey(issueDate: string): string {
          if (params.breakdown !== "monthly") return "total";
          const parts = issueDate.split("/");
          return `${parts[2]}-${parts[0].padStart(2, "0")}`;
        }

        // Roll up by responsible attorney
        const rollup: Record<string, {
          periods: Record<string, number>;
          timekeepers: Record<string, number>;
        }> = {};

        for (const r of filtered) {
          const responsible = r["Responsible Attorney"] ?? "Unknown";
          const user = r["User"] ?? "Unknown";
          const collected = parseFloat(r["Total Funds Collected"] || "0");
          const period = getPeriodKey(r["Issue Date"]);

          if (!rollup[responsible]) rollup[responsible] = { periods: {}, timekeepers: {} };
          rollup[responsible].periods[period] = (rollup[responsible].periods[period] || 0) + collected;
          rollup[responsible].timekeepers[user] = (rollup[responsible].timekeepers[user] || 0) + collected;
        }

        const results = Object.entries(rollup).map(([name, data]) => {
          const totalCollections = Object.values(data.periods).reduce((s, v) => s + v, 0);

          const result: any = {
            responsible_attorney: name,
            total_responsible_collections: Math.round(totalCollections * 100) / 100,
            timekeepers: Object.entries(data.timekeepers)
              .map(([tk, amt]) => ({ name: tk, collected: Math.round(amt * 100) / 100 }))
              .sort((a, b) => b.collected - a.collected),
          };

          if (params.breakdown === "monthly") {
            result.monthly = Object.entries(data.periods)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([period, amount]) => ({
                period,
                collections: Math.round(amount * 100) / 100,
              }));
          }

          return result;
        }).sort((a, b) => b.total_responsible_collections - a.total_responsible_collections);

        const firmTotal = Math.round(results.reduce((s, r) => s + r.total_responsible_collections, 0) * 100) / 100;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: "Clio Fee Allocation Report",
              ...source,
              firm_total_collections: firmTotal,
              rows_in_period: filtered.length,
              responsible_attorneys: results,
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
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
