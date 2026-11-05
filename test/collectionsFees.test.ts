import { describe, it, expect } from "vitest";
import { aggregateMonthFees } from "../src/dashboard/collections";
import { COLLECTIONS_ROSTER, type RosterMember } from "../src/domain/roster";

const ROSTER: RosterMember[] = [
  { initials: "PAR", name: "Paul Romano", user_id: 1 },
  { initials: "KES", name: "Kenny Sumner", user_id: 2 },
  { initials: "NRN", name: "Nicholas Noe", user_id: 3 },
];

// Mirrors the real Fee Allocation CSV columns.
const row = (o: Partial<Record<string, string>>): Record<string, string> => ({
  User: "", "Originating Attorney": "", "Responsible Attorney": "",
  "Billed Time Collected": "0", "Expense Amount Collected": "0", "Total Funds Collected": "0",
  ...o,
});

describe("aggregateMonthFees", () => {
  it("uses Billed Time Collected (fees only), ignoring expenses/tax in Total Funds", () => {
    const rows = [
      row({ User: "Paul Romano", "Originating Attorney": "Paul Romano", "Responsible Attorney": "Paul Romano",
        "Billed Time Collected": "735.0", "Expense Amount Collected": "3.34", "Total Funds Collected": "738.34" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.indiv[1]).toBe(735); // not 738.34 — expense excluded
    expect(agg.firm).toBe(735);
  });

  it("credits col N by working timekeeper, col S by responsible attorney, col V by originating attorney", () => {
    const rows = [
      // Worked by Kenny, responsible Nicholas, originated by Paul
      row({ User: "Kenny Sumner", "Responsible Attorney": "Nicholas Noe", "Originating Attorney": "Paul Romano", "Billed Time Collected": "1000" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.indiv[2]).toBe(1000); // KES (worker) → col N
    expect(agg.resp[3]).toBe(1000);  // NRN (responsible) → col S
    expect(agg.orig[1]).toBe(1000);  // PAR (originator) → col V
  });

  it("tags each working timekeeper's fees by responsible attorney (0 = non-roster) for bonus matter splits", () => {
    const rows = [
      row({ User: "Kenny Sumner", "Responsible Attorney": "Nicholas Noe", "Billed Time Collected": "100" }),
      row({ User: "Kenny Sumner", "Responsible Attorney": "Kenny Sumner", "Billed Time Collected": "40" }),
      row({ User: "Kenny Sumner", "Responsible Attorney": "Someone Else", "Billed Time Collected": "5" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.indivResp[2]).toEqual({ 3: 100, 2: 40, 0: 5 });
    expect(agg.indiv[2]).toBe(145); // per-responsible tags sum to the col-N figure
  });

  it("pools non-roster billers so Σ col N (+NRB) == Σ col S (+NRB) == Σ col V (+NRB) == firm fees", () => {
    const rows = [
      row({ User: "Paul Romano", "Responsible Attorney": "Paul Romano", "Originating Attorney": "Paul Romano", "Billed Time Collected": "500" }),
      // Non-roster worker, roster responsible/originator → drops from col N without NRB, but kept via nonRosterIndiv
      row({ User: "Elissa Silguero", "Responsible Attorney": "Kenny Sumner", "Originating Attorney": "Kenny Sumner", "Billed Time Collected": "300" }),
      // Roster worker, non-roster responsible + originator → kept via nonRosterResp/nonRosterOrig
      row({ User: "Nicholas Noe", "Responsible Attorney": "Former Partner", "Originating Attorney": "Former Partner", "Billed Time Collected": "200" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    const sumN = Object.values(agg.indiv).reduce((s, v) => s + v, 0) + agg.nonRosterIndiv;
    const sumS = Object.values(agg.resp).reduce((s, v) => s + v, 0) + agg.nonRosterResp;
    const sumV = Object.values(agg.orig).reduce((s, v) => s + v, 0) + agg.nonRosterOrig;
    expect(agg.firm).toBe(1000);
    expect(sumN).toBe(1000);
    expect(sumS).toBe(1000);
    expect(sumV).toBe(1000);
    expect(agg.nonRosterIndiv).toBe(300); // Elissa
    expect(agg.nonRosterResp).toBe(200);  // Former Partner
    expect(agg.nonRosterOrig).toBe(200);  // Former Partner
  });

  it("a blank Responsible Attorney falls into the NRB pool (col S still reconciles)", () => {
    const rows = [
      row({ User: "Paul Romano", "Responsible Attorney": "", "Billed Time Collected": "750" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.resp).toEqual({});
    expect(agg.nonRosterResp).toBe(750);
    const sumS = Object.values(agg.resp).reduce((s, v) => s + v, 0) + agg.nonRosterResp;
    expect(sumS).toBe(agg.firm);
  });

  it("skips rows with zero collected fees", () => {
    const rows = [row({ User: "Paul Romano", "Billed Time Collected": "0", "Expense Amount Collected": "50" })];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.firm).toBe(0);
    expect(agg.indiv[1]).toBeUndefined();
  });
});

describe("COLLECTIONS_ROSTER same-last-name disambiguation", () => {
  const uid = (initials: string) => COLLECTIONS_ROSTER.find((r) => r.initials === initials)!.user_id;

  it("routes shared last names (Noe, Hebert, Romano) to the correct individual row", () => {
    const rows = [
      row({ User: "Nicholas Noe", "Billed Time Collected": "100" }),
      row({ User: "Grace Noe", "Billed Time Collected": "10" }),
      row({ User: "Paul Romano", "Billed Time Collected": "200" }),
      row({ User: "Silvana Romano", "Billed Time Collected": "20" }),
      row({ User: "Lindsey Hebert", "Billed Time Collected": "30" }),
      row({ User: "Sara Hebert", "Billed Time Collected": "40" }),
      row({ User: "Joshua Dunegan", "Billed Time Collected": "7170" }),
    ];
    const agg = aggregateMonthFees(rows, COLLECTIONS_ROSTER);
    expect(agg.indiv[uid("NRN")]).toBe(100);
    expect(agg.indiv[uid("GKN")]).toBe(10);
    expect(agg.indiv[uid("PAR")]).toBe(200);
    expect(agg.indiv[uid("SPR")]).toBe(20);
    expect(agg.indiv[uid("LSH")]).toBe(30);
    expect(agg.indiv[uid("SKH")]).toBe(40);
    expect(agg.indiv[uid("JAD")]).toBe(7170);
    expect(agg.nonRosterIndiv).toBe(0);
  });

  it("a biller with no roster row (Merari) falls into the non-roster pool", () => {
    const rows = [
      row({ User: "Paul Romano", "Billed Time Collected": "500" }),
      row({ User: "Merari Zambrano", "Billed Time Collected": "440" }),
    ];
    const agg = aggregateMonthFees(rows, COLLECTIONS_ROSTER);
    expect(agg.indiv[uid("PAR")]).toBe(500);
    expect(agg.nonRosterIndiv).toBe(440);
    const sumN = Object.values(agg.indiv).reduce((s, v) => s + v, 0) + agg.nonRosterIndiv;
    expect(sumN).toBe(agg.firm); // reconciles to firm fees
  });

  it("roster has unique initials and unique user_ids (28 incl. Stacy/SAB)", () => {
    expect(COLLECTIONS_ROSTER.length).toBe(28);
    expect(new Set(COLLECTIONS_ROSTER.map((r) => r.initials)).size).toBe(COLLECTIONS_ROSTER.length);
    expect(new Set(COLLECTIONS_ROSTER.map((r) => r.user_id)).size).toBe(COLLECTIONS_ROSTER.length);
    // Stacy is wired in; Anna stays for history/tail collections.
    expect(COLLECTIONS_ROSTER.find((r) => r.initials === "SAB")?.name).toBe("Stacy Bakri");
    expect(COLLECTIONS_ROSTER.some((r) => r.initials === "AFL")).toBe(true);
  });

  it("CWW/CJW are mapped to the rows Rachel uses (Christopher→CWW, Carrie→CJW)", () => {
    // Rachel files Christopher Winiecki's collections under CWW and Carrie's under CJW,
    // which is swapped vs the Clio names. Pin it so the attribution can't regress.
    expect(COLLECTIONS_ROSTER.find((r) => r.initials === "CWW")?.name).toBe("Christopher Winiecki");
    expect(COLLECTIONS_ROSTER.find((r) => r.initials === "CJW")?.name).toBe("Carrie Wawarosky");
    // And aggregateMonthFees routes each Clio User name to the right initials' row.
    const rows = [
      row({ User: "Christopher Winiecki", "Billed Time Collected": "8657.70" }),
      row({ User: "Carrie Wawarosky", "Billed Time Collected": "70" }),
    ];
    const agg = aggregateMonthFees(rows, COLLECTIONS_ROSTER);
    const uidOf = (ini: string) => COLLECTIONS_ROSTER.find((r) => r.initials === ini)!.user_id;
    expect(agg.indiv[uidOf("CWW")]).toBe(8657.7); // Christopher → CWW row
    expect(agg.indiv[uidOf("CJW")]).toBe(70);     // Carrie → CJW row
  });
});
