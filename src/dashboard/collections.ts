// ============================================================
// Dashboard collections builder (extracted from download_dashboard_update).
// Pure data assembly — no workbook mutation — so it's unit-testable and lives in
// the CI-typechecked lib layer.
// ============================================================
import { genFeeAllocationByMonth, matchRosterUser, matchRosterResponsible } from "../clio/reportCsv";
import type { RosterMember } from "../domain/roster";

export type MonthlyCollections = {
  // month (1-12) -> user_id -> collected fees $ (individual, by working timekeeper → col N "Collected Actual")
  indivByMonth: Record<number, Record<number, number>>;
  // month (1-12) -> ORIGINATING-attorney user_id -> collected fees $ (→ col V "Originating")
  origByMonth: Record<number, Record<number, number>>;
  // month (1-12) -> responsible-attorney user_id -> collected fees $ (→ col S "Collected Actual")
  respByMonth: Record<number, Record<number, number>>;
  // month -> collected fees $ from billers NOT on the roster (→ the "NRB" line, col N)
  nonRosterIndivByMonth: Record<number, number>;
  // month -> collected fees $ originated by attorneys NOT on the roster (→ the "NRB" line, col V)
  nonRosterOrigByMonth: Record<number, number>;
  // month -> collected fees $ whose responsible attorney is NOT on the roster (→ the "NRB" line, col S)
  nonRosterRespByMonth: Record<number, number>;
  // month -> working-timekeeper user_id -> responsible-attorney user_id (0 = not on
  // the roster) -> collected fees $. Lets the bonus route one person's collections
  // by matter (see BONUS_MATTER_SPLITS in bonus.ts).
  indivRespByMonth: Record<number, Record<number, Record<number, number>>>;
  // month -> firm-wide collected fees $ (reconciliation target: Σ col N == Σ col S == Σ col V == this)
  firmByMonth: Record<number, number>;
  // firm-wide YTD total collected fees (reconciliation signal)
  firmYtd: number;
};

const collNum = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;

export type MonthFeeAgg = {
  indiv: Record<number, number>;        // working timekeeper (col N) → fees
  orig: Record<number, number>;         // originating attorney (col V) → fees
  resp: Record<number, number>;         // responsible attorney (col S) → fees
  nonRosterIndiv: number;               // fees by non-roster working timekeepers (→ NRB col N)
  nonRosterOrig: number;                // fees originated by non-roster attorneys (→ NRB col V)
  nonRosterResp: number;                // fees under non-roster responsible attorneys (→ NRB col S)
  indivResp: Record<number, Record<number, number>>; // working timekeeper → responsible attorney (0 = non-roster) → fees
  firm: number;                         // firm-wide fees collected (Σ indiv+NRB == Σ orig+NRB == Σ resp+NRB == this)
};

/**
 * Pure aggregation of ONE month's Fee Allocation rows into the FEES-ONLY collections
 * splits used by 26 Compare. Uses "Billed Time Collected" (excludes collected
 * expenses / interest / tax). Non-roster timekeepers, non-roster originating
 * attorneys, and non-roster responsible attorneys are pooled so
 * Σ col N (+NRB) == Σ col V (+NRB) == Σ col S (+NRB) == firm fees.
 */
export function aggregateMonthFees(rows: Record<string, string>[], roster: RosterMember[]): MonthFeeAgg {
  const agg: MonthFeeAgg = { indiv: {}, orig: {}, resp: {}, nonRosterIndiv: 0, nonRosterOrig: 0, nonRosterResp: 0, indivResp: {}, firm: 0 };
  for (const r of rows) {
    const collected = collNum(r["Billed Time Collected"]);
    if (!collected) continue;
    agg.firm += collected;
    const uid = matchRosterUser(r["User"] || "", roster);
    if (uid != null) agg.indiv[uid] = (agg.indiv[uid] ?? 0) + collected;
    else agg.nonRosterIndiv += collected;
    const oid = matchRosterResponsible(r["Originating Attorney"] || "", roster);
    if (oid != null) agg.orig[oid] = (agg.orig[oid] ?? 0) + collected;
    else agg.nonRosterOrig += collected;
    const rid = matchRosterResponsible(r["Responsible Attorney"] || "", roster);
    if (rid != null) agg.resp[rid] = (agg.resp[rid] ?? 0) + collected;
    else agg.nonRosterResp += collected;
    if (uid != null) {
      const byResp = (agg.indivResp[uid] ??= {});
      byResp[rid ?? 0] = (byResp[rid ?? 0] ?? 0) + collected;
    }
  }
  return agg;
}

/**
 * Build per-month collections on the PAYMENT-RECEIVED basis: one payment-filtered
 * Fee Allocation report per month (Jan..month) = money actually received that
 * month. FEES ONLY: uses "Billed Time Collected" (not "Total Funds Collected",
 * which also includes collected expense reimbursements + interest + tax — the cause
 * of the dashboard running slightly higher than Rachel's). Allocated by:
 *   - working timekeeper  → col N "Collected Actual"
 *   - Originating Attorney → col V "Originating"
 *   - Responsible Attorney → col S "Collected Actual"
 * Collected fees whose timekeeper / originating attorney / responsible attorney is
 * NOT on the roster are summed into nonRoster*ByMonth (the "NRB" line), so
 * Σ col N == Σ col V == Σ col S == firm fees by construction. Each report's
 * period is guarded inside
 * genFeeAllocationByMonth (assertReportPeriod), so a wrong-period report aborts.
 */
export async function buildMonthlyCollections(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[] } = {},
): Promise<MonthlyCollections> {
  const months = opts.months ?? Array.from({ length: month }, (_, i) => i + 1);
  const indivByMonth: Record<number, Record<number, number>> = {};
  const origByMonth: Record<number, Record<number, number>> = {};
  const respByMonth: Record<number, Record<number, number>> = {};
  const nonRosterIndivByMonth: Record<number, number> = {};
  const nonRosterOrigByMonth: Record<number, number> = {};
  const nonRosterRespByMonth: Record<number, number> = {};
  const indivRespByMonth: Record<number, Record<number, Record<number, number>>> = {};
  const firmByMonth: Record<number, number> = {};
  let firmYtd = 0;
  for (const m of months) {
    let feeRows: Record<string, string>[] = [];
    try { feeRows = await genFeeAllocationByMonth(year, m); }
    catch (e: any) { console.warn(`[Dashboard] payment-filtered fee allocation failed for ${year}-${String(m).padStart(2, "0")}: ${e?.message ?? e}`); }
    const agg = aggregateMonthFees(feeRows, roster);
    if (Object.keys(agg.indiv).length) indivByMonth[m] = agg.indiv;
    if (Object.keys(agg.orig).length) origByMonth[m] = agg.orig;
    if (Object.keys(agg.resp).length) respByMonth[m] = agg.resp;
    if (Object.keys(agg.indivResp).length) indivRespByMonth[m] = agg.indivResp;
    nonRosterIndivByMonth[m] = agg.nonRosterIndiv;
    nonRosterOrigByMonth[m] = agg.nonRosterOrig;
    nonRosterRespByMonth[m] = agg.nonRosterResp;
    firmByMonth[m] = agg.firm;
    firmYtd += agg.firm;
  }
  return { indivByMonth, origByMonth, respByMonth, nonRosterIndivByMonth, nonRosterOrigByMonth, nonRosterRespByMonth, indivRespByMonth, firmByMonth, firmYtd };
}
