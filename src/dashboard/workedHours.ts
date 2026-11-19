// ============================================================
// Worked-hours builder for 26 Compare "Billable Hours" (col I) / "TNB" (col H).
//
// Col I = ALL billable hours WORKED in the month, by activity/work date, billed or
// not — a TIME-ENTRY query (the firm's definition), NOT the Revenue Report's
// "Billed Hours + Unbilled Hours". The Revenue Report's Billed Hours is invoice/
// issue-date based, so it counts prior-month work billed this month and, added to
// current WIP, OVERCOUNTS hours actually worked in the month. Verified against the
// firm's reference dashboard for March 2026:
//   NRN: time-entry worked 210.6 ≈ reference 212.0   (Revenue Report said 262.6)
//   PAR: time-entry worked 250.4 ≈ reference 250.0   (Revenue Report said 291.2)
//
// Billable vs nonbillable uses the SAME two-basis decision as the weekly goal
// sheets (classifiedHours.ts): Clio's entry-level non_billable flag, PLUS the
// firm-internal reclassification when `excludeInternal` is set (the default) —
// a billable-flagged entry whose matter's client is the firm itself, or which
// carries rate 0 AND amount 0, moves to nonbillable. Matter names, numbers,
// types and practice areas are still never consulted.
//
// Both bases come back from one pull: `billable`/`nonbillable` are the ADJUSTED
// figures col I and col H are written from, and `billableRaw`/`nonbillableRaw`
// are the flag-only figures, kept so a run can log exactly how much the
// adjustment moved. Real worked time on contingency/flat-fee matters that
// carries a rate IS still billable (the reference includes it — e.g. PAR's 48.4h
// on the Teachworth contingency matter are in his 250.0). Only Rachel's
// synthetic 1-hour fee-placeholder entries are backed out, and that happens
// separately via buildExcludedHoursByMonth (see excludedHours.ts).
// ============================================================
import { fetchAllPages } from "../clio/pagination";
import { buildMatterClientMap, internalReasonFor, isNonBillableEntry } from "./classifiedHours";
import type { RosterMember } from "../domain/roster";

// month (1-12) -> user_id -> hours worked that month (activity/work date)
export type WorkedHoursByMonth = Record<number, Record<number, number>>;

// Parallel views from a single /activities pull. billable + nonbillable == total
// by construction, and so does the raw pair — the internal adjustment MOVES
// hours between the two buckets, it never drops them, so `total` is identical on
// both bases and the Utilization tab's Untracked column can't drift.
//   total          = ALL worked time entries, by work date — the figure a manual
//                    Activities search / get_user_productivity shows (col J basis).
//   billable       = ADJUSTED billable (col I basis, before the fee-placeholder
//                    exclusion is backed out).
//   nonbillable    = ADJUSTED nonbillable (col H), including reclassified internal time.
//   billableRaw    = flag-only billable (non_billable === false).
//   nonbillableRaw = flag-only nonbillable (non_billable === true).
//   internal       = hours the adjustment moved: billableRaw − billable.
export type WorkedHoursSplit = {
  total: WorkedHoursByMonth;
  billable: WorkedHoursByMonth;
  nonbillable: WorkedHoursByMonth;
  billableRaw: WorkedHoursByMonth;
  nonbillableRaw: WorkedHoursByMonth;
  internal: WorkedHoursByMonth;
};

/**
 * Worked hours by month×user for months 1..`month`, summed from /activities TimeEntry
 * rows by their work date (rounded_quantity, the billed-increment hours). One pull per
 * roster member (scoped by user_id), plus one bulk /matters pull for the client map
 * when the internal adjustment is on. Returns the total plus both
 * billable/nonbillable partitions in a single pass.
 */
export async function buildWorkedHoursSplitByMonth(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[]; excludeInternal?: boolean; retryDelayMs?: number } = {},
): Promise<WorkedHoursSplit> {
  const months = new Set(opts.months ?? Array.from({ length: month }, (_, i) => i + 1));
  const maxMonth = Math.max(...months);
  const monthEnd = `${year}-${String(maxMonth).padStart(2, "0")}-${String(new Date(year, maxMonth, 0).getDate()).padStart(2, "0")}`;
  const excludeInternal = opts.excludeInternal !== false;

  const clientByMatter = excludeInternal ? await buildMatterClientMap() : undefined;

  const total: WorkedHoursByMonth = {};
  const billable: WorkedHoursByMonth = {};
  const nonbillable: WorkedHoursByMonth = {};
  const billableRaw: WorkedHoursByMonth = {};
  const nonbillableRaw: WorkedHoursByMonth = {};
  const internal: WorkedHoursByMonth = {};
  const bump = (b: WorkedHoursByMonth, m: number, uid: number, hrs: number) => {
    (b[m] ??= {})[uid] = (b[m][uid] ?? 0) + hrs;
  };

  for (const r of roster) {
    // A failed pull must NOT be skipped. It used to `continue`, which wrote
    // 0 billable / 0 nonbillable for that person into 26 Compare's FROZEN
    // monthly snapshot while the run still reported success — PAR's September
    // 2026 sat at 0/0 (he worked 259.6 hrs) until a manual re-run. Retry
    // transient failures, then fail the whole run: an aborted run writes
    // nothing and can simply be re-run; a silent zero persists.
    const acts = await pullWithRetry(() => fetchAllPages<any>("/activities", {
      type: "TimeEntry",
      // price/total/matter{id} feed the internal reclassification only — the
      // flag still decides the raw split.
      fields: "id,date,quantity,rounded_quantity,price,total,non_billable,matter{id},user{id}",
      user_id: r.user_id,
      created_since: `${year}-01-01T00:00:00+00:00`,
    }), r.initials, opts.retryDelayMs ?? 3000);
    for (const a of acts) {
      if (a.date < `${year}-01-01` || a.date > monthEnd) continue;
      const m = parseInt(String(a.date).slice(5, 7), 10);
      if (!m || !months.has(m)) continue;
      const hrs = (a.rounded_quantity ?? a.quantity ?? 0) / 3600;
      bump(total, m, r.user_id, hrs);

      const flaggedNonBillable = isNonBillableEntry(a.non_billable);
      bump(flaggedNonBillable ? nonbillableRaw : billableRaw, m, r.user_id, hrs);

      const matterId = a.matter?.id;
      const reason = !flaggedNonBillable && excludeInternal
        ? internalReasonFor({
            rate: Number(a.price) || 0,
            amount: Number(a.total) || 0,
            clientId: matterId !== undefined ? clientByMatter?.get(matterId) : undefined,
            nonBillableFlag: false,
          })
        : undefined;
      bump(flaggedNonBillable || reason ? nonbillable : billable, m, r.user_id, hrs);
      if (reason) bump(internal, m, r.user_id, hrs);
    }
  }
  return { total, billable, nonbillable, billableRaw, nonbillableRaw, internal };
}

/** Attempts per timekeeper before the worked-hours pull fails the run. */
export const WORKED_HOURS_PULL_ATTEMPTS = 3;

/**
 * Run one timekeeper's /activities pull, retrying with linear backoff. Throws
 * after the last attempt, naming the timekeeper, so the dashboard job errors
 * out instead of writing zeros.
 */
export async function pullWithRetry<T>(pull: () => Promise<T>, initials: string, delayMs: number): Promise<T> {
  let last: any;
  for (let attempt = 1; attempt <= WORKED_HOURS_PULL_ATTEMPTS; attempt++) {
    try {
      return await pull();
    } catch (e: any) {
      last = e;
      console.warn(`[Dashboard] worked-hours pull failed for ${initials} (attempt ${attempt}/${WORKED_HOURS_PULL_ATTEMPTS}): ${e?.message ?? e}`);
      if (attempt < WORKED_HOURS_PULL_ATTEMPTS) await new Promise((res) => setTimeout(res, delayMs * attempt));
    }
  }
  throw new Error(`worked-hours pull failed for ${initials} after ${WORKED_HOURS_PULL_ATTEMPTS} attempts (${last?.message ?? last}); nothing was written — re-run the dashboard update`);
}

/**
 * Adjusted billable-hours view (col I basis). Retained for backward
 * compatibility; delegates to buildWorkedHoursSplitByMonth.
 */
export async function buildWorkedBillableHoursByMonth(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[]; excludeInternal?: boolean } = {},
): Promise<WorkedHoursByMonth> {
  return (await buildWorkedHoursSplitByMonth(year, month, roster, opts)).billable;
}
