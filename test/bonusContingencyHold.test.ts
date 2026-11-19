import { describe, it, expect } from "vitest";
import {
  computeBonusData, holdOutContingency, FIRM_BONUS_ATTORNEYS, MNH_SPLIT_AMONG, type BonusBracket,
} from "../src/dashboard/bonus";
import { aggregateMonthFees } from "../src/dashboard/collections";

// 2026 Partner Bonus Plan §4.2 (UWC, Nov 2026): a fee received on a
// contingency-fee matter earns no bonus until the Members decide in writing.
// Per NRN (Nov 19 2026) the same hold applies to associate bonuses, and
// associate targets keep the overhead share as previously calculated.
const BRACKETS: BonusBracket[] = [
  { width: 0, rate: 0 }, { width: 50000, rate: 0.05 },
  { width: 50000, rate: 0.10 }, { width: Infinity, rate: 0.15 },
];
const OPTS = { firmOverhead: 500000, numAttorneys: 5, brackets: BRACKETS, mnhSplitAmong: MNH_SPLIT_AMONG };
const last = (rows: { ytd: number; cumBonus: number }[]) => rows[rows.length - 1];

describe("aggregateMonthFees tags contingency-matter collections", () => {
  const ROSTER = [
    { initials: "NRN", name: "Nicholas Noe", user_id: 3 },
    { initials: "AKG", name: "Kaz Gonzalez", user_id: 9 },
  ];
  const row = (o: Record<string, string>) => ({
    "Originating Attorney": "Nicholas Noe", "Responsible Attorney": "Nicholas Noe", ...o,
  });
  it("counts only rows whose matter number is on the contingency list, by working timekeeper", () => {
    const agg = aggregateMonthFees([
      row({ User: "Nicholas Noe", Matter: "02436-Vitales, Juan - Real Estate Litigation", "Billed Time Collected": "18084.39" }),
      row({ User: "Kaz Gonzalez", Matter: "02436-Vitales, Juan - Real Estate Litigation", "Billed Time Collected": "1915.61" }),
      row({ User: "Nicholas Noe", Matter: "02500-Hourly Client", "Billed Time Collected": "450" }),
    ], ROSTER, new Set(["02436"]));
    expect(agg.contingencyIndiv).toEqual({ 3: 18084.39, 9: 1915.61 });
    expect(agg.indiv[3]).toBeCloseTo(18534.39, 2); // col N still includes it
  });
  it("tags nothing when no contingency list is passed (26 Compare callers unchanged)", () => {
    const agg = aggregateMonthFees([row({ User: "Nicholas Noe", Matter: "02436-Vitales", "Billed Time Collected": "100" })], ROSTER);
    expect(agg.contingencyIndiv).toEqual({});
  });
});

describe("holdOutContingency", () => {
  it("splits each month into net + held, capped so nothing goes negative", () => {
    const { net, held } = holdOutContingency(
      { October: { NRN: 30000, AKG: 1000, PAR: 5000 } },
      { October: { NRN: 18084.39, AKG: 1915.61 } }, // AKG held capped at the 1000 she has
    );
    expect(net.October).toEqual({ NRN: 11915.61, AKG: 0, PAR: 5000 });
    expect(held.October).toEqual({ NRN: 18084.39, AKG: 1000 });
  });
});

describe("live case: Vitales $20,000 (Oct 2026) on the Noe Team", () => {
  // NRN team YTD on the dashboard before the hold: $877,678.15 vs target
  // $845,606 → $1,603.61 accrued. The Vitales fee ($18,084.39 Nick + $1,915.61
  // Kaz) is all contingency, so the held figure must be $20,000 and the accrual
  // must drop by exactly 5% of it, to $603.61.
  const nrnOther = 877678.15 - 20000;
  const collections = {
    September: { NRN: nrnOther },
    October: { NRN: 18084.39, AKG: 1915.61 },
  };
  const contingency = { October: { NRN: 18084.39, AKG: 1915.61 } };

  it("drops NRN's accrued bonus from $1,603.61 to $603.61 and reports $20,000 held", () => {
    const before = computeBonusData(collections, FIRM_BONUS_ATTORNEYS, OPTS);
    expect(last(before.NRN.rows).cumBonus).toBeCloseTo(1603.61, 2);

    const { net, held } = holdOutContingency(collections, contingency);
    const after = computeBonusData(net, FIRM_BONUS_ATTORNEYS, OPTS);
    expect(last(after.NRN.rows).ytd).toBeCloseTo(857678.15, 2);
    expect(last(after.NRN.rows).cumBonus).toBeCloseTo(603.61, 2);

    const heldData = computeBonusData(held, FIRM_BONUS_ATTORNEYS, OPTS);
    expect(last(heldData.NRN.rows).ytd).toBeCloseTo(20000, 2);
    expect(last(heldData.PAR.rows).ytd).toBe(0);
    expect(last(heldData.KES.rows).ytd).toBe(0);
  });
});

describe("associate bonuses: contingency held, overhead share as previously calculated", () => {
  it("NAF target stays salary × 1.17 + overhead/5 and a contingency fee earns him nothing", () => {
    const naf = FIRM_BONUS_ATTORNEYS.filter((a) => a.ini === "NAF");
    const target = 130000 * 1.17 + 500000 / 5; // 252,100
    const collections = { March: { NAF: target }, April: { NAF: 10000 } };
    const { net, held } = holdOutContingency(collections, { April: { NAF: 10000 } });

    const data = computeBonusData(net, naf, OPTS);
    expect(data.NAF.baseTarget).toBeCloseTo(252100, 2);
    expect(last(data.NAF.rows).cumBonus).toBe(0);           // without the hold: $500
    expect(last(computeBonusData(collections, naf, OPTS).NAF.rows).cumBonus).toBeCloseTo(500, 2);
    expect(last(computeBonusData(held, naf, OPTS).NAF.rows).ytd).toBeCloseTo(10000, 2);
  });
});
