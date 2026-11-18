// ============================================================
// Rate-tab (Utilization / Realization / Collection) patch helpers.
// Pure XML transforms extracted from download_dashboard_update so the full
// dashboard build and the lighter rate-tabs-only refresh share one
// implementation. Each tab is month-blocked (col A = 3-letter month label,
// col B = initials); these patch one month's block in place.
// ============================================================
import {
  findTabMonthBlock, patchCell, readCell, MONTH_ABBRS, expandSharedFormulas,
  firmAvgRateByMonth, maxRowNumber, appendRowsBeforeSheetClose, stripRowsFromMarker,
  xmlCell, xmlRow, STYLE_BOLD, STYLE_PCT, STYLE_GEN,
} from "../utils/xlsx";
import { MONTH_NAMES_FULL } from "../domain/roster";
import { round1 } from "../utils/num";

// Per-user hours for the Utilization tab: user_id -> { billable, nonbillable }.
export type UtilHours = Record<number, { billable: number; nonbillable: number }>;

/**
 * Patch one month's block on the Utilization tab from per-user hours.
 * Writes C=Billable, D=Nonbillable, E=Total (=Billable+Nonbillable), and
 * G=Untracked (=max(0, Available − Total), reading the row's existing
 * Available in col F). The Utilization Rate (col H) is the template's own
 * =Billable/Available formula and is left untouched.
 *
 * `initialsToUid` maps the tab's col-B initials (uppercased) to user_id;
 * `aliases` remaps a known tab typo (JBP→JPB) before that lookup.
 */
export function patchUtilizationBlock(
  xml: string,
  monthAbbr: string,
  sharedStrings: string[],
  byUid: UtilHours,
  initialsToUid: Record<string, number>,
  aliases: Record<string, string>,
): { xml: string; patched: number } {
  let patched = 0;
  const block = findTabMonthBlock(xml, monthAbbr, sharedStrings, ["C", "D"]);
  if (!block) return { xml, patched };
  for (const { row, ini } of block.attorneys) {
    const uid = initialsToUid[aliases[ini] ?? ini];
    if (!uid) continue;
    const h = byUid[uid];
    if (!h) continue;
    const total = round1(h.billable + h.nonbillable);
    xml = patchCell(xml, `C${row}`, round1(h.billable));    // worked billable (= 26 Compare col I)
    xml = patchCell(xml, `D${row}`, round1(h.nonbillable)); // admin nonbillable (= 26 Compare col H)
    xml = patchCell(xml, `E${row}`, total);                 // Total = Billable + Nonbillable
    const avail = parseFloat(readCell(xml, `F${row}`, sharedStrings));
    if (Number.isFinite(avail)) xml = patchCell(xml, `G${row}`, round1(Math.max(0, avail - total))); // Untracked
    patched++;
  }
  return { xml, patched };
}

/**
 * Read one numeric column of a month block, keyed by user_id (e.g. the
 * Utilization tab's Available, col F). Rows whose initials don't map, or whose
 * cell isn't a number, are omitted.
 */
export function readTabColumnByUid(
  xml: string,
  monthAbbr: string,
  sharedStrings: string[],
  dataCols: string[],
  col: string,
  initialsToUid: Record<string, number>,
  aliases: Record<string, string>,
): Record<number, number> {
  const out: Record<number, number> = {};
  const block = findTabMonthBlock(xml, monthAbbr, sharedStrings, dataCols);
  if (!block) return out;
  for (const { row, ini } of block.attorneys) {
    const uid = initialsToUid[aliases[ini] ?? ini];
    if (!uid) continue;
    const v = parseFloat(readCell(xml, `${col}${row}`, sharedStrings));
    if (Number.isFinite(v)) out[uid] = v;
  }
  return out;
}

// Marker on the auto-generated "Firm Average" summary table appended to the
// bottom of the Utilization / Realization tabs, so it can be stripped and
// refreshed in place each run.
export const FIRM_AVG_MARKER = "Firm Average (auto-generated";
const monthFull = (abbr: string) => MONTH_NAMES_FULL[MONTH_ABBRS.indexOf(abbr)] ?? abbr;

/**
 * Ensure a rate tab has a block for `monthAbbr`, creating one when the template
 * doesn't carry it. The monthly update used to only PATCH blocks that already
 * exist (findTabMonthBlock → skip when absent), so every run rewrote the prior
 * months' sections but a month missing from the template never appeared at all.
 *
 * When the block is missing, the LAST existing month block is cloned as the
 * layout template: its rows (month-header row through its "Total" row, when it
 * has one) are appended after the sheet's last row, renumbered, block-local
 * formula references shifted with them, the col-A label rewritten to the target
 * month (matching the reference label's abbreviated/full + case style), and
 * `zeroCols` (default `dataCols`) zeroed on the attorney rows so the clone's
 * stale numbers can't read as real data. Any auto-generated Firm Average
 * summary is stripped first so the new block lands above where the summary is
 * re-appended.
 *
 * Returns the (possibly updated) XML and whether a block was created. `created`
 * is false with the XML untouched when the block already exists, or when the
 * tab has no reference block to clone.
 */
export function ensureTabMonthBlock(
  xml: string,
  monthAbbr: string,
  sharedStrings: string[],
  dataCols: string[],
  zeroCols?: string[],
): { xml: string; created: boolean } {
  if (findTabMonthBlock(xml, monthAbbr, sharedStrings, dataCols)) return { xml, created: false };

  let base = stripRowsFromMarker(xml, FIRM_AVG_MARKER, sharedStrings);
  // Cloned cells must not carry shared-formula fragments (a follower <f
  // t="shared" si="N"/> without its master corrupts the sheet) — expand to
  // plain per-cell formulas first. No-op when the sheet has none.
  if (base.includes('t="shared"')) base = expandSharedFormulas(base);

  const rows: Array<{ n: number; raw: string }> = [];
  for (const m of base.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g)) {
    rows.push({ n: parseInt(m[1], 10), raw: m[0] });
  }
  rows.sort((a, b) => a.n - b.n);

  // Last complete month block = the clone reference. Same scan rules as
  // findTabMonthBlock: col A month label opens a block; blank/"EMPLOYEE"/
  // "TOTAL" in col B ends it ("Total" belongs to the block and is cloned too).
  type Ref = { hdr: number; hdrText: string; attorneys: number[]; total: number | null };
  let ref: Ref | null = null;
  let cur: Ref | null = null;
  for (const { n } of rows) {
    const aText = readCell(base, `A${n}`, sharedStrings).trim();
    const b = readCell(base, `B${n}`, sharedStrings).trim().toUpperCase();
    if (MONTH_ABBRS.includes(aText.toUpperCase().slice(0, 3))) {
      if (cur && cur.attorneys.length) ref = cur;
      cur = { hdr: n, hdrText: aText, attorneys: [], total: null };
      continue;
    }
    if (!cur) continue;
    if (b === "" || b === "EMPLOYEE" || b === "TOTAL") {
      if (b === "TOTAL") cur.total = n;
      if (cur.attorneys.length) ref = cur;
      cur = null;
      continue;
    }
    cur.attorneys.push(n);
  }
  if (cur && cur.attorneys.length) ref = cur;
  if (!ref) return { xml, created: false };

  const end = ref.total ?? ref.attorneys[ref.attorneys.length - 1];
  const delta = maxRowNumber(base) + 2 - ref.hdr;
  const inRange = rows.filter((r) => r.n >= ref!.hdr && r.n <= end);

  const shifted = inRange.map(({ raw }) => {
    let out = raw.replace(/(<row\b[^>]*?\br=")(\d+)(")/, (_s, p1, rn, p3) => `${p1}${parseInt(rn, 10) + delta}${p3}`);
    // Cell refs (r="D12") move with the row.
    out = out.replace(/(\br=")([A-Z]{1,3})(\d+)(")/g, (_s, p1, col, rn, p4) => `${p1}${col}${parseInt(rn, 10) + delta}${p4}`);
    // Formula refs move only when they point INSIDE the cloned block (a row-local
    // rate like D12/(D12+E12) or the Total row's SUM over the block); anything
    // referencing outside the block keeps its target.
    out = out.replace(/<f\b([^>]*)>([\s\S]*?)<\/f>/g, (_s, attrs, f) => {
      const nf = f.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (t: string, col: string, rn: string) => {
        const num = parseInt(rn, 10);
        return num >= ref!.hdr && num <= end ? `${col}${num + delta}` : t;
      });
      return `<f${attrs}>${nf}</f>`;
    });
    return out;
  });
  base = appendRowsBeforeSheetClose(base, shifted);

  // Rewrite the header's col-A label to the target month, keeping the reference
  // label's shape ("JUN" → "JUL", "June" → "July") and its cell style. The
  // replacement is an inline string so no shared-string entry is needed.
  const mi = MONTH_ABBRS.indexOf(monthAbbr);
  let label = ref.hdrText.length > 3 ? (MONTH_NAMES_FULL[mi] ?? monthAbbr) : monthAbbr;
  if (ref.hdrText === ref.hdrText.toUpperCase()) label = label.toUpperCase();
  else if (label.length === 3) label = label.charAt(0) + label.slice(1).toLowerCase();
  const newHdr = ref.hdr + delta;
  const aRe = new RegExp(`<c\\b([^>]*?)\\br="A${newHdr}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const am = base.match(aRe);
  if (am) {
    const sm = `${am[1]} ${am[2]}`.match(/\bs="(\d+)"/);
    base = base.replace(aRe, xmlCell(`A${newHdr}`, label, sm ? { style: sm[1] } : undefined));
  }

  // Zero the data columns on the cloned attorney rows — the caller's patch pass
  // overwrites the roster rows it has data for; everything else must read 0,
  // not the reference month's numbers.
  for (const n of ref.attorneys) {
    for (const c of zeroCols ?? dataCols) base = patchCell(base, `${c}${n + delta}`, 0);
  }
  return { xml: base, created: true };
}

/**
 * Build the rows of a "Firm Average" summary table: a bold title row (col A
 * only, so a later block scan treats it as a terminator), a header row, and one
 * row per month carrying the month NAME in col B (col A blank, so the rows are
 * never mistaken for new month-block headers). An optional goal column sits
 * between the actual rate and the biller count.
 */
export function buildFirmAvgRows(
  summary: Array<{ monthAbbr: string; avgRate: number; billers: number }>,
  startRow: number,
  title: string,
  rateHeader: string,
  goal?: { value: number; header: string },
): string[] {
  const out: string[] = [];
  out.push(xmlRow(startRow, [xmlCell(`A${startRow}`, title, { style: STYLE_BOLD })]));
  const hr = startRow + 1;
  const billersCol = goal ? "E" : "D";
  const header = [
    xmlCell(`B${hr}`, "Month", { style: STYLE_BOLD }),
    xmlCell(`C${hr}`, rateHeader, { style: STYLE_BOLD }),
  ];
  if (goal) header.push(xmlCell(`D${hr}`, goal.header, { style: STYLE_BOLD }));
  header.push(xmlCell(`${billersCol}${hr}`, "# Billers", { style: STYLE_BOLD }));
  out.push(xmlRow(hr, header));
  summary.forEach((s, i) => {
    const r = hr + 1 + i;
    const cells = [
      xmlCell(`B${r}`, monthFull(s.monthAbbr), { style: STYLE_BOLD }),
      xmlCell(`C${r}`, Math.round(s.avgRate * 10000) / 10000, { style: STYLE_PCT }),
    ];
    if (goal) cells.push(xmlCell(`D${r}`, Math.round(goal.value * 10000) / 10000, { style: STYLE_PCT }));
    cells.push(xmlCell(`${billersCol}${r}`, s.billers, { style: STYLE_GEN }));
    out.push(xmlRow(r, cells));
  });
  return out;
}

/**
 * Refresh the Utilization tab's bottom "Firm Average" summary in place: strip
 * the prior auto-generated block, recompute the per-month firm-mean utilization
 * (Billable C / Available F over active billers, C+D>0), and re-append.
 * `firmUtilGoal` > 0 adds the goal column. Returns the stripped XML unchanged
 * when no active month is found.
 */
export function appendUtilizationFirmAvg(xml: string, sharedStrings: string[], firmUtilGoal: number): string {
  const base = stripRowsFromMarker(xml, FIRM_AVG_MARKER, sharedStrings);
  const summary = firmAvgRateByMonth(base, sharedStrings, ["C", "D", "F"],
    (v) => (v.C + v.D > 0 && v.F > 0 ? v.C / v.F : null));
  if (!summary.length) return base;
  return appendRowsBeforeSheetClose(base, buildFirmAvgRows(
    summary, maxRowNumber(base) + 2,
    `${FIRM_AVG_MARKER} — do not edit) — mean of listed billers' utilization rate vs goal`,
    "Firm Avg Utilization Rate",
    firmUtilGoal > 0 ? { value: firmUtilGoal, header: "Firm Avg Util Goal" } : undefined));
}

/**
 * Refresh the Realization tab's bottom "Firm Average" summary: per-month firm
 * realization computed EXACTLY like an individual row — Billed-Nondiscounted /
 * Total Billed — but on the summed columns (ΣD / Σ(D+E)) of billers with
 * D+E>0. The old simple mean of each biller's own rate overweighted
 * low-volume billers (a timekeeper with a handful of hours at ~100% pulled the
 * mean up) and overstated the firm figure; the totals form matches the tab's
 * per-month "Total" row.
 */
export function appendRealizationFirmAvg(xml: string, sharedStrings: string[], asOf?: string): string {
  const base = stripRowsFromMarker(xml, FIRM_AVG_MARKER, sharedStrings);
  const summary = firmAvgRateByMonth(base, sharedStrings, ["D", "E"],
    (v) => (v.D + v.E > 0 ? v.D / (v.D + v.E) : null), "totals");
  if (!summary.length) return base;
  // The as-of stamp is not decoration. This tab is an activity-date cohort whose
  // D/E/F split keeps moving for ~90 days after a month closes (unbilled work
  // drains into billed), so the same month read at two dates is two different —
  // both correct — numbers. Without a vintage a reader cannot tell which they have.
  const stamp = asOf ? ` — data as of ${asOf}` : "";
  return appendRowsBeforeSheetClose(base, buildFirmAvgRows(
    summary, maxRowNumber(base) + 2,
    `${FIRM_AVG_MARKER} — do not edit) — firm realization rate: total nondiscounted ÷ total billed of listed billers${stamp}`,
    "Firm Realization Rate"));
}

/**
 * Refresh the Collection tab's bottom "Firm Average" summary: per-month firm
 * collection rate on the SUMMED columns (ΣC / Σ(C+D)) of billers with C+D>0 —
 * the totals form, not a mean of each biller's own rate, for the same reason the
 * Realization summary uses it (a mean overweights low-volume billers).
 *
 * The as-of stamp matters more here than anywhere else on the workbook. This tab
 * is an invoice-issue cohort whose collected/uncollected split keeps moving for
 * months as payments arrive, so the same month read at two dates gives two very
 * different — both correct — numbers. Measured against the prior hand-keyed
 * workbook: March 2026 was recorded at 32.7% and is actually 91.0%, a 58-point
 * understatement, because it was keyed weeks after the month closed and never
 * revisited. Without a vintage a reader cannot tell which reading they hold.
 */
export function appendCollectionFirmAvg(xml: string, sharedStrings: string[], asOf?: string): string {
  const base = stripRowsFromMarker(xml, FIRM_AVG_MARKER, sharedStrings);
  const summary = firmAvgRateByMonth(base, sharedStrings, ["C", "D"],
    (v) => (v.C + v.D > 0 ? v.C / (v.C + v.D) : null), "totals");
  if (!summary.length) return base;
  const stamp = asOf ? ` — data as of ${asOf}` : "";
  return appendRowsBeforeSheetClose(base, buildFirmAvgRows(
    summary, maxRowNumber(base) + 2,
    `${FIRM_AVG_MARKER} — do not edit) — firm collection rate: total collected ÷ total billed hours of listed billers${stamp}`,
    "Firm Collection Rate"));
}
