import { describe, it, expect } from "vitest";
import {
  parseCSV, matchRosterUser, matchRosterResponsible,
  aggregateRealizationCollections, aggregateFeeAllocationCollectionHrs,
  aggregateRealizationHours, isUnbilledRealizStatus, placeholderKey, realizRowDate,
} from "../src/clio/reportCsv";

const roster = [
  { initials: "NRN", name: "Nicholas Noe", user_id: 348755029 },
  { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
];

describe("parseCSV", () => {
  it("parses headers + rows", () => {
    expect(parseCSV("a,b,c\n1,2,3")).toEqual([{ a: "1", b: "2", c: "3" }]);
  });
  it("strips a leading UTF-8 BOM from the first header", () => {
    expect(parseCSV("﻿h1,h2\nv1,v2")[0]).toEqual({ h1: "v1", h2: "v2" });
  });
  it("respects quoted fields with commas and escaped quotes", () => {
    expect(parseCSV('a,b\n"x,y","a""b"')).toEqual([{ a: "x,y", b: 'a"b' }]);
  });
  it("skips blank lines; header-only yields []", () => {
    expect(parseCSV("a,b\n\n1,2\n")).toEqual([{ a: "1", b: "2" }]);
    expect(parseCSV("a,b")).toEqual([]);
  });
});

describe("matchRosterUser ('Last, First' or 'First Last')", () => {
  it("matches Last, First", () => expect(matchRosterUser("Simmons, Tzipora", roster)).toBe(359711375));
  it("matches First Last", () => expect(matchRosterUser("Nicholas Noe", roster)).toBe(348755029));
  it("returns null for unknown", () => expect(matchRosterUser("Nobody, X", roster)).toBeNull());
});

describe("matchRosterResponsible ('First Last')", () => {
  it("exact match", () => expect(matchRosterResponsible("Nicholas Noe", roster)).toBe(348755029));
  it("last-name fallback", () => expect(matchRosterResponsible("Noe", roster)).toBe(348755029));
  it("empty -> null", () => expect(matchRosterResponsible("", roster)).toBeNull());
});

// Collection-tab HOURS split: the Realization-report aggregator and the
// Fee-Allocation aggregator must produce IDENTICAL collected/uncollected hours
// given the same economic inputs (billed$, collected$, outstanding$, billed hrs).
// This proves the "compare_collection_methods" diagnostic measures the SOURCE
// population (Realization = time-entry date vs Fee Allocation = issue date), not
// a difference in the arithmetic — so any live delta is a real basis difference,
// not a bug. Column names differ between the two reports ("Billed Time Amount"
// vs "Billed Time").
describe("collection HOURS aggregators are equivalent given equal inputs", () => {
  const nameToUid = new Map<string, number>(roster.map((r) => [r.name.toLowerCase(), r.user_id]));

  it("allocates billed hours to collected/uncollected by the dollar split", () => {
    const realizRows = [
      { User: "Nicholas Noe", "Billed Time Amount": "1000", "Billed Time Collected": "600", "Billed Time Outstanding": "400", "Billed Hours": "10" },
    ];
    const feeRows = [
      { User: "Nicholas Noe", "Billed Time": "1000", "Billed Time Collected": "600", "Billed Time Outstanding": "400", "Billed Hours": "10" },
    ];
    const a = aggregateRealizationCollections(realizRows, nameToUid)[348755029];
    const b = aggregateFeeAllocationCollectionHrs(feeRows, roster)[348755029];
    expect(a.collectedHrs).toBeCloseTo(6, 6);
    expect(a.uncollectedHrs).toBeCloseTo(4, 6);
    expect(b.collectedHrs).toBeCloseTo(a.collectedHrs, 6);
    expect(b.uncollectedHrs).toBeCloseTo(a.uncollectedHrs, 6);
  });

  it("sums multiple entries and skips zero-billed / non-roster rows", () => {
    const realizRows = [
      { User: "Nicholas Noe", "Billed Time Amount": "1000", "Billed Time Collected": "500", "Billed Time Outstanding": "500", "Billed Hours": "8" },
      { User: "Nicholas Noe", "Billed Time Amount": "200", "Billed Time Collected": "200", "Billed Time Outstanding": "0", "Billed Hours": "2" },
      { User: "Nicholas Noe", "Billed Time Amount": "0", "Billed Time Collected": "0", "Billed Time Outstanding": "0", "Billed Hours": "0" }, // unbilled — skipped
      { User: "Stranger, Sam", "Billed Time Amount": "500", "Billed Time Collected": "500", "Billed Time Outstanding": "0", "Billed Hours": "5" }, // non-roster — skipped
    ];
    const agg = aggregateRealizationCollections(realizRows, nameToUid)[348755029];
    // entry1: 8h * 0.5 = 4 collected, 4 uncollected; entry2: 2h collected
    expect(agg.collectedHrs).toBeCloseTo(6, 6);
    expect(agg.uncollectedHrs).toBeCloseTo(4, 6);
  });
});

// ---------------------------------------------------------------------------
// Realization-tab D/E/F hours, read from Clio's Realization report rather than
// inferred. Column names and value shapes below are taken from a live report
// (MNH, Jan 2026): discount columns arrive NEGATIVE, "Billed Hours" already
// EXCLUDES the discounted portion, and for a billed entry
//   Quantity == Billed Hours + |Hours Discounted|
// ---------------------------------------------------------------------------
describe("isUnbilledRealizStatus", () => {
  it("treats no-invoice and draft as unbilled", () => {
    for (const st of ["", "-", " - ", "Draft", "draft bill"]) {
      expect(isUnbilledRealizStatus(st)).toBe(true);
    }
    expect(isUnbilledRealizStatus(undefined)).toBe(true);
  });
  it("treats an issued bill as billed", () => {
    for (const st of ["Billed", "Paid", "Awaiting Payment"]) {
      expect(isUnbilledRealizStatus(st)).toBe(false);
    }
  });
});

describe("aggregateRealizationHours", () => {
  const nameToUid = new Map<string, number>(roster.map((r) => [r.name.toLowerCase(), r.user_id]));
  const NRN = 348755029;
  const row = (o: Record<string, string>) => ({
    User: "Nicholas Noe", "Time Entry Type": "Hourly", "Invoice Status": "Billed",
    Quantity: "0", "Billed Hours": "0", "Hours Discounted": "0", "Adjusted Hours": "0", ...o,
  });

  it("reads NEGATIVE Hours Discounted as discounted hours (the live sign convention)", () => {
    const agg = aggregateRealizationHours([
      row({ Quantity: "0.4", "Billed Hours": "0", "Hours Discounted": "-0.4" }),
      row({ Quantity: "0.6", "Billed Hours": "0", "Hours Discounted": "-0.6" }),
    ], nameToUid)[NRN];
    expect(agg.billedDiscHrs).toBeCloseTo(1.0, 6);
    expect(agg.billedNondiscHrs).toBeCloseTo(0, 6);
    expect(agg.unbilledHrs).toBeCloseTo(0, 6);
  });

  it("handles an unsigned Hours Discounted identically", () => {
    const neg = aggregateRealizationHours([row({ Quantity: "2", "Billed Hours": "0", "Hours Discounted": "-2" })], nameToUid)[NRN];
    const pos = aggregateRealizationHours([row({ Quantity: "2", "Billed Hours": "0", "Hours Discounted": "2" })], nameToUid)[NRN];
    expect(pos.billedDiscHrs).toBeCloseTo(neg.billedDiscHrs, 6);
  });

  it("splits a partly-discounted entry so D + E == Quantity", () => {
    const agg = aggregateRealizationHours([
      row({ Quantity: "1.0", "Billed Hours": "0.6", "Hours Discounted": "-0.4" }),
    ], nameToUid)[NRN];
    expect(agg.billedNondiscHrs).toBeCloseTo(0.6, 6);
    expect(agg.billedDiscHrs).toBeCloseTo(0.4, 6);
    expect(agg.billedNondiscHrs + agg.billedDiscHrs).toBeCloseTo(1.0, 6);
  });

  it("counts a no-invoice entry as unbilled at its full quantity", () => {
    const agg = aggregateRealizationHours([
      row({ "Invoice Status": "-", Quantity: "3.5" }),
      row({ "Invoice Status": "Draft", Quantity: "1.5" }),
    ], nameToUid)[NRN];
    expect(agg.unbilledHrs).toBeCloseTo(5.0, 6);
    expect(agg.billedNondiscHrs).toBeCloseTo(0, 6);
    expect(agg.billedDiscHrs).toBeCloseTo(0, 6);
  });

  it("excludes nonbillable time from every bucket", () => {
    const agg = aggregateRealizationHours([
      row({ "Time Entry Type": "Non-billable", "Invoice Status": "-", Quantity: "7.6" }),
      row({ Quantity: "1", "Billed Hours": "1" }),
    ], nameToUid)[NRN];
    expect(agg.unbilledHrs).toBeCloseTo(0, 6);
    expect(agg.billedNondiscHrs).toBeCloseTo(1, 6);
  });

  it("folds Adjusted Hours into discounted while keeping the component visible", () => {
    // Adjusted Hours is a second reduction alongside the discount: it must land in
    // a bucket or the denominator stops equalling hours worked.
    const agg = aggregateRealizationHours([
      row({ Quantity: "2", "Billed Hours": "1.5", "Adjusted Hours": "-0.5" }),
    ], nameToUid)[NRN];
    expect(agg.billedNondiscHrs).toBeCloseTo(1.5, 6);
    expect(agg.billedDiscHrs).toBeCloseTo(0.5, 6);
    expect(agg.adjustedHrs).toBeCloseTo(0.5, 6);
    expect(agg.billedNondiscHrs + agg.billedDiscHrs).toBeCloseTo(2, 6);
  });

  it("holds the three-term identity on real report rows (live Jan 2026 shapes)", () => {
    // The only 3 rows of 227 that broke the two-term identity were exactly the
    // rows carrying Adjusted Hours; each closes with the third term.
    const agg = aggregateRealizationHours([
      row({ Quantity: "0.4", "Billed Hours": "0.28", "Hours Discounted": "0", "Adjusted Hours": "-0.12" }),
      row({ Quantity: "0.4", "Billed Hours": "0.28", "Hours Discounted": "0", "Adjusted Hours": "-0.12" }),
      row({ Quantity: "0.6", "Billed Hours": "0.43", "Hours Discounted": "0", "Adjusted Hours": "-0.17" }),
      row({ Quantity: "0.4", "Billed Hours": "0", "Hours Discounted": "-0.4" }),
    ], nameToUid)[NRN];
    const total = agg.billedNondiscHrs + agg.billedDiscHrs + agg.unbilledHrs;
    expect(total).toBeCloseTo(1.8, 6);      // 0.4 + 0.4 + 0.6 + 0.4
    expect(agg.adjustedHrs).toBeCloseTo(0.41, 6);
    expect(agg.billedDiscHrs).toBeCloseTo(0.81, 6);  // 0.41 adjusted + 0.4 discounted
  });

  it("subtracts an UPWARD Adjusted Hours instead of adding it", () => {
    // Regression. Adjusted Hours is signed and bidirectional, so Math.abs turned
    // an entry billed ABOVE standard into extra discounted hours — wrong twice
    // over. The hours mirror of the live April dollar row on matter
    // "03357-Young, Joyce M. - Estate of" (2.0 hrs at $450 billed at $1,170,
    // Adjusted Amount +$270 == +0.6 hrs).
    const agg = aggregateRealizationHours([
      row({ Quantity: "2.0", "Billed Hours": "2.6", "Adjusted Hours": "0.6" }),
    ], nameToUid)[NRN];
    expect(agg.adjustedHrs).toBeCloseTo(-0.6, 6);
    expect(agg.billedDiscHrs).toBeCloseTo(-0.6, 6);
    // The point of the fix: D + E still equals the hours actually worked.
    expect(agg.billedNondiscHrs + agg.billedDiscHrs).toBeCloseTo(2.0, 6);
  });

  it("still routes a billed row with an adjustment but no billed hours to col E", () => {
    // The anomaly guard tests the three columns separately so a nonzero
    // adjustment cannot cancel against billed hours and be miscounted unbilled.
    const agg = aggregateRealizationHours([
      row({ Quantity: "1.0", "Billed Hours": "0", "Adjusted Hours": "-1.0" }),
    ], nameToUid)[NRN];
    expect(agg.billedDiscHrs).toBeCloseTo(1.0, 6);
    expect(agg.unbilledHrs).toBeCloseTo(0, 6);
  });

  it("skips non-roster users", () => {
    const agg = aggregateRealizationHours([
      { ...row({ Quantity: "5", "Billed Hours": "5" }), User: "Stranger, Sam" },
    ], nameToUid);
    expect(Object.keys(agg)).toHaveLength(0);
  });

  it("preserves the month's total hours: D + E + F == sum of Quantity", () => {
    const rows = [
      row({ Quantity: "10", "Billed Hours": "10" }),
      row({ Quantity: "4", "Billed Hours": "1.5", "Hours Discounted": "-2.5" }),
      row({ Quantity: "2", "Billed Hours": "1.2", "Hours Discounted": "-0.5", "Adjusted Hours": "-0.3" }),
      row({ "Invoice Status": "-", Quantity: "6" }),
    ];
    const a = aggregateRealizationHours(rows, nameToUid)[NRN];
    expect(a.billedNondiscHrs + a.billedDiscHrs + a.unbilledHrs).toBeCloseTo(22, 6);
  });

  it("buckets a billed row with no billed or discounted hours as unbilled, keeping the total intact", () => {
    const a = aggregateRealizationHours([
      row({ "Invoice Status": "Billed", Quantity: "2", "Billed Hours": "0", "Hours Discounted": "0" }),
    ], nameToUid)[NRN];
    expect(a.unbilledHrs).toBeCloseTo(2, 6);
    expect(a.billedNondiscHrs + a.billedDiscHrs).toBeCloseTo(0, 6);
  });
});

describe("aggregateRealizationHours: $0-rate time and fee placeholders", () => {
  const nameToUid = new Map<string, number>(roster.map((r) => [r.name.toLowerCase(), r.user_id]));
  const NRN = 348755029;
  const GHOLSTON = "02681-Gholston Sr., Ronald - Estate of";
  // Shapes copied from the live Realization report for NRN, Mar/Apr 2025.
  const live = (o: Record<string, string>) => ({
    "Time Entry Date": "04/16/2025", User: "Nicholas Noe", "Time Entry Type": "Hourly",
    "Invoice Status": "Billed", "Rate Type": "Custom rate", Rate: "400.0", Quantity: "0.2",
    "Original Billable Total": "80.0", "Adjusted Hours": "0.0", "Hours Discounted": "0.0",
    "Billed Hours": "0.2", "Matter Number": "02705-Lopez, Joaquin Peter - Estate of", ...o,
  });
  const zeroBilled = live({
    "Time Entry Date": "03/12/2025", Rate: "0.0", Quantity: "1.0", "Original Billable Total": "0.0",
    "Billed Hours": "0.0", "Matter Number": GHOLSTON,
  });
  const placeholder = live({
    Rate: "56187.98", Quantity: "1.0", "Original Billable Total": "56187.98",
    "Billed Hours": "1.0", "Matter Number": GHOLSTON,
  });

  it("backs a billed $0-rate row out of D/E/F instead of dumping it in unbilled", () => {
    // Regression: Billed Hours 0.0 with nothing discounted used to trip the anomaly
    // guard and land in col F as never-to-bill "unbilled" time.
    const a = aggregateRealizationHours([zeroBilled, live({})], nameToUid)[NRN];
    expect(a.unbilledHrs).toBeCloseTo(0, 6);
    expect(a.billedNondiscHrs).toBeCloseTo(0.2, 6);
    expect(a.billedDiscHrs).toBeCloseTo(0, 6);
    expect(a.zeroRateHrs).toBeCloseTo(1.0, 6);
  });

  it("backs out unbilled $0-rate time too", () => {
    const a = aggregateRealizationHours([
      live({ "Invoice Status": "-", Rate: "0.0", Quantity: "2.5", "Original Billable Total": "0.0", "Billed Hours": "0.0" }),
    ], nameToUid)[NRN];
    expect(a.unbilledHrs).toBeCloseTo(0, 6);
    expect(a.zeroRateHrs).toBeCloseTo(2.5, 6);
  });

  it("keeps a $0 row that still carries billable value (rate 0 alone is not enough)", () => {
    const a = aggregateRealizationHours([
      live({ Rate: "0.0", "Original Billable Total": "80.0" }),
    ], nameToUid)[NRN];
    expect(a.zeroRateHrs).toBeCloseTo(0, 6);
    expect(a.billedNondiscHrs).toBeCloseTo(0.2, 6);
  });

  it("does not treat missing Rate / Original Billable Total columns as $0", () => {
    // A schema change must not silently empty the tab.
    const r: Record<string, string> = { ...live({}) };
    delete r["Rate"]; delete r["Original Billable Total"];
    const a = aggregateRealizationHours([r], nameToUid)[NRN];
    expect(a.billedNondiscHrs).toBeCloseTo(0.2, 6);
    expect(a.zeroRateHrs).toBeCloseTo(0, 6);
  });

  it("backs out a keyed fee placeholder from col D", () => {
    const keys = new Set([placeholderKey(NRN, "2025-04-16", GHOLSTON, 56187.98)]);
    const a = aggregateRealizationHours([placeholder, live({})], nameToUid, { placeholderKeys: keys })[NRN];
    expect(a.billedNondiscHrs).toBeCloseTo(0.2, 6);
    expect(a.placeholderHrs).toBeCloseTo(1.0, 6);
  });

  it("leaves the placeholder in col D when no keys are supplied (prior behavior)", () => {
    const a = aggregateRealizationHours([placeholder], nameToUid)[NRN];
    expect(a.billedNondiscHrs).toBeCloseTo(1.0, 6);
    expect(a.placeholderHrs).toBeCloseTo(0, 6);
  });

  it("does not strip an unkeyed 1.0h row on the same matter and day", () => {
    const keys = new Set([placeholderKey(NRN, "2025-04-16", GHOLSTON, 56187.98)]);
    const other = live({ Rate: "39609.15", Quantity: "1.0", "Original Billable Total": "39609.15", "Billed Hours": "1.0", "Matter Number": GHOLSTON });
    const a = aggregateRealizationHours([other], nameToUid, { placeholderKeys: keys })[NRN];
    expect(a.billedNondiscHrs).toBeCloseTo(1.0, 6);
  });
});

describe("placeholderKey / realizRowDate", () => {
  it("converts the report's MM/DD/YYYY to the /activities date form", () => {
    expect(realizRowDate("04/16/2025")).toBe("2025-04-16");
    expect(realizRowDate("4/6/2025")).toBe("2025-04-06");
    expect(realizRowDate("2025-04-16")).toBe("2025-04-16");
  });
  it("matches across float noise and matter-number case/whitespace", () => {
    expect(placeholderKey(1, "2025-04-16", " 02681-Gholston ", 56187.98))
      .toBe(placeholderKey(1, "2025-04-16", "02681-gholston", 56187.980000001));
  });
});
