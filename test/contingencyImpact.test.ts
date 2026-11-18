import { describe, it, expect } from "vitest";
import {
  isContingencyReportRow, withoutContingencyRows, contingencyBillableByMonth,
  buildContingencyImpactSheet, collectRealizImpact, collectCollImpact, collectUtilImpact,
  impactCell, DEFAULT_MONTHLY_AVAILABLE, type ImpactContext,
} from "../src/dashboard/contingencyImpact";
import { matterNumberPrefix, type ClassifiedTimeEntry } from "../src/dashboard/classifiedHours";

const PREFIXES = new Set(["03061", "02671"]); // Teachworth, Anike — both Contingency-checked in Clio

const ctx = (): ImpactContext => ({
  data: {}, matters: { ids: new Set([1799152610]), prefixes: PREFIXES },
  contBillable: {}, errors: [], rowsRemoved: { realization: 0, collection: 0 },
});

describe("matter matching", () => {
  it("takes the leading matter number from a display number or report cell", () => {
    expect(matterNumberPrefix("03061-Teachworth, Walter & Joan, - In The Estate of")).toBe("03061");
    expect(matterNumberPrefix("  02671")).toBe("02671");
    expect(matterNumberPrefix("Teachworth 03061")).toBeNull(); // not leading → never matched
    expect(matterNumberPrefix("")).toBeNull();
    expect(matterNumberPrefix(undefined)).toBeNull();
  });

  it("matches Realization ('Matter Number') and Fee Allocation ('Matter') rows", () => {
    expect(isContingencyReportRow({ "Matter Number": "03061-Teachworth" }, PREFIXES)).toBe(true);
    expect(isContingencyReportRow({ Matter: "02671-Anike Fort Bend Property Ownership" }, PREFIXES)).toBe(true);
    expect(isContingencyReportRow({ Matter: "02888-Admin" }, PREFIXES)).toBe(false);
    expect(isContingencyReportRow({}, PREFIXES)).toBe(false);
    // 030610 must not match 03061 — whole leading number only.
    expect(isContingencyReportRow({ Matter: "030610-Other" }, PREFIXES)).toBe(false);
  });

  it("removes only contingency rows and counts them", () => {
    const rows = [{ Matter: "03061-T" }, { Matter: "02888-Admin" }, { Matter: "02671-A" }];
    const out = withoutContingencyRows(rows, PREFIXES);
    expect(out.rows).toEqual([{ Matter: "02888-Admin" }]);
    expect(out.removed).toBe(2);
  });
});

describe("contingencyBillableByMonth", () => {
  const e = (over: Partial<ClassifiedTimeEntry>): ClassifiedTimeEntry => ({
    id: 1, uid: 344117381, userName: "Paul Romano", date: "2026-03-05", hours: 2,
    cls: "billable", clsRaw: "billable", internal: false, internalAny: false, contingency: true, ...over,
  });
  it("sums adjusted-billable contingency hours by month and user only", () => {
    const out = contingencyBillableByMonth([
      e({ hours: 2 }),
      e({ hours: 1.5, date: "2026-03-20" }),
      e({ hours: 4, cls: "nonbillable" }),     // not billable → not subtracted from billable
      e({ hours: 3, contingency: false }),     // hourly matter
      e({ hours: 5, contingency: null }),      // unknown → never counted
      e({ hours: 1, date: "2026-04-02", uid: 359711375 }),
    ]);
    expect(out[3][344117381]).toBeCloseTo(3.5, 6);
    expect(out[4][359711375]).toBeCloseTo(1, 6);
    expect(out[3][359711375]).toBeUndefined();
  });
});

describe("collectors", () => {
  it("realization: 'with' is the tab's agg untouched, 'without' re-aggregates minus contingency rows", () => {
    const c = ctx();
    const nameToUid = new Map([["paul romano", 344117381]]);
    const row = (matter: string, billed: string, disc: string) => ({
      User: "Paul Romano", "Matter Number": matter, "Time Entry Type": "Hourly", Quantity: "1",
      Rate: "450", "Original Billable Total": "450", "Billed Hours": billed, "Hours Discounted": disc,
      "Adjusted Hours": "0", "Invoice Status": "Paid", "Time Entry Date": "03/05/2026",
    });
    const rows = [row("02500-Client", "1", "0"), row("03061-Teachworth", "0", "1")];
    const tabAgg = { 344117381: { billedNondiscHrs: 1, billedDiscHrs: 1, unbilledHrs: 0, adjustedHrs: 0, zeroRateHrs: 0, placeholderHrs: 0 } };
    collectRealizImpact(c, 3, tabAgg, rows, nameToUid);
    const r = c.data[3][344117381].realiz!;
    expect(r.nondisc).toBe(1);
    expect(r.disc).toBe(1);
    expect(c.rowsRemoved.realization).toBe(1);
    expect(r.discEx).toBe(0); // the discounted hour was on the contingency matter
  });

  it("realization: legacy path (no rows) leaves the cell blank", () => {
    const c = ctx();
    collectRealizImpact(c, 3, { 1: { billedNondiscHrs: 1, billedDiscHrs: 0, unbilledHrs: 0, adjustedHrs: 0, zeroRateHrs: 0, placeholderHrs: 0 } }, undefined, new Map());
    expect(c.data[3]).toBeUndefined();
  });

  it("collection: fee-allocation rows split with/without by matter", () => {
    const c = ctx();
    const roster = [{ initials: "PAR", name: "Paul Romano", user_id: 344117381 }];
    const row = (matter: string, coll: string, out: string) => ({
      User: "Paul Romano", Matter: matter, "Billed Time": "450", "Billed Time Collected": coll,
      "Billed Time Outstanding": out, "Billed Hours": "1",
    });
    const rows = [row("02500-Client", "450", "0"), row("03061-Teachworth", "0", "450")];
    collectCollImpact(c, 3, { 344117381: { collectedHrs: 1, uncollectedHrs: 1 } }, { kind: "fee_allocation", rows, roster });
    expect(c.data[3][344117381].coll).toEqual({ collected: 1, uncollected: 1, collectedEx: 1, uncollectedEx: 0 });
    expect(c.rowsRemoved.collection).toBe(1);
  });

  it("a failed contingency lookup collects nothing (blank, never 0)", () => {
    const c: ImpactContext = { ...ctx(), matters: null, contBillable: null };
    collectCollImpact(c, 3, { 1: { collectedHrs: 1, uncollectedHrs: 0 } }, { kind: "fee_allocation", rows: [], roster: [] });
    collectUtilImpact(c, "<worksheet/>", [3], [], {}, {});
    expect(c.data).toEqual({});
  });
});

describe("buildContingencyImpactSheet", () => {
  const roster = [
    { initials: "PAR", name: "Paul Romano", user_id: 344117381 },
    { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
    { initials: "XXX", name: "No Data", user_id: 1 },
  ];

  it("returns empty when nobody has data", () => {
    expect(buildContingencyImpactSheet({}, [1, 2], roster)).toBe("");
  });

  it("writes a firm block plus one per active timekeeper, with both rates as formulas", () => {
    const data = {};
    impactCell(data, 3, 344117381).util = { billable: 120, contingencyBillable: 40, available: DEFAULT_MONTHLY_AVAILABLE };
    impactCell(data, 3, 344117381).realiz = { nondisc: 80, disc: 20, nondiscEx: 70, discEx: 5 };
    impactCell(data, 3, 359711375).coll = { collected: 50, uncollected: 10, collectedEx: 50, uncollectedEx: 2 };
    const xml = buildContingencyImpactSheet(data, [3], roster, "2026-11-18");
    expect(xml).toContain("FIRM TOTAL (listed timekeepers)");
    expect(xml).toContain("Paul Romano (PAR)");
    expect(xml).toContain("Tzipora Simmons (TBS)");
    expect(xml).not.toContain("No Data (XXX)");
    expect(xml).toContain("Utilization — without contingency");
    expect(xml).toContain("MAX(0,");                 // without = (billable − contingency) ÷ available
    expect(xml).toContain("Data as of 2026-11-18");
    // Firm block sums the two people's Billable hrs.
    expect(xml).toMatch(/Billable hrs[\s\S]*?>120</);
  });

  it("leaves a cell blank when a source had no data that month (never writes 0)", () => {
    const data = {};
    impactCell(data, 1, 344117381).util = { billable: 100, contingencyBillable: 0, available: 156 };
    // Feb has no data at all for anyone.
    const xml = buildContingencyImpactSheet(data, [1, 2], roster);
    // Billable hrs row: Jan (B) written, Feb (C) absent, YTD (D) a SUM formula.
    const billableRow = xml.match(/<row r="(\d+)"><c r="A\1"[^>]*><is><t>Billable hrs<\/t><\/is><\/c>(.*?)<\/row>/);
    expect(billableRow).not.toBeNull();
    expect(billableRow![2]).toContain(`r="B${billableRow![1]}"`);
    expect(billableRow![2]).not.toContain(`r="C${billableRow![1]}"`);
    expect(billableRow![2]).toContain("SUM(");
  });
});
