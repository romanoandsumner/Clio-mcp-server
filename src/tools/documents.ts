import { z } from "zod/v4";
import { buildRevenueByMonth } from "../dashboard/revenue";
import { computeBonusData, reconcileBonusConfig, FIRM_BONUS_ATTORNEYS, MNH_SPLIT_AMONG } from "../dashboard/bonus";
import { buildNonbillableByMonth } from "../dashboard/nonbillable";
import { buildMonthlyCollections } from "../dashboard/collections";
import { buildMonthlyBilled } from "../dashboard/billed";
import { buildExcludedHoursByMonth, feePlaceholderKeys } from "../dashboard/excludedHours";
import {
  classifyYtdTimeEntries, addToTotals, emptyTotals,
  type ClassifiedTimeEntry, type HoursTotals,
} from "../dashboard/classifiedHours";
import { buildWorkedHoursSplitByMonth } from "../dashboard/workedHours";
import { patchUtilizationBlock, appendUtilizationFirmAvg, appendRealizationFirmAvg, appendCollectionFirmAvg, ensureTabMonthBlock, type UtilHours } from "../dashboard/rateTabs";
import { buildRealizationDollarsSheet, REALIZATION_DOLLARS_TAB, type DollarsByMonth } from "../dashboard/realizationDollars";
import { applyTieredSplit } from "../domain/vd";
import { DashJob, dashboardJobs, pruneDashboardJobs } from "../utils/jobs";
import { diagnosticTool } from "../utils/diagnostics";
import { FIRM_ROSTER, COLLECTIONS_ROSTER, SCORECARD_ROSTER, INITIALS_BY_USER_ID, MONTH_NAMES_FULL, MONTH_NAMES_SHORT } from "../domain/roster";
import { border, $, makePara, makeDocxTable, pageBreak, spacer, h2, pageProps } from "../utils/docx";
import { round2, round1, fmt } from "../utils/num";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport, rawGetSingle, rawPostSingle } from "../clio/pagination";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageBreak, PageNumber, LevelFormat,
} from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { uploadToBox, createBoxFile, findBoxFileId, downloadFromBox } from "../utils/box";
import { registerDownload, mimeForFilename } from "../utils/downloadStore";

import {
  parseSharedStrings,
  MONTH_ABBRS,
  findTabMonthBlock,
  firmAvgRateByMonth,
  maxRowNumber,
  appendRowsBeforeSheetClose,
  stripRowsFromMarker,
  xmlCell,
  xmlRow,
  STYLE_CUR,
  STYLE_DEC,
  STYLE_PCT,
  STYLE_BOLD,
  STYLE_GEN,
  STYLE_GREEN,
  STYLE_AMBER,
  STYLE_RED,
  STYLE_CURDASH,
  STYLE_CURDASHB,
  goalColorStyle,
  setCellStyle,
  buildSheetXml,
  getZipSheetMap,
  StyleIndices,
  surgicalWriteXlsx,
  sanitizeXlsxBuffer,
  sanitizeSheetXml,
  colLetter,
  patchCell,
  readCell,
  STYLE_CURB,
  STYLE_PCTB,
  STYLE_HDR
} from "../utils/xlsx";

// ========== SHARED HELPERS ==========



import {
  parseCSV,
  getFeeAllocationCSV,
  assertReportPeriod,
  genFeeAllocationByMonth,
  getClientActivityCSV,
  getRealizationReportCSV,
  aggregateRealizationCollections,
  aggregateFeeAllocationCollectionHrs,
  aggregateClientActivity,
  fetchRealizationHours,
  type RealizDollarsAgg,
  type RealizHoursAgg,
  getRevenueReportCSV,
  matchRosterUser,
  matchRosterResponsible,
  REVENUE_REPORT_SIGNATURE,
  RealizCollectionsAgg,
} from "../clio/reportCsv";



// V&D tier logic

// ========== REGISTER TOOLS ==========

// ─── Extracted weekly-goals logic (reusable by both single + batch tools) ───

// Firm dashboard (the same workbook download_dashboard_update maintains).
// On the "26 Compare" sheet: col B = month name, col C = initials,
// col N (14) = that timekeeper's individual collected $ for the month.
const FIRM_DASHBOARD_FILE_ID = "2199324794140";

// Box folder the individual weekly goals sheets live in (their primary save
// location, unchanged). Each weekly goals sheet is ALSO duplicated into the
// Weekly Measureables folder below.
const WEEKLY_GOALS_FOLDER_ID = "372923594239";

// Traction > Measurables save destinations (EOS measurables). Weekly items go in
// Weekly Measureables, monthly items in Monthly Measureables. (Box spells the
// folders "Measureables".)
const WEEKLY_MEASURABLES_FOLDER_ID = "390777368470";
const MONTHLY_MEASURABLES_FOLDER_ID = "390781679459";

// Best-effort copy of a generated buffer into a second Box folder, kept in sync
// by name (versions an existing copy, creates it the first time). Never throws —
// a failed duplicate must not break the primary save; the failure is returned.
async function duplicateToFolder(buffer: Buffer, filename: string, folderId: string): Promise<any> {
  try {
    const existingId = await findBoxFileId(folderId, filename);
    const dup = existingId
      ? await uploadToBox({ buffer, filename, folderId, overwriteFileId: existingId })
      : await createBoxFile({ buffer, filename, folderId });
    return dup.uploaded
      ? { uploaded: true, box_file_id: dup.box_file_id, box_url: dup.box_url }
      : { uploaded: false, reason: (dup as any).reason };
  } catch (e: any) {
    return { uploaded: false, error: e?.message ?? String(e) };
  }
}



// Cache the parsed dashboard collections per (fileId, day) so a batch run
// (download_all_weekly_goals) doesn't re-download the workbook for every person.
const _dashboardCollectionsCache = new Map<string, Promise<Record<string, Record<string, number>>>>();

// Returns { "January": { "PAR": 29172.05, ... }, ... } of individual collected $.
async function getDashboardCollections(fileId: string): Promise<Record<string, Record<string, number>>> {
  const cacheKey = `${fileId}:${new Date().toISOString().slice(0, 10)}`;
  const cached = _dashboardCollectionsCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const buf = await downloadFromBox(fileId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const sheet = wb.getWorksheet("26 Compare");
    if (!sheet) throw new Error("'26 Compare' sheet not found in firm dashboard");

    const out: Record<string, Record<string, number>> = {};
    sheet.eachRow((row) => {
      const month = String(row.getCell(2).value ?? "").trim(); // col B
      if (!MONTH_NAMES_FULL.includes(month)) return;            // skips totals/header rows
      const ini = String(row.getCell(3).value ?? "").trim().toUpperCase(); // col C
      if (!ini) return;
      const raw = row.getCell(14).value;                        // col N = individual collected
      const num = typeof raw === "number" ? raw : parseFloat(String(raw ?? "").replace(/[$,()\s]/g, "")) || 0;
      (out[month] ??= {})[ini] = num;
    });
    return out;
  })();

  _dashboardCollectionsCache.set(cacheKey, promise);
  promise.catch(() => _dashboardCollectionsCache.delete(cacheKey)); // allow retry on failure
  return promise;
}

interface WeeklyGoalsParams {
  user_id: number;
  year: number;
  weekly_billable_goal: number;
  hours_per_day?: number;
  box_folder_id?: string;
  dashboard_file_id?: string;
  /** Reclassify firm-internal time as nonbillable for billable_actual. Default
   *  true. Ignored when `entries` is supplied — the batch already classified on
   *  its own basis and both bases travel on every entry. */
  exclude_internal?: boolean;
  /** Pre-classified YTD entries (all users OK — filtered to user_id here). The
   *  batch tool classifies the whole roster in one pass and hands each sheet its
   *  slice, so 12 sheets don't redo the /matters + candidate-matter lookups. */
  entries?: ClassifiedTimeEntry[];
}

async function downloadWeeklyGoals(params: WeeklyGoalsParams): Promise<{
  filename: string;
  box_file_id?: string;
  box_url?: string;
  base64?: string;
  size_kb?: number;
  direct_download_url?: string;
  expires_at?: string;
  reason?: string;
  note?: string;
  weekly_measurables?: any;
  figures?: any;
}> {
  const hoursPerDay = params.hours_per_day ?? 8;
  const endDate = new Date().toISOString().split("T")[0];

  // Classified with the SAME filtration as the monthly dashboard (26 Compare
  // cols I/H) — see dashboard/classifiedHours.ts: Clio's entry-level
  // non_billable flag, PLUS the firm-internal reclassification (matter's client
  // is the firm itself, or a billable-flagged entry with rate 0 AND amount 0),
  // with only the synthetic fee-placeholder entries excluded. Every bucket
  // carries BOTH bases, so the sheet reports the adjusted figure while `figures`
  // also returns the legacy flag-only one.
  const excludeInternal = params.exclude_internal !== false;
  const entries = (params.entries
    ?? await classifyYtdTimeEntries({
      year: params.year, endDate, userIds: [params.user_id],
      excludeInternal,
    })
  ).filter((e) => e.uid === params.user_id);
  const userName = entries[0]?.userName ?? "Unknown";

  // Group by month and week
  const months: Record<string, HoursTotals> = {};
  const weeks: Record<string, HoursTotals> = {};

  for (const e of entries) {
    if (e.cls === "excluded") continue; // fee placeholders aren't real worked time
    const monthKey = e.date.slice(0, 7);
    const d2 = new Date(e.date + "T12:00:00");
    const dow = d2.getDay();
    const mon = new Date(d2); mon.setDate(d2.getDate() - ((dow + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const weekKey = `${mon.getMonth() + 1}/${mon.getDate()}-${sun.getMonth() + 1}/${sun.getDate()}`;

    addToTotals(months[monthKey] ??= emptyTotals(), e);
    addToTotals(weeks[weekKey] ??= emptyTotals(), e);
  }

  function getWorkingDays(year: number, month: number): number {
    let count = 0;
    const dim = new Date(year, month, 0).getDate();
    for (let d = 1; d <= dim; d++) { const dow = new Date(year, month - 1, d).getDay(); if (dow !== 0 && dow !== 6) count++; }
    return count;
  }

  // Build all 52/53 weeks for the year (Mon-Sun)
  const allWeeks: { key: string; monDate: Date }[] = [];
  const jan1 = new Date(params.year, 0, 1);
  const dow1 = jan1.getDay();
  const firstMon = new Date(jan1);
  firstMon.setDate(jan1.getDate() - ((dow1 + 6) % 7));
  for (let d = new Date(firstMon); d.getFullYear() <= params.year; d.setDate(d.getDate() + 7)) {
    const mon = new Date(d);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    if (sun.getFullYear() < params.year) continue;
    if (mon.getFullYear() > params.year) break;
    const key = `${mon.getMonth() + 1}/${mon.getDate()}-${sun.getMonth() + 1}/${sun.getDate()}`;
    allWeeks.push({ key, monDate: new Date(mon) });
  }

  // Prior-month individual collections, scraped from the firm dashboard.
  // Dashboard collections are posted ~7th of the month, so before the 7th the
  // immediately-prior month isn't up yet — step back to the last posted month.
  let collectionsLabel = "";
  let collectionsValue: number | null = null;
  try {
    const nowD = new Date();
    let target = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1); // prior month
    if (nowD.getDate() < 7) target = new Date(nowD.getFullYear(), nowD.getMonth() - 2, 1);
    // Dashboard only carries the current year's months; skip for off-year sheets.
    if (target.getFullYear() === params.year) {
      const map = await getDashboardCollections(params.dashboard_file_id ?? FIRM_DASHBOARD_FILE_ID);
      const ini = INITIALS_BY_USER_ID[params.user_id] ?? "";
      const monthName = MONTH_NAMES_FULL[target.getMonth()];
      collectionsLabel = `${monthName} ${target.getFullYear()}`;
      const v = map[monthName]?.[ini];
      collectionsValue = typeof v === "number" ? v : null;
    }
  } catch (err: any) {
    console.warn(`[Doc] weekly goals — collections scrape failed: ${err?.message ?? err}`);
    collectionsValue = null;
  }

  // Build Excel
  const wb = new ExcelJS.Workbook();
  const monthNames = MONTH_NAMES_SHORT;

  // Summary (Monthly) sheet
  const ws1 = wb.addWorksheet("Summary");
  ws1.addRow(["Month", "Billable Goal", "Billable Actual", "Over/Under", "Nonbillable", "Total", "Available", "Utilization %"]).font = { bold: true };

  let cumBillable = 0, cumGoal = 0, monthsCounted = 0;
  // Legacy flag-only YTD billable plus the internal-adjustment breakdown, so the
  // sheet and its `figures` payload always reconcile the two bases explicitly.
  let cumBillableRaw = 0, cumInternal = 0, cumFirmSelf = 0, cumZeroValue = 0, cumFirmSelfRated = 0;
  const currentMonth = new Date().getMonth() + 1; // 1-indexed
  const isCurrentYear = params.year === new Date().getFullYear();

  // Monthly billable goal is derived from the weekly goal so it matches the dashboard:
  // 47 working weeks/yr ÷ 12 months. 30/wk → 1410/yr → 117.5/mo (partners & paras),
  // 32/wk → 1504/yr → 125.33/mo (associates).
  const WORKING_WEEKS_PER_YEAR = 47;
  const ANNUAL_AVAILABLE_HOURS = 1880;
  const flatMonthlyGoal = round1(params.weekly_billable_goal * WORKING_WEEKS_PER_YEAR / 12);
  // Utilization = billable ÷ available hours (1880/12 = 156.7/mo), per the dashboard.
  const availPerMonth = ANNUAL_AVAILABLE_HOURS / 12;
  const flatMonthlyAvailable = round1(availPerMonth); // 156.7

  for (let m = 1; m <= 12; m++) {
    const key = `${params.year}-${String(m).padStart(2, "0")}`;
    const data = months[key] || emptyTotals();
    const goal = flatMonthlyGoal;
    const avail = flatMonthlyAvailable;
    // Only accumulate YTD totals for months up to current month (or all months for past years)
    if (!isCurrentYear || m <= currentMonth) {
      cumBillable += data.billable; cumGoal += goal; monthsCounted++;
      cumBillableRaw += data.billableRaw;
      cumInternal += data.internalHours;
      cumFirmSelf += data.firmSelfClientHours;
      cumZeroValue += data.zeroValueHours;
      cumFirmSelfRated += data.firmSelfClientRatedHours;
    }
    const ou = round1(data.billable - goal);
    const util = round1((data.billable / availPerMonth) * 100);
    const row = ws1.addRow([monthNames[m - 1], goal, round1(data.billable), ou, round1(data.nonbillable), round1(data.billable + data.nonbillable), avail, util]);
    row.getCell(4).font = { color: { argb: ou >= 0 ? "FF008000" : "FFFF0000" } };
  }
  const ytdUtil = monthsCounted > 0 ? round1((cumBillable / (availPerMonth * monthsCounted)) * 100) : 0;
  const totRow = ws1.addRow(["YTD Total", round1(cumGoal), round1(cumBillable), round1(cumBillable - cumGoal), "", "", "", ytdUtil]);
  totRow.font = { bold: true };
  totRow.getCell(4).font = { bold: true, color: { argb: (cumBillable - cumGoal) >= 0 ? "FF008000" : "FFFF0000" } };

  // Prior-month individual collections, scraped from the firm dashboard (posts ~7th).
  ws1.addRow([]);
  const collHdr = ws1.addRow(["Prior-Month Collections (Individual — from Firm Dashboard)"]);
  collHdr.font = { bold: true };
  const collValueRow = ws1.addRow([
    collectionsLabel || "n/a",
    collectionsValue != null ? collectionsValue : "not yet posted",
  ]);
  if (collectionsValue != null) collValueRow.getCell(2).numFmt = '"$"#,##0.00';
  ws1.addRow(["Dashboard collections post ~7th of each month; figure reflects the most recently posted month."])
    .font = { italic: true, color: { argb: "FF666666" } };

  // Utilization goal legend (text only).
  const utilGoalPct = round1((params.weekly_billable_goal * WORKING_WEEKS_PER_YEAR / ANNUAL_AVAILABLE_HOURS) * 100);
  ws1.addRow([]);
  ws1.addRow(["Utilization Goal"]).font = { bold: true };
  ws1.addRow([`${utilGoalPct}%`, `Billable ÷ available hours (${params.weekly_billable_goal}/wk × 47 ÷ 1,880)`]);
  ws1.addRow(["Firm targets: 75% (partners & paralegals), 80% (associates)."])
    .font = { italic: true, color: { argb: "FF666666" } };
  ws1.addRow([excludeInternal
    ? "Hours use the firm dashboard's filtration: billable vs nonbillable follows each entry's Clio non-billable flag, AND firm-internal time is reclassified as nonbillable — matters whose client is Romano & Sumner, LLC (e.g. 02888-Admin, 00050-Potential Clients) plus billable-flagged entries with a $0 rate and $0 amount. Synthetic fee-placeholder entries are excluded."
    : "Hours use the LEGACY filtration: billable vs nonbillable follows each entry's Clio non-billable flag only (rate and matter are ignored); synthetic fee-placeholder entries are excluded."])
    .font = { italic: true, color: { argb: "FF666666" } };
  if (excludeInternal && cumInternal > 0.05) {
    ws1.addRow([`Internal-time adjustment: ${round1(cumInternal)} YTD hrs moved from billable to nonbillable (firm-self-client ${round1(cumFirmSelf)} hrs, $0 rate+amount ${round1(cumZeroValue)} hrs). YTD billable on the legacy flag-only basis: ${round1(cumBillableRaw)} hrs.`])
      .font = { italic: true, color: { argb: "FF666666" } };
    if (cumFirmSelfRated > 0.05) {
      ws1.addRow([`Of that, ${round1(cumFirmSelfRated)} hrs were booked at a RATE on a firm-self-client matter — check whether that is real client work filed under the firm's own client rather than internal time.`])
        .font = { italic: true, color: { argb: "FFC00000" } };
    }
  }

  // Weekly sheet: horizontal layout - weeks as columns, metrics as rows
  const ws2 = wb.addWorksheet("Weekly");
  const headerRow = ws2.getRow(4);
  for (let i = 0; i < allWeeks.length; i++) {
    headerRow.getCell(i + 3).value = allWeeks[i].key;
  }

  // `today` gates which weeks get shaded (only weeks that have actually started).
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  // Billable row — shaded red (< 20), yellow (20 → below goal), green (>= goal).
  ws2.getCell("B5").value = "Billable";
  ws2.getCell("B5").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    const billable = round1(data?.billable ?? 0);
    const cell = ws2.getRow(5).getCell(i + 3);
    cell.value = billable;
    if (allWeeks[i].monDate <= today) {
      const argb = billable < 20
        ? "FFFFC7CE"                                   // red
        : billable < params.weekly_billable_goal
          ? "FFFFEB9C"                                 // yellow
          : "FFC6EFCE";                                // green
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    }
  }

  ws2.getCell("B6").value = "Nonbillable";
  ws2.getCell("B6").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    ws2.getRow(6).getCell(i + 3).value = round1(data?.nonbillable ?? 0);
  }

  ws2.getCell("B7").value = "Total Tracked";
  ws2.getCell("B7").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    ws2.getRow(7).getCell(i + 3).value = round1((data?.billable ?? 0) + (data?.nonbillable ?? 0));
  }

  ws2.getCell("B9").value = "Billable Goal";
  ws2.getCell("B9").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    ws2.getRow(9).getCell(i + 3).value = params.weekly_billable_goal;
  }

  ws2.getCell("B10").value = "Over/Under";
  ws2.getCell("B10").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    const billable = data?.billable ?? 0;
    const ou = round1(billable - params.weekly_billable_goal);
    const cell = ws2.getRow(10).getCell(i + 3);
    cell.value = ou;
    cell.font = { color: { argb: ou >= 0 ? "FF008000" : "FFFF0000" } };
  }

  // Row 11: Trailing 4-week average of billable hours (this week + prior 3 that
  // have started). A rolling read of recent pace that smooths single-week noise.
  ws2.getCell("B11").value = "Trailing 4-Wk Avg";
  ws2.getCell("B11").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    if (allWeeks[i].monDate > today) break; // only weeks that have started
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 3); j <= i; j++) {
      sum += weeks[allWeeks[j].key]?.billable ?? 0;
      cnt++;
    }
    ws2.getRow(11).getCell(i + 3).value = round1(sum / cnt);
  }

  // Row 12: YTD Over/Under — running cumulative, only through current week
  ws2.getCell("B12").value = "YTD Over/Under";
  ws2.getCell("B12").font = { bold: true };
  let cumWeeklyOU = 0;
  for (let i = 0; i < allWeeks.length; i++) {
    // Only include weeks that have started (Monday <= today)
    if (allWeeks[i].monDate > today) break;
    const data = weeks[allWeeks[i].key];
    const billable = data?.billable ?? 0;
    cumWeeklyOU += billable - params.weekly_billable_goal;
    const cell = ws2.getRow(12).getCell(i + 3);
    cell.value = round1(cumWeeklyOU);
    cell.font = { bold: true, color: { argb: cumWeeklyOU >= 0 ? "FF008000" : "FFFF0000" } };
  }

  // Key figures for the JSON payload, so callers (Claude, unattended jobs) can
  // read the numbers without downloading and parsing the workbook.
  let lastStartedIdx = -1;
  for (let i = 0; i < allWeeks.length; i++) {
    if (allWeeks[i].monDate > today) break;
    lastStartedIdx = i;
  }
  let figures: any = null;
  if (lastStartedIdx >= 0) {
    const wk = weeks[allWeeks[lastStartedIdx].key] ?? emptyTotals();
    let t4Sum = 0, t4SumRaw = 0, t4Cnt = 0;
    for (let j = Math.max(0, lastStartedIdx - 3); j <= lastStartedIdx; j++) {
      t4Sum += weeks[allWeeks[j].key]?.billable ?? 0;
      t4SumRaw += weeks[allWeeks[j].key]?.billableRaw ?? 0;
      t4Cnt++;
    }
    figures = {
      user: userName,
      current_week: allWeeks[lastStartedIdx].key,
      week_billable: round1(wk.billable),
      week_nonbillable: round1(wk.nonbillable),
      week_goal: params.weekly_billable_goal,
      week_over_under: round1(wk.billable - params.weekly_billable_goal),
      trailing_4wk_avg_billable: round1(t4Sum / t4Cnt),
      trailing_4wk_avg_billable_raw: round1(t4SumRaw / t4Cnt),
      ytd_weekly_over_under: round1(cumWeeklyOU),
      ytd_billable: round1(cumBillable),
      ytd_goal: round1(cumGoal),
      ytd_over_under: round1(cumBillable - cumGoal),
      ytd_utilization_pct: ytdUtil,
      // Legacy flag-only basis, kept so the sheet reconciles to the
      // pre-adjustment 26 Compare col I. The delta is internal_reclassified.
      exclude_internal: excludeInternal,
      week_billable_raw: round1(wk.billableRaw),
      ytd_billable_raw: round1(cumBillableRaw),
      ytd_over_under_raw: round1(cumBillableRaw - cumGoal),
      ytd_utilization_raw_pct: monthsCounted > 0
        ? round1((cumBillableRaw / (availPerMonth * monthsCounted)) * 100) : 0,
      internal_reclassified_ytd: round1(cumInternal),
      internal_firm_self_client_ytd: round1(cumFirmSelf),
      internal_zero_rate_and_amount_ytd: round1(cumZeroValue),
      // Firm-self-client hours that carried a RATE — internal time is normally
      // $0, so a material figure means rule (a) caught real client work filed
      // under the firm's own client. See dashboard/classifiedHours.ts.
      internal_firm_self_client_rated_ytd: round1(cumFirmSelfRated),
      prior_month_collections: collectionsValue != null
        ? { month: collectionsLabel, amount: round2(collectionsValue) }
        : null,
    };
  }

  // Legend for the Billable-row shading (rows 14-17).
  const goalNum = params.weekly_billable_goal;
  ws2.getCell("B14").value = "Legend — Billable hours";
  ws2.getCell("B14").font = { bold: true };
  const legend: Array<[number, string, string]> = [
    [15, "FFFFC7CE", `Below minimum (< 20)`],
    [16, "FFFFEB9C", `Approaching goal (20 to < ${goalNum})`],
    [17, "FFC6EFCE", `At / above goal (≥ ${goalNum})`],
  ];
  for (const [r, argb, label] of legend) {
    const swatch = ws2.getCell(`B${r}`);
    swatch.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    swatch.border = {
      top: { style: "thin", color: { argb: "FFBFBFBF" } },
      left: { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      right: { style: "thin", color: { argb: "FFBFBFBF" } },
    };
    ws2.getCell(`C${r}`).value = label;
  }

  ws2.getColumn(2).width = 14;
  for (let i = 0; i < allWeeks.length; i++) {
    ws2.getColumn(i + 3).width = 10;
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `${userName} Goals ${params.year}.xlsx`;
  const size_kb = Math.round(buffer.byteLength / 1024);

  if (params.box_folder_id !== undefined) {
    const INITIALS_MAP: Record<number, string> = {
      344117381: "PAR", 344134017: "KES", 348755029: "NRN", 359380639: "NAF",
      358528744: "ACA", 358108805: "AFL", 358550509: "AKG", 359711375: "TBS",
      359576660: "MNH", 360091325: "JPB", 360049685: "KGV", 359865560: "CTD",
      360383465: "SAB",
    };
    const initials = INITIALS_MAP[params.user_id] ?? userName.split(" ").map((p: string) => p[0]?.toUpperCase() ?? "").join("");
    const boxFilename = `${initials} Goals ${params.year}.xlsx`;
    const folderId = params.box_folder_id || WEEKLY_GOALS_FOLDER_ID;
    // Version the existing sheet when there is one; CREATE it when there
    // isn't. uploadToBox alone deliberately never creates files, which left a
    // NEW timekeeper (no prior "<INI> Goals <year>.xlsx" in the folder, e.g.
    // SAB mid-2026) permanently unable to get a sheet into Box — every run
    // uploaded the file, deleted it as an orphan, and fell back to a 1-hour
    // download link. Same lookup-then-version-or-create flow as
    // duplicateToFolder uses for the Weekly Measureables copy.
    const existingId = await findBoxFileId(folderId, boxFilename);
    const result = existingId
      ? await uploadToBox({ buffer, filename: boxFilename, folderId, overwriteFileId: existingId })
      : await createBoxFile({ buffer, filename: boxFilename, folderId });
    // Also duplicate the sheet into Weekly Measureables (kept in sync each run).
    const weekly_measurables = await duplicateToFolder(buffer, boxFilename, WEEKLY_MEASURABLES_FOLDER_ID);
    if (result.uploaded) {
      return { filename: boxFilename, size_kb: result.size_kb, box_file_id: result.box_file_id, box_url: result.box_url, weekly_measurables, figures };
    }
    return {
      filename: boxFilename,
      size_kb: result.size_kb,
      direct_download_url: result.direct_download_url,
      expires_at: result.expires_at,
      reason: result.reason,
      note: result.note,
      weekly_measurables,
      figures,
    };
  }

  // No Box target — park the buffer and hand back a direct-download URL.
  console.warn(`[Doc] generate_weekly_goals — returning direct_download_url filename=${filename} size_kb=${size_kb}`);
  const reg = registerDownload(buffer, filename, mimeForFilename(filename));
  return { filename, size_kb, direct_download_url: reg.url, expires_at: reg.expires_at, figures };
}

// Roster-wide $0-rate and fee-placeholder hours a month's Realization tab backed out
// of D/E/F (see aggregateRealizationHours), rounded for the tool result.
function sumRealizExcluded(agg: Record<number, RealizHoursAgg>): { zero_rate_hrs: number; placeholder_hrs: number } {
  let z = 0, p = 0;
  for (const a of Object.values(agg)) { z += a.zeroRateHrs; p += a.placeholderHrs; }
  return { zero_rate_hrs: round1(z), placeholder_hrs: round1(p) };
}

// ─── ROSTER (hardcoded for batch weekly goals, grouped by team) ──

// Weekly billable goals match the dashboard: partners & paras = 30/wk, associates = 32/wk.
const WEEKLY_GOALS_ROSTER = [
  { name: "Nicholas Noe",    user_id: 348755029, goal: 30, group: "NRN" }, // partner/para
  { name: "Tzipora Simmons", user_id: 359711375, goal: 32, group: "NRN" }, // associate
  { name: "Kaz Gonzalez",    user_id: 358550509, goal: 30, group: "NRN" }, // partner/para
  { name: "Paul Romano",     user_id: 344117381, goal: 30, group: "PAR" }, // partner/para
  { name: "Angela Alanis",   user_id: 358528744, goal: 30, group: "PAR" }, // partner/para
  { name: "Nick Fernelius",  user_id: 359380639, goal: 32, group: "PAR" }, // associate
  { name: "Kenny Sumner",    user_id: 344134017, goal: 30, group: "KES" }, // partner/para
  // DEPARTED — deliberately absent from the weekly goal sheets and monthly
  // summary. Goals are a forward-looking management tool; there is nothing to
  // set a target against once someone has left. Their historical sheets stay in
  // Box, and every HISTORY view keeps them via FIRM_ROSTER: 26 Compare rows,
  // tail collections on their old invoices, bonus attribution (Anna's paralegal
  // tail still credits KES — see bonus.ts), and their Realization ($) blocks.
  // Drop from FIRM_ROSTER for 2027, not before.
  //   Jonathan Barbee (JPB, 360091325) — terminated July 2026.
  //   Anna Lozano     (AFL, 358108805) — left mid-2026, replaced by Stacy Bakri.
  { name: "Stacy Bakri",     user_id: 360383465, goal: 30, group: "KES" }, // partner/para — Kenny's paralegal, replaced Anna mid-2026
  { name: "May Huynh",       user_id: 359576660, goal: 32, group: "MNH" }, // associate
];

// ─── Monthly goals summary (firm-wide chart, one workbook) ──

// Same shading palette as the weekly goals sheets.
const FILL_GREEN = "FFC6EFCE";
const FILL_YELLOW = "FFFFEB9C";
const FILL_RED = "FFFFC7CE";

interface MonthlyGoalsSummaryParams {
  year: number;
  box_folder_id?: string;
  close_threshold_pct?: number;
  exclude_internal?: boolean;
}

async function downloadMonthlyGoalsSummary(params: MonthlyGoalsSummaryParams): Promise<{
  filename: string;
  created: boolean;
  months_reported: number;
  box_file_id?: string;
  box_url?: string;
  size_kb?: number;
  direct_download_url?: string;
  expires_at?: string;
  reason?: string;
  note?: string;
  figures?: any;
}> {
  const closePct = params.close_threshold_pct ?? 90;
  const endDate = `${params.year}-12-31`;

  // Same dashboard filtration as the weekly sheets (classifiedHours.ts): the
  // chart tracks billable vs goal only, where billable = worked time whose Clio
  // non_billable flag is false AND which isn't firm-internal (the matter's
  // client is the firm itself, or the entry is billable-flagged at rate 0 and
  // amount 0), minus fee placeholders — matching 26 Compare col I. Matter
  // names/numbers/types are still never consulted.
  const entries = await classifyYtdTimeEntries({
    year: params.year, endDate, userIds: WEEKLY_GOALS_ROSTER.map((r) => r.user_id),
    excludeInternal: params.exclude_internal,
  });

  // Firm-wide adjustment totals, so the sheet's footnote can state how much the
  // internal reclassification moved instead of just naming the rule. Scoped to
  // the roster, matching the population the chart actually reports.
  const rosterIds = new Set(WEEKLY_GOALS_ROSTER.map((r) => r.user_id));
  const adj = emptyTotals();
  for (const e of entries) if (rosterIds.has(e.uid)) addToTotals(adj, e);

  // billableByUser[user_id][monthIdx] = billable hours
  const billableByUser: Record<number, number[]> = {};
  for (const r of WEEKLY_GOALS_ROSTER) billableByUser[r.user_id] = Array(12).fill(0);
  for (const e of entries) {
    if (e.cls !== "billable" || !billableByUser[e.uid]) continue;
    const m = parseInt(e.date.slice(5, 7), 10) - 1;
    billableByUser[e.uid][m] += e.hours;
  }

  // Months that have started (the current month shades month-to-date, same
  // as the weekly sheets shade the in-progress week).
  const now = new Date();
  const monthsStarted =
    params.year < now.getFullYear() ? 12 :
    params.year > now.getFullYear() ? 0 :
    now.getMonth() + 1;

  // Monthly goal derived from the weekly goal, same as the weekly sheets:
  // 47 working weeks/yr ÷ 12 months (30/wk → 117.5, 32/wk → 125.3).
  const WORKING_WEEKS_PER_YEAR = 47;
  const ANNUAL_AVAILABLE_HOURS = 1880;
  const availPerMonth = ANNUAL_AVAILABLE_HOURS / 12;
  const roster = WEEKLY_GOALS_ROSTER.map((r) => ({
    ...r,
    initials: INITIALS_BY_USER_ID[r.user_id]
      ?? r.name.split(" ").map((p) => p[0]?.toUpperCase() ?? "").join(""),
    monthlyGoal: round1(r.goal * WORKING_WEEKS_PER_YEAR / 12),
  }));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Monthly Summary", { views: [{ state: "frozen" as const, ySplit: 4, xSplit: 1 }] });

  ws.getCell(1, 1).value = `Monthly Goals Summary — ${params.year}`;
  ws.getCell(1, 1).font = { bold: true, size: 13 };

  // Rows 3-4: attorney headers (initials) + each person's monthly goal.
  ws.getCell(3, 1).value = "Month";
  ws.getCell(3, 1).font = { bold: true };
  ws.getCell(4, 1).value = "Monthly Goal";
  ws.getCell(4, 1).font = { bold: true };
  roster.forEach((r, i) => {
    const col = i + 2;
    const head = ws.getCell(3, col);
    head.value = r.initials;
    head.font = { bold: true };
    head.alignment = { horizontal: "center" as const };
    ws.getCell(4, col).value = r.monthlyGoal;
    ws.getColumn(col).width = 11;
  });
  ws.getColumn(1).width = 16;

  // Rows 5-16: one row per month, attorneys side by side. Shaded green
  // (>= goal), yellow (close: >= closePct% of goal), red (off goal).
  for (let m = 0; m < 12; m++) {
    const row = ws.getRow(5 + m);
    row.getCell(1).value = MONTH_NAMES_SHORT[m];
    row.getCell(1).font = { bold: true };
    if (m >= monthsStarted) continue; // future months stay blank
    roster.forEach((r, i) => {
      const billable = round1(billableByUser[r.user_id][m]);
      const cell = row.getCell(i + 2);
      cell.value = billable;
      const argb = billable >= r.monthlyGoal
        ? FILL_GREEN
        : billable >= r.monthlyGoal * (closePct / 100)
          ? FILL_YELLOW
          : FILL_RED;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    });
  }

  // Rows 18-21: YTD section (months that have started only).
  const ytdLabels: Array<[number, string]> = [
    [18, "YTD Billable"], [19, "YTD Goal"], [20, "YTD Over/Under"], [21, "YTD Utilization %"],
  ];
  for (const [rowNum, label] of ytdLabels) {
    ws.getCell(rowNum, 1).value = label;
    ws.getCell(rowNum, 1).font = { bold: true };
  }
  roster.forEach((r, i) => {
    const col = i + 2;
    const ytd = billableByUser[r.user_id].slice(0, monthsStarted).reduce((s, v) => s + v, 0);
    const ytdGoal = r.monthlyGoal * monthsStarted;
    ws.getCell(18, col).value = round1(ytd);
    ws.getCell(19, col).value = round1(ytdGoal);
    const ou = round1(ytd - ytdGoal);
    const ouCell = ws.getCell(20, col);
    ouCell.value = ou;
    ouCell.font = { bold: true, color: { argb: ou >= 0 ? "FF008000" : "FFFF0000" } };
    ws.getCell(21, col).value = monthsStarted > 0
      ? round1((ytd / (availPerMonth * monthsStarted)) * 100)
      : 0;
  });

  // Legend (rows 23-26) — swatch + label, matching the weekly sheets.
  ws.getCell(23, 1).value = "Legend — monthly billable vs goal";
  ws.getCell(23, 1).font = { bold: true };
  const legend: Array<[number, string, string]> = [
    [24, FILL_GREEN, "On goal (≥ monthly goal)"],
    [25, FILL_YELLOW, `Close (≥ ${closePct}% of goal)`],
    [26, FILL_RED, `Off goal (< ${closePct}% of goal)`],
  ];
  for (const [rowNum, argb, label] of legend) {
    const swatch = ws.getCell(rowNum, 1);
    swatch.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    swatch.border = {
      top: { style: "thin", color: { argb: "FFBFBFBF" } },
      left: { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      right: { style: "thin", color: { argb: "FFBFBFBF" } },
    };
    ws.getCell(rowNum, 2).value = label;
  }
  // Footnote must state the ACTUAL rule: the internal reclassification consults
  // the matter's client and the entry's rate, which the old wording denied.
  const excludeInternal = params.exclude_internal !== false;
  ws.getCell(28, 1).value = excludeInternal
    ? "Monthly goal = weekly goal × 47 ÷ 12. Current month shows month-to-date. Billable excludes entries flagged non-billable in Clio, synthetic fee placeholders, AND firm-internal time — matters whose client is Romano & Sumner, LLC (e.g. 02888-Admin, 00050-Potential Clients) plus billable-flagged entries with a $0 rate and $0 amount."
    : "Monthly goal = weekly goal × 47 ÷ 12. Current month shows month-to-date. Billable uses the LEGACY flag-only filtration (entries flagged non-billable in Clio and fee placeholders excluded); firm-internal time is NOT excluded.";
  ws.getCell(28, 1).font = { italic: true, color: { argb: "FF666666" } };
  if (excludeInternal && adj.internalHours > 0.05) {
    ws.getCell(29, 1).value = `Internal-time adjustment across the roster: ${round1(adj.internalHours)} YTD hrs moved out of billable (firm-self-client ${round1(adj.firmSelfClientHours)} hrs, $0 rate+amount ${round1(adj.zeroValueHours)} hrs). YTD billable on the legacy flag-only basis: ${round1(adj.billableRaw)} hrs.`;
    ws.getCell(29, 1).font = { italic: true, color: { argb: "FF666666" } };
    if (adj.firmSelfClientRatedHours > 0.05) {
      ws.getCell(30, 1).value = `Of that, ${round1(adj.firmSelfClientRatedHours)} hrs were booked at a RATE on a firm-self-client matter — check whether that is real client work filed under the firm's own client rather than internal time.`;
      ws.getCell(30, 1).font = { italic: true, color: { argb: "FFC00000" } };
    }
  }

  // Roster-wide reconciliation of the two bases, so a poller sees the adjustment
  // without opening the workbook.
  const figures = {
    exclude_internal: excludeInternal,
    months_reported: monthsStarted,
    ytd_billable: round1(adj.billable),
    ytd_billable_raw: round1(adj.billableRaw),
    internal_reclassified_ytd: round1(adj.internalHours),
    internal_firm_self_client_ytd: round1(adj.firmSelfClientHours),
    internal_zero_rate_and_amount_ytd: round1(adj.zeroValueHours),
    internal_firm_self_client_rated_ytd: round1(adj.firmSelfClientRatedHours),
  };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `Monthly Goals Summary ${params.year}.xlsx`;
  // Saves into Traction > Measurables > Monthly Measureables (a monthly measurable).
  const folderId = params.box_folder_id || MONTHLY_MEASURABLES_FOLDER_ID;

  // Version the existing file, or create it the first time (same pattern as
  // the AR scorecard — uploadToBox alone never creates new files).
  const existingId = await findBoxFileId(folderId, filename);
  const result = existingId
    ? await uploadToBox({ buffer, filename, folderId, overwriteFileId: existingId })
    : await createBoxFile({ buffer, filename, folderId });

  if (result.uploaded) {
    return {
      filename,
      created: !existingId,
      months_reported: monthsStarted,
      size_kb: result.size_kb,
      box_file_id: result.box_file_id,
      box_url: result.box_url,
      figures,
    };
  }
  return {
    filename,
    created: !existingId,
    months_reported: monthsStarted,
    size_kb: result.size_kb,
    direct_download_url: result.direct_download_url,
    expires_at: result.expires_at,
    reason: result.reason,
    note: result.note,
    figures,
  };
}

export function registerDocumentTools(server: McpServer): void {

  // ============================================================
  // TOOL 3: download_weekly_goals
  // ============================================================
  server.tool(
    "download_weekly_goals",
    "Generate an individual weekly goals Excel sheet for a specific timekeeper. Includes monthly and weekly breakdowns with goals and over/under tracking. " +
    "BILLABLE CLASSIFICATION NOW CONSULTS THE MATTER'S CLIENT AND THE ENTRY'S RATE, not just the Clio non-billable flag. An entry counts as nonbillable when its native non_billable flag is set, OR — when exclude_internal is true (the DEFAULT) — when either (a) the matter's client is the firm itself, Romano & Sumner, LLC (the structural signal: catches 02888-Admin, 00050-Potential Clients and any future internal matter automatically), or (b) the entry is billable-flagged but carries rate 0 AND amount 0 (the rate-based safety net for internal time booked under another client). Reclassified hours MOVE to nonbillable rather than disappearing, so total tracked time is identical on both bases; synthetic fee-placeholder entries are still dropped from both. " +
    "The sheet and its Utilization % are on the ADJUSTED basis; the firm dashboard (26 Compare col I and the Utilization tab) uses the same adjusted basis, so the two still reconcile. " +
    "The response always includes a `figures` object (current-week and YTD billable vs goal, trailing 4-week average, utilization, prior-month collections) so results can be read without opening the workbook, plus the legacy flag-only twins — ytd_billable_raw, ytd_over_under_raw, ytd_utilization_raw_pct, week_billable_raw, trailing_4wk_avg_billable_raw — and internal_reclassified_ytd broken out by rule, so the two bases always reconcile explicitly. " +
    "Also returns either box_url (uploaded) or a short-lived direct_download_url (1-hour TTL) the user can click to download the file.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      weekly_billable_goal: z.coerce.number().describe("Weekly billable hours goal (30 for partners/paras, 32 for associates). Monthly goal is derived as weekly × 47 ÷ 12 to match the dashboard."),
      hours_per_day: z.coerce.number().optional().default(8).describe("Hours in a work day (default 8)"),
      box_folder_id: z.string().optional().describe("Box folder ID. If provided and the generated file has an existing overwrite target, the tool versions it in Box. Otherwise (omitted or upload fails) the tool returns a short-lived direct_download_url (1-hour TTL) the user can click to download the file directly — no base64 inlined in the MCP response."),
      exclude_internal: z.boolean().optional().default(true).describe("Reclassify firm-internal time as nonbillable when computing billable hours: matters whose client is the firm itself (Romano & Sumner, LLC), plus billable-flagged entries with rate 0 AND amount 0. Default true. Set false for the legacy flag-only basis, where the billable figure equals its _raw counterpart."),
    },
    async (params) => {
      try {
        const result = await downloadWeeklyGoals({
          user_id: params.user_id,
          year: params.year,
          weekly_billable_goal: params.weekly_billable_goal,
          hours_per_day: params.hours_per_day,
          box_folder_id: params.box_folder_id,
          exclude_internal: params.exclude_internal,
        });

        if (result.box_file_id) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename: result.filename, size_kb: result.size_kb, box_file_id: result.box_file_id, box_url: result.box_url, weekly_measurables: result.weekly_measurables, figures: result.figures }) }] };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filename: result.filename, format: "xlsx", size_kb: result.size_kb, direct_download_url: result.direct_download_url, expires_at: result.expires_at, reason: result.reason, note: result.note, figures: result.figures }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }], isError: true };
      }
    }
  );

  // ============================================================
  // TOOL 3b: download_all_weekly_goals (batch — entire firm)
  // ============================================================
  server.tool(
    "download_all_weekly_goals",
    "Update the weekly goals spreadsheet for all firm timekeepers, uploading to Box in parallel. " +
    "BILLABLE CLASSIFICATION NOW CONSULTS THE MATTER'S CLIENT AND THE ENTRY'S RATE, not just the Clio non-billable flag. An entry counts as nonbillable when its native non_billable flag is set, OR — when exclude_internal is true (the DEFAULT) — when either (a) the matter's client is the firm itself, Romano & Sumner, LLC (the structural signal: catches 02888-Admin, 00050-Potential Clients and any future internal matter automatically), or (b) the entry is billable-flagged but carries rate 0 AND amount 0 (the rate-based safety net for internal time booked under another client). Reclassified hours MOVE to nonbillable rather than disappearing, so total tracked time is identical on both bases; synthetic fee-placeholder entries are still dropped from both. " +
    "The roster is classified ONCE for the whole firm and each sheet is handed its slice. Each per-person `figures` payload carries both bases (billable plus its _raw twin) and internal_reclassified_ytd. " +
    "The full batch regenerates every sheet from Clio time entries and can exceed the MCP client's ~180s timeout, " +
    "so it runs as a background job: this tool returns a job_id immediately — poll get_dashboard_status with it " +
    "for the per-person results (status, box_url, and key figures for each timekeeper). No arguments required.",
    {
      year: z.number().optional().describe("Year (defaults to current year)"),
      box_folder_id: z.string().optional().describe(
        "Box folder ID to upload to. Omit or pass empty string for default folder."
      ),
      exclude_internal: z.boolean().optional().default(true).describe("Reclassify firm-internal time as nonbillable when computing billable hours: matters whose client is the firm itself (Romano & Sumner, LLC), plus billable-flagged entries with rate 0 AND amount 0. Default true. Set false for the legacy flag-only basis, where the billable figure equals its _raw counterpart."),
    },
    async ({ year, box_folder_id, exclude_internal }) => {
      const targetYear = year ?? new Date().getFullYear();
      const folderId = box_folder_id ?? "";
      const excludeInternal = exclude_internal !== false;

      const jobId = `wkgoals_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const job: DashJob = { id: jobId, status: "running", started_at: new Date().toISOString() };
      dashboardJobs.set(jobId, job);
      pruneDashboardJobs();

      // Run detached so the MCP call returns immediately (regenerating + uploading
      // every timekeeper's sheet outlasts the ~180s client timeout in unattended
      // jobs). Result/error are recorded on the job for get_dashboard_status polling.
      (async () => {
      // Classify the whole roster's entries ONCE (one /matters pull + one
      // /activities pull per member), then hand each sheet its slice — instead
      // of 12 parallel sheets each redoing the admin-matter/placeholder lookups.
      const allEntries = await classifyYtdTimeEntries({
        year: targetYear,
        endDate: new Date().toISOString().split("T")[0],
        userIds: WEEKLY_GOALS_ROSTER.map((r) => r.user_id),
        excludeInternal,
      });


      const results = await Promise.allSettled(
        WEEKLY_GOALS_ROSTER.map(({ name, user_id, goal, group }) =>
          downloadWeeklyGoals({
            user_id,
            weekly_billable_goal: goal,
            year: targetYear,
            box_folder_id: folderId,
            exclude_internal: excludeInternal,
            entries: allEntries,
          }).then((res: any) => {
            const uploaded = !!res.box_file_id;
            return {
              name,
              group,
              status: uploaded ? ("uploaded" as const) : ("download_link" as const),
              filename: res.filename ?? null,
              box_url: res.box_url ?? null,
              box_file_id: res.box_file_id ?? null,
              direct_download_url: res.direct_download_url ?? null,
              expires_at: res.expires_at ?? null,
              reason: res.reason ?? null,
              figures: res.figures ?? null,
            };
          })
            .catch((err: Error) => ({
              name,
              group,
              status: `FAILED: ${err.message}` as const,
              filename: null,
              box_url: null,
              box_file_id: null,
              direct_download_url: null,
              expires_at: null,
              reason: err.message,
              figures: null,
            }))
        )
      );

      const uploads = results.map((r) => (r.status === "fulfilled" ? r.value : r.reason));

      // Group by team
      const groups: Record<string, any[]> = {};
      for (const u of uploads) {
        const g = u.group || "Other";
        if (!groups[g]) groups[g] = [];
        groups[g].push({
          name: u.name,
          status: u.status,
          filename: u.filename,
          box_url: u.box_url,
          box_file_id: u.box_file_id,
          direct_download_url: u.direct_download_url,
          expires_at: u.expires_at,
          figures: u.figures,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            year: targetYear,
            count: uploads.length,
            succeeded: uploads.filter((u: any) => u.status === "uploaded").length,
            download_link: uploads.filter((u: any) => u.status === "download_link").length,
            failed: uploads.filter((u: any) => typeof u.status === "string" && u.status.startsWith("FAILED")).length,
            by_team: groups,
          }, null, 2),
        }],
      };
      })()
        .then((res: any) => { job.result = res; job.status = "done"; job.finished_at = new Date().toISOString(); })
        .catch((err: any) => { job.status = "error"; job.error = String(err?.message ?? err); job.finished_at = new Date().toISOString(); });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            job_id: jobId,
            status: "started",
            year: targetYear,
            timekeepers: WEEKLY_GOALS_ROSTER.length,
            message: "Weekly goals batch is running in the background (regenerates and uploads every timekeeper's sheet). Poll get_dashboard_status with this job_id for per-person results.",
          }),
        }],
      };
    }
  );

  // ============================================================
  // TOOL 3c: download_monthly_goals_summary (firm-wide chart)
  // ============================================================
  server.tool(
    "download_monthly_goals_summary",
    "Generate the firm-wide monthly goals summary chart: every timekeeper's monthly billable hours side by side, " +
    "color coded against their monthly goal (green = on goal, yellow = close, red = off goal), plus YTD totals. " +
    "Billable hours use the same filtration as the firm dashboard: each entry's Clio non-billable flag, PLUS the firm-internal reclassification when exclude_internal is true (the default) — matters whose client is the firm itself (Romano & Sumner, LLC) and billable-flagged entries with rate 0 AND amount 0 count as nonbillable, so rate and the matter's client ARE consulted. Synthetic fee placeholders are excluded. 26 Compare col I and its Utilization tab use this same adjusted basis, so the YTD Utilization % row still reconciles to the dashboard. " +
    "Saves the workbook to Traction > Measurables > Monthly Measureables (versioned on re-runs, created on first run). " +
    "Classifying the whole roster's year takes longer than the MCP client's 60s timeout, so this runs as a BACKGROUND JOB: the tool returns a job_id immediately — poll get_dashboard_status with it for the filename, box_url and the internal-time adjustment totals.",
    {
      year: z.coerce.number().optional().describe("Year (defaults to current year)"),
      box_folder_id: z.string().optional().describe("Box folder ID. Defaults to the Monthly Measureables folder."),
      close_threshold_pct: z.coerce.number().optional().describe("Percent of monthly goal that still counts as 'close' (yellow). Default 90."),
      exclude_internal: z.boolean().optional().default(true).describe("Reclassify firm-internal time as nonbillable when computing billable hours: matters whose client is the firm itself (Romano & Sumner, LLC), plus billable-flagged entries with rate 0 AND amount 0. Default true. Set false for the legacy flag-only basis."),
    },
    async (params) => {
      // Detached like download_all_weekly_goals: one full-year /activities pull
      // per roster member outlasts the client timeout, and the previous
      // synchronous form completed the Box write but returned a timeout error —
      // so callers had no confirmation and no figures for work that HAD landed.
      const jobId = `mgoals_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const job: DashJob = { id: jobId, status: "running", started_at: new Date().toISOString() };
      dashboardJobs.set(jobId, job);
      pruneDashboardJobs();

      downloadMonthlyGoalsSummary({
        year: params.year ?? new Date().getFullYear(),
        box_folder_id: params.box_folder_id,
        close_threshold_pct: params.close_threshold_pct,
        exclude_internal: params.exclude_internal,
      })
        .then((res) => { job.result = res; job.status = "done"; job.finished_at = new Date().toISOString(); })
        .catch((err: any) => { job.status = "error"; job.error = String(err?.message ?? err); job.finished_at = new Date().toISOString(); });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            job_id: jobId,
            status: "started",
            year: params.year ?? new Date().getFullYear(),
            timekeepers: WEEKLY_GOALS_ROSTER.length,
            message: "Monthly goals summary is running in the background (classifies the whole roster's year). Poll get_dashboard_status with this job_id for the filename, box_url and adjustment totals.",
          }),
        }],
      };
    }
  );

  // ============================================================
  // DIAGNOSTIC: probe_clio_report_apis  (read-only)
  // Determines whether Clio's new "Custom Reports" (beta) engine is reachable
  // via the API and under what path, vs the classic /reports surface the
  // dashboard tool uses. Hits candidate endpoints with the firm's token and
  // reports HTTP status + response shape, plus enumerates the classic reports.
  // ============================================================
  diagnosticTool(server).tool(
    "probe_clio_report_apis",
    "Diagnostic (read-only). Probes candidate Clio report API endpoints with the firm's token and returns HTTP status + response shape for each, to discover whether the new 'Custom Reports' (beta) reporting engine is API-accessible and under what path (vs the classic /reports endpoint the dashboard uses). Also enumerates classic /reports by kind/name/format so a missing or mis-grouped report can be spotted. Run this when the dashboard can't find the expected Revenue Report.",
    {},
    async () => {
      const out: any = {};

      // 1) Report Presets — this is where grouping (group_by) and scheduled-report
      // config live in the classic API. If the "NRN Copy…(like Classic)" report is
      // a classic preset, it'll appear here WITH its options (group_by etc.), and we
      // can generate it on demand. If it's not here, it's beta-only.
      try {
        const presets = await fetchAllPages<any>("/report_presets", {
          fields: "id,name,kind,format,category,options,disabled,report_schedule{id,frequency,next_scheduled_date}",
          order: "name(asc)", // /report_presets rejects the default order=id (422)
        });
        out.report_presets = presets.map((p: any) => ({
          id: p.id, name: p.name, kind: p.kind, format: p.format, category: p.category,
          disabled: p.disabled, options: p.options, report_schedule: p.report_schedule,
        }));
      } catch (e: any) {
        out.report_presets = { error: e?.response?.status ?? String(e), detail: typeof e?.response?.data === "string" ? e.response.data.slice(0, 200) : undefined };
      }

      // 2) Report Schedules
      try {
        out.report_schedules = await fetchAllPages<any>("/report_schedules", {
          fields: "id,frequency,report_preset_id,next_scheduled_date,status,day_of_month,days_of_week",
        });
      } catch (e: any) {
        out.report_schedules = { error: e?.response?.status ?? String(e) };
      }

      // 3) /reports — break down by kind AND source (beta reports, if they land in
      // /reports at all, would show a non-"reports" source), plus recent revenue-kind
      // and completed-CSV reports.
      try {
        const reps = await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format,source,category,created_at", order: "name(asc)" });
        const byKind: Record<string, number> = {};
        const bySource: Record<string, number> = {};
        for (const r of reps) {
          byKind[r.kind ?? "?"] = (byKind[r.kind ?? "?"] || 0) + 1;
          bySource[r.source ?? "?"] = (bySource[r.source ?? "?"] || 0) + 1;
        }
        out.reports = {
          total: reps.length, by_kind: byKind, by_source: bySource,
          revenue_kind: reps.filter((r: any) => r.kind === "revenue").slice(0, 25)
            .map((r: any) => ({ id: r.id, name: r.name, state: r.state, format: r.format, source: r.source, created_at: r.created_at })),
          completed_csv: reps.filter((r: any) => r.state === "completed" && r.format === "csv").slice(0, 40)
            .map((r: any) => ({ id: r.id, name: r.name, kind: r.kind, source: r.source })),
        };
      } catch (e: any) {
        out.reports = { error: e?.response?.status ?? String(e) };
      }

      // 4) Quick guesses at any separate new-engine endpoints (likely 404 if beta-only).
      out.new_engine_guesses = [];
      for (const path of ["/custom_reports", "/reporting/custom_reports", "/insights"]) {
        try { await rawGetSingle(path, { limit: 1 }); out.new_engine_guesses.push({ path, status: 200 }); }
        catch (e: any) { out.new_engine_guesses.push({ path, status: e?.response?.status ?? "ERR" }); }
      }

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  // ============================================================
  // DIAGNOSTIC: compare_collection_methods  (read-only — writes nothing to the dashboard)
  // Confirms whether switching the Collection tab's default source from the Fee
  // Allocation report (current default, invoice-issue-date basis) to the dedicated
  // Realization report (now API-generatable — POST /reports {kind:"realization"}
  // completes reliably) would change the per-timekeeper Collected/Uncollected
  // HOURS. Generates BOTH reports for the month and runs the SAME aggregators the
  // Collection tab uses, returning a side-by-side with deltas and firm totals.
  // ============================================================
  diagnosticTool(server).tool(
    "compare_collection_methods",
    "Diagnostic (read-only; writes nothing to the dashboard). For a given month, generates BOTH the Realization report (kind=realization) and the issue-date Fee Allocation report, runs the exact aggregators the Collection tab uses (aggregateRealizationCollections vs aggregateFeeAllocationCollectionHrs), and returns a per-timekeeper side-by-side of Collected/Uncollected HOURS with deltas and firm totals. Use to confirm — against prior data — whether adopting the Realization report as the Collection tab's default source is authentic before switching it.",
    {
      year: z.coerce.number().describe("Year, e.g. 2026"),
      month: z.coerce.number().describe("Month number 1-12"),
    },
    async (p) => {
      try {
        const roster = FIRM_ROSTER;
        const nameToUid = new Map<string, number>(roster.map((r) => [r.name.toLowerCase(), r.user_id]));
        const monthStart = `${p.year}-${String(p.month).padStart(2, "0")}-01`;
        const endDay = new Date(p.year, p.month, 0).getDate();
        const monthEnd = `${p.year}-${String(p.month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;

        // Method A — Realization report (proposed authoritative source).
        let realizAgg: Record<number, RealizCollectionsAgg> = {};
        let realizMeta: any = null;
        let realizErr: string | undefined;
        try {
          const rr = await getRealizationReportCSV({ start_date: monthStart, end_date: monthEnd });
          realizAgg = aggregateRealizationCollections(rr.rows, nameToUid);
          realizMeta = { report_id: rr.report.id, kind: rr.report.kind, via: rr.report.via, rows: rr.rows.length };
        } catch (e: any) { realizErr = e?.message ?? String(e); }

        // Method B — Fee Allocation report, issue-date basis (current default).
        let feeAgg: Record<number, RealizCollectionsAgg> = {};
        let feeErr: string | undefined;
        try {
          const rows = await genFeeAllocationByMonth(p.year, p.month, { filterByPayment: false });
          feeAgg = aggregateFeeAllocationCollectionHrs(rows, roster);
        } catch (e: any) { feeErr = e?.message ?? String(e); }

        const round = (n: number) => Math.round((n ?? 0) * 100) / 100;
        const perTimekeeper = roster.map((r) => {
          const a = realizAgg[r.user_id] ?? { collectedHrs: 0, uncollectedHrs: 0 };
          const b = feeAgg[r.user_id] ?? { collectedHrs: 0, uncollectedHrs: 0 };
          return {
            initials: r.initials,
            name: r.name,
            realization: { collectedHrs: round(a.collectedHrs), uncollectedHrs: round(a.uncollectedHrs) },
            fee_allocation: { collectedHrs: round(b.collectedHrs), uncollectedHrs: round(b.uncollectedHrs) },
            delta: {
              collectedHrs: round(a.collectedHrs - b.collectedHrs),
              uncollectedHrs: round(a.uncollectedHrs - b.uncollectedHrs),
            },
          };
        });
        const sumHrs = (sel: (x: RealizCollectionsAgg) => number, agg: Record<number, RealizCollectionsAgg>) =>
          round(Object.values(agg).reduce((s, v) => s + sel(v), 0));
        const totals = {
          realization: { collectedHrs: sumHrs((v) => v.collectedHrs, realizAgg), uncollectedHrs: sumHrs((v) => v.uncollectedHrs, realizAgg) },
          fee_allocation: { collectedHrs: sumHrs((v) => v.collectedHrs, feeAgg), uncollectedHrs: sumHrs((v) => v.uncollectedHrs, feeAgg) },
        };
        return { content: [{ type: "text", text: JSON.stringify({
          period: { start: monthStart, end: monthEnd },
          note: "Realization = time-entry-date basis (proposed default); Fee Allocation = invoice-issue-date basis (current Collection-tab default). Non-zero deltas are expected where the two date bases disagree — use this to judge materiality against prior data before switching the default.",
          realization_report: realizMeta,
          realization_error: realizErr,
          fee_allocation_error: feeErr,
          totals,
          per_timekeeper: perTimekeeper,
        }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }], isError: true };
      }
    }
  );

  // ============================================================
  // Report Preset tooling (classic API): list presets + their options,
  // create a preset, and generate-on-demand from a preset. Beta custom
  // reports are backed by classic ReportPresets (a report_schedule points at
  // a report_preset_id), so generate_report_from_preset can produce that
  // report NOW — a normal /reports entry, downloadable, usable as
  // download_dashboard_update's revenue_report_id — without waiting on a schedule.
  // ============================================================
  server.tool(
    "list_report_presets",
    "List classic Clio Report Presets with their options (group_by, date_range, etc.). Beta custom reports are backed by presets too, so this reveals the exact options schema and the preset_id behind a scheduled/beta report. Read-only.",
    {},
    async () => {
      try {
        const presets = await fetchAllPages<any>("/report_presets", { fields: "id,name,kind,format,category,disabled,options", order: "name(asc)" });
        return { content: [{ type: "text", text: JSON.stringify(presets.map((p: any) => ({ id: p.id, name: p.name, kind: p.kind, format: p.format, category: p.category, disabled: p.disabled, options: p.options })), null, 2) }] };
      } catch (e: any) {
        // Fallback: the list endpoint may reject the `options` field; fetch options per-record.
        try {
          const presets = await fetchAllPages<any>("/report_presets", { fields: "id,name,kind,format,category,disabled", order: "name(asc)" });
          const detailed: any[] = [];
          for (const p of presets.slice(0, 25)) {
            try { const one = await rawGetSingle(`/report_presets/${p.id}`, { fields: "id,name,kind,format,options" }); detailed.push(one?.data ?? one); }
            catch { detailed.push({ id: p.id, name: p.name, kind: p.kind, options: "(options fetch failed)" }); }
          }
          return { content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }] };
        } catch (e2: any) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e2?.response?.status ?? String(e2), detail: typeof e2?.response?.data === "string" ? e2.response.data.slice(0, 300) : e2?.response?.data }, null, 2) }] };
        }
      }
    }
  );

  server.tool(
    "create_report_preset",
    "Create a classic Clio Report Preset (POST /report_presets). Provide kind (e.g. 'revenue'), format (default csv), and the kind-specific options object (group_by, date_range, start_date, end_date, kind). Returns the created preset or the API error detail. Model options on an existing preset from list_report_presets.",
    {
      name: z.string().describe("Preset name"),
      kind: z.string().describe("Report kind, e.g. 'revenue'"),
      format: z.string().default("csv").describe("csv | xlsx | pdf | html | json | zip"),
      options: z.record(z.string(), z.any()).describe("Options object, e.g. { date_range:'this_month', format:'csv', group_by:'user', kind:'revenue' }"),
    },
    async (p) => {
      try {
        const res = await rawPostSingle("/report_presets", { data: { name: p.name, kind: p.kind, format: p.format, options: p.options } });
        return { content: [{ type: "text", text: JSON.stringify(res?.data ?? res, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  server.tool(
    "generate_report_from_preset",
    "Generate a report on demand from a Report Preset (POST /report_presets/{id}/generate_report), poll until complete (bounded), and return the new report's id, state, and CSV header columns + first row so the grouping/columns can be verified. The returned report_id is a classic /reports id usable as download_dashboard_update's revenue_report_id. Use this to produce a beta/scheduled report's output NOW instead of waiting for its schedule.",
    {
      preset_id: z.coerce.number().describe("ReportPreset id (from list_report_presets, or a report_schedule's report_preset_id)"),
      poll_seconds: z.coerce.number().default(90).describe("Max seconds to poll for completion"),
    },
    async (p) => {
      try {
        const gen = await rawPostSingle(`/report_presets/${p.preset_id}/generate_report`, {});
        const rep = gen?.data ?? gen;
        const reportId = rep?.id;
        let state = rep?.state;
        const deadline = Date.now() + p.poll_seconds * 1000;
        while (reportId && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4000));
          try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,name,state,format,progress" }); state = (s?.data ?? s)?.state; }
          catch { break; }
        }
        let columns: string[] = [];
        let firstRow: any = null;
        if (state === "completed") {
          try { const rows = parseCSV(await downloadReport(reportId)); columns = rows[0] ? Object.keys(rows[0]) : []; firstRow = rows[0] ?? null; }
          catch { /* download/parse failed — state still reported */ }
        }
        return { content: [{ type: "text", text: JSON.stringify({ report_id: reportId, state, columns, firstRow }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  server.tool(
    "generate_classic_report",
    "Generate a classic Clio report on demand (POST /reports) with explicit parameters — kind, format, an explicit date range, and optional user / responsible_attorney scope — then poll to completion and return report_id, state, CSV columns, row count, and the first rows. Use to produce a per-timekeeper revenue report (kind='revenue', user_id=…, start_date/end_date for the target month) or a firm-wide one. The returned report_id can be passed to download_dashboard_update as revenue_report_id.",
    {
      kind: z.string().default("revenue").describe("Report kind, e.g. 'revenue', 'productivity_by_user'"),
      format: z.string().default("csv").describe("csv | xlsx | pdf | html | json | zip"),
      start_date: z.string().describe("Inclusive start date, YYYY-MM-DD"),
      end_date: z.string().describe("Inclusive end date, YYYY-MM-DD"),
      user_id: z.coerce.number().optional().describe("Scope to a single working timekeeper (for per-attorney revenue)"),
      responsible_attorney_id: z.coerce.number().optional().describe("Scope to a responsible attorney"),
      poll_seconds: z.coerce.number().default(120).describe("Max seconds to poll for completion"),
    },
    async (p) => {
      try {
        const data: any = { kind: p.kind, format: p.format, start_date: p.start_date, end_date: p.end_date };
        if (p.user_id) data.user = { id: p.user_id };
        if (p.responsible_attorney_id) data.responsible_attorney = { id: p.responsible_attorney_id };
        const gen = await rawPostSingle("/reports", { data });
        const rep = gen?.data ?? gen;
        const reportId = rep?.id;
        let state = rep?.state;
        const deadline = Date.now() + p.poll_seconds * 1000;
        while (reportId && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4000));
          try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,name,state,format,progress" }); state = (s?.data ?? s)?.state; }
          catch { break; }
        }
        let columns: string[] = [];
        let rowCount = 0;
        let sample: any[] = [];
        if (state === "completed") {
          try { const rows = parseCSV(await downloadReport(reportId)); rowCount = rows.length; columns = rows[0] ? Object.keys(rows[0]) : []; sample = rows.slice(0, 3); }
          catch { /* download/parse failed — state still reported */ }
        }
        return { content: [{ type: "text", text: JSON.stringify({ report_id: reportId, state, columns, rowCount, sample }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  server.tool(
    "get_report",
    "Fetch a Clio report by ID: returns its state/kind/format/source, and if completed and CSV, the columns, row count, and first rows. Decouples retrieval from generation — use it to pull a report that finished server-side after a generate call timed out, instead of regenerating (each regenerate spawns a new report). A completed CSV report's id can be passed to download_dashboard_update as revenue_report_id.",
    {
      report_id: z.coerce.number().describe("The Clio report id"),
      rows_sample: z.coerce.number().default(5).describe("How many CSV rows to return as a sample"),
    },
    async (p) => {
      try {
        const meta = await rawGetSingle(`/reports/${p.report_id}`, { fields: "id,name,state,kind,format,progress,source,category,created_at" });
        const m = meta?.data ?? meta;
        let columns: string[] = [];
        let rowCount = 0;
        let sample: any[] = [];
        if (m?.state === "completed" && m?.format === "csv") {
          try { const rows = parseCSV(await downloadReport(p.report_id)); rowCount = rows.length; columns = rows[0] ? Object.keys(rows[0]) : []; sample = rows.slice(0, p.rows_sample); }
          catch { /* download/parse failed — meta still returned */ }
        }
        return { content: [{ type: "text", text: JSON.stringify({ report: { id: m?.id, name: m?.name, state: m?.state, kind: m?.kind, format: m?.format, progress: m?.progress, source: m?.source, created_at: m?.created_at }, columns, rowCount, sample }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  // ============================================================
  // TOOL 4: download_dashboard_update
  // ============================================================
  server.tool(
    "download_dashboard_update",
    "Update Rachel's firm dashboard (the 'Claude Version 2' workbook in Box) for the specified month. Sources actual billed figures (billed $, write-offs, line discounts, billable hours — by timekeeper AND responsible attorney), not a hours×rate reconstruction. Revenue source, in priority order: (1) revenue_csv_box_file_id — a month×user 'Revenue Report (Like Classic)' CSV in Box (covers all YTD months in one file); (2) revenue_report_id — same month×user shape from Clio /reports; (3) DEFAULT — replicates Rachel's manual classic method: generates a per-timekeeper classic revenue report for each roster member plus one firm-wide report, for the TARGET MONTH only, on demand (revenue honors the date range). Nonbillable category columns D/E/F/G come from a targeted /activities query on the admin matters (Biz Dev 00706 + Website 00316, Potential Clients 00050, CLE 00707, Other Admin 02888) — an informational breakdown only; TNB col H is the TOTAL of nonbillable time on the ADJUSTED basis: entries flagged non-billable in Clio, PLUS firm-internal time reclassified out of billable (see col I) — so col H can exceed D+E+F+G when internal matters outside the four categories carry flagged non-billable or firm-internal time; collections from per-month PAYMENT-FILTERED Fee Allocation reports (payment-received basis). The month×user sources rewrite all YTD months; the classic default writes the target month only (for hours/billed). Each nonbillable category is the time booked to its admin matter(s); Other Admin = matter 02888-Admin. Collections come from PAYMENT-FILTERED Fee Allocation reports (filter_by_payment=true) generated one-per-month — money actually received each month, FEES ONLY (Billed Time Collected; excludes collected expenses/interest/tax), allocated by working timekeeper (col N 'Collected Actual'), by RESPONSIBLE attorney (col S 'Collected Actual' under the Responsible Attorney group), and by ORIGINATING attorney (col V 'Originating'). Fees from billers / responsible / originating attorneys not on the roster are pooled into the 'NRB' row so Σ col N == Σ col S == Σ col V == firm fees. This is the payment-received basis: it captures payments on prior-year invoices; each month's report period is verified (assertReportPeriod) before it is written. Billed $ (col K) is on the INVOICE-ISSUE-DATE basis (the Billed Time that appeared on bills issued that month — issued invoices only, no unbilled WIP), from one per-month Fee Allocation report, with a configurable billing-month cutoff (billed_cutoff_day, default 0 = count each bill in its calendar issue month, matching Rachel; set N>0 to roll bills issued in the first N days of a month back into the prior month's run). Billable Hours (col I) is ALL hours WORKED that month whose Clio non_billable flag is false AND which are not FIRM-INTERNAL (activity/work-date basis, billed or not), minus ONLY Rachel's synthetic 1-hour contingency/flat fee-placeholder entries (single-hour billable-flagged entries whose rate doesn't match the timekeeper's standard hourly rate); real RATED worked time on contingency/flat matters still counts, and the fee dollars still count in col K and in collections. FIRM-INTERNAL (excluded from col I, moved into col H, when exclude_internal is true — the DEFAULT) means either (a) the matter's client is the firm itself, Romano & Sumner, LLC — the structural signal, catching 02888-Admin, 00050-Potential Clients and any future internal matter automatically — or (b) the entry is billable-flagged but carries rate 0 AND amount 0, the rate-based safety net. So the matter's CLIENT and the entry's RATE/AMOUNT ARE now consulted for billable classification; matter names, numbers, types and practice areas still never are. The adjustment MOVES hours from col I to col H, so col J (total worked) and the Utilization tab's Untracked column are unaffected. Set exclude_internal=false for the legacy flag-only col I. The PARALEGAL HOURS BONUS uses col I, so it is on the adjusted basis too — $0-rate and firm-internal hours do not count toward bonus hours. Each run logs the raw→adjusted col I delta per month. (fee_report_id is deprecated/ignored — the Collection tab now generates its own per-month report; see below.) By default writes ONLY the target month's hours/billable/billed/write-off/discount/collections columns in '26 Compare' (a STATIC monthly snapshot — prior closed months are never changed retroactively); pass backfill_ytd=true for a one-time historical rewrite of all YTD months. Then rebuilds the Bonus Config/Tracker and Attorney Performance tabs and versions the file back to Box. ALSO patches the 'Utilization' tab (billable = worked billable hours; nonbillable = flagged non-billable hours — the SAME figures as 26 Compare cols I and H, NOT the Client Activity Price==0 heuristic, which under-counted nonbillable and collapsed it to ~0; the Total and Untracked columns are recomputed from Billable+Nonbillable so they can't drift from the patched hours) and the 'Realization' tab (billed-nondiscounted/billed-discounted/unbilled hours, from auto-generated Clio Realization reports — one per month patched; $0-rate billable time and the synthetic 1-hour fee placeholders — the same matter-gated set col I backs out — are excluded from all three columns, and the result's realization_excluded_hours reports what was backed out per month) — pass client_activity_report_id to use a specific pre-generated Client Activity report for the Realization tab (target month only). ALSO patches the 'Collection' tab (Collected / Uncollected HOURS), derived by default from a SINGLE-MONTH Fee Allocation report per patched month (per-user Billed Hours allocated to collected vs uncollected by the Billed Time Collected/Outstanding dollar split) — per-month, NOT the old cumulative YTD report that summed every month into each block (the Feb/Mar blow-up); pass realization_report_id to instead source the target month from a specific pre-generated Realization report. All three rate tabs honor backfill_ytd: a normal run patches only the TARGET month's block, while backfill_ytd=true re-derives EVERY YTD month block (generating one Client Activity / Fee Allocation report per month) — use it for a one-time historical correction of stale months. Report generation (Client Activity for Util/Realiz) auto-retries on transient failures and each tab patches independently — a failure in one tab no longer aborts the others; the result reports per-tab status (ok/failed/skipped) and the report ids used. ALSO appends a 'Firm Average' summary table to the BOTTOM of the 'Utilization', 'Realization' and 'Collection' tabs (the Realization and Collection tables carry a 'data as of' date, because a maturing cohort read at two dates gives two different, both correct, numbers): one row per month with the firm-wide rate computed as the simple MEAN of the listed billers' own monthly rate (utilization = billable/available; realization = nondiscounted/total-billed), excluding inactive timekeepers (no hours / #DIV/0!). The Utilization table also includes a 'Firm Avg Util Goal' column — the mean of each biller's own utilization goal from the '2026 Goals' tab — so actual can be charted against goal. It is appended after the existing month blocks (never inserted mid-sheet, so the template's per-attorney formulas are untouched) and refreshed in place each run, and is regenerated as static values from the hour columns. The workbook is set to fully recalculate on open so the rate/total formulas refresh automatically. Pass revenue_report_id to force a specific revenue report if auto-selection picks the wrong one. If the Box upload fails, returns a short-lived direct_download_url (1-hour TTL) instead.",
    {
      month: z.coerce.number().describe("Month number (1-12)"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      revenue_report_id: z.coerce.number().optional().describe("Specific Clio report ID for the monthly classic Revenue Report (overrides auto-selection by header signature). Use when multiple revenue-style reports exist and the wrong one is being picked."),
      revenue_csv_box_file_id: z.string().optional().describe("Box file ID of a manually-exported month×user Revenue Report CSV (the beta 'Revenue Report (Like Classic)', grouped by Activity month + User). When set, the dashboard reads revenue from this Box CSV instead of Clio's /reports — the reliable path when the report lives in Clio's beta engine (no API) or the report-generation endpoint is flaky."),
      client_activity_report_id: z.coerce.number().optional().describe("Specific Clio report ID for the Client Activity report covering the target month (overrides auto-generation). Use when a Client Activity CSV has already been generated and you want to reuse it instead of POSTing a new one."),
      realization_report_id: z.coerce.number().optional().describe("Specific Clio report ID for the Realization report covering the target month (overrides auto-generation). The Realization report is the source for the Collection tab's Collected/Uncollected $ — pass this to reuse an existing report instead of POSTing a new one."),
      fee_report_id: z.coerce.number().optional().describe("Deprecated / ignored. Previously pinned a cumulative Fee Allocation report for the Collection tab's collected/uncollected HOURS split; the Collection tab now generates its own single-month Fee Allocation report for the target month. 26 Compare collections (cols N/S/V) always use per-month payment-filtered reports."),
      box_folder_id: z.string().optional().describe("Deprecated / ignored. The tool always versions the Claude Version 2 workbook in its fixed Box folder."),
      update_existing: z.boolean().optional().describe("Deprecated / ignored. The full dashboard update now always runs; this flag no longer changes behavior."),
      backfill_ytd: z.boolean().optional().describe("Controls the HOURS / issue-date BILLED $ snapshot only. When true, (re)writes those columns for EVERY year-to-date month block (Jan..target) — for HOURS only when a month×user revenue source is supplied (revenue_csv_box_file_id / revenue_report_id); the classic default only has the target month's hours. Use for a ONE-TIME historical correction (recommended: pass backfill_ytd=true together with revenue_csv_box_file_id). DEFAULT false: hours/billed are a STATIC monthly snapshot — only the TARGET month is written, so a closed month never changes retroactively. The 'Utilization' rate tab follows this same cadence (worked hours are final at month close). The 'Realization' and 'Collection' tabs do NOT — they ALWAYS rewrite every YTD month and ignore this flag, because both are cohorts whose SPLIT keeps moving after the month closes (Realization: unbilled work drains into billed/discounted over ~90 days; Collection: uncollected drains into collected as payments arrive). Writing either once at month close freezes it at its worst reading — measured on the prior hand-keyed workbook, March collection was recorded at 32.7% against an actual 91.0%. Refreshing is safe because it only reclassifies within a fixed month total, and each generates one Clio report per month. NOTE: COLLECTIONS (cols N/S/V) ignore this flag — they are ALWAYS refreshed for every YTD month (payment-date basis keeps moving via late payments/reversals/re-dates), so each payment is counted in exactly one month and never double-credited across a boundary."),
      realization_hours_source: z.enum(["realization", "client_activity"]).optional().describe("Source for the Realization tab's D/E/F hours. DEFAULT 'realization' — Clio's Realization report, which reports Billed Hours and Hours Discounted per time entry, so the discounted split comes from Clio rather than being inferred. 'client_activity' restores the previous derived split (a discount was inferred from Quantity*Price != Total on the ACTIVITY row) and exists only to diff one run against the old numbers before that path is removed: it CANNOT see invoice-level discounts and is known to under-report them badly (it recorded 0.0 discounted hours for a timekeeper in Jan/Feb/Mar 2026 where Clio's own figures showed 46.3). Do not use it to produce reported figures."),
      billed_cutoff_day: z.coerce.number().optional().describe("Billing-month cutoff day for the issue-date 'Billed $' column (default 0 = no roll-back: each bill is counted in its CALENDAR issue month, matching Rachel's reference). Set to a positive N to roll bills issued on days 1..N of a month back into the PRIOR month's billed total, so an end-of-month billing run that slips into the first days of the next month stays grouped together (e.g. N=7 ⇒ May 27–Jun 7 all count as May); if you do, run the month's snapshot after day N of the following month to capture those late-issued bills."),
      exclude_internal: z.boolean().optional().default(true).describe("Reclassify firm-internal time out of col I and into col H: matters whose client is the firm itself (Romano & Sumner, LLC), plus billable-flagged entries with rate 0 AND amount 0. Default true. Set false for the legacy flag-only col I (the pre-adjustment basis). Also governs the Utilization tab and the paralegal hours bonus, which both derive from col I. Ignored on the rate_tabs_only path, which reads col I/H straight off the sheet."),
      rate_tabs_only: z.boolean().optional().describe("RATE-TABS-ONLY refresh. When true, ONLY the 'Utilization', 'Realization', and 'Collection' tabs are rewritten for every month Jan..month, and NOTHING ELSE in the workbook is touched — 26 Compare, Bonus, Attorney Performance and all other sheets are preserved byte-for-byte. Utilization is sourced by READING 26 Compare's existing Billable (col I) / Nonbillable (col H) for each month (no /activities pull, no revenue report needed) and reshaping them (Billable, Nonbillable, Total=Billable+Nonbillable, Untracked=Available−Total) — so Utilization stays exactly consistent with 26 Compare. Realization comes from a per-month Realization report and Collection from a per-month Fee Allocation report (the same per-month sources the full build uses); both cover every month Jan..month. Use this to fix/backfill the rate tabs for closed months WITHOUT retroactively rewriting 26 Compare's frozen snapshots. Ignores backfill_ytd / revenue_csv_box_file_id / billed_cutoff_day (not relevant to this path). pass client_activity_report_id to reuse a pre-generated Client Activity report for the TARGET month's Realization."),
    },
    async (params) => {
      const jobId = `dash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const job: DashJob = { id: jobId, status: "running", started_at: new Date().toISOString() };
      dashboardJobs.set(jobId, job);
      pruneDashboardJobs();
      // Run detached so the MCP call returns immediately (the work outlasts the
      // ~180s client timeout). Result/error are recorded on the job for polling.
      (async () => {
      let _step = "init";
      try {
        const ROSTER = FIRM_ROSTER;
        // Collections (col N "Collected Actual" / col S responsible-attorney
        // "Collected Actual" / col V "Originating") are attributed across ALL 27
        // timekeeper rows in the sheet, not just the 12 comp-roster members —
        // each biller's row is filled individually. Hours/billed/bonus/perf
        // stay on FIRM_ROSTER (12). Billers with fees but no row fall into the NRB row.
        const COLL_ROSTER = COLLECTIONS_ROSTER;
        // STATIC SNAPSHOT semantics apply to the HOURS / BILLED columns only: by default
        // only the TARGET month's hours/billed are written so a closed month's snapshot
        // never changes retroactively. backfill_ytd=true rewrites every YTD month's
        // hours/billed (one-time historical correction). COLLECTIONS (col N/V) are exempt
        // — they're always refreshed for every YTD month (payment-date basis keeps moving),
        // regardless of backfill_ytd, so a re-dated payment is never double-counted.
        const backfillYtd = params.backfill_ytd === true;

        const monthNames = MONTH_NAMES_FULL;
        const monthName = monthNames[params.month - 1];
        const monthStart = `${params.year}-${String(params.month).padStart(2, "0")}-01`;
        const endDay = new Date(params.year, params.month, 0).getDate();
        const monthEnd = `${params.year}-${String(params.month).padStart(2, "0")}-${endDay}`;

        // ============================================================
        // RATE-TABS-ONLY refresh (rate_tabs_only=true)
        // ============================================================
        // Rewrite ONLY Utilization / Realization / Collection for Jan..month and
        // touch nothing else in the workbook. Utilization is sourced by READING
        // 26 Compare's existing Billable (col I) / Nonbillable (col H) — no
        // /activities pull, no revenue report — so it stays exactly consistent
        // with 26 Compare; Realization/Collection use their own per-month reports.
        // surgicalWriteXlsx only writes the sheets we return, so 26 Compare and
        // every other tab are preserved byte-for-byte.
        if (params.rate_tabs_only === true) {
          _step = "rate-tabs-only: loading workbook";
          const fileBuffer = await sanitizeXlsxBuffer(await downloadFromBox(FIRM_DASHBOARD_FILE_ID));
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(fileBuffer as any);
          const compareSheet = wb.getWorksheet("26 Compare");
          if (!compareSheet) throw new Error("Sheet '26 Compare' not found in dashboard workbook.");

          // 26 Compare hours by month name → initials → {billable (col I=9), nonbillable (col H=8)}.
          // Single pass: a month name in col B starts a block; any other non-empty
          // col B (e.g. "2026 Totals") ends it; data rows carry initials in col C.
          _step = "rate-tabs-only: reading 26 Compare hours";
          const monthNameSet = new Set(monthNames);
          const hoursByMonthName: Record<string, Record<string, { billable: number; nonbillable: number }>> = {};
          let curMonth: string | null = null;
          compareSheet.eachRow((row) => {
            const b = String(row.getCell(2).value ?? "").trim();
            if (monthNameSet.has(b)) { curMonth = b; (hoursByMonthName[b] ??= {}); return; }
            if (b) { curMonth = null; return; }
            if (!curMonth) return;
            const ini = String(row.getCell(3).value ?? "").trim().toUpperCase();
            if (!ini || hoursByMonthName[curMonth][ini]) return; // first row per initials wins
            const num = (c: number) => { const v = row.getCell(c).value; return typeof v === "number" ? v : (parseFloat(String(v)) || 0); };
            hoursByMonthName[curMonth][ini] = { billable: num(9), nonbillable: num(8) };
          });

          // Firm utilization goal from "2026 Goals" (col 3), for the Util firm-avg goal column.
          const goalsSheet = wb.getWorksheet("2026 Goals ") || wb.getWorksheet("2026 Goals");
          const utilGoals: number[] = [];
          if (goalsSheet) {
            for (let r = 3; r <= 15; r++) {
              const ini = String(goalsSheet.getRow(r).getCell(1).value ?? "").trim().toUpperCase();
              if (!ini || ini === "TOTAL") continue;
              const g = Number(goalsSheet.getRow(r).getCell(3).value) || 0;
              if (Number.isFinite(g) && g > 0) utilGoals.push(g);
            }
          }
          const firmUtilGoal = utilGoals.length ? utilGoals.reduce((s, v) => s + v, 0) / utilGoals.length : 0;

          _step = "rate-tabs-only: opening rate-tab XML";
          const origZip = await JSZip.loadAsync(fileBuffer);
          const compareSheetMap = await getZipSheetMap(origZip);
          const ssFile = origZip.file("xl/sharedStrings.xml");
          const sharedStrings = ssFile ? parseSharedStrings(await ssFile.async("string")) : [];

          const rosterRT = FIRM_ROSTER;
          const nameToUid = new Map<string, number>(rosterRT.map((r) => [r.name.toLowerCase(), r.user_id]));
          const initialsAliases: Record<string, string> = { JBP: "JPB" };
          const initialsToUid: Record<string, number> = {};
          for (const r of rosterRT) initialsToUid[r.initials.toUpperCase()] = r.user_id;
          const rtMonths = Array.from({ length: params.month }, (_, i) => i + 1);

          let utilXml: string | undefined, realizXml: string | undefined, collectionXml: string | undefined;
          let utilPatched = 0, realizPatched = 0, collectionPatched = 0;
          let clientActivityReportId: number | undefined;
          let clientActivityErr: string | undefined, realizationErr: string | undefined;
          const realizDollars: DollarsByMonth = {};
          // Per-month hours backed out of the Realization tab's D/E/F, for the result.
          const realizExcluded: Record<string, { zero_rate_hrs: number; placeholder_hrs: number }> = {};

          // -- Utilization -- from 26 Compare col I/H (read-only; no Clio pull)
          _step = "rate-tabs-only: patch Utilization";
          const utilPath = compareSheetMap["Utilization"];
          if (utilPath) {
            try {
              utilXml = await origZip.file(utilPath)!.async("string");
              for (const m of rtMonths) {
                const byIni = hoursByMonthName[monthNames[m - 1]];
                if (!byIni) continue;
                const byUid: UtilHours = {};
                for (const r of rosterRT) {
                  const h = byIni[r.initials.toUpperCase()];
                  if (h) byUid[r.user_id] = h;
                }
                const ensured = ensureTabMonthBlock(utilXml, MONTH_ABBRS[m - 1], sharedStrings, ["C", "D"], ["C", "D", "E", "G"]);
                utilXml = ensured.xml;
                if (ensured.created) console.log(`[dashboard] Utilization tab: generated new ${MONTH_ABBRS[m - 1]} block`);
                const res = patchUtilizationBlock(utilXml, MONTH_ABBRS[m - 1], sharedStrings, byUid, initialsToUid, initialsAliases);
                utilXml = res.xml;
                utilPatched += res.patched;
              }
              if (utilPatched > 0) utilXml = appendUtilizationFirmAvg(utilXml, sharedStrings, firmUtilGoal);
            } catch (e: any) {
              clientActivityErr = e?.message ?? String(e);
              console.error("[dashboard] rate-tabs-only Utilization failed:", clientActivityErr);
            }
          }

          // -- Realization -- per-month Realization report (all YTD months; see
          // the REFRESH POLICY note on the full-build path for why this tab can
          // never be a frozen snapshot).
          _step = "rate-tabs-only: patch Realization";
          const realizPath = compareSheetMap["Realization"];
          if (realizPath) {
            try { realizXml = await origZip.file(realizPath)!.async("string"); } catch { realizXml = undefined; }
          }
          if (realizXml) {
            // Fee placeholders to back out of D/E/F — the same matter-gated set
            // 26 Compare col I strips (see aggregateRealizationHours).
            const placeholderKeys = await feePlaceholderKeys(params.year, rtMonths, ROSTER);
            for (const m of rtMonths) {
              const mStart = `${params.year}-${String(m).padStart(2, "0")}-01`;
              const mEnd = `${params.year}-${String(m).padStart(2, "0")}-${String(new Date(params.year, m, 0).getDate()).padStart(2, "0")}`;
              try {
                const fetched = await fetchRealizationHours({
                  start_date: mStart, end_date: mEnd, nameToUid,
                  legacy: params.realization_hours_source === "client_activity",
                  clientActivityReportId: m === params.month ? params.client_activity_report_id : undefined,
                  placeholderKeys,
                });
                const agg = fetched.agg;
                realizExcluded[MONTH_ABBRS[m - 1]] = sumRealizExcluded(agg);
                if (Object.keys(fetched.dollars).length) realizDollars[m] = fetched.dollars;
                if (m === params.month && fetched.clientActivityReportId) clientActivityReportId = fetched.clientActivityReportId;
                const ensured = ensureTabMonthBlock(realizXml, MONTH_ABBRS[m - 1], sharedStrings, ["D", "E", "F"]);
                realizXml = ensured.xml;
                if (ensured.created) console.log(`[dashboard] Realization tab: generated new ${MONTH_ABBRS[m - 1]} block`);
                const block = findTabMonthBlock(realizXml, MONTH_ABBRS[m - 1], sharedStrings, ["D", "E", "F"]);
                if (!block) continue;
                for (const { row, ini } of block.attorneys) {
                  const uid = initialsToUid[initialsAliases[ini] ?? ini];
                  if (!uid) continue;
                  const a = agg[uid];
                  if (!a) continue;
                  realizXml = patchCell(realizXml, `D${row}`, round1(a.billedNondiscHrs));
                  realizXml = patchCell(realizXml, `E${row}`, round1(a.billedDiscHrs));
                  realizXml = patchCell(realizXml, `F${row}`, round1(a.unbilledHrs));
                  realizPatched++;
                }
              } catch (e: any) {
                const msg = `${MONTH_ABBRS[m - 1]}: ${e?.message ?? e}`;
                clientActivityErr = clientActivityErr ? `${clientActivityErr}; ${msg}` : msg;
                console.error(`[dashboard] rate-tabs-only Realization failed (${MONTH_ABBRS[m - 1]}):`, e?.message ?? e);
              }
            }
            if (realizPatched > 0) realizXml = appendRealizationFirmAvg(realizXml, sharedStrings, new Date().toISOString().slice(0, 10));
          }

          // -- Collection -- per-month Fee Allocation report (issue basis)
          _step = "rate-tabs-only: patch Collection";
          const collPath = compareSheetMap["Collection"];
          if (collPath) {
            try { collectionXml = await origZip.file(collPath)!.async("string"); } catch (e: any) { collectionXml = undefined; realizationErr = e?.message ?? String(e); }
          }
          if (collectionXml) {
            for (const m of rtMonths) {
              try {
                const rows = await genFeeAllocationByMonth(params.year, m, { filterByPayment: false });
                const collAgg = aggregateFeeAllocationCollectionHrs(rows, rosterRT);
                const ensured = ensureTabMonthBlock(collectionXml, MONTH_ABBRS[m - 1], sharedStrings, ["C", "D"]);
                collectionXml = ensured.xml;
                if (ensured.created) console.log(`[dashboard] Collection tab: generated new ${MONTH_ABBRS[m - 1]} block`);
                const block = findTabMonthBlock(collectionXml, MONTH_ABBRS[m - 1], sharedStrings, ["C", "D"]);
                if (!block) continue;
                for (const { row, ini } of block.attorneys) {
                  const uid = initialsToUid[initialsAliases[ini] ?? ini];
                  if (!uid) continue;
                  const c = collAgg[uid];
                  if (!c) continue;
                  collectionXml = patchCell(collectionXml, `C${row}`, round1(c.collectedHrs));
                  collectionXml = patchCell(collectionXml, `D${row}`, round1(c.uncollectedHrs));
                  collectionPatched++;
                }
              } catch (e: any) {
                const msg = `${MONTH_ABBRS[m - 1]}: ${e?.message ?? e}`;
                realizationErr = realizationErr ? `${realizationErr}; ${msg}` : msg;
                console.error(`[dashboard] rate-tabs-only Collection failed (${MONTH_ABBRS[m - 1]}):`, e?.message ?? e);
              }
            }
            if (collectionPatched > 0) {
              collectionXml = appendCollectionFirmAvg(collectionXml, sharedStrings, new Date().toISOString().slice(0, 10));
            }
          }

          // Write back ONLY the patched rate tabs. surgicalWriteXlsx leaves every
          // other sheet (26 Compare, Bonus, Attorney Performance, …) untouched.
          _step = "rate-tabs-only: surgical write + upload";
          const outputBuffer = await surgicalWriteXlsx(fileBuffer, (ST: StyleIndices) => {
            // CUR/DEC were absent here; the dollars tab needs currency, and a
            // placeholder left unsubstituted would ship a literal "__CUR__" as a
            // style id and corrupt the sheet.
            const subst = (xml: string): string => xml
              .split(`s="${STYLE_PCT}"`).join(`s="${ST.percent}"`)
              .split(`s="${STYLE_BOLD}"`).join(`s="${ST.bold}"`)
              .split(`s="${STYLE_GEN}"`).join(`s="${ST.general}"`)
              .split(`s="${STYLE_CUR}"`).join(`s="${ST.currency}"`)
              .split(`s="${STYLE_DEC}"`).join(`s="${ST.decimal}"`)
              .split(`s="${STYLE_CURB}"`).join(`s="${ST.currencyBold}"`)
              .split(`s="${STYLE_PCTB}"`).join(`s="${ST.percentBold}"`)
              .split(`s="${STYLE_HDR}"`).join(`s="${ST.header}"`);
            const out: Record<string, string> = {};
            if (utilXml && utilPatched > 0) out["Utilization"] = subst(utilXml);
            if (realizXml && realizPatched > 0) out["Realization"] = subst(realizXml);
            if (collectionXml && collectionPatched > 0) out["Collection"] = subst(collectionXml);
            const dollarsXml = buildRealizationDollarsSheet(
              realizDollars, rtMonths, rosterRT, new Date().toISOString().slice(0, 10));
            if (dollarsXml) out[REALIZATION_DOLLARS_TAB] = subst(dollarsXml);
            return out;
          }, new Set<string>());

          const result = await uploadToBox({
            buffer: outputBuffer,
            filename: `${params.year} Firm Dashboard - Claude Version 2.xlsx`,
            folderId: MONTHLY_MEASURABLES_FOLDER_ID,
            overwriteFileId: FIRM_DASHBOARD_FILE_ID,
          });

          const rtPayload: any = {
            mode: "rate_tabs_only",
            months: `${monthNames[0]}–${monthName}`,
            note: "Only Utilization / Realization / Collection were rewritten; 26 Compare and all other tabs were left untouched.",
            utilization_patched: utilPatched,
            realization_patched: realizPatched,
            realization_excluded_hours: realizExcluded,
            collection_patched: collectionPatched,
            collection_source: "fee_allocation_monthly",
            client_activity_report_id: clientActivityReportId,
            utilization_source: "26 Compare cols I/H (read-only)",
            tabs: {
              utilization: utilPatched > 0 ? "ok" : (clientActivityErr ? "failed" : "skipped"),
              realization: realizPatched > 0 ? "ok" : (clientActivityErr ? "failed" : "skipped"),
              collection: collectionPatched > 0 ? "ok" : (realizationErr ? "failed" : "skipped"),
            },
            ...(clientActivityErr ? { realization_error: clientActivityErr } : {}),
            ...(realizationErr ? { collection_error: realizationErr } : {}),
          };
          if (result.uploaded) { rtPayload.success = true; rtPayload.box_file_id = result.box_file_id; rtPayload.box_url = result.box_url; }
          else { rtPayload.success = false; rtPayload.direct_download_url = result.direct_download_url; rtPayload.reason = result.reason; }
          return { content: [{ type: "text" as const, text: JSON.stringify(rtPayload) }] };
        }

        type PerUserData = {
          // billableHrs (col I) / nonbillableHrs (col H) are split per entry by
          // Clio's non_billable flag — never by matter or rate.
          billableHrs: number; nonbillableHrs: number; billedHrs: number; unbilledHrs: number;
          // workedBillableHrs = billable hours WORKED that month — identical to col I.
          // Feeds the paralegal HOURS bonus, which rewards hours worked, not hours
          // billed on invoices.
          workedBillableHrs: number;
          // totalWorkedHrs = ALL hours worked that month by work date (col J anchor)
          // = billableHrs + nonbillableHrs (fee placeholders backed out).
          totalWorkedHrs: number;
          billableDollars: number; billedDollars: number; writeOffs: number; lineDiscounts: number;
          bizDev: number; potentialClients: number; cle: number; otherAdmin: number;
          indivCollected: number; respCollected: number; origCollected: number;
        };
        type MonthBundle = { month: number; monthName: string; data: Record<number, PerUserData>; respData: Record<number, { respHrs: number; respBilled: number }> };
        const newPerUser = (): PerUserData => ({
          billableHrs: 0, nonbillableHrs: 0, billedHrs: 0, unbilledHrs: 0, workedBillableHrs: 0,
          totalWorkedHrs: 0,
          billableDollars: 0, billedDollars: 0, writeOffs: 0, lineDiscounts: 0,
          bizDev: 0, potentialClients: 0, cle: 0, otherAdmin: 0,
          indivCollected: 0, respCollected: 0, origCollected: 0,
        });

        // ---- Revenue (billed hours/$, write-offs, discounts) by month×user ----
        // Extracted to src/dashboard/revenue.ts: a month×user CSV (Box or Clio)
        // when revenue_csv_box_file_id/revenue_report_id is given, else the default
        // classic per-timekeeper generation for the target month. Returns the indiv
        // (by working timekeeper) + responsible-attorney rollup maps + revMonths.
        _step = "building revenue (by month)";
        const { indivByMonth, respByMonth, revMonths, revLabel, useBeta } = await buildRevenueByMonth(
          { year: params.year, month: params.month, revenueCsvBoxFileId: params.revenue_csv_box_file_id, revenueReportId: params.revenue_report_id },
          ROSTER,
        );

        // Nonbillable categories (Biz Dev / Potential Clients / CLE / Other Admin),
        // by month×user, from a targeted /activities query on the admin matters.
        _step = "building nonbillable categories";
        const catByMonth = await buildNonbillableByMonth(params.year, params.month);

        // Months actually written for the HOURS / BILLED snapshot (cols D–M, Q/R):
        // target only (static snapshot), or all YTD when backfilling. These columns are
        // activity-/issue-date based and don't move once a month closes, so re-running a
        // prior month would needlessly disturb a frozen snapshot (and pull ~12 reports).
        const writeMonths = backfillYtd
          ? Array.from({ length: params.month }, (_, i) => i + 1)
          : [params.month];

        // COLLECTIONS (cols N/V) are different: they're payment-date based, and cash keeps
        // moving after a month closes (late payments, reversals, re-dates, re-allocations).
        // A payment that re-dates across a month boundary would be DOUBLE-COUNTED if the
        // prior month stayed frozen while the new month picked it up. So collections are
        // ALWAYS refreshed for every YTD month (by current payment date) — each payment
        // then lands in exactly one month. This is independent of backfill_ytd.
        const collMonths = Array.from({ length: params.month }, (_, i) => i + 1);

        // Billed $ (col K) on the INVOICE-ISSUE-DATE basis (what appeared on a bill
        // issued that month), bucketed by CALENDAR issue month by default
        // (billed_cutoff_day=0; set >0 to roll an end-of-month run forward into the
        // prior month — see buildMonthlyBilled): col K =
        // "Billed Time". (Billable Hours / col I is a WORKED-time figure — see the
        // assembly loop below — NOT this issue-date report.)
        _step = "building billed $ (issue-date)";
        const cutoffDay = params.billed_cutoff_day ?? 0;
        // Keyed by COLL_ROSTER (not just FIRM_ROSTER) so billers who have a row on the
        // chart but aren't on the comp roster (CWW, JAD, RT, ASI, …) resolve to their
        // OWN col K; firmByMonth still totals every row so the NRB remainder is exact.
        const { billedByMonth, firmByMonth: billedFirmByMonth } =
          await buildMonthlyBilled(params.year, params.month, COLL_ROSTER, { cutoffDay, months: writeMonths });
        console.log(`[Dashboard] billed-$ issue-date firm totals by month: ${JSON.stringify(Object.fromEntries(Object.entries(billedFirmByMonth).map(([m, v]) => [m, round2(v)])))}`);

        // Billable Hours (col I) = billable hours WORKED each month, summed from time
        // entries by work date (the firm's definition; reproduces the reference where
        // the Revenue Report's billed+unbilled overcounts). Real contingency/flat
        // worked time is included; only the 1h fee placeholders below are removed.
        _step = "building worked hours (time entries, flag + firm-internal split)";
        // Partitioned per entry by the same single decision the weekly goal
        // sheets use (see classifiedHours.ts): Clio's non_billable flag, PLUS the
        // firm-internal reclassification —
        //   billable    = non_billable === false AND not firm-internal (col I basis)
        //   nonbillable = non_billable === true, OR firm-internal      (col H)
        // where firm-internal means the matter's client is the firm itself
        // (Romano & Sumner, LLC) or the entry is billable-flagged with rate 0 AND
        // amount 0. The *Raw views are the legacy flag-only figures, kept only to
        // log how much the adjustment moved — cols H/I are written from the
        // ADJUSTED views.
        const {
          billable: workedBillableByMonth, nonbillable: workedNonbillableByMonth,
          billableRaw: workedBillableRawByMonth, internal: workedInternalByMonth,
        } = await buildWorkedHoursSplitByMonth(params.year, params.month, ROSTER, {
          months: writeMonths,
          excludeInternal: params.exclude_internal,
        });
        for (const m of writeMonths) {
          const internalFirm = Object.values(workedInternalByMonth[m] ?? {}).reduce((a, b) => a + b, 0);
          if (internalFirm > 0.05) {
            const rawFirm = Object.values(workedBillableRawByMonth[m] ?? {}).reduce((a, b) => a + b, 0);
            const adjFirm = Object.values(workedBillableByMonth[m] ?? {}).reduce((a, b) => a + b, 0);
            console.log(`[Dashboard] internal-time adjustment ${monthNames[m - 1]}: col I firm billable ${round1(rawFirm)}h raw → ${round1(adjFirm)}h adjusted (${round1(internalFirm)}h of firm-internal / $0 time moved to col H)`);
          }
        }

        // Synthetic 1-hour fee-placeholder hours (on contingency/flat matters) to back
        // out of col I and the paralegal hours bonus — these aren't real worked time.
        _step = "building excluded (fee-placeholder) hours";
        const excludedHrsByMonth = await buildExcludedHoursByMonth(params.year, params.month, ROSTER, { months: writeMonths });

        // ---- Assemble per-month bundles (only the months we have revenue for) ----
        const monthsData: MonthBundle[] = [];
        for (const m of revMonths) {
          const md: Record<number, PerUserData> = {};
          const mrd: Record<number, { respHrs: number; respBilled: number }> = {};
          for (const r of ROSTER) {
            const src = indivByMonth[m]?.[r.user_id];
            const cat = catByMonth[m]?.[r.user_id];
            const d = newPerUser();
            if (src) {
              d.writeOffs = src.writeOffs;       // col L — from Revenue Report
              d.lineDiscounts = src.lineDiscounts; // col M — from Revenue Report
            }
            // Billed $ (col K) = "Billed Time" on invoices issued this billing month.
            d.billedDollars = billedByMonth[m]?.[r.user_id] ?? 0;
            // Cols D–G = the four tracked admin categories (Rachel's breakdown of
            // admin-matter time). Informational only — the billable-vs-nonbillable
            // SPLIT below comes strictly from the entry-level non_billable flag, so
            // col H can exceed D+E+F+G when internal/other matters outside the four
            // categories carry flagged non-billable time (e.g. rated RomSum entries).
            d.bizDev = cat?.bizDev ?? 0;
            d.potentialClients = cat?.potentialClients ?? 0;
            d.cle = cat?.cle ?? 0;
            d.otherAdmin = cat?.otherAdmin ?? 0;
            // Hours columns, on the ADJUSTED basis — Clio's entry-level
            // non_billable flag PLUS the firm-internal reclassification. Matter
            // names/numbers/types are still never consulted; the matter's CLIENT
            // and the entry's rate/amount are:
            //   Nonbillable (col H) = hours where non_billable === true, plus
            //     firm-internal hours (client is the firm itself, or a
            //     billable-flagged entry with rate 0 AND amount 0).
            //   Billable (col I)    = hours where non_billable === false and the
            //     entry is not firm-internal, minus Rachel's synthetic 1-hour fee
            //     placeholders (excludedHrsByMonth — billable-flagged in Clio but
            //     not real worked time).
            //   Total worked (col J) = col H + col I (work-date basis, billed or
            //     not). The adjustment MOVES hours between H and I, so col J and
            //     the Utilization tab's Untracked column are unaffected by it.
            const excl = excludedHrsByMonth[m]?.[r.user_id] ?? 0;
            d.nonbillableHrs = workedNonbillableByMonth[m]?.[r.user_id] ?? 0;
            d.billableHrs = Math.max(0, (workedBillableByMonth[m]?.[r.user_id] ?? 0) - excl);
            d.totalWorkedHrs = d.billableHrs + d.nonbillableHrs;
            // Paralegal HOURS bonus uses the same figure as col I, so it is on
            // the ADJUSTED basis too: $0-rate and firm-internal hours do not
            // count toward bonus hours.
            d.workedBillableHrs = d.billableHrs;
            md[r.user_id] = d;
            mrd[r.user_id] = respByMonth[m]?.[r.user_id] ?? { respHrs: 0, respBilled: 0 };
          }
          monthsData.push({ month: m, monthName: monthNames[m - 1], data: md, respData: mrd });
        }
        console.log(`[Dashboard] revenue source: ${revLabel}; months_built=${monthsData.length}`);

        // Worked billable hours by monthName→initials, for the paralegal HOURS bonus
        // (which must use hours worked, not the issue-date billed hours now in col I).
        // Only covers months built this run; the bonus falls back to the sheet's col I
        // for any other month (run with backfill_ytd to cover all YTD months).
        const workedHrsByMonthIni: Record<string, Record<string, number>> = {};
        for (const b of monthsData) {
          const slot = (workedHrsByMonthIni[b.monthName] ??= {});
          for (const r of ROSTER) slot[r.initials.toUpperCase()] = b.data[r.user_id]?.workedBillableHrs ?? 0;
        }

        // The target-month bundle is used by the billed-$ content guard and the
        // Attorney Performance tab below.
        const targetBundle = monthsData.find((b) => b.month === params.month)!;

        // ---- HOURS RECONCILIATION LOG (cols I/H/J) ----
        // Cols I/H are split per entry by the non_billable flag, so col I + col H ==
        // col J holds by construction. What can still drift is Clio DATA HYGIENE:
        // compare the tracked admin-category sum (cols D–G, matter-based breakdown)
        // against flagged nonbillable (col H). Categories exceeding col H means
        // admin-matter time was logged WITHOUT the non_billable flag in Clio — the
        // sheet follows the flag (that time counts as billable), so the entries
        // should be fixed in Clio. Col H exceeding the categories is expected:
        // internal/other matters outside the four tracked categories (e.g. RomSum)
        // carry flagged non-billable time.
        {
          let firmTotal = 0;
          for (const r of ROSTER) {
            const d = targetBundle.data[r.user_id];
            if (!d) continue;
            firmTotal += d.totalWorkedHrs;
            const catSum = d.bizDev + d.potentialClients + d.cle + d.otherAdmin;
            if (catSum > d.nonbillableHrs + 0.05) {
              // Col H is now the ADJUSTED nonbillable, so admin-matter time
              // left unflagged in Clio is normally reclassified INTO col H by
              // rule (a) and no longer trips this guard. If it still trips, the
              // admin-category hours are on matters that are NOT owned by the
              // firm's own client — a matter-setup problem, not just a missing
              // entry flag.
              console.warn(`[Dashboard] hours reconcile ${r.initials} ${monthName}: admin-category hours ${round1(catSum)}h EXCEED adjusted nonbillable ${round1(d.nonbillableHrs)}h (Δ${round1(catSum - d.nonbillableHrs)}h) — admin-matter time that is neither flagged non-billable nor caught by the firm-internal rules. Check the entries' non_billable flag AND whether those admin matters are filed under the firm's own client in Clio.`);
            }
          }
          console.log(`[Dashboard] worked-hours firm total ${monthName}: ${round1(firmTotal)}h (col J basis = manual Activities total, fee placeholders backed out)`);
        }

        // Collections (cols N/S) are written per-month from the cumulative Fee
        // Allocation CSV AFTER the main write loop below — see the per-month
        // backfill block. They are intentionally NOT folded into the revenue
        // bundles (which are single-snapshot) to avoid stamping a YTD total into
        // a single month (the cause of the April==May duplication).

        // ---- UPDATE THE DASHBOARD IN BOX ----
        // The rich update always runs and always versions Claude Version 2 —
        // the legacy single-sheet build was retired so no call can overwrite
        // the dashboard with a stub. (update_existing / box_folder_id are kept
        // in the schema for backward compatibility but no longer change paths.)
        {
          const DASHBOARD_FILE_ID = "2199324794140"; // Claude Version 2
          _step = "downloading from Box";
          const fileBuffer = await sanitizeXlsxBuffer(await downloadFromBox(DASHBOARD_FILE_ID));
          _step = "loading workbook";
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(fileBuffer as any);
          _step = "getting 26 Compare sheet";

          const compareSheet = wb.getWorksheet("26 Compare");
          if (!compareSheet) throw new Error("Sheet '26 Compare' not found in dashboard workbook.");

          // ---- Helper: scan a month block in 26 Compare ----
          // The section label (month name or "2026 Totals") sits on the FIRST row
          // only; the rows below it have a blank col B. Data rows carry an initials
          // value in col C; the trailing blank-col-C row is the (unlabeled) SUM row.
          // A block runs from its label row down to the next label row / its SUM row.
          type MonthBlock = { firstRow: number; lastRow: number; sumRow: number; map: Record<string, number>; initials: string[] };
          function scanMonthBlock(sheet: ExcelJS.Worksheet, targetMonth: string): MonthBlock | null {
            let startRow = 0;
            sheet.eachRow((row, rowNum) => {
              if (startRow) return;
              if (String(row.getCell(2).value ?? "").trim() === targetMonth) startRow = rowNum;
            });
            if (!startRow) return null;
            const map: Record<string, number> = {};
            const initials: string[] = [];
            let firstRow = 0, lastRow = 0, sumRow = 0;
            const maxRow = sheet.rowCount;
            for (let rowNum = startRow; rowNum <= maxRow; rowNum++) {
              const row = sheet.getRow(rowNum);
              const bVal = String(row.getCell(2).value ?? "").trim();
              // A non-empty col B other than our label marks the next section — stop.
              if (rowNum !== startRow && bVal && bVal !== targetMonth) break;
              const cVal = String(row.getCell(3).value ?? "").trim();
              if (cVal) {
                if (!firstRow) firstRow = rowNum;
                if (!map[cVal.toUpperCase()]) { map[cVal.toUpperCase()] = rowNum; initials.push(cVal.toUpperCase()); }
                lastRow = rowNum;
              } else if (firstRow) {
                sumRow = rowNum; // first blank-col-C row after the data = SUM row; block ends
                break;
              }
            }
            return firstRow ? { firstRow, lastRow, sumRow, map, initials } : null;
          }

          // Scan January block (always exists)
          const janBlock = scanMonthBlock(compareSheet, "January");
          if (!janBlock) throw new Error("January block not found in 26 Compare.");

          _step = "creating month block";
          // ---- Create month block if it doesn't exist (overwrite approach) ----
          let monthBlock = scanMonthBlock(compareSheet, monthName);
          let blockCreated = false;

          // ---- Content guard against duplicating the prior month ----
          // In classic (target-month-only) mode, if the freshly-pulled target-month
          // billed $ matches the PRIOR month ALREADY in the sheet for every active
          // timekeeper, Clio returned the prior month's report (the April-into-May
          // bug). An exact full-roster match to the cent can't happen by chance, so
          // abort rather than write a duplicate month. (Belt-and-suspenders with
          // assertReportPeriod, which relies on Clio exposing the report period.)
          if (!useBeta && params.month >= 2) {
            const priorName = monthNames[params.month - 2];
            const priorBlock = scanMonthBlock(compareSheet, priorName);
            if (priorBlock) {
              let comparable = 0, identical = 0;
              for (const r of ROSTER) {
                const cur = round2(targetBundle.data[r.user_id]?.billedDollars ?? 0);
                const rowNum = priorBlock.map[r.initials.toUpperCase()];
                if (!rowNum) continue;
                const raw = compareSheet.getRow(rowNum).getCell(11).value; // col K = Billed $
                const prior = round2(typeof raw === "number" ? raw : parseFloat(String(raw)) || 0);
                if (cur > 0 && prior > 0) { comparable++; if (Math.abs(cur - prior) < 0.005) identical++; }
              }
              if (comparable >= 3 && identical === comparable) {
                throw new Error(
                  `Aborting: ${monthName} billed $ is identical to ${priorName} for all ${comparable} active timekeepers — ` +
                  `Clio returned the prior month's revenue instead of ${monthName}'s. No data was written. ` +
                  `Retry (Clio likely served a cached report), or pass the month×user Revenue CSV (revenue_csv_box_file_id) ` +
                  `or an explicit revenue_report_id generated for ${monthName}.`,
                );
              }
            }
          }

          if (!monthBlock) {
            throw new Error(`'${monthName}' block not found in '26 Compare'. The workbook pre-defines a labeled block for every month (Jan–Dec) plus '2026 Totals'; this tool only PATCHES existing blocks — it does not create them (in-place creation corrupted the Totals block). Add a row with '${monthName}' in column B with the timekeeper initials beneath it, then rerun.`);
          }

          const initialsRowMap = monthBlock.map;

          // ---- ALL YTD MONTHS ----
          // monthsData (months 1..target) was built upfront from the Revenue
          // Report + targeted nonbillable query. This loop writes the hours /
          // billable / billed / write-off / discount columns. Collections
          // (cols N=14, S=19, V=22) are written separately, per-month, in the
          // Fee-Allocation backfill block right after this loop.
          _step = "writing Clio data to 26 Compare (all months)";
          let tkUpdated = 0;
          let monthsSkipped = 0;
          for (const md of monthsData) {
            // Static snapshot: skip prior months unless explicitly backfilling.
            if (!backfillYtd && md.month !== params.month) continue;
            const block = md.month === params.month ? monthBlock : scanMonthBlock(compareSheet, md.monthName);
            if (!block) {
              console.warn(`[Dashboard] no month block for ${md.monthName} — skipping (run the tool with month=${md.month} to create it)`);
              monthsSkipped++;
              continue;
            }
            const rowMap = block.map;
            for (const r of ROSTER) {
              const row = rowMap[r.initials.toUpperCase()];
              if (!row) continue;
              const d = md.data[r.user_id];
              const rd = md.respData[r.user_id];
              const wsRow = compareSheet.getRow(row);
              // Hours / billable / billed — always rewritten (we have fresh per-month data)
              wsRow.getCell(4).value = round1(d.bizDev);
              wsRow.getCell(5).value = round1(d.potentialClients);
              wsRow.getCell(6).value = round1(d.cle);
              wsRow.getCell(7).value = round1(d.otherAdmin);
              // H = TOTAL flagged nonbillable (may exceed the D–G tracked categories
              // when internal/other matters carry flagged non-billable time).
              wsRow.getCell(8).value = round1(d.nonbillableHrs);
              wsRow.getCell(9).value = round1(d.billableHrs);
              wsRow.getCell(10).value = round1(d.billableHrs + d.nonbillableHrs);
              wsRow.getCell(11).value = round2(d.billedDollars);
              wsRow.getCell(12).value = round2(d.writeOffs);     // L = Write-offs (Credit Notes)
              wsRow.getCell(13).value = round2(d.lineDiscounts); // M = Line Discounts
              wsRow.getCell(17).value = round1(rd.respHrs);
              wsRow.getCell(18).value = round2(rd.respBilled);
              // Collections (cols N=14, S=19, V=22) are written in the per-month
              // Fee-Allocation backfill block below — not here.
              wsRow.commit();
              tkUpdated++;
            }
          }
          console.log(`[Dashboard] wrote tkUpdated=${tkUpdated} across months_processed=${monthsData.length - monthsSkipped} months_skipped=${monthsSkipped}`);

          // ---- PER-MONTH COLLECTIONS (payment-filtered Fee Allocation, all YTD months) ----
          // Payment-received basis: one PAYMENT-FILTERED Fee Allocation report per
          // month (filter_by_payment=true) = money actually received that month,
          // allocated by working timekeeper (User → col N=14 individual), by
          // Responsible Attorney (col S=19), and by Originating Attorney
          // (col V=22). This captures payments on prior-year
          // invoices and reconciles to Clio's Revenue Report; assertReportPeriod (in
          // genFeeAllocationByMonth) guards each month so a wrong-period report aborts.
          // Replaces the old cumulative issue-date split, which bucketed by invoice
          // issue month and dropped prior-year payments (~$326K low). The ExcelJS
          // write loop below AND the surgical compareXml patch both consume these
          // maps; the Bonus Tracker is derived from col N, so it picks these up too.
          _step = "generating payment-filtered Fee Allocation reports (per YTD month)";
          const {
            indivByMonth: indivCollByMonth, origByMonth: origCollByMonth,
            respByMonth: respCollByMonth,
            nonRosterIndivByMonth: nrbIndivByMonth, nonRosterOrigByMonth: nrbOrigByMonth,
            nonRosterRespByMonth: nrbRespByMonth,
            firmByMonth: collFirmFeesByMonth, firmYtd: collFirmYtd,
          } = await buildMonthlyCollections(params.year, params.month, COLL_ROSTER, { months: collMonths });
          console.log(`[Dashboard] FEES-ONLY collections built: firm YTD fees received=$${collFirmYtd.toFixed(2)} (Billed Time Collected; excludes expenses/interest/tax)`);
          // Collections write to: col N=14 "Collected Actual" (working timekeeper),
          // col S=19 "Collected Actual" under Responsible Attorney (responsible-attorney
          // rollup), col V=22 "Originating" (originating attorney). Non-roster billers /
          // responsible / originating attorneys go to the "NRB" row so
          // Σ col N == Σ col S == Σ col V == firm fees.
          let collCellsWritten = 0;
          for (let m = 1; m <= params.month; m++) {
            // No static-snapshot skip: collections are refreshed for every YTD month on
            // every run (payment-date basis), so a re-dated/reversed payment is counted
            // in exactly one month and never double-credited across a month boundary.
            const block = m === params.month ? monthBlock : scanMonthBlock(compareSheet, monthNames[m - 1]);
            if (!block) continue;
            for (const r of COLL_ROSTER) {
              const rowNum = block.map[r.initials.toUpperCase()];
              if (!rowNum) continue;
              const wsRow = compareSheet.getRow(rowNum);
              wsRow.getCell(14).value = round2(indivCollByMonth[m]?.[r.user_id] ?? 0); // N "Collected Actual"
              wsRow.getCell(19).value = round2(respCollByMonth[m]?.[r.user_id] ?? 0);  // S "Collected Actual" (Responsible)
              wsRow.getCell(22).value = round2(origCollByMonth[m]?.[r.user_id] ?? 0);  // V "Originating"
              wsRow.commit();
              collCellsWritten++;
            }
            // NRB ("Non-Roster Billers") line — aggregate collected fees from billers
            // not on the roster (col N), matters whose responsible attorney is not on
            // the roster (col S), and origination by non-roster attorneys (col V).
            const nrbRow = block.map["NRB"];
            if (nrbRow) {
              const wsRow = compareSheet.getRow(nrbRow);
              wsRow.getCell(14).value = round2(nrbIndivByMonth[m] ?? 0);
              wsRow.getCell(19).value = round2(nrbRespByMonth[m] ?? 0);
              wsRow.getCell(22).value = round2(nrbOrigByMonth[m] ?? 0);
              wsRow.commit();
              collCellsWritten++;
            } else if (Math.abs(nrbIndivByMonth[m] ?? 0) > 0.005 || Math.abs(nrbOrigByMonth[m] ?? 0) > 0.005 || Math.abs(nrbRespByMonth[m] ?? 0) > 0.005) {
              console.warn(`[Dashboard] ${monthNames[m - 1]}: non-roster collected fees (indiv=$${round2(nrbIndivByMonth[m] ?? 0)}, resp=$${round2(nrbRespByMonth[m] ?? 0)}, orig=$${round2(nrbOrigByMonth[m] ?? 0)}) have nowhere to go — add an 'NRB' row to this month block so cols N, S, and V reconcile.`);
            }
            // Reconciliation: Σ col N, Σ col S, and Σ col V (each roster + NRB) must
            // each equal the firm fees collected that month.
            const sumN = COLL_ROSTER.reduce((s, r) => s + (indivCollByMonth[m]?.[r.user_id] ?? 0), 0) + (nrbIndivByMonth[m] ?? 0);
            const sumS = COLL_ROSTER.reduce((s, r) => s + (respCollByMonth[m]?.[r.user_id] ?? 0), 0) + (nrbRespByMonth[m] ?? 0);
            const sumV = COLL_ROSTER.reduce((s, r) => s + (origCollByMonth[m]?.[r.user_id] ?? 0), 0) + (nrbOrigByMonth[m] ?? 0);
            const firm = collFirmFeesByMonth[m] ?? 0;
            if (Math.abs(sumN - firm) > 0.05 || Math.abs(sumS - firm) > 0.05 || Math.abs(sumV - firm) > 0.05) {
              console.warn(`[Dashboard] ${monthNames[m - 1]} collections reconciliation off: Σcol N=$${round2(sumN)} Σcol S=$${round2(sumS)} Σcol V=$${round2(sumV)} firm fees=$${round2(firm)}`);
            }
          }
          console.log(`[Dashboard] per-month collections written: cells=${collCellsWritten} months=1..${params.month} (always-refreshed, fees-only; col N indiv + col S responsible + col V originating)`);

          _step = "tracking bonus sheets for deletion";
          // ---- TRACK OLD BONUS SHEETS FOR DELETION ----
          // Don't remove from ExcelJS (causes writeBuffer crash) — surgical write handles deletion at zip level
          const sheetsToDelete = wb.worksheets.filter(ws => ws.name.toLowerCase().includes("bonus"));

          _step = "creating Bonus Config";
          // ---- CREATE / UPDATE BONUS CONFIG SHEET ----
          // Attribution model (FIRM_BONUS_ATTORNEYS, src/dashboard/bonus.ts):
          // partners credit own + paralegal collections (their base target carries
          // the para's salary); associates credit their own only. No associate
          // credit rolls up to a partner, and no MNH split.
          const BONUS_ATTORNEYS = FIRM_BONUS_ATTORNEYS;
          const FIRM_OVERHEAD = 500000;
          const NUM_ATTORNEYS = 5;
          const BRACKETS = [
            { width: 0, rate: 0 },     // Bracket 1: base target at 0%
            { width: 50000, rate: 0.05 },
            { width: 50000, rate: 0.10 },
            { width: Infinity, rate: 0.15 },
          ];

          // Read config from existing "Bonus Config" sheet if present, else create with defaults
          let configSheet = wb.getWorksheet("Bonus Config");
          let configAttorneys = BONUS_ATTORNEYS;
          let firmOverhead = FIRM_OVERHEAD;
          let numAttorneys = NUM_ATTORNEYS;

          if (configSheet) {
            // Read the existing sheet's rows, then RECONCILE against BONUS_ATTORNEYS
            // (reconcileBonusConfig): the roster and the associate/paralegal credit
            // lists come from the code (firm comp model — partners credit own +
            // paralegal collections only, with "SAB,AFL" keeping Anna's tail on
            // KES; associates credit their own only; no standalone JPB row), while
            // salary/paraSalary/legalAsst/payroll stay sheet-editable. Previously
            // the sheet was used verbatim and then rewritten from itself, so a
            // stale sheet overrode every code fix forever (PAR credited JPB; KES
            // credited TBS — double-counting an attorney with his own bonus row —
            // and lost AFL's tail).
            const readAttorneys: typeof BONUS_ATTORNEYS = [];
            for (let r = 5; r <= 11; r++) {
              const row = configSheet.getRow(r);
              const ini = String(row.getCell(1).value ?? "").trim().toUpperCase();
              if (!ini) continue;
              readAttorneys.push({
                ini,
                salary: Number(row.getCell(2).value) || 0,
                associate: String(row.getCell(3).value ?? "").trim().toUpperCase(),
                paralegal: String(row.getCell(4).value ?? "").trim().toUpperCase(),
                paraSalary: Number(row.getCell(5).value) || 0,
                legalAsst: Number(row.getCell(6).value) || 0,
                payroll: Number(row.getCell(7).value) || 0.17,
              });
            }
            const reconciled = reconcileBonusConfig(readAttorneys, BONUS_ATTORNEYS);
            configAttorneys = reconciled.attorneys;
            for (const note of reconciled.notes) console.warn(`[Dashboard] Bonus Config reconcile: ${note}`);
            firmOverhead = Number(configSheet.getRow(13).getCell(2).value) || FIRM_OVERHEAD;
            numAttorneys = Number(configSheet.getRow(14).getCell(2).value) || NUM_ATTORNEYS;
          } else {
            // Create Bonus Config with defaults
            configSheet = wb.addWorksheet("Bonus Config");
            configSheet.getRow(1).values = ["Bonus Configuration"];
            configSheet.getRow(1).font = { bold: true, size: 14 };
            configSheet.getRow(3).values = [];
            configSheet.getRow(4).values = ["Attorney", "Base Salary", "Associate", "Paralegal", "Para Salary", "Legal Asst", "Payroll %"];
            configSheet.getRow(4).font = { bold: true };
            for (let i = 0; i < BONUS_ATTORNEYS.length; i++) {
              const a = BONUS_ATTORNEYS[i];
              configSheet.getRow(5 + i).values = [a.ini, a.salary, a.associate, a.paralegal, a.paraSalary, a.legalAsst, a.payroll];
            }
            configSheet.getRow(13).values = ["Firm Overhead", FIRM_OVERHEAD];
            configSheet.getRow(13).font = { bold: true };
            configSheet.getRow(14).values = ["# of Attorneys", NUM_ATTORNEYS];
            configSheet.getRow(16).values = ["Bracket", "Width", "Rate"];
            configSheet.getRow(16).font = { bold: true };
            configSheet.getRow(17).values = [1, "Base Target", 0];
            configSheet.getRow(18).values = [2, 50000, 0.05];
            configSheet.getRow(19).values = [3, 50000, 0.10];
            configSheet.getRow(20).values = [4, "Unlimited", 0.15];
            configSheet.getRow(22).values = ["Partners credit own + paralegal collections; associates their own only"];
            configSheet.getRow(24).values = ["Paralegal Hours Bonus"];
            configSheet.getRow(24).font = { bold: true };
            configSheet.getRow(25).values = ["Min Hours", "Bonus"];
            configSheet.getRow(25).font = { bold: true };
            configSheet.getRow(26).values = [110, 100];
            configSheet.getRow(27).values = [121, 300];
            configSheet.getRow(28).values = [133, 500];
            configSheet.getRow(30).values = ["Paralegals: ACA, SAB, AKG"];
            configSheet.columns.forEach(col => { col.width = 16; });
          }

          _step = "computing bonus data";
          // ---- COMPUTE BONUS DATA ----
          // Gather individual collected (col N) from ALL existing month blocks
          const monthCollections: Record<string, Record<string, number>> = {}; // monthName -> initials -> collected
          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const block = scanMonthBlock(compareSheet, mn);
            if (!block) continue;
            monthCollections[mn] = {};
            for (const [ini, rowNum] of Object.entries(block.map)) {
              const val = compareSheet.getRow(rowNum).getCell(14).value; // col N
              monthCollections[mn][ini] = typeof val === "number" ? val : (parseFloat(String(val)) || 0);
            }
          }

          // Per-attorney bonus math — pure, extracted to src/dashboard/bonus.ts (unit-tested).
          const bonusData = computeBonusData(monthCollections, configAttorneys, {
            firmOverhead, numAttorneys, brackets: BRACKETS, mnhSplitAmong: MNH_SPLIT_AMONG,
          });

          _step = "creating Bonus Tracker";
          // ---- CREATE BONUS TRACKER SHEET ----
          let trackerSheet = wb.getWorksheet("Bonus Tracker");
          if (trackerSheet) wb.removeWorksheet(trackerSheet.id);
          trackerSheet = wb.addWorksheet("Bonus Tracker");

          const attys = configAttorneys;
          const colsPerAtty = 4; // Collections, YTD, Bonus Earned, Cum Bonus
          const startCol = 2; // Col B onwards (Col A = month labels)

          // Row 1: Title
          trackerSheet.getRow(1).getCell(1).value = `${params.year} Bonus Tracker`;
          trackerSheet.getRow(1).getCell(1).font = { bold: true, size: 14 };

          // Row 3: Attorney headers (merged across 4 cols each)
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            trackerSheet.getRow(3).getCell(col).value = attys[ai].ini;
            trackerSheet.getRow(3).getCell(col).font = { bold: true, size: 12 };
          }

          // Row 4: Sub-headers
          trackerSheet.getRow(4).getCell(1).value = "Month";
          trackerSheet.getRow(4).getCell(1).font = { bold: true };
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            trackerSheet.getRow(4).getCell(col).value = "Collections";
            trackerSheet.getRow(4).getCell(col + 1).value = "YTD";
            trackerSheet.getRow(4).getCell(col + 2).value = "Bonus";
            trackerSheet.getRow(4).getCell(col + 3).value = "Cum Bonus";
          }
          trackerSheet.getRow(4).font = { bold: true };

          // Rows 5-16: Monthly data
          for (let mi = 0; mi < 12; mi++) {
            const rowNum = 5 + mi;
            const row = trackerSheet.getRow(rowNum);
            row.getCell(1).value = monthNames[mi];
            for (let ai = 0; ai < attys.length; ai++) {
              const col = startCol + ai * colsPerAtty;
              const br = bonusData[attys[ai].ini]?.rows[mi];
              if (br && (br.collections > 0 || br.ytd > 0)) {
                row.getCell(col).value = br.collections;
                row.getCell(col + 1).value = br.ytd;
                row.getCell(col + 2).value = br.bonusEarned;
                row.getCell(col + 3).value = br.cumBonus;
              }
            }
            row.commit();
          }

          // Row 17: Totals
          const totalsRow = trackerSheet.getRow(17);
          totalsRow.getCell(1).value = "TOTAL";
          totalsRow.font = { bold: true };
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            const bd = bonusData[attys[ai].ini];
            if (bd) {
              const lastRow = bd.rows.filter(r => r.collections > 0).pop();
              totalsRow.getCell(col).value = bd.rows.reduce((s, r) => s + r.collections, 0);
              totalsRow.getCell(col + 1).value = lastRow?.ytd || 0;
              totalsRow.getCell(col + 2).value = bd.rows.reduce((s, r) => s + r.bonusEarned, 0);
              totalsRow.getCell(col + 3).value = lastRow?.cumBonus || 0;
            }
          }
          totalsRow.commit();

          // Row 19+: Summary block
          trackerSheet.getRow(19).getCell(1).value = "Attorney Summary";
          trackerSheet.getRow(19).getCell(1).font = { bold: true, size: 12 };
          const sumHeaders = ["Attorney", "Base Target", "YTD Collections", "Current Bracket", "To Next Bracket", "Total Bonus Earned", "Paid", "Balance"];
          trackerSheet.getRow(20).values = sumHeaders;
          trackerSheet.getRow(20).font = { bold: true };

          for (let ai = 0; ai < attys.length; ai++) {
            const row = trackerSheet.getRow(21 + ai);
            const bd = bonusData[attys[ai].ini];
            if (!bd) continue;
            const lastActive = bd.rows.filter(r => r.collections > 0).pop() || bd.rows[0];
            row.getCell(1).value = attys[ai].ini;
            row.getCell(2).value = bd.baseTarget;
            row.getCell(3).value = lastActive.ytd;
            row.getCell(4).value = lastActive.bracket;
            row.getCell(5).value = lastActive.toNext;
            row.getCell(6).value = lastActive.cumBonus;
            row.getCell(7).value = 0; // Paid — manually editable
            row.getCell(8).value = lastActive.cumBonus; // Balance = bonus - paid
            row.commit();
          }

          // Format currency columns for attorney section
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            for (const c of [col, col + 1, col + 2, col + 3]) {
              trackerSheet.getColumn(c).numFmt = '"$"#,##0.00';
            }
          }
          for (const c of [2, 3, 5, 6, 7, 8]) {
            trackerSheet.getColumn(c).numFmt = '"$"#,##0.00';
          }

          _step = "paralegal hours bonus";
          // ---- PARALEGAL HOURS BONUS SECTION ----
          const PARALEGALS = ["ACA", "SAB", "AKG"]; // AFL (Anna) replaced by SAB (Stacy); Anna stays in the rosters for history/tail collections
          const PARA_BONUS_TIERS = [
            { minHours: 133, bonus: 500 },
            { minHours: 121, bonus: 300 },
            { minHours: 110, bonus: 100 },
          ];

          // Paralegal hours bonus rewards hours WORKED, not the issue-date billed hours
          // in col I. Use this run's in-memory worked-hours for months built now; for any
          // other month fall back to the sheet's col I (legacy/best-available).
          const monthBillableHrs: Record<string, Record<string, number>> = {}; // month -> initials -> WORKED hours
          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const block = scanMonthBlock(compareSheet, mn);
            if (!block) continue;
            monthBillableHrs[mn] = {};
            for (const [ini, rowNum] of Object.entries(block.map)) {
              const worked = workedHrsByMonthIni[mn]?.[ini];
              if (worked != null) { monthBillableHrs[mn][ini] = worked; continue; }
              const val = compareSheet.getRow(rowNum).getCell(9).value; // col I fallback
              monthBillableHrs[mn][ini] = typeof val === "number" ? val : (parseFloat(String(val)) || 0);
            }
          }

          const paraStartRow = 21 + attys.length + 2;
          trackerSheet.getRow(paraStartRow).getCell(1).value = "Paralegal Hours Bonus";
          trackerSheet.getRow(paraStartRow).getCell(1).font = { bold: true, size: 12 };

          // Sub-headers
          const paraHeaderRow = paraStartRow + 1;
          trackerSheet.getRow(paraHeaderRow).getCell(1).value = "Month";
          trackerSheet.getRow(paraHeaderRow).getCell(1).font = { bold: true };
          for (let pi = 0; pi < PARALEGALS.length; pi++) {
            const col = 2 + pi * 3;
            trackerSheet.getRow(paraStartRow).getCell(col).value = PARALEGALS[pi];
            trackerSheet.getRow(paraStartRow).getCell(col).font = { bold: true, size: 12 };
            trackerSheet.getRow(paraHeaderRow).getCell(col).value = "Worked Hrs";
            trackerSheet.getRow(paraHeaderRow).getCell(col + 1).value = "Tier";
            trackerSheet.getRow(paraHeaderRow).getCell(col + 2).value = "Bonus";
          }
          trackerSheet.getRow(paraHeaderRow).font = { bold: true };

          // Monthly rows
          const paraTotals: Record<string, { hours: number; bonus: number }> = {};
          for (const p of PARALEGALS) paraTotals[p] = { hours: 0, bonus: 0 };

          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const rowNum = paraHeaderRow + 1 + mi;
            const row = trackerSheet.getRow(rowNum);
            row.getCell(1).value = mn;

            for (let pi = 0; pi < PARALEGALS.length; pi++) {
              const col = 2 + pi * 3;
              const hrs = monthBillableHrs[mn]?.[PARALEGALS[pi]] || 0;
              if (hrs > 0) {
                // Determine bonus tier
                let bonus = 0;
                let tier = "-";
                for (const t of PARA_BONUS_TIERS) {
                  if (hrs >= t.minHours) { bonus = t.bonus; tier = `≥${t.minHours}`; break; }
                }
                row.getCell(col).value = round1(hrs);
                row.getCell(col + 1).value = tier;
                row.getCell(col + 2).value = bonus;
                paraTotals[PARALEGALS[pi]].hours += hrs;
                paraTotals[PARALEGALS[pi]].bonus += bonus;
              }
            }
            row.commit();
          }

          // Totals row
          const paraTotalRowNum = paraHeaderRow + 13;
          const paraTotalRow = trackerSheet.getRow(paraTotalRowNum);
          paraTotalRow.getCell(1).value = "TOTAL";
          paraTotalRow.font = { bold: true };
          for (let pi = 0; pi < PARALEGALS.length; pi++) {
            const col = 2 + pi * 3;
            paraTotalRow.getCell(col).value = round1(paraTotals[PARALEGALS[pi]].hours);
            paraTotalRow.getCell(col + 2).value = paraTotals[PARALEGALS[pi]].bonus;
          }
          paraTotalRow.commit();

          // Format paralegal bonus columns as currency
          for (let pi = 0; pi < PARALEGALS.length; pi++) {
            const col = 2 + pi * 3 + 2; // bonus column
            trackerSheet.getColumn(col).numFmt = '"$"#,##0';
          }

          trackerSheet.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

          _step = "deleting NAF tabs";
          // ---- DELETE OLD NAF TABS ----
          const nafSheets = wb.worksheets.filter(ws =>
            ws.name.includes("NAF(") || ws.name.includes("NAF Admin")
          );
          for (const ws of nafSheets) { sheetsToDelete.push(ws); }

          _step = "building Attorney Performance";
          // ---- ATTORNEY PERFORMANCE SHEET ----
          // Read 2026 Goals for per-attorney annual goals and billing rates
          const goalsSheet = wb.getWorksheet("2026 Goals ") || wb.getWorksheet("2026 Goals");
          const attyGoals: Record<string, { annualGoal: number; billingRate: number; availableHrs: number; utilGoal: number; realGoal: number; collGoal: number }> = {};
          if (goalsSheet) {
            for (let r = 3; r <= 15; r++) {
              const row = goalsSheet.getRow(r);
              const ini = String(row.getCell(1).value ?? "").trim().toUpperCase();
              if (!ini || ini === "TOTAL") continue;
              const availRaw = row.getCell(2).value;
              const availHrs = typeof availRaw === "object" && availRaw !== null && "result" in (availRaw as any)
                ? (availRaw as any).result : (typeof availRaw === "number" ? availRaw : 1880);
              const utilGoal = Number(row.getCell(3).value) || 0.75;
              const realGoal = Number(row.getCell(5).value) || 0.75;
              const collGoal = Number(row.getCell(7).value) || 0.75;
              const billingRate = Number(row.getCell(9).value) || 0;
              const goalRaw = row.getCell(10).value;
              const annualGoal = typeof goalRaw === "object" && goalRaw !== null && "result" in (goalRaw as any)
                ? (goalRaw as any).result : (typeof goalRaw === "number" ? goalRaw : 0);
              attyGoals[ini] = { annualGoal, billingRate, availableHrs: availHrs, utilGoal, realGoal, collGoal };
            }
          }

          // Read ALL columns from 26 Compare for each month (including L=write-offs, M=discounts)
          const monthFullData: Record<string, Record<string, {
            bizDev: number; potClients: number; cle: number; admin: number; tnb: number;
            billableHrs: number; totalHrs: number; billedAmt: number; writeOffs: number;
            discounts: number; collected: number;
          }>> = {};
          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const block = scanMonthBlock(compareSheet, mn);
            if (!block) continue;
            monthFullData[mn] = {};
            for (const [ini, rowNum] of Object.entries(block.map)) {
              const r = compareSheet.getRow(rowNum);
              const getNum = (col: number) => { const v = r.getCell(col).value; return typeof v === "number" ? v : (parseFloat(String(v)) || 0); };
              monthFullData[mn][ini] = {
                bizDev: getNum(4), potClients: getNum(5), cle: getNum(6), admin: getNum(7),
                tnb: getNum(8), billableHrs: getNum(9), totalHrs: getNum(10), billedAmt: getNum(11),
                writeOffs: getNum(12), discounts: getNum(13), collected: getNum(14),
              };
            }
          }

          // Create the sheet
          let perfSheet = wb.getWorksheet("Attorney Performance");
          if (perfSheet) wb.removeWorksheet(perfSheet.id);
          perfSheet = wb.addWorksheet("Attorney Performance");

          const PERF_HEADERS = [
            "Month", "BizDev", "Pot Clients", "CLE", "Admin", "TNB",
            "Billable Hrs", "Total Hrs", "Billed $", "Write-offs", "Discounts",
            "Collected", "Goal", "vs Goal",
            "Util Rate", "Util Goal", "Real Rate", "Real Goal", "Coll Rate", "Coll Goal",
          ];

          let perfRow = 1;
          perfSheet.getRow(perfRow).getCell(1).value = `${params.year} Attorney Performance`;
          perfSheet.getRow(perfRow).getCell(1).font = { bold: true, size: 14 };
          perfRow += 2;

          for (const r of ROSTER) {
            const goals = attyGoals[r.initials] || { annualGoal: 0, billingRate: 0, availableHrs: 1880, utilGoal: 0.75, realGoal: 0.75, collGoal: 0.75 };
            const monthlyGoal = round2(goals.annualGoal / 12);
            const monthlyAvail = round1(goals.availableHrs / 12);

            // Attorney header
            perfSheet.getRow(perfRow).getCell(1).value = `${r.name} (${r.initials})`;
            perfSheet.getRow(perfRow).getCell(1).font = { bold: true, size: 12 };
            perfRow++;

            // Column headers
            const hdrRow = perfSheet.getRow(perfRow);
            PERF_HEADERS.forEach((h, i) => { hdrRow.getCell(i + 1).value = h; });
            hdrRow.font = { bold: true };
            perfRow++;

            // Monthly data
            let ytdCollected = 0, ytdBilled = 0, ytdBillableHrs = 0;
            const dataStartRow = perfRow;

            for (let mi = 0; mi < 12; mi++) {
              const mn = monthNames[mi];
              const md = monthFullData[mn]?.[r.initials];
              const row = perfSheet.getRow(perfRow);
              row.getCell(1).value = mn;

              if (md && (md.billableHrs > 0 || md.collected > 0 || md.totalHrs > 0)) {
                ytdCollected += md.collected;
                ytdBilled += md.billedAmt;
                ytdBillableHrs += md.billableHrs;

                row.getCell(2).value = round1(md.bizDev);
                row.getCell(3).value = round1(md.potClients);
                row.getCell(4).value = round1(md.cle);
                row.getCell(5).value = round1(md.admin);
                row.getCell(6).value = round1(md.tnb);
                row.getCell(7).value = round1(md.billableHrs);
                row.getCell(8).value = round1(md.totalHrs);
                row.getCell(9).value = round2(md.billedAmt);
                row.getCell(10).value = round2(md.writeOffs);
                row.getCell(11).value = round2(md.discounts);
                row.getCell(12).value = round2(md.collected);
                row.getCell(13).value = monthlyGoal;
                row.getCell(14).value = round2(md.collected - monthlyGoal);

                const utilRate = monthlyAvail > 0 ? md.billableHrs / monthlyAvail : 0;
                row.getCell(15).value = round2(utilRate);
                row.getCell(16).value = goals.utilGoal;

                const expectedBilled = md.billableHrs * goals.billingRate;
                const realRate = expectedBilled > 0 ? md.billedAmt / expectedBilled : 0;
                row.getCell(17).value = round2(realRate);
                row.getCell(18).value = goals.realGoal;

                const collRate = md.billedAmt > 0 ? md.collected / md.billedAmt : 0;
                row.getCell(19).value = round2(collRate);
                row.getCell(20).value = goals.collGoal;
              }
              row.commit();
              perfRow++;
            }

            // Totals row
            const totRow = perfSheet.getRow(perfRow);
            totRow.getCell(1).value = "YTD";
            totRow.font = { bold: true };
            // Sum columns 2-12 from data rows
            for (let ci = 2; ci <= 12; ci++) {
              let sum = 0;
              for (let dr = dataStartRow; dr < dataStartRow + 12; dr++) {
                const v = perfSheet.getRow(dr).getCell(ci).value;
                if (typeof v === "number") sum += v;
              }
              totRow.getCell(ci).value = round2(sum);
            }
            totRow.getCell(13).value = round2(monthlyGoal * 12);
            totRow.getCell(14).value = round2(ytdCollected - goals.annualGoal);
            // Average rates
            const monthsWithData = Object.keys(monthFullData).filter(mn => monthFullData[mn]?.[r.initials]?.totalHrs > 0).length;
            if (monthsWithData > 0) {
              const avgUtil = monthlyAvail * monthsWithData > 0 ? ytdBillableHrs / (monthlyAvail * monthsWithData) : 0;
              totRow.getCell(15).value = round2(avgUtil);
              const expectedTotal = ytdBillableHrs * goals.billingRate;
              totRow.getCell(17).value = expectedTotal > 0 ? round2(ytdBilled / expectedTotal) : 0;
              totRow.getCell(19).value = ytdBilled > 0 ? round2(ytdCollected / ytdBilled) : 0;
            }
            totRow.commit();
            perfRow += 2; // gap before next attorney
          }

          // Format currency columns
          for (const col of [9, 10, 11, 12, 13, 14]) {
            perfSheet.getColumn(col).numFmt = '"$"#,##0.00';
          }
          // Format rate columns as percentages
          for (const col of [15, 16, 17, 18, 19, 20]) {
            perfSheet.getColumn(col).numFmt = '0%';
          }
          perfSheet.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

          _step = "surgical write + upload";
          // ---- SAVE AND UPLOAD (direct XML, no ExcelJS write) ----
          // Style indices from the original 26 Compare sheet:
          const S = { monthStr: "369", initials: "170", hrs1: "311", hrs: "171", hrsFormula: "330", totalFormula: "327", currency: "172", writeoffs: "62", collected: "173", respHrs: "174", respBilled: "175", respColl: "176", bold: "1" };
          // Excel column letter for a 1-based column index. Must handle >26
          // (AA, AB, …): the Bonus Tracker lays out 7 attorneys × 4 cols and
          // runs past Z. The old `String.fromCharCode(64 + c)` produced bytes
          // like "[", "\\", "]" for cols 27-29, yielding invalid cell refs that
          // corrupt the workbook (and make ExcelJS throw "A Cell needs a Row").

          // --- 26 Compare: patch the original XML ---
          const origZip = await JSZip.loadAsync(fileBuffer);
          const compareSheetMap = await getZipSheetMap(origZip);
          const comparePath = compareSheetMap["26 Compare"];
          // Normalize the stored XML BEFORE patching (not only at save):
          // unique+sorted rows/cells and any historical malformation (e.g. the
          // pre-2026-07 patchCell cell-fusing damage) scrubbed, so the regex
          // patchers below always operate on well-formed rows. Idempotent —
          // the save path runs the same sanitize on the way out.
          let compareXml = sanitizeSheetXml(await origZip.file(comparePath)!.async("string"));
          // Resolve the workbook's shared-string table once — the Util/Realiz/
          // Collection tabs store col A month labels and col B initials as shared
          // strings, so findTabMonthBlock needs this to read them as text.
          const ssFile = origZip.file("xl/sharedStrings.xml");
          const sharedStrings = ssFile ? parseSharedStrings(await ssFile.async("string")) : [];


          // Patch existing month data cells (cells that already exist in the XML).
          // STATIC SNAPSHOT: only the target month is written unless backfill_ytd is
          // set (then every YTD month is rewritten). Mirrors the ExcelJS hours loop's
          // column rules. Collections (cols N=14, S=19, V=22) are patched separately below.
          // The target month's rows may not exist yet when blockCreated — in
          // that case patchCell is a no-op and the blockCreated section below
          // writes those rows.
          for (const md of monthsData) {
            if (!backfillYtd && md.month !== params.month) continue; // static snapshot
            const isTarget = md.month === params.month;
            const block = isTarget ? monthBlock : scanMonthBlock(compareSheet, md.monthName);
            if (!block) continue;
            const rowMap = block.map;
            for (const r of ROSTER) {
              const row = rowMap[r.initials.toUpperCase()];
              if (!row) continue;
              const d = md.data[r.user_id];
              const rd = md.respData[r.user_id];
              const patches: [number, number][] = [
                [4, round1(d.bizDev)], [5, round1(d.potentialClients)], [6, round1(d.cle)], [7, round1(d.otherAdmin)],
                [8, round1(d.nonbillableHrs)], // H = flagged nonbillable, not the D–G sum
                [9, round1(d.billableHrs)], [10, round1(d.billableHrs + d.nonbillableHrs)],
                [11, round2(d.billedDollars)],
                [12, round2(d.writeOffs)], [13, round2(d.lineDiscounts)],
                [17, round1(rd.respHrs)], [18, round2(rd.respBilled)],
              ];
              // Collections (col 14=N "Collected Actual", col 19=S responsible-attorney
              // "Collected Actual", col 22=V "Originating") are patched in the
              // dedicated per-month loop below — not here.
              for (const [col, val] of patches) {
                compareXml = patchCell(compareXml, `${colLetter(col)}${row}`, val);
              }
            }
          }

          // If month block was created, we need to add new rows to the XML
          if (blockCreated) {
            // Build new row XML strings for the April block
            const newRowsXml: string[] = [];
            for (const ini of janBlock.initials) {
              const row = initialsRowMap[ini];
              if (!row) continue;
              const rosterEntry = ROSTER.find(r => r.initials.toUpperCase() === ini);
              const d = rosterEntry ? targetBundle.data[rosterEntry.user_id] : null;
              const rd = rosterEntry ? targetBundle.respData[rosterEntry.user_id] : null;

              const cells = [
                xmlCell(`B${row}`, monthName, { style: S.monthStr }),
                xmlCell(`C${row}`, ini, { style: S.initials }),
                xmlCell(`D${row}`, d ? round1(d.bizDev) : 0, { style: S.hrs1 }),
                xmlCell(`E${row}`, d ? round1(d.potentialClients) : 0, { style: S.hrs }),
                xmlCell(`F${row}`, d ? round1(d.cle) : 0, { style: S.hrs }),
                xmlCell(`G${row}`, d ? round1(d.otherAdmin) : 0, { style: S.hrs }),
                // H = flagged nonbillable as a VALUE, not =SUM(D:G) — flagged time on
                // matters outside the four tracked categories must stay in col H.
                xmlCell(`H${row}`, d ? round1(d.nonbillableHrs) : 0, { style: S.hrsFormula }),
                xmlCell(`I${row}`, d ? round1(d.billableHrs) : 0, { style: S.hrsFormula }),
                xmlCell(`J${row}`, null, { style: S.totalFormula, formula: `H${row}+I${row}` }),
                xmlCell(`K${row}`, d ? round2(d.billedDollars) : 0, { style: S.currency }),
                xmlCell(`L${row}`, d ? round2(d.writeOffs) : 0, { style: S.writeoffs }),
                xmlCell(`M${row}`, d ? round2(d.lineDiscounts) : 0, { style: S.currency }),
                xmlCell(`N${row}`, d ? round2(d.indivCollected) : 0, { style: S.collected }),
                xmlCell(`Q${row}`, rd ? round1(rd.respHrs) : 0, { style: S.respHrs }),
                xmlCell(`R${row}`, rd ? round2(rd.respBilled) : 0, { style: S.respBilled }),
                xmlCell(`S${row}`, d ? round2(d.respCollected) : 0, { style: S.respColl }),
                xmlCell(`V${row}`, d ? round2(d.origCollected) : 0, { style: S.respColl }),
              ];
              newRowsXml.push(xmlRow(row, cells));
            }

            // Add SUM row for the month
            if (monthBlock.sumRow) {
              const sr = monthBlock.sumRow;
              const first = monthBlock.firstRow;
              const last = monthBlock.lastRow;
              const sumCells = [4,5,6,7,8,9,10,11,12,13,14,17,18,19,22].map(col =>
                xmlCell(`${colLetter(col)}${sr}`, null, { formula: `SUM(${colLetter(col)}${first}:${colLetter(col)}${last})` })
              );
              sumCells.unshift(xmlCell(`B${sr}`, monthName, { style: S.monthStr }));
              newRowsXml.push(xmlRow(sr, sumCells));
            }

            // Insert before </sheetData>
            compareXml = compareXml.replace("</sheetData>", newRowsXml.join("") + "</sheetData>");
          }

          // ---- PERSIST PER-MONTH COLLECTIONS to compareXml (cols N=14, S=19, V=22) ----
          // compareXml (the original sheet XML + patches) is what actually gets
          // saved — the ExcelJS edits above only feed the in-memory bonus-tracker
          // derivation and color-coding. One payment-filtered Fee Allocation report
          // per month = money actually received that month. FEES-ONLY (Billed Time
          // Collected): col N=14 "Collected Actual" (working timekeeper), col S=19
          // "Collected Actual" under Responsible Attorney (responsible-attorney
          // rollup), and col V=22 "Originating" (originating attorney); the "NRB"
          // row absorbs non-roster billers / responsible / originating so
          // Σ col N == Σ col S == Σ col V == firm fees. ALWAYS refreshed for every
          // YTD month (not a static snapshot) so payment-date drift never
          // double-credits across a boundary.
          // Runs after blockCreated so a fresh target block's cells exist.
          let collCellsPatched = 0;
          const collFirmByMonth: Record<number, number> = {};
          for (let m = 1; m <= params.month; m++) {
            // No static-snapshot skip: collections are refreshed for every YTD month on
            // every run (payment-date basis), so a re-dated/reversed payment is counted
            // in exactly one month and never double-credited across a month boundary.
            const blk = m === params.month ? monthBlock : scanMonthBlock(compareSheet, monthNames[m - 1]);
            if (!blk) continue;
            for (const r of COLL_ROSTER) {
              const row = blk.map[r.initials.toUpperCase()];
              if (!row) continue;
              const iv = round2(indivCollByMonth[m]?.[r.user_id] ?? 0);
              const rv = round2(respCollByMonth[m]?.[r.user_id] ?? 0);
              const ov = round2(origCollByMonth[m]?.[r.user_id] ?? 0);
              compareXml = patchCell(compareXml, `N${row}`, iv); // Collected Actual
              compareXml = patchCell(compareXml, `S${row}`, rv); // Collected Actual (Responsible)
              compareXml = patchCell(compareXml, `V${row}`, ov); // Originating
              collFirmByMonth[m] = round2((collFirmByMonth[m] ?? 0) + iv);
              collCellsPatched++;
            }
            const nrbRow = blk.map["NRB"];
            if (nrbRow) {
              const iv = round2(nrbIndivByMonth[m] ?? 0);
              const rv = round2(nrbRespByMonth[m] ?? 0);
              const ov = round2(nrbOrigByMonth[m] ?? 0);
              compareXml = patchCell(compareXml, `N${nrbRow}`, iv);
              compareXml = patchCell(compareXml, `S${nrbRow}`, rv);
              compareXml = patchCell(compareXml, `V${nrbRow}`, ov);
              collFirmByMonth[m] = round2((collFirmByMonth[m] ?? 0) + iv);
              collCellsPatched++;
            }
          }
          console.log(`[Dashboard] collections patched to compareXml: cells=${collCellsPatched} per-month-indiv-firm=${JSON.stringify(collFirmByMonth)}`);

          // ---- PER-MONTH BILLED $ : non-roster billers + NRB (col K=11) ----
          // Billed $ follows the SAME attribution rule as collections: a biller WITH a
          // row on the chart gets their own col K; every biller WITHOUT a row (and any
          // unknown biller) is pooled into the NRB row, so Σ col K == firm billed.
          // billedByMonth is keyed by COLL_ROSTER, so non-FIRM_ROSTER billers resolve to
          // their own rows; FIRM_ROSTER cells were already patched above (re-patched here
          // with the identical billedByMonth value — idempotent). STATIC SNAPSHOT: same
          // writeMonths gating as the main billed write (target month only unless
          // backfill_ytd), NOT the all-YTD collections cadence.
          let billedCellsPatched = 0;
          const billedColByMonth: Record<number, number> = {};
          for (const m of writeMonths) {
            const blk = m === params.month ? monthBlock : scanMonthBlock(compareSheet, monthNames[m - 1]);
            if (!blk) continue;
            let placed = 0;
            for (const r of COLL_ROSTER) {
              const row = blk.map[r.initials.toUpperCase()];
              if (!row) continue; // no row → absorbed by NRB via the remainder below
              const bv = round2(billedByMonth[m]?.[r.user_id] ?? 0);
              compareXml = patchCell(compareXml, `K${row}`, bv);
              placed = round2(placed + bv);
              billedCellsPatched++;
            }
            const nrbBilled = round2((billedFirmByMonth[m] ?? 0) - placed);
            const nrbRow = blk.map["NRB"];
            if (nrbRow) {
              compareXml = patchCell(compareXml, `K${nrbRow}`, nrbBilled);
              billedCellsPatched++;
            } else if (Math.abs(nrbBilled) > 0.005) {
              console.warn(`[Dashboard] ${monthNames[m - 1]}: non-roster billed $${nrbBilled} has nowhere to go — add an 'NRB' row so col K reconciles to firm billed $${round2(billedFirmByMonth[m] ?? 0)}.`);
            }
            billedColByMonth[m] = round2(placed + (nrbRow ? nrbBilled : 0));
          }
          console.log(`[Dashboard] billed-$ non-roster/NRB patched to compareXml: cells=${billedCellsPatched} per-month-col-K-total=${JSON.stringify(billedColByMonth)}`);

          // ============================================================
          // Patch Utilization / Realization tabs
          // ============================================================
          // The Realization tab needs per-time-entry billed/unbilled state plus the
          // line-discount split (Q*P vs Total), which the Client Activity report
          // provides. These tabs are month-blocked, so we patch EVERY month in
          // writeMonths — the target month only on a normal run, or all YTD when
          // backfill_ytd=true. (Before this, the rate tabs only ever patched the
          // single target month, so any month last written by older code — e.g. the
          // Collection Feb/Mar cumulative blow-up — stayed frozen and drifted from
          // Clio. Backfilling re-derives every YTD month from current per-month
          // sources.)
          _step = "patch util/realiz tabs";
          let utilXml: string | undefined, realizXml: string | undefined, collectionXml: string | undefined;
          let utilPatched = 0, realizPatched = 0, collectionPatched = 0;
          let clientActivityReportId: number | undefined;
          let clientActivityErr: string | undefined;
          let realizationReportId: number | undefined;
          let realizationHoursReportId: number | undefined;
          let realizationErr: string | undefined;
          let collectionSource: string | undefined;
          // Months to (re)write on the rate tabs: target only, or all YTD when
          // backfilling — identical to the HOURS/BILLED snapshot cadence.
          const rateTabMonths = writeMonths;
          // Map full name → user_id (case-insensitive). JBP/JPB initials alias
          // handled separately at row-match time.
          const nameToUid = new Map<string, number>(ROSTER.map(r => [r.name.toLowerCase(), r.user_id]));
          // Per-tab initials aliases. The Utilization tab has a typo: "JBP" instead
          // of "JPB" for Jonathan Barbee. Map both to JPB so the patch hits the
          // right row regardless.
          const initialsAliases: Record<string, string> = { JBP: "JPB" };
          const initialsToUid: Record<string, number> = {};
          for (const r of ROSTER) initialsToUid[r.initials.toUpperCase()] = r.user_id;
          const monthBounds = (m: number) => ({
            start: `${params.year}-${String(m).padStart(2, "0")}-01`,
            end: `${params.year}-${String(m).padStart(2, "0")}-${String(new Date(params.year, m, 0).getDate()).padStart(2, "0")}`,
          });

          // -- Utilization patch -- (cols C=billable, D=nonbillable, E=Total, G=Untracked)
          // Sourced from the SAME data as 26 Compare cols I (worked billable hours)
          // and H (flagged non-billable hours), NOT the Client Activity report — its
          // Price==0 nonbillable test missed rated non-billable time and collapsed
          // Utilization nonbillable to ~0; the flag-based nonbillableHrs is the
          // figure that already reconciles on 26 Compare. Total (E) and Untracked
          // (G) are rewritten from the patched figures so they can't drift from
          // Billable/Nonbillable (the partner rows had stale pre-fix Totals like Mar
          // PAR 282 vs the correct 252.8+70.6=323.4): Total = Billable + Nonbillable;
          // Untracked = max(0, Available − Total), reading the row's existing
          // Available (col F). The Utilization Rate (col H) is the template's own
          // =Billable/Available formula and is left untouched.
          const utilPath = compareSheetMap["Utilization"];
          if (utilPath) {
            try {
              utilXml = await origZip.file(utilPath)!.async("string");
              for (const m of rateTabMonths) {
                const bundle = monthsData.find((b) => b.month === m);
                if (!bundle) continue; // no hours data this month (classic default covers target only)
                const byUid: UtilHours = {};
                for (const r of ROSTER) {
                  const tb = bundle.data[r.user_id];
                  if (tb) byUid[r.user_id] = { billable: tb.billableHrs, nonbillable: tb.nonbillableHrs };
                }
                const ensured = ensureTabMonthBlock(utilXml, MONTH_ABBRS[m - 1], sharedStrings, ["C", "D"], ["C", "D", "E", "G"]);
                utilXml = ensured.xml;
                if (ensured.created) console.log(`[dashboard] Utilization tab: generated new ${MONTH_ABBRS[m - 1]} block`);
                const res = patchUtilizationBlock(utilXml, MONTH_ABBRS[m - 1], sharedStrings, byUid, initialsToUid, initialsAliases);
                utilXml = res.xml;
                utilPatched += res.patched;
              }
            } catch (e: any) {
              clientActivityErr = e?.message ?? String(e);
              console.error("[dashboard] Utilization tab patch failed:", clientActivityErr);
            }
          }

          // -- Realization patch -- (cols D/E/F = billed-nondisc/disc/unbilled hrs)
          // Per month, from an auto-generated REALIZATION report scoped to that
          // month (see aggregateRealizationHours for why the old Client Activity
          // split could not see discounts at all). Each month is fetched + patched
          // independently so one month's report failure doesn't abort the rest.
          //
          // REFRESH POLICY — this tab ALWAYS rewrites every YTD month, ignoring
          // backfill_ytd. It is not a static snapshot and cannot be: the tab is an
          // ACTIVITY-DATE cohort (the denominator D+E+F is the hours WORKED that
          // month, fixed at month close), and what moves afterward is the SPLIT —
          // F drains into D and E as bills go out, over roughly 90 days. Writing a
          // month once, shortly after it closes, freezes it at maximum unbilled,
          // i.e. permanently at its worst reading. Verified live 2026-08: the tab
          // carried 97.4 unbilled hours for MNH Jan–Jun while only 13.4 of that
          // work was still unbilled — 84 hours had been billed since those rows
          // were written. A refresh is safe precisely because the denominator is
          // fixed: re-running only reclassifies hours among D/E/F and cannot change
          // the month's total, which is what the static-snapshot rule protects.
          // (That rule stays right for BILLED $ — invoice-issue basis, genuinely
          // final at close. The Collection tab has the same maturity problem as
          // this one and is NOT yet changed.)
          const realizMonths = Array.from({ length: params.month }, (_, i) => i + 1);
          // Dollars for the "Realization ($)" tab, harvested from the SAME
          // per-month report rows as the hours above — no extra Clio call.
          const realizDollars: DollarsByMonth = {};
          // Per-month hours backed out of the Realization tab's D/E/F, for the result.
          const realizExcluded: Record<string, { zero_rate_hrs: number; placeholder_hrs: number }> = {};
          const realizPath = compareSheetMap["Realization"];
          if (realizPath) {
            try {
              realizXml = await origZip.file(realizPath)!.async("string");
            } catch (e: any) {
              realizXml = undefined;
              clientActivityErr = clientActivityErr ?? (e?.message ?? String(e));
            }
          }
          if (realizXml) {
            // Fee placeholders to back out of D/E/F — the same matter-gated set
            // 26 Compare col I strips (see aggregateRealizationHours).
            const placeholderKeys = await feePlaceholderKeys(params.year, realizMonths, ROSTER);
            for (const m of realizMonths) {
              const { start: mStart, end: mEnd } = monthBounds(m);
              try {
                const fetched = await fetchRealizationHours({
                  start_date: mStart, end_date: mEnd, nameToUid,
                  legacy: params.realization_hours_source === "client_activity",
                  clientActivityReportId: m === params.month ? params.client_activity_report_id : undefined,
                  // Same report kind and same month as the Collection tab's
                  // override, so reuse it instead of POSTing a duplicate.
                  realizationReportId: m === params.month ? params.realization_report_id : undefined,
                  placeholderKeys,
                });
                const agg = fetched.agg;
                realizExcluded[MONTH_ABBRS[m - 1]] = sumRealizExcluded(agg);
                if (Object.keys(fetched.dollars).length) realizDollars[m] = fetched.dollars;
                if (m === params.month) {
                  if (fetched.clientActivityReportId) clientActivityReportId = fetched.clientActivityReportId;
                  if (fetched.realizationReportId) realizationHoursReportId = fetched.realizationReportId;
                }
                const ensured = ensureTabMonthBlock(realizXml, MONTH_ABBRS[m - 1], sharedStrings, ["D", "E", "F"]);
                realizXml = ensured.xml;
                if (ensured.created) console.log(`[dashboard] Realization tab: generated new ${MONTH_ABBRS[m - 1]} block`);
                const block = findTabMonthBlock(realizXml, MONTH_ABBRS[m - 1], sharedStrings, ["D", "E", "F"]);
                if (!block) continue;
                for (const { row, ini } of block.attorneys) {
                  const uid = initialsToUid[initialsAliases[ini] ?? ini];
                  if (!uid) continue;
                  const a = agg[uid];
                  if (!a) continue;
                  realizXml = patchCell(realizXml, `D${row}`, round1(a.billedNondiscHrs));
                  realizXml = patchCell(realizXml, `E${row}`, round1(a.billedDiscHrs));
                  realizXml = patchCell(realizXml, `F${row}`, round1(a.unbilledHrs));
                  realizPatched++;
                }
              } catch (e: any) {
                const msg = `${MONTH_ABBRS[m - 1]}: ${e?.message ?? e}`;
                clientActivityErr = clientActivityErr ? `${clientActivityErr}; ${msg}` : msg;
                console.error(`[dashboard] Realization tab patch failed (${MONTH_ABBRS[m - 1]}):`, e?.message ?? e);
              }
            }
          }

          // ============================================================
          // Firm-average summary tables (Utilization / Realization)
          // ============================================================
          // Append a "Firm Average" table to the BOTTOM of each rate tab.
          // Utilization = the simple MEAN of the listed billers' own monthly rate
          // (billable/available), matching its goal column (mean of individual
          // goals). Realization = the same formula as an individual row applied
          // to the firm TOTALS (Σnondiscounted / Σtotal-billed) — a mean of
          // per-biller rates overweighted low-volume billers and overstated the
          // firm figure. It is
          // appended after the existing month blocks (never inserted mid-sheet,
          // so the template's per-attorney rate formulas are left untouched) and
          // refreshed in place each run via the marker below. Rates are recomputed
          // from the hour columns (concrete values) rather than read from the
          // rate-column FORMULAS, whose cached values are stale until Excel
          // recalculates on open. Inactive rows (no hours / #DIV/0!) are excluded
          // by the rate fns so they never drag the mean. Title row uses col A only
          // (col B blank) so a later scan treats it as a block terminator, and the
          // data rows carry month NAMES in col B (col A blank) so they are never
          // mistaken for new month-block headers.
          // Firm utilization goal = the simple mean of each biller's own
          // utilization goal from the "2026 Goals" tab (attyGoals, col 3 = util
          // goal). 0 when the goals tab wasn't found, in which case no goal column
          // is written. The summary append (strip prior marker → recompute the
          // per-month firm-mean rate from the hour columns → re-append) lives in
          // ../dashboard/rateTabs so the rate-tabs-only path shares it exactly.
          const utilGoalVals = Object.values(attyGoals).map((g) => g.utilGoal).filter((v) => Number.isFinite(v) && v > 0);
          const firmUtilGoal = utilGoalVals.length ? utilGoalVals.reduce((s, v) => s + v, 0) / utilGoalVals.length : 0;
          try {
            if (utilXml && utilPatched > 0) utilXml = appendUtilizationFirmAvg(utilXml, sharedStrings, firmUtilGoal);
            if (realizXml && realizPatched > 0) realizXml = appendRealizationFirmAvg(realizXml, sharedStrings, new Date().toISOString().slice(0, 10));
          } catch (e: any) {
            console.warn(`[dashboard] firm-average summary append skipped: ${e?.message ?? e}`);
          }

          // ============================================================
          // Patch Collection tab (Collected / Uncollected HOURS)
          // ============================================================
          // Per month, from a SINGLE-MONTH Fee Allocation report for that month
          // (filter_by_payment=false → invoices issued that month), whose per-User
          // Billed Hours are split into collected vs uncollected by the Billed Time
          // Collected/Outstanding dollar ratio. This replaces the old cumulative
          // (Jan 1 → report date) Fee Allocation CSV, which was summed with NO month
          // filter and wrote a running YTD total into each month's block (the Feb/Mar
          // blow-up). Each month is generated + patched independently so one month's
          // failure doesn't abort the rest. If realization_report_id is passed it
          // sources the TARGET month from that Realization report (it only covers the
          // target month).
          //
          // REFRESH POLICY — like the Realization tab, this ALWAYS rewrites every YTD
          // month and ignores backfill_ytd. The denominator (billed hours on invoices
          // issued that month) is fixed once the month closes, but the SPLIT keeps
          // moving for months as payments arrive: uncollected drains into collected.
          // Writing a month once, shortly after it closes, freezes it at maximum
          // uncollected — its worst possible reading. Measured against the prior
          // hand-keyed workbook, where each month was keyed near its close and never
          // revisited: Jan 81.5% vs 86.9% actual, Feb 64.6% vs 93.5%, and March 32.7%
          // vs 91.0% — a 58-point understatement, the gradient being simply how long
          // each month had to mature. A refresh is safe because it only reclassifies
          // hours between collected and uncollected; it cannot change the month's
          // total. 26 Compare's collections columns (N/S/V) already always refresh for
          // exactly this reason ("payment-date basis keeps moving"), and the
          // rate_tabs_only path already covered every month — this brings the full
          // build in line with both.
          _step = "patch collection (per-month fee allocation)";
          const collPath = compareSheetMap["Collection"];
          if (collPath) {
            try {
              collectionXml = await origZip.file(collPath)!.async("string");
            } catch (e: any) {
              collectionXml = undefined;
              realizationErr = e?.message ?? String(e);
            }
          }
          const collTabMonths = Array.from({ length: params.month }, (_, i) => i + 1);
          if (collectionXml) {
            for (const m of collTabMonths) {
              const { start: mStart, end: mEnd } = monthBounds(m);
              try {
                let collAgg: Record<number, RealizCollectionsAgg>;
                if (params.realization_report_id && m === params.month) {
                  const rr = await getRealizationReportCSV({ start_date: mStart, end_date: mEnd, reportId: params.realization_report_id });
                  realizationReportId = rr.report.id;
                  collectionSource = "realization_report";
                  collAgg = aggregateRealizationCollections(rr.rows, nameToUid);
                } else {
                  collectionSource = collectionSource === "realization_report" ? collectionSource : "fee_allocation_monthly";
                  const monthFeeRows = await genFeeAllocationByMonth(params.year, m, { filterByPayment: false });
                  collAgg = aggregateFeeAllocationCollectionHrs(monthFeeRows, ROSTER);
                }
                // -- Collection patch -- (cols C=collected hrs, D=uncollected hrs)
                const ensured = ensureTabMonthBlock(collectionXml, MONTH_ABBRS[m - 1], sharedStrings, ["C", "D"]);
                collectionXml = ensured.xml;
                if (ensured.created) console.log(`[dashboard] Collection tab: generated new ${MONTH_ABBRS[m - 1]} block`);
                const block = findTabMonthBlock(collectionXml, MONTH_ABBRS[m - 1], sharedStrings, ["C", "D"]);
                if (!block) continue;
                for (const { row, ini } of block.attorneys) {
                  const uid = initialsToUid[initialsAliases[ini] ?? ini];
                  if (!uid) continue;
                  const c = collAgg[uid];
                  if (!c) continue;
                  // Collection tab is in HOURS (collected / uncollected hrs).
                  collectionXml = patchCell(collectionXml, `C${row}`, round1(c.collectedHrs));
                  collectionXml = patchCell(collectionXml, `D${row}`, round1(c.uncollectedHrs));
                  collectionPatched++;
                }
              } catch (e: any) {
                const msg = `${MONTH_ABBRS[m - 1]}: ${e?.message ?? e}`;
                realizationErr = realizationErr ? `${realizationErr}; ${msg}` : msg;
                console.error(`[dashboard] Collection tab patch failed (${MONTH_ABBRS[m - 1]}):`, e?.message ?? e);
              }
            }
            if (collectionPatched > 0) {
              try {
                collectionXml = appendCollectionFirmAvg(collectionXml, sharedStrings, new Date().toISOString().slice(0, 10));
              } catch (e: any) {
                console.warn(`[dashboard] Collection firm-average append skipped: ${e?.message ?? e}`);
              }
            }
          }

          // --- Build new sheet XMLs from data ---
          // Bonus Config
          const configRows: string[] = [];
          configRows.push(xmlRow(1, [xmlCell("A1", "Bonus Configuration", { style: STYLE_BOLD })]));
          configRows.push(xmlRow(4, [
            xmlCell("A4", "Attorney",    { style: STYLE_BOLD }),
            xmlCell("B4", "Base Salary", { style: STYLE_BOLD }),
            xmlCell("C4", "Associate",   { style: STYLE_BOLD }),
            xmlCell("D4", "Paralegal",   { style: STYLE_BOLD }),
            xmlCell("E4", "Para Salary", { style: STYLE_BOLD }),
            xmlCell("F4", "Legal Asst",  { style: STYLE_BOLD }),
            xmlCell("G4", "Payroll %",   { style: STYLE_BOLD }),
          ]));
          for (let i = 0; i < configAttorneys.length; i++) {
            const a = configAttorneys[i];
            configRows.push(xmlRow(5 + i, [
              xmlCell(`A${5+i}`, a.ini,        { style: STYLE_BOLD }),
              xmlCell(`B${5+i}`, a.salary,     { style: STYLE_CUR }),
              xmlCell(`C${5+i}`, a.associate),
              xmlCell(`D${5+i}`, a.paralegal),
              xmlCell(`E${5+i}`, a.paraSalary, { style: STYLE_CUR }),
              xmlCell(`F${5+i}`, a.legalAsst,  { style: STYLE_CUR }),
              xmlCell(`G${5+i}`, a.payroll,    { style: STYLE_PCT }),
            ]));
          }
          configRows.push(xmlRow(13, [xmlCell("A13", "Firm Overhead",  { style: STYLE_BOLD }), xmlCell("B13", firmOverhead, { style: STYLE_CUR })]));
          configRows.push(xmlRow(14, [xmlCell("A14", "# of Attorneys", { style: STYLE_BOLD }), xmlCell("B14", numAttorneys)]));
          configRows.push(xmlRow(16, [xmlCell("A16", "Bracket", { style: STYLE_BOLD }), xmlCell("B16", "Width", { style: STYLE_BOLD }), xmlCell("C16", "Rate", { style: STYLE_BOLD })]));
          configRows.push(xmlRow(17, [xmlCell("A17", 1), xmlCell("B17", "Base Target"),                   xmlCell("C17", 0,    { style: STYLE_PCT })]));
          configRows.push(xmlRow(18, [xmlCell("A18", 2), xmlCell("B18", 50000, { style: STYLE_CUR }),     xmlCell("C18", 0.05, { style: STYLE_PCT })]));
          configRows.push(xmlRow(19, [xmlCell("A19", 3), xmlCell("B19", 50000, { style: STYLE_CUR }),     xmlCell("C19", 0.10, { style: STYLE_PCT })]));
          configRows.push(xmlRow(20, [xmlCell("A20", 4), xmlCell("B20", "Unlimited"),                     xmlCell("C20", 0.15, { style: STYLE_PCT })]));
          configRows.push(xmlRow(22, [xmlCell("A22", "Partners credit own + paralegal collections; associates their own only")]));
          configRows.push(xmlRow(24, [xmlCell("A24", "Paralegal Hours Bonus", { style: STYLE_BOLD })]));
          configRows.push(xmlRow(25, [xmlCell("A25", "Min Hours", { style: STYLE_BOLD }), xmlCell("B25", "Bonus", { style: STYLE_BOLD })]));
          configRows.push(xmlRow(26, [xmlCell("A26", 110), xmlCell("B26", 100, { style: STYLE_CUR })]));
          configRows.push(xmlRow(27, [xmlCell("A27", 121), xmlCell("B27", 300, { style: STYLE_CUR })]));
          configRows.push(xmlRow(28, [xmlCell("A28", 133), xmlCell("B28", 500, { style: STYLE_CUR })]));
          configRows.push(xmlRow(30, [xmlCell("A30", "Paralegals: ACA, SAB, AKG")]));
          // Column widths so the Bonus Config table reads cleanly.
          const bonusConfigXml = buildSheetXml(configRows, {
            cols: [
              { min: 1, max: 1, width: 16 },  // Attorney label / section names
              { min: 2, max: 2, width: 14 },  // Base Salary / etc.
              { min: 3, max: 4, width: 11 },  // Associate / Paralegal initials
              { min: 5, max: 5, width: 13 },  // Para Salary
              { min: 6, max: 6, width: 12 },  // Legal Asst
              { min: 7, max: 7, width: 11 },  // Payroll %
            ],
          });

          // Bonus Tracker
          // Layout: title row 1; attorney name headers row 3 (4 cols each);
          // sub-headers row 4 (Collections/YTD/Bonus/CumBonus); months rows
          // 5-16; Year Total row 17; Attorney Summary block starting row 19;
          // Paralegal Hours section follows. All $ cells use currency style,
          // all hours cells use decimal, headers/totals use bold.
          const trackerRows: string[] = [];
          trackerRows.push(xmlRow(1, [xmlCell("A1", `${params.year} Bonus Tracker`, { style: STYLE_BOLD })]));
          const xmlColsPerAtty = 4;
          const trackerHeaderCells: string[] = [];
          const trackerSubCells: string[] = [xmlCell("A4", "Month", { style: STYLE_BOLD })];
          for (let ai = 0; ai < attys.length; ai++) {
            const col = 2 + ai * xmlColsPerAtty;
            trackerHeaderCells.push(xmlCell(`${colLetter(col)}3`, attys[ai].ini, { style: STYLE_BOLD }));
            trackerSubCells.push(xmlCell(`${colLetter(col)}4`,   "Collections", { style: STYLE_BOLD }));
            trackerSubCells.push(xmlCell(`${colLetter(col+1)}4`, "YTD",         { style: STYLE_BOLD }));
            trackerSubCells.push(xmlCell(`${colLetter(col+2)}4`, "Bonus",       { style: STYLE_BOLD }));
            trackerSubCells.push(xmlCell(`${colLetter(col+3)}4`, "Cum Bonus",   { style: STYLE_BOLD }));
          }
          trackerRows.push(xmlRow(3, trackerHeaderCells));
          trackerRows.push(xmlRow(4, trackerSubCells));

          for (let mi = 0; mi < 12; mi++) {
            const rn = 5 + mi;
            const cells: string[] = [xmlCell(`A${rn}`, monthNames[mi])];
            for (let ai = 0; ai < attys.length; ai++) {
              const col = 2 + ai * xmlColsPerAtty;
              const br = bonusData[attys[ai].ini]?.rows[mi];
              if (br && (br.collections > 0 || br.ytd > 0)) {
                cells.push(xmlCell(`${colLetter(col)}${rn}`,   br.collections, { style: STYLE_CUR }));
                cells.push(xmlCell(`${colLetter(col+1)}${rn}`, br.ytd,         { style: STYLE_CUR }));
                cells.push(xmlCell(`${colLetter(col+2)}${rn}`, br.bonusEarned, { style: STYLE_CUR }));
                cells.push(xmlCell(`${colLetter(col+3)}${rn}`, br.cumBonus,    { style: STYLE_CUR }));
              }
            }
            trackerRows.push(xmlRow(rn, cells));
          }

          // Row 17: Year Total — sums collections + bonus, shows final YTD/CumBonus.
          const yearTotalCells: string[] = [xmlCell("A17", "Year Total", { style: STYLE_BOLD })];
          for (let ai = 0; ai < attys.length; ai++) {
            const col = 2 + ai * xmlColsPerAtty;
            const bd = bonusData[attys[ai].ini];
            if (!bd) continue;
            const yearColl  = round2(bd.rows.reduce((s, r) => s + r.collections, 0));
            const yearBonus = round2(bd.rows.reduce((s, r) => s + r.bonusEarned, 0));
            const finalYtd  = bd.rows.length ? bd.rows[bd.rows.length - 1].ytd      : 0;
            const finalCum  = bd.rows.length ? bd.rows[bd.rows.length - 1].cumBonus : 0;
            yearTotalCells.push(xmlCell(`${colLetter(col)}17`,   yearColl,  { style: STYLE_BOLD }));
            yearTotalCells.push(xmlCell(`${colLetter(col+1)}17`, finalYtd,  { style: STYLE_BOLD }));
            yearTotalCells.push(xmlCell(`${colLetter(col+2)}17`, yearBonus, { style: STYLE_BOLD }));
            yearTotalCells.push(xmlCell(`${colLetter(col+3)}17`, finalCum,  { style: STYLE_BOLD }));
          }
          trackerRows.push(xmlRow(17, yearTotalCells));

          // Summary section
          trackerRows.push(xmlRow(19, [xmlCell("A19", "Attorney Summary", { style: STYLE_BOLD })]));
          trackerRows.push(xmlRow(20, [
            xmlCell("A20", "Attorney",         { style: STYLE_BOLD }),
            xmlCell("B20", "Base Target",      { style: STYLE_BOLD }),
            xmlCell("C20", "YTD Collections",  { style: STYLE_BOLD }),
            xmlCell("D20", "Current Bracket",  { style: STYLE_BOLD }),
            xmlCell("E20", "To Next Bracket",  { style: STYLE_BOLD }),
            xmlCell("F20", "Total Bonus",      { style: STYLE_BOLD }),
            xmlCell("G20", "Paid",             { style: STYLE_BOLD }),
            xmlCell("H20", "Balance",          { style: STYLE_BOLD }),
          ]));
          for (let ai = 0; ai < attys.length; ai++) {
            const rn = 21 + ai;
            const bd = bonusData[attys[ai].ini];
            if (!bd) continue;
            const lastActive = bd.rows.filter(r => r.collections > 0).pop() || bd.rows[0];
            trackerRows.push(xmlRow(rn, [
              xmlCell(`A${rn}`, attys[ai].ini, { style: STYLE_BOLD }),
              xmlCell(`B${rn}`, bd.baseTarget,       { style: STYLE_CUR }),
              // Color YTD collections vs base target prorated to today (green = on
              // pace to clear the bonus threshold by year-end, amber within 10%, red below).
              xmlCell(`C${rn}`, lastActive.ytd,      { style: goalColorStyle(lastActive.ytd, bd.baseTarget * params.month / 12) }),
              xmlCell(`D${rn}`, lastActive.bracket),
              xmlCell(`E${rn}`, lastActive.toNext,   { style: STYLE_CUR }),
              xmlCell(`F${rn}`, lastActive.cumBonus, { style: STYLE_CUR }),
              xmlCell(`G${rn}`, 0,                   { style: STYLE_CUR }),
              xmlCell(`H${rn}`, lastActive.cumBonus, { style: STYLE_CUR }),
            ]));
          }

          // Paralegal section
          const paraStart = 21 + attys.length + 2;
          const paraHdr = paraStart + 1;
          // Row `paraStart`: section title + paralegal name headers.
          // Row `paraHdr`:   per-paralegal column sub-headers.
          // NB: each cell's ref row MUST match the row it's emitted in — a
          // cell like B30 inside <row r="31"> is invalid OOXML and Excel
          // discards the sheet's cell data ("Removed Records").
          const paraTitleCells: string[] = [xmlCell(`A${paraStart}`, "Paralegal Hours Bonus", { style: STYLE_BOLD })];
          const paraHdrCells: string[] = [xmlCell(`A${paraHdr}`, "Month", { style: STYLE_BOLD })];
          const XML_PARALEGALS = ["ACA", "SAB", "AKG"]; // keep in sync with PARALEGALS above (AFL replaced by SAB mid-2026)
          const XML_PARA_TIERS = [{ minHours: 133, bonus: 500 }, { minHours: 121, bonus: 300 }, { minHours: 110, bonus: 100 }];
          for (let pi = 0; pi < XML_PARALEGALS.length; pi++) {
            const col = 2 + pi * 3;
            paraTitleCells.push(xmlCell(`${colLetter(col)}${paraStart}`, XML_PARALEGALS[pi], { style: STYLE_BOLD }));
            paraHdrCells.push(xmlCell(`${colLetter(col)}${paraHdr}`,   "Worked Hrs", { style: STYLE_BOLD }));
            paraHdrCells.push(xmlCell(`${colLetter(col+1)}${paraHdr}`, "Tier",         { style: STYLE_BOLD }));
            paraHdrCells.push(xmlCell(`${colLetter(col+2)}${paraHdr}`, "Bonus",        { style: STYLE_BOLD }));
          }
          trackerRows.push(xmlRow(paraStart, paraTitleCells));
          trackerRows.push(xmlRow(paraHdr, paraHdrCells));

          for (let mi = 0; mi < 12; mi++) {
            const rn = paraHdr + 1 + mi;
            const cells: string[] = [xmlCell(`A${rn}`, monthNames[mi])];
            for (let pi = 0; pi < XML_PARALEGALS.length; pi++) {
              const col = 2 + pi * 3;
              const hrs = monthBillableHrs[monthNames[mi]]?.[XML_PARALEGALS[pi]] || 0;
              if (hrs > 0) {
                let bonus = 0, tier = "-";
                for (const t of XML_PARA_TIERS) { if (hrs >= t.minHours) { bonus = t.bonus; tier = `≥${t.minHours}`; break; } }
                cells.push(xmlCell(`${colLetter(col)}${rn}`,   round1(hrs), { style: STYLE_DEC }));
                cells.push(xmlCell(`${colLetter(col+1)}${rn}`, tier));
                cells.push(xmlCell(`${colLetter(col+2)}${rn}`, bonus,       { style: STYLE_CUR }));
              }
            }
            trackerRows.push(xmlRow(rn, cells));
          }
          // Column widths: A = month names (12), then for each of 7 attorneys
          // 4 cols × 13 chars wide ≈ $XX,XXX.XX fits comfortably.
          const trackerCols: Array<{ min: number; max: number; width: number }> = [{ min: 1, max: 1, width: 12 }];
          for (let ai = 0; ai < attys.length; ai++) {
            const colStart = 2 + ai * xmlColsPerAtty;
            trackerCols.push({ min: colStart, max: colStart + xmlColsPerAtty - 1, width: 13 });
          }
          // Freeze first column (A) and the first 4 rows (title + headers).
          const bonusTrackerXml = buildSheetXml(trackerRows, { cols: trackerCols, freezeRow: 4, freezeCol: 1 });

          // Attorney Performance
          const perfRows: string[] = [];
          perfRows.push(xmlRow(1, [xmlCell("A1", `${params.year} Attorney Performance`)]));
          const PERF_HDRS = ["Month","BizDev","Pot Clients","CLE","Admin","TNB","Billable Hrs","Total Hrs","Billed $","Write-offs","Discounts","Collected","Goal","vs Goal","Util Rate","Util Goal","Real Rate","Real Goal","Coll Rate","Coll Goal"];
          let pRow = 3;
          for (const r of ROSTER) {
            const goals = attyGoals[r.initials] || { annualGoal: 0, billingRate: 0, availableHrs: 1880, utilGoal: 0.75, realGoal: 0.75, collGoal: 0.75 };
            const monthlyGoal = round2(goals.annualGoal / 12);
            const monthlyAvail = round1(goals.availableHrs / 12);
            perfRows.push(xmlRow(pRow, [xmlCell(`A${pRow}`, `${r.name} (${r.initials})`)]));
            pRow++;
            perfRows.push(xmlRow(pRow, PERF_HDRS.map((h, i) => xmlCell(`${colLetter(i + 1)}${pRow}`, h))));
            pRow++;
            let ytdColl = 0, ytdBilled = 0, ytdBillHrs = 0;
            const dataStart = pRow;
            for (let mi = 0; mi < 12; mi++) {
              const mn = monthNames[mi];
              const md = monthFullData[mn]?.[r.initials];
              const cells: string[] = [xmlCell(`A${pRow}`, mn)];
              if (md && (md.billableHrs > 0 || md.collected > 0 || md.totalHrs > 0)) {
                ytdColl += md.collected; ytdBilled += md.billedAmt; ytdBillHrs += md.billableHrs;
                cells.push(xmlCell(`B${pRow}`, round1(md.bizDev)), xmlCell(`C${pRow}`, round1(md.potClients)),
                  xmlCell(`D${pRow}`, round1(md.cle)), xmlCell(`E${pRow}`, round1(md.admin)),
                  xmlCell(`F${pRow}`, round1(md.tnb)), xmlCell(`G${pRow}`, round1(md.billableHrs)),
                  xmlCell(`H${pRow}`, round1(md.totalHrs)), xmlCell(`I${pRow}`, round2(md.billedAmt)),
                  xmlCell(`J${pRow}`, round2(md.writeOffs)), xmlCell(`K${pRow}`, round2(md.discounts)),
                  xmlCell(`L${pRow}`, round2(md.collected)), xmlCell(`M${pRow}`, monthlyGoal),
                  xmlCell(`N${pRow}`, round2(md.collected - monthlyGoal)));
                const utilRate = monthlyAvail > 0 ? round2(md.billableHrs / monthlyAvail) : 0;
                const expectedBilled = md.billableHrs * goals.billingRate;
                const realRate = expectedBilled > 0 ? round2(md.billedAmt / expectedBilled) : 0;
                const collRate = md.billedAmt > 0 ? round2(md.collected / md.billedAmt) : 0;
                cells.push(xmlCell(`O${pRow}`, utilRate), xmlCell(`P${pRow}`, goals.utilGoal),
                  xmlCell(`Q${pRow}`, realRate), xmlCell(`R${pRow}`, goals.realGoal),
                  xmlCell(`S${pRow}`, collRate), xmlCell(`T${pRow}`, goals.collGoal));
              }
              perfRows.push(xmlRow(pRow, cells));
              pRow++;
            }
            // YTD row
            const ytdCells: string[] = [xmlCell(`A${pRow}`, "YTD")];
            ytdCells.push(xmlCell(`L${pRow}`, round2(ytdColl)), xmlCell(`M${pRow}`, round2(monthlyGoal * 12)),
              xmlCell(`N${pRow}`, round2(ytdColl - goals.annualGoal)));
            const mwd = Object.keys(monthFullData).filter(mn => monthFullData[mn]?.[r.initials]?.totalHrs > 0).length;
            if (mwd > 0) {
              ytdCells.push(xmlCell(`O${pRow}`, round2(monthlyAvail * mwd > 0 ? ytdBillHrs / (monthlyAvail * mwd) : 0)));
              const et = ytdBillHrs * goals.billingRate;
              ytdCells.push(xmlCell(`Q${pRow}`, et > 0 ? round2(ytdBilled / et) : 0));
              ytdCells.push(xmlCell(`S${pRow}`, ytdBilled > 0 ? round2(ytdColl / ytdBilled) : 0));
            }
            perfRows.push(xmlRow(pRow, ytdCells));
            pRow += 2;
          }
          const perfXml = buildSheetXml(perfRows);

          // ---- Color the 2026 Totals "Collected" cells (col N) on/off-goal ----
          // YTD collected (sum of monthly col N in compareSheet) vs the attorney's
          // annual collection goal (Totals col O) prorated to today. green/amber/red
          // placeholders are substituted with real style indices in buildSheets.
          _step = "color-coding 2026 Totals vs goal";
          try {
            const totalsBlock = scanMonthBlock(compareSheet, "2026 Totals");
            if (totalsBlock) {
              const monthsElapsed = params.month;
              for (const r of ROSTER) {
                const ini = r.initials.toUpperCase();
                const tRow = totalsBlock.map[ini];
                if (!tRow) continue;
                const annualGoal = Number(compareSheet.getRow(tRow).getCell(15).value) || 0; // col O
                if (annualGoal <= 0) continue;
                let ytd = 0;
                for (let m = 1; m <= monthsElapsed; m++) {
                  const mb = scanMonthBlock(compareSheet, monthNames[m - 1]);
                  const mrow = mb?.map[ini];
                  if (mrow) ytd += Number(compareSheet.getRow(mrow).getCell(14).value) || 0; // col N
                }
                const color = goalColorStyle(ytd, (annualGoal * monthsElapsed) / 12);
                if (color !== STYLE_CUR) compareXml = setCellStyle(compareXml, `N${tRow}`, color);
              }
            }
          } catch (e: any) { console.warn(`[Dashboard] 2026 Totals color-coding skipped: ${e?.message ?? e}`); }

          // --- Assemble and upload ---
          // Use placeholder styles, then replace after surgicalWriteXlsx injects real indices
          const deletedSheets = new Set(sheetsToDelete.map((ws: any) => ws.name));
          const outputBuffer = await surgicalWriteXlsx(fileBuffer, (ST: StyleIndices) => {
            // Post-process new sheet XMLs to apply style indices.
            // 1. Any <c r="…"> with no s="…" attribute gets the general style
            //    (prevents Excel from defaulting to the date format).
            // 2. Cells whose s="…" is one of our placeholders (__CUR__,
            //    __DEC__, __PCT__, __BOLD__, __GEN__) get rewritten to the
            //    real cellXfs index that surgicalWriteXlsx just injected.
            //    This is what lets us emit currency vs decimal vs percent
            //    cells per-call without threading ST through every helper.
            function addStyles(xml: string): string {
              xml = xml.replace(/<c r="([^"]+)">/g, (_, ref) => `<c r="${ref}" s="${ST.general}">`);
              xml = xml.split(`s="${STYLE_CUR}"`).join(`s="${ST.currency}"`);
              xml = xml.split(`s="${STYLE_DEC}"`).join(`s="${ST.decimal}"`);
              xml = xml.split(`s="${STYLE_PCT}"`).join(`s="${ST.percent}"`);
              xml = xml.split(`s="${STYLE_BOLD}"`).join(`s="${ST.bold}"`);
              xml = xml.split(`s="${STYLE_GEN}"`).join(`s="${ST.general}"`);
              return applyColors(xml);
            }
            // Substitute only the on/off-goal color placeholders. Used on the
            // rebuilt sheets (via addStyles) AND on the in-place 26 Compare XML,
            // whose Totals collected cells carry these placeholders.
            function applyColors(xml: string): string {
              return xml
                .split(`s="${STYLE_GREEN}"`).join(`s="${ST.green}"`)
                .split(`s="${STYLE_AMBER}"`).join(`s="${ST.amber}"`)
                .split(`s="${STYLE_RED}"`).join(`s="${ST.red}"`);
            }
            const out: Record<string, string> = {
              "26 Compare": applyColors(compareXml),  // original styles + on/off-goal color placeholders
              "Bonus Config": addStyles(bonusConfigXml),
              "Bonus Tracker": addStyles(bonusTrackerXml),
              "Attorney Performance": addStyles(perfXml),
            };
            // The patched Util/Realiz/Collection tabs are the ORIGINAL template
            // XML plus our edits, so we must NOT run the full addStyles (its
            // unstyled-cell regex would rewrite existing template cells). We only
            // resolve the placeholder style tokens our appended firm-average rows
            // carry; template cells never contain these sentinels, so this is a
            // no-op on them.
            const substTabPlaceholders = (xml: string): string => applyColors(
              xml
                .split(`s="${STYLE_PCT}"`).join(`s="${ST.percent}"`)
                .split(`s="${STYLE_BOLD}"`).join(`s="${ST.bold}"`)
                .split(`s="${STYLE_GEN}"`).join(`s="${ST.general}"`)
                .split(`s="${STYLE_CUR}"`).join(`s="${ST.currency}"`)
                .split(`s="${STYLE_DEC}"`).join(`s="${ST.decimal}"`)
                .split(`s="${STYLE_CURB}"`).join(`s="${ST.currencyBold}"`)
                .split(`s="${STYLE_PCTB}"`).join(`s="${ST.percentBold}"`)
                .split(`s="${STYLE_HDR}"`).join(`s="${ST.header}"`),
            );
            if (utilXml && utilPatched > 0) out["Utilization"] = substTabPlaceholders(utilXml);
            if (realizXml && realizPatched > 0) out["Realization"] = substTabPlaceholders(realizXml);
            if (collectionXml && collectionPatched > 0) out["Collection"] = substTabPlaceholders(collectionXml);
            const dollarsXml = buildRealizationDollarsSheet(
              realizDollars, realizMonths, ROSTER, new Date().toISOString().slice(0, 10));
            if (dollarsXml) out[REALIZATION_DOLLARS_TAB] = substTabPlaceholders(dollarsXml);
            return out;
          }, deletedSheets);
          const result = await uploadToBox({
            buffer: outputBuffer,
            filename: `${params.year} Firm Dashboard - Claude Version 2.xlsx`,
            folderId: MONTHLY_MEASURABLES_FOLDER_ID, // Traction > Measurables > Monthly Measureables
            overwriteFileId: DASHBOARD_FILE_ID,
          });

          const common = {
            updated_sheet: "26 Compare",
            month: monthName,
            year: params.year,
            timekeepers_updated: tkUpdated,
            months_processed: params.month - monthsSkipped,
            months_skipped: monthsSkipped,
            backfilled_through: `${monthNames[0]}–${monthName}`,
            block_created: blockCreated,
            bonus_tracker_rebuilt: true,
            attorneys_tracked: attys.length,
            utilization_patched: utilPatched,
            realization_patched: realizPatched,
            realization_excluded_hours: realizExcluded,
            collection_patched: collectionPatched,
            collection_source: collectionSource,
            client_activity_report_id: clientActivityReportId,
            realization_report_id: realizationReportId,
            realization_hours_source: params.realization_hours_source ?? "realization",
            realization_hours_report_id: realizationHoursReportId,
            realization_months_refreshed: `${monthNames[0]}–${monthName}`,
            // Per-tab status so a partial failure is visible (and which tab to retry).
            tabs: {
              utilization: utilPatched > 0 ? "ok" : (clientActivityErr ? "failed" : "skipped"),
              realization: realizPatched > 0 ? "ok" : (clientActivityErr ? "failed" : "skipped"),
              collection: collectionPatched > 0 ? "ok" : (realizationErr ? "failed" : "skipped"),
            },
            ...(clientActivityErr ? { client_activity_error: clientActivityErr } : {}),
            ...(realizationErr ? { collection_error: realizationErr } : {}),
          };

          if (result.uploaded) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  ...common,
                  box_file_id: result.box_file_id,
                  box_url: result.box_url,
                }),
              }],
            };
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                ...common,
                size_kb: result.size_kb,
                direct_download_url: result.direct_download_url,
                expires_at: result.expires_at,
                reason: result.reason,
                note: result.note,
              }),
            }],
          };
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, step: _step, message: err.message, stack: err.stack?.split("\n").slice(0, 5).join(" | ") }) }], isError: true };
      }
      })()
        .then((res: any) => { job.result = res; job.status = res?.isError ? "error" : "done"; job.finished_at = new Date().toISOString(); })
        .catch((err: any) => { job.status = "error"; job.error = String(err?.message ?? err); job.finished_at = new Date().toISOString(); });
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: jobId, status: "started", message: "Dashboard update is running in the background. Classic (default) mode takes ~1–5 min — it generates a revenue report per timekeeper. Poll get_dashboard_status with this job_id; the workbook versions in Box when done. (Tip: revenue_csv_box_file_id is much faster.)" }) }] };
    }
  );

  // ============================================================
  // get_dashboard_status — poll a download_dashboard_update background job
  // ============================================================
  server.tool(
    "get_dashboard_status",
    "Check a background job by job_id: returns running | done | error, timestamps, and (when finished) the full result or error. Poll this after calling download_dashboard_update or download_all_weekly_goals, which return immediately with a job_id.",
    { job_id: z.string().describe("The job_id returned by download_dashboard_update or download_all_weekly_goals") },
    async (p) => {
      const j = dashboardJobs.get(p.job_id);
      if (!j) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No job '${p.job_id}' found — it may have expired or the server restarted. Re-run the tool that started it.`, known_jobs: [...dashboardJobs.keys()] }) }] };
      }
      let result: any;
      const inner = j.result?.content?.[0]?.text;
      if (inner) { try { result = JSON.parse(inner); } catch { result = inner; } }
      const elapsed_s = Math.round(((j.finished_at ? new Date(j.finished_at).getTime() : Date.now()) - new Date(j.started_at).getTime()) / 1000);
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: j.id, status: j.status, started_at: j.started_at, finished_at: j.finished_at, elapsed_s, error: j.error, result }, null, 2) }] };
    }
  );

  // ============================================================
  // dump_compare_layout — read-only: inspect the '26 Compare' sheet's exact
  // row layout (row #, col B label, col C initials, key data cells) so block
  // boundaries and per-row identities can be mapped precisely. Diagnostic for
  // normalizing the initials column.
  // ============================================================
  diagnosticTool(server).tool(
    "dump_compare_layout",
    "Read-only diagnostic: dumps the '26 Compare' sheet row layout from the Box dashboard — for each used row: row number, col B (month/section label), col C (initials), and key data cells (BizDev D, Billable Hrs I, Billed $ K, Collected N). Use to see exactly which rows are blocks vs SUM vs '2026 Totals', and to compare month blocks (e.g. April vs May) for duplicated data. Pass raw_rows (comma-separated sheet row numbers) to ALSO return those rows' VERBATIM worksheet XML — for diagnosing malformed/fused cells that value-level reads can't show.",
    {
      raw_rows: z.string().optional().describe("Comma-separated sheet row numbers (e.g. '6,38,70') whose raw <row> XML should be returned verbatim, straight from the stored sheet XML (no ExcelJS normalization)."),
    },
    async (p) => {
      const DASHBOARD_FILE_ID = "2199324794140";
      const buf = await sanitizeXlsxBuffer(await downloadFromBox(DASHBOARD_FILE_ID));
      // Raw XML extraction FIRST (from the untouched zip), so ExcelJS's parse
      // can't normalize away the malformation we're trying to observe.
      let rawRowsOut: Record<string, string> | undefined;
      if (p.raw_rows?.trim()) {
        rawRowsOut = {};
        const zip = await JSZip.loadAsync(buf);
        const sheetMap = await getZipSheetMap(zip);
        const xml = await zip.file(sheetMap["26 Compare"])!.async("string");
        for (const part of p.raw_rows.split(",")) {
          const rn = parseInt(part.trim(), 10);
          if (!Number.isFinite(rn)) continue;
          const m = xml.match(new RegExp(`<row\\b[^>]*\\br="${rn}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`));
          rawRowsOut[String(rn)] = m ? m[0].slice(0, 4000) : "(row element not found)";
        }
      }
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as any);
      const sheet = wb.getWorksheet("26 Compare");
      if (!sheet) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "'26 Compare' sheet not found" }) }] };
      const cellStr = (r: ExcelJS.Row, c: number): string => {
        const v = r.getCell(c).value as any;
        if (v == null) return "";
        if (typeof v === "object") {
          if (v.result != null) return String(v.result);
          if (v.text != null) return String(v.text);
          if (v.richText) return v.richText.map((t: any) => t.text).join("");
          return JSON.stringify(v);
        }
        return String(v);
      };
      const rows: any[] = [];
      sheet.eachRow((row, n) => {
        const B = cellStr(row, 2).trim();
        const C = cellStr(row, 3).trim();
        const D = cellStr(row, 4).trim();
        const I = cellStr(row, 9).trim();
        const K = cellStr(row, 11).trim();
        const N = cellStr(row, 14).trim();
        if (B || C || D || I || K || N) rows.push({ row: n, B, C, bizDev_D: D, billableHrs_I: I, billed_K: K, collected_N: N });
      });
      // When raw rows were requested, return ONLY those (the full layout dump
      // alongside 4KB XML blobs would blow the response size).
      if (rawRowsOut) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ sheet: "26 Compare", raw_rows: rawRowsOut }, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ sheet: "26 Compare", row_count: rows.length, rows }, null, 2) }] };
    }
  );

  // ============================================================
  // add_collections_by_matter_tab — YTD Collections by Resp. Attorney × Matter
  // ============================================================
  server.tool(
    "add_collections_by_matter_tab",
    "Add or replace a 'YTD Collections by Matter' worksheet in the Claude Version 2 dashboard (Box file 2199324794140). Reads the Fee Allocation Report (same pipeline the Collection tab uses), aggregates 'Total Funds Collected' by Responsible Attorney → Matter (summing all timekeeper rows that share a matter), and writes attorney blocks (bold header + subtotal, matters nested beneath sorted by $ desc) with Excel SUM formulas plus a firm grand total. Reconciles the grouped sum to the report's firm total to the cent and ABORTS without writing if it doesn't match. Additive only — does not touch any existing sheet/formula/formatting. Versions the workbook back to Box and recalculates on open. Defaults to the latest Fee Allocation report; pass report_id to pin one.",
    {
      month: z.coerce.number().describe("Target month (1-12) for the 'YTD through' label"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      report_id: z.coerce.number().optional().describe("Specific Fee Allocation report id (default: latest completed)"),
    },
    async (params) => {
      const SHEET = "YTD Collections by Matter";
      const DASHBOARD_FILE_ID = "2199324794140";
      const FOLDER_ID = MONTHLY_MEASURABLES_FOLDER_ID; // Traction > Measurables > Monthly Measureables
      try {
        const mNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        const endDay = new Date(params.year, params.month, 0).getDate();
        const periodLabel = `Jan 1 – ${mNames[params.month - 1]} ${endDay}, ${params.year} (YTD)`;
        const num = (x?: string) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;
        const r2 = (n: number) => Math.round(n * 100) / 100;

        // 1. Fee Allocation CSV (latest or pinned)
        const { rows, report } = await getFeeAllocationCSV(params.report_id);
        // Report firm total = sum of every row's Total Funds Collected.
        const firmTotal = r2(rows.reduce((s, r) => s + num(r["Total Funds Collected"]), 0));

        // 2. Aggregate at the row level: Responsible Attorney -> Matter -> sum.
        const byAtt = new Map<string, Map<string, number>>();
        for (const r of rows) {
          const att = (r["Responsible Attorney"] ?? "").trim() || "(Unassigned)";
          const matter = (r["Matter"] ?? "").trim() || "(No matter)";
          if (!byAtt.has(att)) byAtt.set(att, new Map());
          const mm = byAtt.get(att)!;
          mm.set(matter, (mm.get(matter) ?? 0) + num(r["Total Funds Collected"]));
        }
        const attorneys = [...byAtt.entries()].map(([name, mm]) => {
          const matters = [...mm.entries()].map(([matter, amt]) => ({ matter, amt: r2(amt) })).sort((a, b) => b.amt - a.amt);
          return { name, total: r2(matters.reduce((s, m) => s + m.amt, 0)), matters };
        }).sort((a, b) => b.total - a.total);

        // 3. Reconciliation gate — abort (no write) if grouped != report firm total.
        const grouped = r2(attorneys.reduce((s, a) => s + a.total, 0));
        if (Math.abs(grouped - firmTotal) >= 0.005) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            tab: SHEET, status: "failed", reconciled: false,
            message: `Reconciliation failed: grouped attorney×matter total $${grouped.toFixed(2)} != report firm total $${firmTotal.toFixed(2)} — not writing a partial tab.`,
            report_id: report.id, report_name: report.name,
          }, null, 2) }], isError: true };
        }

        // 4. Build the sheet XML. Subtotals + grand total are Excel SUM formulas
        //    referencing the cells (recalculable); $ uses dash-zero currency.
        const sheetRows: string[] = [];
        sheetRows.push(xmlRow(1, [xmlCell("A1", `YTD Collections by Resp. Attorney × Matter — ${periodLabel}`, { style: STYLE_BOLD })]));
        sheetRows.push(xmlRow(2, [xmlCell("A2", "Responsible Attorney / Matter", { style: STYLE_BOLD }), xmlCell("B2", "Collected", { style: STYLE_BOLD })]));
        let rn = 3;
        const subtotalRefs: string[] = [];
        for (const a of attorneys) {
          const hdrRn = rn;
          const firstMatter = hdrRn + 1, lastMatter = hdrRn + a.matters.length;
          subtotalRefs.push(`B${hdrRn}`);
          sheetRows.push(xmlRow(hdrRn, [
            xmlCell(`A${hdrRn}`, a.name, { style: STYLE_BOLD }),
            xmlCell(`B${hdrRn}`, a.total, { style: STYLE_CURDASHB, formula: a.matters.length ? `SUM(B${firstMatter}:B${lastMatter})` : undefined }),
          ]));
          rn++;
          for (const m of a.matters) {
            sheetRows.push(xmlRow(rn, [xmlCell(`A${rn}`, `    ${m.matter}`), xmlCell(`B${rn}`, m.amt, { style: STYLE_CURDASH })]));
            rn++;
          }
        }
        const grandRn = rn;
        sheetRows.push(xmlRow(grandRn, [
          xmlCell(`A${grandRn}`, "Firm Total", { style: STYLE_BOLD }),
          xmlCell(`B${grandRn}`, firmTotal, { style: STYLE_CURDASHB, formula: subtotalRefs.length ? `SUM(${subtotalRefs.join(",")})` : undefined }),
        ]));
        const sheetXml = buildSheetXml(sheetRows, { cols: [{ min: 1, max: 1, width: 60 }, { min: 2, max: 2, width: 16 }], freezeRow: 2 });

        // 5. Write the single sheet into the workbook (additive) and version to Box.
        //    surgicalWriteXlsx adds the sheet if new / replaces it if it exists,
        //    leaves every other sheet untouched, and sets recalc-on-open.
        const fileBuffer = await sanitizeXlsxBuffer(await downloadFromBox(DASHBOARD_FILE_ID));
        const outputBuffer = await surgicalWriteXlsx(fileBuffer, (ST: StyleIndices) => {
          const styled = (xml: string) => xml
            .replace(/<c r="([^"]+)">/g, (_, ref) => `<c r="${ref}" s="${ST.general}">`)
            .split(`s="${STYLE_CURDASHB}"`).join(`s="${ST.currencyDashBold}"`)
            .split(`s="${STYLE_CURDASH}"`).join(`s="${ST.currencyDash}"`)
            .split(`s="${STYLE_BOLD}"`).join(`s="${ST.bold}"`);
          return { [SHEET]: styled(sheetXml) };
        }, new Set<string>());

        const result = await uploadToBox({
          buffer: outputBuffer,
          filename: `${params.year} Firm Dashboard - Claude Version 2.xlsx`,
          folderId: FOLDER_ID,
          overwriteFileId: DASHBOARD_FILE_ID,
        });

        const payload: any = {
          tab: SHEET,
          status: result.uploaded ? "ok" : "failed",
          reconciled: true,
          firm_total: firmTotal,
          attorneys: attorneys.length,
          matters: attorneys.reduce((s, a) => s + a.matters.length, 0),
          report_id: report.id, report_name: report.name, period: periodLabel,
        };
        if (result.uploaded) { payload.box_file_id = result.box_file_id; payload.box_url = result.box_url; }
        else { payload.direct_download_url = (result as any).direct_download_url; payload.reason = (result as any).reason; }
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], ...(result.uploaded ? {} : { isError: true }) };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ tab: SHEET, status: "failed", error: true, message: e?.message ?? String(e) }) }], isError: true };
      }
    }
  );
}


/**
 * ARCHIVED 2026-08-24 — download_vd_statement and download_firm_scorecard are no
 * longer registered on the MCP surface.
 *
 *  - download_vd_statement: the V&D Of Counsel compensation statement is now
 *    produced by a separate skill, so the server no longer needs a second path
 *    to those numbers.
 *  - download_firm_scorecard: archival. Note it never migrated to the shared
 *    classifier — it still splits billable vs nonbillable with the pre-2026-07-09
 *    `price > 0` heuristic, a third basis that reconciles to neither 26 Compare
 *    nor the weekly goal sheets. That is why it was NOT given the
 *    exclude_internal treatment: it is retired instead.
 *
 * The source is retained verbatim (unwired) for reference. To re-expose either
 * tool, call this from registerDocumentTools — but migrate download_firm_scorecard
 * onto classifiedHours.ts first, or it will report a basis nothing else uses.
 */
export function registerArchivedDocumentTools(server: McpServer): void {
  // ============================================================
  // TOOL 1: download_vd_statement
  // ============================================================
  server.tool(
    "download_vd_statement",
    "Generate a V&D Of Counsel compensation statement as a downloadable Word document. Includes cover letter from Rachel Trevino, compensation summary with tier breakdown, timekeeper detail, and payment history. Returns a short-lived direct_download_url (1-hour TTL) for the generated .docx.",
    {
      month: z.coerce.number().describe("Month number (1-12)"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
    },
    async (params) => {
      try {
        const monthNames = MONTH_NAMES_FULL;
        const monthName = monthNames[params.month - 1];
        const startDate = `${params.year}-${String(params.month).padStart(2, "0")}-01`;
        const endDay = new Date(params.year, params.month, 0).getDate();
        const endDate = `${params.year}-${String(params.month).padStart(2, "0")}-${endDay}`;

        // Get users
        const allUsers = await fetchAllPages<any>("/users", { fields: "id,name,enabled" });
        const users = allUsers.map((u: any) => ({ id: u.id, name: u.name }));
        const gus = users.find((u) => u.name.toLowerCase().includes("gus"));
        const courtney = users.find((u) => u.name.toLowerCase().includes("courtney") || u.name.toLowerCase().includes("courteney"));
        const vdAttorneys = [gus, courtney].filter(Boolean) as { id: number; name: string }[];
        const vdLastNames = vdAttorneys.map(a => a.name.toLowerCase().split(" ").pop() ?? "");

        // Get fee allocation CSV
        const { rows: csvRows } = await getFeeAllocationCSV();

        // Filter V&D rows
        const vdRows = csvRows.filter(r => {
          const ra = (r["Responsible Attorney"] ?? "").toLowerCase();
          return vdLastNames.some(ln => ra.includes(ln));
        });

        // Classify rows
        const classified = vdRows.map(r => ({
          responsible: r["Responsible Attorney"] ?? "Unknown",
          user: r["User"] ?? "Unknown",
          isAttorneyTime: vdLastNames.some(ln => (r["User"] ?? "").toLowerCase().includes(ln)),
          collected: parseFloat(r["Billed Time Collected"] || r["Total Funds Collected"] || "0"),
          hours: parseFloat(r["Billed Hours"] || "0"),
        }));

        // Calculate splits (pooled tiers)
        let combinedYTD = 0;
        const perAtty: Record<string, { attyCollected: number; attyVD: number; attyFirm: number; staffCollected: number; staffVD: number; staffFirm: number; tks: Record<string, { collected: number; hours: number }> }> = {};
        for (const a of vdAttorneys) {
          perAtty[a.name] = { attyCollected: 0, attyVD: 0, attyFirm: 0, staffCollected: 0, staffVD: 0, staffFirm: 0, tks: {} };
        }

        // Attorney time
        const attyRows = classified.filter(c => c.isAttorneyTime);
        const totalAttyCollected = attyRows.reduce((s, c) => s + c.collected, 0);
        const attySplit = applyTieredSplit(totalAttyCollected, combinedYTD);
        combinedYTD = attySplit.ytdAfter;

        for (const c of attyRows) {
          const pa = Object.entries(perAtty).find(([k]) => c.responsible.toLowerCase().includes(k.toLowerCase().split(" ").pop()!))?.[1];
          if (!pa) continue;
          const prop = totalAttyCollected > 0 ? c.collected / totalAttyCollected : 0;
          pa.attyCollected += c.collected;
          pa.attyVD += attySplit.vd * prop;
          pa.attyFirm += attySplit.firm * prop;
        }

        // Staff time
        const staffRows = classified.filter(c => !c.isAttorneyTime);
        for (const c of staffRows) {
          const pa = Object.entries(perAtty).find(([k]) => c.responsible.toLowerCase().includes(k.toLowerCase().split(" ").pop()!))?.[1];
          if (!pa) continue;
          const split = applyTieredSplit(c.collected, combinedYTD);
          combinedYTD = split.ytdAfter;
          pa.staffCollected += c.collected;
          pa.staffVD += split.vd;
          pa.staffFirm += split.firm;
        }

        // Timekeeper breakdown
        for (const c of classified) {
          const pa = Object.entries(perAtty).find(([k]) => c.responsible.toLowerCase().includes(k.toLowerCase().split(" ").pop()!))?.[1];
          if (!pa) continue;
          if (!pa.tks[c.user]) pa.tks[c.user] = { collected: 0, hours: 0 };
          pa.tks[c.user].collected += c.collected;
          pa.tks[c.user].hours += c.hours;
        }

        // Tier breakdown
        const tier1 = Math.min(combinedYTD, 250000);
        const tier2 = Math.min(Math.max(combinedYTD - 250000, 0), 250000);
        const tier3 = Math.max(combinedYTD - 500000, 0);

        const grandCollected = Object.values(perAtty).reduce((s, a) => s + a.attyCollected + a.staffCollected, 0);
        const grandVD = Object.values(perAtty).reduce((s, a) => s + a.attyVD + a.staffVD, 0);
        const grandFirm = Object.values(perAtty).reduce((s, a) => s + a.attyFirm + a.staffFirm, 0);

        // Generate letter date (15th of next month)
        const nextMonth = params.month === 12 ? 1 : params.month + 1;
        const nextYear = params.month === 12 ? params.year + 1 : params.year;
        const letterDate = new Date(nextYear, nextMonth - 1, 15).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

        // ===== BUILD DOCUMENT =====
        const doc = new Document({
          styles: {
            default: { document: { run: { font: "Arial", size: 20 } } },
            paragraphStyles: [
              { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: "Arial", color: "2E4057" }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
              { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Arial", color: "2E4057" }, paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 1 } },
            ],
          },
          sections: [{
            properties: {
              ...pageProps,
              headers: {
                default: new Header({ children: [
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [$("Romano & Sumner, PLLC", { size: 28, bold: true, color: "2E4057" })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [$("Of Counsel Compensation Statement", { size: 22, color: "666666" })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [$(`Period: ${monthName} ${params.year}`, { size: 20, color: "666666" })] }),
                ] }),
              },
              footers: {
                default: new Footer({ children: [
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [
                    $("Generated from Clio Fee Allocation Report  |  Romano & Sumner, PLLC Confidential  |  Page ", { size: 16, color: "999999" }),
                    new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: "999999" }),
                  ] }),
                ] }),
              },
            } as any,
            children: [
              // PAGE 1: COVER LETTER
              makePara(letterDate, { size: 22, spacingAfter: 200 }),
              makePara(`Re: Of Counsel Compensation - ${monthName} ${params.year}`, { bold: true, size: 22, spacingAfter: 200 }),
              makePara("Dear Gus and Courteney:", { size: 22, spacingAfter: 200 }),
              makePara(`Enclosed please find a check in the amount of ${fmt(round2(grandVD))} for V&D compensation for the month of ${monthName} ${params.year}.`, { size: 22, spacingAfter: 120 }),
              ...vdAttorneys.map(a => {
                const pa = perAtty[a.name];
                const total = round2(pa.attyVD + pa.staffVD);
                return new Paragraph({ spacing: { after: 60 }, children: [
                  $(`    ${a.name}: `, { size: 22 }),
                  $(fmt(total), { size: 22, bold: true }),
                ] });
              }),
              makePara("", { spacingAfter: 120 }),
              makePara("Please see the attached compensation statement for a detailed breakdown of collections, tier calculations, and payment history.", { size: 22, spacingAfter: 200 }),
              makePara("Please do not hesitate to reach out with any questions.", { size: 22, spacingAfter: 400 }),
              makePara("Sincerely,", { size: 22, spacingAfter: 400 }),
              makePara("Rachel Trevino", { size: 22, spacingAfter: 0 }),
              makePara("Executive Director", { size: 22, spacingAfter: 0 }),
              makePara("Romano & Sumner, PLLC", { size: 22, spacingAfter: 200 }),

              // PAGE 2: SUMMARY
              pageBreak(),
              makePara(`V&D Compensation Statement - ${monthName} ${params.year}`, { bold: true, size: 28, alignment: AlignmentType.CENTER, spacingAfter: 200 }),
              spacer(),
              (() => {
                const rows: string[][] = [];
                for (const a of vdAttorneys) {
                  const pa = perAtty[a.name];
                  const firstName = a.name.split(" ")[0];
                  rows.push([a.name, "", "", ""]);
                  rows.push(["  Attorney Time", fmt(round2(pa.attyCollected)), fmt(round2(pa.attyVD)), fmt(round2(pa.attyFirm))]);
                  rows.push(["  Staff Time (allowance)", fmt(round2(pa.staffCollected)), fmt(round2(pa.staffVD)), fmt(round2(pa.staffFirm))]);
                  rows.push(["  Staff Time (regular)", fmt(0), fmt(0), fmt(0)]);
                  rows.push([`  ${firstName} Subtotal`, fmt(round2(pa.attyCollected + pa.staffCollected)), fmt(round2(pa.attyVD + pa.staffVD)), fmt(round2(pa.attyFirm + pa.staffFirm))]);
                  rows.push(["", "", "", ""]);
                }
                rows.push(["V&D Total", fmt(round2(grandCollected)), fmt(round2(grandVD)), fmt(round2(grandFirm))]);
                rows.push(["", "", "", ""]);
                rows.push([`Tier 1 ($0-$250K @ 82.5%)`, fmt(round2(tier1)), "", ""]);
                rows.push([`Tier 2 ($250K-$500K @ 80%)`, fmt(round2(tier2)), "", ""]);
                rows.push([`Tier 3 ($500K+ @ 77.5%)`, fmt(round2(tier3)), "", ""]);
                return makeDocxTable(["", "Collected", "V&D Share", "Firm Share"], rows, [3200, 2100, 2100, 1960]);
              })(),
              spacer(),
              makePara(`Amount Due to V&D for ${monthName}: ${fmt(round2(grandVD))}`, { bold: true, size: 24, spacingAfter: 200 }),

              // PAGE 3: DETAIL
              pageBreak(),
              h2("Timekeeper Detail"),
              spacer(),
              (() => {
                const rows: string[][] = [];
                for (const a of vdAttorneys) {
                  const pa = perAtty[a.name];
                  for (const [name, data] of Object.entries(pa.tks).sort(([,a],[,b]) => b.collected - a.collected)) {
                    rows.push([a.name, name, String(round1(data.hours)), fmt(round2(data.collected))]);
                  }
                  rows.push(["", "", "", ""]);
                }
                return makeDocxTable(["Responsible Attorney", "Timekeeper", "Hours", "Collected"], rows, [2400, 2400, 1280, 3280]);
              })(),
              spacer(), spacer(),
              h2("Payment History (YTD)"),
              spacer(),
              ...vdAttorneys.flatMap(a => {
                const pa = perAtty[a.name];
                const total = round2(pa.attyCollected + pa.staffCollected);
                const vd = round2(pa.attyVD + pa.staffVD);
                return [
                  makePara(a.name, { bold: true, spacingAfter: 80 }),
                  makeDocxTable(
                    ["Month", "Collections", "V&D Share", "Amount Paid", "Date Paid"],
                    [
                      [monthName, fmt(total), fmt(vd), "__________", "__________"],
                      ["YTD Total", fmt(total), fmt(vd), "", ""],
                    ],
                    [1800, 1900, 1900, 1900, 1860]
                  ),
                  spacer(),
                ];
              }),
            ],
          }],
        });

        const buffer = await Packer.toBuffer(doc);
        const filename = `V&D Compensation Statement - ${monthName} ${params.year}.docx`;
        const size_kb = Math.round(buffer.length / 1024);
        console.warn(`[Doc] download_vd_statement — returning direct_download_url filename=${filename} size_kb=${size_kb}`);
        const reg = registerDownload(buffer, filename, mimeForFilename(filename));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "docx",
              size_kb,
              direct_download_url: reg.url,
              expires_at: reg.expires_at,
              note: "Download the file from direct_download_url within 1 hour.",
              summary: {
                period: `${monthName} ${params.year}`,
                total_vd_compensation: fmt(round2(grandVD)),
                attorneys: vdAttorneys.map(a => ({ name: a.name, vd: fmt(round2(perAtty[a.name].attyVD + perAtty[a.name].staffVD)) })),
              },
            }),
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

  // ============================================================
  // TOOL 2: download_firm_scorecard
  // ============================================================
  server.tool(
    "download_firm_scorecard",
    "Generate the firm-wide development meeting scorecard as a downloadable Excel file. Includes weekly and monthly data for all timekeepers. Returns a short-lived direct_download_url (1-hour TTL); if box_folder_id is provided the file is also versioned to Box when possible.",
    {
      week_of: z.string().optional().describe("Date within the target week (YYYY-MM-DD). Defaults to today."),
      box_folder_id: z.string().optional().describe("Box folder ID. If provided and the generated file has an existing overwrite target, the tool versions it in Box. Otherwise (omitted or upload fails) the tool returns a short-lived direct_download_url (1-hour TTL) the user can click to download the file directly — no base64 inlined in the MCP response."),
    },
    async (params) => {
      try {
        const ROSTER = SCORECARD_ROSTER;

        const targetDate = params.week_of ?? new Date().toISOString().split("T")[0];
        const d = new Date(targetDate + "T12:00:00");
        const day = d.getDay();
        const monday = new Date(d); monday.setDate(d.getDate() - ((day + 6) % 7));
        const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
        const fmtDate = (dt: Date) => dt.toISOString().split("T")[0];
        const weekStart = fmtDate(monday);
        const weekEnd = fmtDate(sunday);
        const weekLabel = `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${sunday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

        const monthStart = `${targetDate.slice(0, 7)}-01`;
        const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const monthEnd = fmtDate(mEnd);
        const monthLabel = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

        // Fetch time entries for the month (covers the week too)
        const entries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,quantity,rounded_quantity,price,billed,user{id,name}",
          created_since: `${monthStart}T00:00:00+00:00`,
        }).then(e => e.filter((x: any) => x.date >= monthStart && x.date <= monthEnd));

        // Build per-user weekly + monthly data
        const userData: Record<number, { weekBillable: number; weekNonbillable: number; monthBillable: number; monthNonbillable: number; monthBilledHrs: number; monthUnbilledHrs: number; monthBillableDollars: number }> = {};
        for (const r of ROSTER) {
          userData[r.user_id] = { weekBillable: 0, weekNonbillable: 0, monthBillable: 0, monthNonbillable: 0, monthBilledHrs: 0, monthUnbilledHrs: 0, monthBillableDollars: 0 };
        }

        for (const e of entries) {
          const uid = e.user?.id;
          if (!uid || !userData[uid]) continue;
          // Use rounded_quantity (billed hours) not raw quantity (actual tracked).
          const hours = (e.rounded_quantity ?? e.quantity) / 3600;
          const isBillable = (e.price || 0) > 0;
          const inWeek = e.date >= weekStart && e.date <= weekEnd;

          if (isBillable) {
            userData[uid].monthBillable += hours;
            userData[uid].monthBillableDollars += hours * (e.price || 0);
            if (e.billed) userData[uid].monthBilledHrs += hours; else userData[uid].monthUnbilledHrs += hours;
            if (inWeek) userData[uid].weekBillable += hours;
          } else {
            userData[uid].monthNonbillable += hours;
            if (inWeek) userData[uid].weekNonbillable += hours;
          }
        }

        // Build Excel
        const wb = new ExcelJS.Workbook();

        // Weekly sheet
        const ws1 = wb.addWorksheet("Weekly");
        ws1.columns = [
          { header: "Initials", key: "initials", width: 10 },
          { header: "Name", key: "name", width: 25 },
          { header: "Billable", key: "billable", width: 12 },
          { header: "Nonbillable", key: "nonbillable", width: 14 },
          { header: "Total", key: "total", width: 12 },
        ];
        ws1.getRow(1).font = { bold: true };
        ws1.mergeCells("A1:E1");
        ws1.getCell("A1").value = `Weekly Scorecard: ${weekLabel}`;
        ws1.getCell("A1").font = { bold: true, size: 14 };
        ws1.addRow({}); // blank
        const hRow1 = ws1.addRow(["Initials", "Name", "Billable", "Nonbillable", "Total"]);
        hRow1.font = { bold: true };

        for (const r of ROSTER) {
          const d = userData[r.user_id];
          ws1.addRow([r.initials, r.name, round1(d.weekBillable), round1(d.weekNonbillable), round1(d.weekBillable + d.weekNonbillable)]);
        }

        // Monthly sheet
        const ws2 = wb.addWorksheet("Monthly");
        ws2.mergeCells("A1:H1");
        ws2.getCell("A1").value = `Monthly Scorecard: ${monthLabel}`;
        ws2.getCell("A1").font = { bold: true, size: 14 };
        ws2.addRow({});
        const hRow2 = ws2.addRow(["Initials", "Name", "Billable Hrs", "Billable $", "Billed Hrs", "Unbilled Hrs", "Nonbillable", "Total"]);
        hRow2.font = { bold: true };

        for (const r of ROSTER) {
          const d = userData[r.user_id];
          ws2.addRow([
            r.initials, r.name,
            round1(d.monthBillable), round2(d.monthBillableDollars),
            round1(d.monthBilledHrs), round1(d.monthUnbilledHrs),
            round1(d.monthNonbillable),
            round1(d.monthBillable + d.monthNonbillable),
          ]);
        }

        // Format currency column
        ws2.getColumn(4).numFmt = '"$"#,##0.00';

        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        const filename = `Firm Scorecard - ${weekLabel.replace(/\//g, "-")}.xlsx`;
        const size_kb = Math.round(buffer.byteLength / 1024);

        if (params.box_folder_id !== undefined) {
          const folderId = params.box_folder_id || "375771584500";
          const result = await uploadToBox({ buffer, filename, folderId });
          if (result.uploaded) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename, size_kb: result.size_kb, box_file_id: result.box_file_id, box_url: result.box_url }) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, filename, size_kb: result.size_kb, direct_download_url: result.direct_download_url, expires_at: result.expires_at, reason: result.reason, note: result.note }) }] };
        }

        console.warn(`[Doc] download_firm_scorecard — returning direct_download_url filename=${filename} size_kb=${size_kb}`);
        const reg = registerDownload(buffer, filename, mimeForFilename(filename));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filename, format: "xlsx", size_kb, direct_download_url: reg.url, expires_at: reg.expires_at, note: "Download the file from direct_download_url within 1 hour." }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }], isError: true };
      }
    }
  );
}
