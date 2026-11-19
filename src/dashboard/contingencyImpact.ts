// ============================================================
// "Contingency Impact" tab — utilization, realization and collection, each
// shown WITH contingency matters and WITHOUT them, side by side.
//
// WHY. Contingency time is real worked time, but it is not billed hourly: it is
// usually recorded at $0 or carried to the bill by one of Rachel's fee
// placeholders. Left in, it drags hourly realization and collection toward
// zero; pulled out, utilization shows only the hourly book. Partners need both
// readings, so every rate appears twice on one row pair.
//
// WHAT "CONTINGENCY" MEANS HERE: the matter's Clio "Contingency" checkbox (the
// firm's source of truth — billing_method mislabels these "hourly"). Time
// entries match by matter id; report CSV rows match by the leading matter
// number of their "Matter Number" / "Matter" cell ("03061-Teachworth…" → 03061).
//
// THE "WITH" FIGURES ARE THE EXISTING TABS' FIGURES, UNCHANGED:
//   Utilization  — the Utilization tab's Billable (col C) ÷ Available (col F).
//   Realization  — the Realization tab's basis: billed-nondiscounted ÷ billed
//                  hours, with $0-rate time and fee placeholders already backed
//                  out (aggregateRealizationHours). Since most contingency time
//                  is $0-rate, much of it is ALREADY out of this "with" figure —
//                  the key on the sheet says so.
//   Collection   — the Collection tab's basis: collected ÷ billed hours.
// "WITHOUT" re-aggregates the same rows / hours with contingency matters
// removed, so the only difference between the two columns is contingency.
//
// LAYOUT mirrors the Realization ($) tab: firm block first, then one block per
// timekeeper, months across, YTD last. Hours are values; every rate is a
// FORMULA over the hour rows in its own column, so the sheet is auditable and a
// YTD rate is computed from YTD hours, never as a mean of monthly rates.
// ============================================================
import {
  xmlCell, xmlRow, STYLE_BOLD, STYLE_PCT, STYLE_GEN, STYLE_DEC, STYLE_PCTB, STYLE_HDR,
} from "../utils/xlsx";
import { MONTH_NAMES_SHORT } from "../domain/roster";
import {
  matterNumberPrefix, buildContingencyMatters, classifyYtdTimeEntries,
  type ClassifiedTimeEntry, type ContingencyMatters,
} from "./classifiedHours";
import { dataCol } from "./realizationDollars";
import { readTabColumnByUid } from "./rateTabs";
import {
  aggregateRealizationHours, aggregateFeeAllocationCollectionHrs, aggregateRealizationCollections,
  type RealizHoursAgg, type RealizCollectionsAgg,
} from "../clio/reportCsv";
import { MONTH_ABBRS } from "../utils/xlsx";

/** Sheet name. Changing it creates a second tab rather than renaming the first. */
export const CONTINGENCY_IMPACT_TAB = "Contingency Impact";

/** Available hours per month when the Utilization tab has none for a person (1880 ÷ 12). */
export const DEFAULT_MONTHLY_AVAILABLE = 1880 / 12;

type Member = { initials: string; user_id: number; name?: string };

export type ImpactCell = {
  util?: { billable: number; contingencyBillable: number; available: number };
  realiz?: { nondisc: number; disc: number; nondiscEx: number; discEx: number };
  coll?: { collected: number; uncollected: number; collectedEx: number; uncollectedEx: number };
};
/** month (1-12) → user_id → figures. */
export type ImpactByMonth = Record<number, Record<number, ImpactCell>>;

/** Mutable accessor so each tab's loop can drop its figures in as it goes. */
export function impactCell(data: ImpactByMonth, month: number, uid: number): ImpactCell {
  return ((data[month] ??= {})[uid] ??= {});
}

/** The matter text on a Clio report CSV row (Realization: "Matter Number";
 *  Fee Allocation: "Matter"). */
export function reportRowMatter(r: Record<string, string>): string | undefined {
  return r["Matter Number"] ?? r["Matter"];
}

/** True when a report row belongs to a contingency matter. */
export function isContingencyReportRow(r: Record<string, string>, prefixes: Set<string>): boolean {
  const p = matterNumberPrefix(reportRowMatter(r));
  return p !== null && prefixes.has(p);
}

/** Report rows with contingency matters removed, plus how many were removed. */
export function withoutContingencyRows<T extends Record<string, string>>(
  rows: T[], prefixes: Set<string>,
): { rows: T[]; removed: number } {
  const kept = rows.filter((r) => !isContingencyReportRow(r, prefixes));
  return { rows: kept, removed: rows.length - kept.length };
}

/**
 * Adjusted-basis BILLABLE hours on contingency matters, by month then user —
 * the hours "without contingency" subtracts from the Utilization tab's billable.
 * Entries whose contingency status is unknown (null) are not counted; callers
 * only build this when the contingency lookup succeeded.
 */
export function contingencyBillableByMonth(entries: ClassifiedTimeEntry[]): Record<number, Record<number, number>> {
  const out: Record<number, Record<number, number>> = {};
  for (const e of entries) {
    if (e.contingency !== true || e.cls !== "billable") continue;
    const m = parseInt(e.date.slice(5, 7), 10);
    const by = (out[m] ??= {});
    by[e.uid] = (by[e.uid] ?? 0) + e.hours;
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Hour rows, in display order: [label, section, getter]. A getter returning
// undefined writes a blank (the source wasn't available that month), not 0.
type HourRow = [string, (c: ImpactCell) => number | undefined];
const SECTIONS: Array<{
  title: string;
  hours: HourRow[];
  // rate rows: [label, formula(refs, col), headline]
  rates: Array<[string, (r: number[], c: string) => string, boolean]>;
}> = [
  {
    title: "UTILIZATION",
    hours: [
      ["Available hrs", (c) => c.util?.available],
      ["Billable hrs", (c) => c.util?.billable],
      ["Contingency billable hrs", (c) => c.util?.contingencyBillable],
    ],
    rates: [
      ["Utilization — with contingency", (r, c) => `IF(${c}${r[0]}=0,"",${c}${r[1]}/${c}${r[0]})`, true],
      ["Utilization — without contingency", (r, c) => `IF(${c}${r[0]}=0,"",MAX(0,${c}${r[1]}-${c}${r[2]})/${c}${r[0]})`, true],
    ],
  },
  {
    title: "REALIZATION (hours)",
    hours: [
      ["Billed nondiscounted hrs — all", (c) => c.realiz?.nondisc],
      ["Billed discounted hrs — all", (c) => c.realiz?.disc],
      ["Billed nondiscounted hrs — ex-contingency", (c) => c.realiz?.nondiscEx],
      ["Billed discounted hrs — ex-contingency", (c) => c.realiz?.discEx],
    ],
    rates: [
      ["Realization — with contingency", (r, c) => `IF((${c}${r[0]}+${c}${r[1]})=0,"",${c}${r[0]}/(${c}${r[0]}+${c}${r[1]}))`, true],
      ["Realization — without contingency", (r, c) => `IF((${c}${r[2]}+${c}${r[3]})=0,"",${c}${r[2]}/(${c}${r[2]}+${c}${r[3]}))`, true],
    ],
  },
  {
    title: "COLLECTION (hours)",
    hours: [
      ["Collected hrs — all", (c) => c.coll?.collected],
      ["Uncollected hrs — all", (c) => c.coll?.uncollected],
      ["Collected hrs — ex-contingency", (c) => c.coll?.collectedEx],
      ["Uncollected hrs — ex-contingency", (c) => c.coll?.uncollectedEx],
    ],
    rates: [
      ["Collection — with contingency", (r, c) => `IF((${c}${r[0]}+${c}${r[1]})=0,"",${c}${r[0]}/(${c}${r[0]}+${c}${r[1]}))`, true],
      ["Collection — without contingency", (r, c) => `IF((${c}${r[2]}+${c}${r[3]})=0,"",${c}${r[2]}/(${c}${r[2]}+${c}${r[3]}))`, true],
    ],
  },
];

const KEY: Array<[string, string]> = [
  ["Contingency", "Matters with the Contingency box checked in Clio. Everything else is treated as hourly."],
  ["With contingency", "Exactly the figure on the Utilization / Realization / Collection tab — unchanged."],
  ["Without contingency", "The same calculation with every contingency matter removed. The gap between the two lines is contingency's effect."],
  ["Utilization", "Billable ÷ Available. 'Without' subtracts contingency billable hours from the numerator; Available is unchanged."],
  ["Realization", "Billed nondiscounted ÷ billed hours. $0-rate time and fee placeholders are already excluded on BOTH lines (as on the Realization tab), and most contingency time is $0-rate — so this gap is usually smaller than the other two."],
  ["Collection", "Collected ÷ billed hours, by invoice issue month (as on the Collection tab)."],
  ["Blank cell", "No data for that month (the source report wasn't available), not zero."],
];

/**
 * Build the complete "Contingency Impact" sheet XML. Rebuilt in full each run —
 * derived entirely from Clio, nothing hand-entered to preserve. Returns "" when
 * no timekeeper has any data, so the caller skips the tab.
 */
export function buildContingencyImpactSheet(
  data: ImpactByMonth,
  months: number[],
  roster: Member[],
  asOf?: string,
): string {
  const has = (c?: ImpactCell) => !!c && (
    (c.util && (c.util.billable !== 0 || c.util.contingencyBillable !== 0)) ||
    (c.realiz && (c.realiz.nondisc !== 0 || c.realiz.disc !== 0)) ||
    (c.coll && (c.coll.collected !== 0 || c.coll.uncollected !== 0)));
  const active = roster.filter((k) => months.some((m) => has(data[m]?.[k.user_id])));
  if (!active.length || !months.length) return "";

  const ytdCol = dataCol(months.length);
  const lastMonthCol = dataCol(months.length - 1);
  const rows: string[] = [];
  let r = 1;

  rows.push(xmlRow(r++, [xmlCell("A1", "CONTINGENCY IMPACT — WITH vs WITHOUT CONTINGENCY MATTERS", { style: STYLE_HDR })]));
  rows.push(xmlRow(r++, [xmlCell("A2",
    "Auto-generated — do not edit. Each rate appears twice: the existing tab's figure, then the same figure with contingency matters removed." +
    (asOf ? `  Data as of ${asOf}.` : ""), { style: STYLE_GEN })]));
  r++;
  rows.push(xmlRow(r, [
    xmlCell(`A${r}`, "HOW TO READ THIS", { style: STYLE_HDR }),
    xmlCell(`B${r}`, "", { style: STYLE_HDR }),
  ]));
  r++;
  for (const [term, meaning] of KEY) {
    rows.push(xmlRow(r, [xmlCell(`A${r}`, term, { style: STYLE_BOLD }), xmlCell(`B${r}`, meaning, { style: STYLE_GEN })]));
    r++;
  }
  r += 2;

  // Firm block sums every listed timekeeper; a field missing for everyone that
  // month stays blank rather than reading 0.
  const sumField = (m: number, get: (c: ImpactCell) => number | undefined): number | undefined => {
    let t = 0, any = false;
    for (const k of active) {
      const c = data[m]?.[k.user_id];
      const v = c ? get(c) : undefined;
      if (v === undefined) continue;
      t += v; any = true;
    }
    return any ? t : undefined;
  };
  const blocks: Array<{ label: string; value: (m: number, get: (c: ImpactCell) => number | undefined) => number | undefined }> = [
    { label: "FIRM TOTAL (listed timekeepers)", value: sumField },
    ...active.map((k) => ({
      label: k.name ? `${k.name} (${k.initials})` : k.initials,
      value: (m: number, get: (c: ImpactCell) => number | undefined) => {
        const c = data[m]?.[k.user_id];
        return c ? get(c) : undefined;
      },
    })),
  ];

  for (const block of blocks) {
    rows.push(xmlRow(r, [
      xmlCell(`A${r}`, block.label, { style: STYLE_HDR }),
      ...months.map((m, i) => xmlCell(`${dataCol(i)}${r}`, MONTH_NAMES_SHORT[m - 1] ?? String(m), { style: STYLE_HDR })),
      xmlCell(`${ytdCol}${r}`, "YTD", { style: STYLE_HDR }),
    ]));
    r++;

    for (const sec of SECTIONS) {
      rows.push(xmlRow(r, [xmlCell(`A${r}`, sec.title, { style: STYLE_BOLD })]));
      r++;
      const refs: number[] = [];
      for (const [label, get] of sec.hours) {
        const cells = [xmlCell(`A${r}`, label, { style: STYLE_GEN })];
        months.forEach((m, i) => {
          const v = block.value(m, get);
          if (v !== undefined) cells.push(xmlCell(`${dataCol(i)}${r}`, round1(v), { style: STYLE_DEC }));
        });
        cells.push(xmlCell(`${ytdCol}${r}`, null, { style: STYLE_DEC, formula: `SUM(${dataCol(0)}${r}:${lastMonthCol}${r})` }));
        rows.push(xmlRow(r, cells));
        refs.push(r);
        r++;
      }
      for (const [label, mk, headline] of sec.rates) {
        const style = headline ? STYLE_PCTB : STYLE_PCT;
        const cells = [xmlCell(`A${r}`, label, { style: headline ? STYLE_BOLD : STYLE_GEN })];
        for (let i = 0; i < months.length; i++) cells.push(xmlCell(`${dataCol(i)}${r}`, null, { style, formula: mk(refs, dataCol(i)) }));
        cells.push(xmlCell(`${ytdCol}${r}`, null, { style, formula: mk(refs, ytdCol) }));
        rows.push(xmlRow(r, cells));
        r++;
      }
    }
    r++;
  }

  const widths = `<cols><col min="1" max="1" width="42" customWidth="1"/>` +
    `<col min="2" max="${months.length + 1}" width="11" customWidth="1"/>` +
    `<col min="${months.length + 2}" max="${months.length + 2}" width="12" customWidth="1"/></cols>`;
  const views = `<sheetViews><sheetView workbookViewId="0">` +
    `<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/></sheetView></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    views + widths + `<sheetData>${rows.filter(Boolean).join("")}</sheetData></worksheet>`;
}

// ─── Collectors shared by the full build and the rate_tabs_only refresh ───

/** Everything a dashboard run needs before its tab loops; built once per run. */
export type ImpactContext = {
  data: ImpactByMonth;
  matters: ContingencyMatters | null;
  /** month → uid → contingency billable hrs; null when the entry pull failed. */
  contBillable: Record<number, Record<number, number>> | null;
  errors: string[];
  rowsRemoved: { realization: number; collection: number };
};

/**
 * One contingency-matter pull plus one classified /activities pull for the
 * roster (work dates Jan 1 .. end of `month`, capped at today). A failed step
 * is recorded in `errors` and the dependent figures stay blank — never 0.
 */
export async function startContingencyImpact(year: number, month: number, userIds: number[]): Promise<ImpactContext> {
  const ctx: ImpactContext = { data: {}, matters: null, contBillable: null, errors: [], rowsRemoved: { realization: 0, collection: 0 } };
  ctx.matters = await buildContingencyMatters();
  if (!ctx.matters) { ctx.errors.push("contingency matter lookup failed"); return ctx; }
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const entries = await classifyYtdTimeEntries({
      year, endDate: monthEnd < today ? monthEnd : today, userIds,
      contingencyMatterIds: ctx.matters.ids,
    });
    ctx.contBillable = contingencyBillableByMonth(entries);
  } catch (e: any) {
    ctx.errors.push(`contingency time-entry pull failed: ${e?.message ?? e}`);
  }
  return ctx;
}

/** Utilization pair for every month, read from the (already patched) Utilization tab. */
export function collectUtilImpact(
  ctx: ImpactContext, utilXml: string, months: number[], sharedStrings: string[],
  initialsToUid: Record<string, number>, aliases: Record<string, string>,
): void {
  if (!ctx.contBillable) return;
  for (const m of months) {
    const abbr = MONTH_ABBRS[m - 1];
    const billable = readTabColumnByUid(utilXml, abbr, sharedStrings, ["C", "D"], "C", initialsToUid, aliases);
    const nonbillable = readTabColumnByUid(utilXml, abbr, sharedStrings, ["C", "D"], "D", initialsToUid, aliases);
    const avail = readTabColumnByUid(utilXml, abbr, sharedStrings, ["C", "D"], "F", initialsToUid, aliases);
    for (const [uidStr, b] of Object.entries(billable)) {
      const uid = Number(uidStr);
      // No hours at all on the tab = no data for that person-month (the month
      // isn't snapshotted yet, the person wasn't active, or the snapshot is
      // missing). Leave it blank rather than write 0%: otherwise its Available
      // hours drag the YTD rate down. Same active-biller rule (C + D > 0) as the
      // tab's own Firm Average (appendUtilizationFirmAvg).
      if (!(b + (nonbillable[uid] ?? 0) > 0)) continue;
      impactCell(ctx.data, m, uid).util = {
        billable: b,
        contingencyBillable: ctx.contBillable[m]?.[uid] ?? 0,
        available: avail[uid] ?? DEFAULT_MONTHLY_AVAILABLE,
      };
    }
  }
}

/** Realization pair for one month: `agg` is the tab's own figures; the
 *  ex-contingency side re-aggregates the same rows minus contingency matters. */
export function collectRealizImpact(
  ctx: ImpactContext, month: number, agg: Record<number, RealizHoursAgg>,
  rows: Record<string, string>[] | undefined, nameToUid: Map<string, number>,
  placeholderKeys?: Set<string>,
): void {
  if (!ctx.matters || !rows) return;
  const ex = withoutContingencyRows(rows, ctx.matters.prefixes);
  ctx.rowsRemoved.realization += ex.removed;
  const aggEx = aggregateRealizationHours(ex.rows, nameToUid, { placeholderKeys });
  for (const [uidStr, a] of Object.entries(agg)) {
    const uid = Number(uidStr);
    impactCell(ctx.data, month, uid).realiz = {
      nondisc: a.billedNondiscHrs, disc: a.billedDiscHrs,
      nondiscEx: aggEx[uid]?.billedNondiscHrs ?? 0, discEx: aggEx[uid]?.billedDiscHrs ?? 0,
    };
  }
}

/** Collection pair for one month from the rows the tab used — Fee Allocation
 *  (default) or the Realization report (when the full build pins one). */
export function collectCollImpact(
  ctx: ImpactContext, month: number, collAgg: Record<number, RealizCollectionsAgg>,
  source: { kind: "fee_allocation"; rows: Record<string, string>[]; roster: { initials: string; name: string; user_id: number }[] }
        | { kind: "realization"; rows: Record<string, string>[]; nameToUid: Map<string, number> },
): void {
  if (!ctx.matters) return;
  const ex = withoutContingencyRows(source.rows, ctx.matters.prefixes);
  ctx.rowsRemoved.collection += ex.removed;
  const exAgg = source.kind === "fee_allocation"
    ? aggregateFeeAllocationCollectionHrs(ex.rows, source.roster)
    : aggregateRealizationCollections(ex.rows, source.nameToUid);
  for (const [uidStr, c] of Object.entries(collAgg)) {
    const uid = Number(uidStr);
    impactCell(ctx.data, month, uid).coll = {
      collected: c.collectedHrs, uncollected: c.uncollectedHrs,
      collectedEx: exAgg[uid]?.collectedHrs ?? 0, uncollectedEx: exAgg[uid]?.uncollectedHrs ?? 0,
    };
  }
}

/** Short summary for the tool result. */
export function impactSummary(ctx: ImpactContext, written: boolean) {
  return {
    tab: CONTINGENCY_IMPACT_TAB,
    written,
    contingency_matters: ctx.matters ? ctx.matters.ids.size : null,
    report_rows_removed: ctx.rowsRemoved,
    errors: ctx.errors.length ? ctx.errors : undefined,
  };
}
