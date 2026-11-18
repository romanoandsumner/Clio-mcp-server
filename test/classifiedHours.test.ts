import { describe, it, expect } from "vitest";
import {
  classifyRawEntries, isNonBillableEntry, isFirmSelfClient, isZeroValueBillable,
  internalReasonFor, sumTotals, FIRM_SELF_CLIENT_ID, toRawTimeEntry,
  matchesInternalRuleIgnoringFlag, assertTotalsReconcile,
  type RawTimeEntry,
} from "../src/dashboard/classifiedHours";

// Default: ordinary rated client work on a client matter — billable on both bases.
const entry = (over: Partial<RawTimeEntry>): RawTimeEntry => ({
  id: 1, uid: 100, userName: "Test User", date: "2026-03-05",
  hours: 2, rate: 400, amount: 800, matterId: 555, clientId: 999,
  nonBillableFlag: false,
  ...over,
});

// The two firm-internal matters from the live reproduction: 02888-Admin and
// 00050-Potential Clients, both on client 866197764 (Romano & Sumner, LLC),
// booked at rate 0 / amount 0 but left flagged BILLABLE in Clio.
const ADMIN_MATTER = 1753453984;
const POTENTIAL_CLIENTS_MATTER = 1017563959;
const internalEntry = (over: Partial<RawTimeEntry>): RawTimeEntry => entry({
  rate: 0, amount: 0, matterId: ADMIN_MATTER, clientId: FIRM_SELF_CLIENT_ID,
  nonBillableFlag: false,
  ...over,
});

describe("isNonBillableEntry", () => {
  it("is true only for a strict non_billable === true", () => {
    expect(isNonBillableEntry(true)).toBe(true);
    expect(isNonBillableEntry(false)).toBe(false);
    expect(isNonBillableEntry(undefined)).toBe(false);
    expect(isNonBillableEntry(null)).toBe(false);
    expect(isNonBillableEntry("true")).toBe(false); // never coerce
  });
});

describe("the firm-internal rules", () => {
  it("rule (a) matches only the firm's own client id", () => {
    expect(isFirmSelfClient(FIRM_SELF_CLIENT_ID)).toBe(true);
    expect(isFirmSelfClient(999)).toBe(false);
    expect(isFirmSelfClient(undefined)).toBe(false);
  });

  it("rule (b) needs BOTH rate 0 and amount 0, and only on a billable-flagged entry", () => {
    expect(isZeroValueBillable({ rate: 0, amount: 0, nonBillableFlag: false })).toBe(true);
    // A rated entry written down to $0 is still client work.
    expect(isZeroValueBillable({ rate: 400, amount: 0, nonBillableFlag: false })).toBe(false);
    // A $0 rate that still produced money (a flat amount) is client work.
    expect(isZeroValueBillable({ rate: 0, amount: 800, nonBillableFlag: false })).toBe(false);
    // Already nonbillable by the flag — rule (b) has nothing to do.
    expect(isZeroValueBillable({ rate: 0, amount: 0, nonBillableFlag: true })).toBe(false);
  });

  it("reports rule (a) in preference to rule (b) when both match", () => {
    expect(internalReasonFor({
      rate: 0, amount: 0, clientId: FIRM_SELF_CLIENT_ID, nonBillableFlag: false,
    })).toBe("firm_self_client");
    // Firm-self client but RATED — still internal, by rule (a) alone.
    expect(internalReasonFor({
      rate: 525, amount: 1050, clientId: FIRM_SELF_CLIENT_ID, nonBillableFlag: false,
    })).toBe("firm_self_client");
    // $0 under some other client — rule (b) only.
    expect(internalReasonFor({
      rate: 0, amount: 0, clientId: 999, nonBillableFlag: false,
    })).toBe("zero_rate_and_amount");
    expect(internalReasonFor({
      rate: 400, amount: 800, clientId: 999, nonBillableFlag: false,
    })).toBeUndefined();
  });
});

describe("classifyRawEntries — RAW basis (clsRaw, flag only)", () => {
  it("a non_billable entry at a dollar rate on a client matter is nonbillable", () => {
    // The Kenny Sumner bug (#186): internal work booked at his $525 standard
    // rate but flagged non-billable was counted billable by the pre-#186 rules.
    const out = classifyRawEntries(
      [entry({ id: 1, matterId: 555, rate: 525, amount: 1050, nonBillableFlag: true })],
      new Set(),
    );
    expect(out[0].clsRaw).toBe("nonbillable");
    expect(out[0].cls).toBe("nonbillable");
  });

  it("clsRaw follows the flag alone — the client and the rate never flip it", () => {
    const out = classifyRawEntries(
      [
        entry({ id: 1, rate: 525, amount: 1050, nonBillableFlag: true }),
        entry({ id: 2, rate: 0, amount: 0, nonBillableFlag: true }),
        entry({ id: 3, rate: 0, amount: 0, nonBillableFlag: false }),   // $0 → raw-billable
        entry({ id: 4, rate: 400, amount: 800, nonBillableFlag: false }),
        internalEntry({ id: 5 }),                                        // firm-self → raw-billable
        entry({ id: 6, matterId: undefined, clientId: undefined }),
      ],
      new Set(),
    );
    expect(out.map((e) => e.clsRaw)).toEqual([
      "nonbillable", "nonbillable", "billable", "billable", "billable", "billable",
    ]);
  });

  it("drops identified fee placeholders into excluded on both bases", () => {
    const out = classifyRawEntries(
      [entry({ id: 7, matterId: 555, hours: 1, rate: 25000, amount: 25000 }), entry({ id: 8 })],
      new Set([7]),
    );
    expect(out.find((e) => e.id === 7)!.clsRaw).toBe("excluded");
    expect(out.find((e) => e.id === 7)!.cls).toBe("excluded");
    expect(out.find((e) => e.id === 8)!.cls).toBe("billable");
  });

  it("the non_billable flag wins over the excluded set — a flagged entry never leaves nonbillable", () => {
    const out = classifyRawEntries([entry({ id: 9, nonBillableFlag: true })], new Set([9]));
    expect(out[0].cls).toBe("nonbillable");
    expect(out[0].clsRaw).toBe("nonbillable");
  });
});

describe("classifyRawEntries — ADJUSTED basis (cls, firm-internal reclassified)", () => {
  it("moves firm-self-client time out of billable by rule (a), even when rated", () => {
    const out = classifyRawEntries(
      [
        internalEntry({ id: 1 }),
        internalEntry({ id: 2, rate: 525, amount: 1050 }), // rated internal work
      ],
      new Set(),
    );
    for (const e of out) {
      expect(e.clsRaw).toBe("billable");
      expect(e.cls).toBe("nonbillable");
      expect(e.internal).toBe(true);
      expect(e.internalReason).toBe("firm_self_client");
    }
  });

  it("moves $0 rate + $0 amount time out of billable by rule (b)", () => {
    const out = classifyRawEntries(
      [entry({ id: 1, rate: 0, amount: 0, clientId: 999 })],
      new Set(),
    );
    expect(out[0].clsRaw).toBe("billable");
    expect(out[0].cls).toBe("nonbillable");
    expect(out[0].internalReason).toBe("zero_rate_and_amount");
  });

  it("leaves rated client work and written-down client work billable", () => {
    const out = classifyRawEntries(
      [
        entry({ id: 1, rate: 400, amount: 800 }),          // ordinary
        entry({ id: 2, rate: 400, amount: 0 }),            // full write-down: rate survives
        entry({ id: 3, rate: 0, amount: 5000 }),           // flat amount, no rate
      ],
      new Set(),
    );
    expect(out.map((e) => e.cls)).toEqual(["billable", "billable", "billable"]);
    expect(out.every((e) => !e.internal)).toBe(true);
  });

  it("excludeInternal=false restores the legacy basis exactly (cls === clsRaw)", () => {
    const raw = [
      internalEntry({ id: 1 }),
      entry({ id: 2, rate: 0, amount: 0, clientId: 999 }),
      entry({ id: 3, rate: 400, amount: 800 }),
      entry({ id: 4, nonBillableFlag: true }),
    ];
    const out = classifyRawEntries(raw, new Set(), { excludeInternal: false });
    for (const e of out) {
      expect(e.cls).toBe(e.clsRaw);
      expect(e.internal).toBe(false);
    }
    expect(out.map((e) => e.cls)).toEqual(["billable", "billable", "billable", "nonbillable"]);
  });

  it("defaults to excludeInternal=true when no options are passed", () => {
    const out = classifyRawEntries([internalEntry({ id: 1 })], new Set());
    expect(out[0].cls).toBe("nonbillable");
  });
});

describe("both bases stay internally consistent", () => {
  it("partitions every entry into exactly one bucket on each basis", () => {
    const raw = [
      entry({ id: 1, hours: 3.2 }),
      entry({ id: 2, hours: 1.0, rate: 25000, amount: 25000 }), // placeholder
      entry({ id: 3, hours: 5.4, rate: 525, amount: 2835, nonBillableFlag: true }),
      entry({ id: 4, hours: 0.6, rate: 0, amount: 0, nonBillableFlag: true }),
      internalEntry({ id: 5, hours: 4.0 }),
    ];
    const out = classifyRawEntries(raw, new Set([2]));
    const t = sumTotals(out);
    const total = raw.reduce((s, e) => s + e.hours, 0);
    const excluded = out.filter((e) => e.cls === "excluded").reduce((s, e) => s + e.hours, 0);

    // Tracked time is identical on both bases — the adjustment MOVES hours.
    expect(t.billable + t.nonbillable + excluded).toBeCloseTo(total, 10);
    expect(t.billableRaw + t.nonbillableRaw + excluded).toBeCloseTo(total, 10);
    expect(t.billable + t.nonbillable).toBeCloseTo(t.billableRaw + t.nonbillableRaw, 10);

    expect(t.billableRaw).toBeCloseTo(7.2, 10);  // 3.2 client + 4.0 internal
    expect(t.billable).toBeCloseTo(3.2, 10);
    expect(t.nonbillableRaw).toBeCloseTo(6.0, 10);
    expect(t.nonbillable).toBeCloseTo(10.0, 10); // 6.0 flagged + 4.0 reclassified
  });

  it("internalHours accounts for the ENTIRE gap between the two bases", () => {
    const raw = [
      entry({ id: 1, hours: 10 }),
      internalEntry({ id: 2, hours: 4 }),
      entry({ id: 3, hours: 2, rate: 0, amount: 0, clientId: 999 }),
    ];
    const t = sumTotals(classifyRawEntries(raw, new Set()));
    expect(t.billableRaw - t.billable).toBeCloseTo(t.internalHours, 10);
    expect(t.nonbillable - t.nonbillableRaw).toBeCloseTo(t.internalHours, 10);
    expect(t.firmSelfClientHours + t.zeroValueHours).toBeCloseTo(t.internalHours, 10);
    expect(t.firmSelfClientHours).toBeCloseTo(4, 10);
    expect(t.zeroValueHours).toBeCloseTo(2, 10);
  });
});

describe("the reported regression", () => {
  it("keeps 02888-Admin and 00050-Potential Clients out of billable (184.0 hrs)", () => {
    // Verified against Clio entry-level data: 92.4 + 91.6 billable-FLAGGED hours,
    // every entry at rate 0 / amount 0, both matters on client 866197764. Under
    // the flag-only basis introduced by #186 these inflated billable_actual.
    const raw = [
      internalEntry({ id: 1, hours: 92.4, matterId: ADMIN_MATTER }),
      internalEntry({ id: 2, hours: 91.6, matterId: POTENTIAL_CLIENTS_MATTER }),
      entry({ id: 3, hours: 345, rate: 525, amount: 181125 }), // real client work
    ];
    const t = sumTotals(classifyRawEntries(raw, new Set()));
    expect(t.billableRaw).toBeCloseTo(529.0, 10); // the inflated figure
    expect(t.billable).toBeCloseTo(345.0, 10);    // the corrected figure
    expect(t.internalHours).toBeCloseTo(184.0, 10);
    // Rule (a) alone catches both matters — the $0 net is never needed here.
    expect(t.firmSelfClientHours).toBeCloseTo(184.0, 10);
    expect(t.zeroValueHours).toBeCloseTo(0, 10);
  });

  it("rule (a) still catches internal time even when it carries a rate", () => {
    // The point of preferring the structural signal: a future internal matter
    // that someone books at a real rate is caught by the client, not the rate.
    const t = sumTotals(classifyRawEntries(
      [internalEntry({ id: 1, hours: 10, rate: 525, amount: 5250 })], new Set(),
    ));
    expect(t.billable).toBeCloseTo(0, 10);
    expect(t.firmSelfClientHours).toBeCloseTo(10, 10);
  });

  it("still reproduces Kenny Sumner's 2026-07-06..12 week on BOTH bases (48.4 / 52.0 of 100.4)", () => {
    // The #186 fixture: 27.0h on tracked admin matters, 25.0h on internal
    // RomSum/joint-venture matters at his $525 rate but flagged non-billable,
    // and 48.4h of real client work. Every nonbillable hour here is already
    // FLAGGED, so the internal adjustment must not move anything — this guards
    // against the new rules double-counting what the flag already caught.
    const raw = [
      entry({ id: 1, uid: 344134017, hours: 48.4, rate: 525, amount: 25410, nonBillableFlag: false }),
      entry({ id: 2, uid: 344134017, hours: 21.8, rate: 525, amount: 11445, nonBillableFlag: true }),
      entry({ id: 3, uid: 344134017, hours: 2.8, rate: 525, amount: 1470, nonBillableFlag: true }),
      entry({ id: 4, uid: 344134017, hours: 0.4, rate: 525, amount: 210, nonBillableFlag: true }),
      entry({ id: 5, uid: 344134017, hours: 27.0, rate: 0, amount: 0, nonBillableFlag: true }),
    ];
    const t = sumTotals(classifyRawEntries(raw, new Set()));
    expect(t.billable).toBeCloseTo(48.4, 10);
    expect(t.billableRaw).toBeCloseTo(48.4, 10);
    expect(t.nonbillable).toBeCloseTo(52.0, 10);
    expect(t.nonbillable).toBeCloseTo(t.nonbillableRaw, 10);
    expect(t.internalHours).toBeCloseTo(0, 10);
  });
});

describe("rule (a) false-positive exposure (firmSelfClientRatedHours)", () => {
  it("flags firm-self-client hours that carried a rate", () => {
    // 02671-Anike Fort Bend Property Ownership and 01537-Mediation Services are
    // filed under client 866197764 but hold real RATED client work. Rule (a)
    // reclassifies them as specified; this counter is what makes that visible.
    const t = sumTotals(classifyRawEntries([
      internalEntry({ id: 1, hours: 16.2, rate: 350, amount: 6077, matterId: 1615587349 }),
      internalEntry({ id: 2, hours: 0.6, rate: 450, amount: 205, matterId: 1194786934 }),
      internalEntry({ id: 3, hours: 92.4, matterId: ADMIN_MATTER }), // genuine $0 internal
    ], new Set()));
    expect(t.firmSelfClientHours).toBeCloseTo(109.2, 10);
    expect(t.firmSelfClientRatedHours).toBeCloseTo(16.8, 10);
    expect(t.billable).toBeCloseTo(0, 10);
  });

  it("does not flag genuine $0 internal time, and never flags rule (b) hours", () => {
    const t = sumTotals(classifyRawEntries([
      internalEntry({ id: 1, hours: 10 }),                                  // $0 internal
      entry({ id: 2, hours: 5, rate: 0, amount: 0, clientId: 999 }),        // rule (b)
    ], new Set()));
    expect(t.firmSelfClientRatedHours).toBeCloseTo(0, 10);
    expect(t.zeroValueHours).toBeCloseTo(5, 10);
  });

  it("counts an amount-only firm-self entry as rated (a flat fee with no hourly rate)", () => {
    const t = sumTotals(classifyRawEntries(
      [internalEntry({ id: 1, hours: 3, rate: 0, amount: 1500 })], new Set(),
    ));
    expect(t.firmSelfClientRatedHours).toBeCloseTo(3, 10);
  });
});

describe("toRawTimeEntry", () => {
  it("maps a Clio /activities row, resolving the client through the matter map", () => {
    const raw = toRawTimeEntry({
      id: 5, date: "2026-03-05", rounded_quantity: 7200, quantity: 6900,
      price: 400, total: 800, non_billable: false,
      matter: { id: ADMIN_MATTER }, user: { id: 7, name: "PAR" },
    }, 99, new Map([[ADMIN_MATTER, FIRM_SELF_CLIENT_ID]]));
    expect(raw).toEqual({
      id: 5, uid: 7, userName: "PAR", date: "2026-03-05", hours: 2,
      rate: 400, amount: 800, matterId: ADMIN_MATTER,
      clientId: FIRM_SELF_CLIENT_ID, nonBillableFlag: false,
      contingency: null, // no contingency set passed → unknown, not false
    });
  });

  it("prefers rounded_quantity, falls back to the caller's uid, and coerces missing money to 0", () => {
    const raw = toRawTimeEntry({
      id: 6, date: "2026-03-05", quantity: 3600, non_billable: true,
    }, 99);
    expect(raw.hours).toBe(1);
    expect(raw.uid).toBe(99);
    expect(raw.userName).toBe("Unknown");
    expect(raw.rate).toBe(0);
    expect(raw.amount).toBe(0);
    expect(raw.matterId).toBeUndefined();
    expect(raw.clientId).toBeUndefined();
    expect(raw.nonBillableFlag).toBe(true);
  });

  it("leaves clientId undefined when the matter map has no entry (rule (a) fails safe)", () => {
    // A failed /matters pull hands an empty map: rule (a) must simply not fire,
    // never silently drop client time out of billable.
    const raw = toRawTimeEntry({
      id: 7, date: "2026-03-05", rounded_quantity: 3600, price: 400, total: 400,
      non_billable: false, matter: { id: 555 },
    }, 99, new Map());
    expect(raw.clientId).toBeUndefined();
    expect(classifyRawEntries([raw], new Set())[0].cls).toBe("billable");
  });
});

// ─── Regression: "internal_reclassified_ytd is undercounted" (2026-11-18) ───
// Reported as a bug: PAR showed 193.4 internal hrs against 901.8 measured, TBS
// 0 against 92.0. Not a bug — the measurement ignored the Clio non_billable
// flag, while internal_reclassified counts only BILLABLE-flagged internal hours
// (the ones the adjustment has to move). The shortfall was exactly the internal
// time each timekeeper had already flagged non-billable. Live Clio figures,
// 2026-01-01..2026-11-15, are the fixtures. internal_total_ytd now reports the
// flag-agnostic number so the two can't be confused again.
describe("internal total vs reclassified — live PAR / TBS fixtures", () => {
  const OTHER = 2028032059; // an ordinary client
  let nextId = 1000;
  const e = (over: Partial<RawTimeEntry>): RawTimeEntry =>
    entry({ id: nextId++, ...over });
  const firm = (hours: number, over: Partial<RawTimeEntry> = {}) =>
    e({ hours, rate: 0, amount: 0, clientId: FIRM_SELF_CLIENT_ID, ...over });

  it("TBS: all 92.0 internal hrs self-flagged non-billable → reclassified 0, total 92.0", () => {
    const raw = [
      firm(35.2, { nonBillableFlag: true, rate: 375, amount: 225 }), // 02888-Admin (some rated)
      firm(23.8, { nonBillableFlag: true }),                         // 00706-Business Development
      firm(17.2, { nonBillableFlag: true }),                         // 00050-Potential Clients
      firm(14.4, { nonBillableFlag: true }),                         // 00707-CLE
      e({ hours: 1.4, rate: 0, amount: 0, clientId: OTHER, nonBillableFlag: true }), // 02653-Lopez $0/$0
      e({ hours: 1339.0, rate: 375, amount: 502125, clientId: OTHER }), // billable client work
    ];
    const t = sumTotals(classifyRawEntries(raw, new Set()));
    expect(t.internalHours).toBeCloseTo(0, 6);
    expect(t.firmSelfClientHours).toBeCloseTo(0, 6);
    expect(t.zeroValueHours).toBeCloseTo(0, 6);
    expect(t.internalTotalHours).toBeCloseTo(92.0, 6);
    expect(t.internalSelfFlaggedHours).toBeCloseTo(92.0, 6);
    // Net and raw both 1339.0: flagged time was never in raw.
    expect(t.billable).toBeCloseTo(1339.0, 6);
    expect(t.billableRaw).toBeCloseTo(1339.0, 6);
    expect(() => assertTotalsReconcile(t, "TBS")).not.toThrow();
  });

  it("PAR: 901.8 internal = 708.4 self-flagged + 193.4 reclassified", () => {
    const raw = [
      firm(535.6, { nonBillableFlag: true }),   // 02888-Admin, flagged
      firm(108.2, { nonBillableFlag: true }),   // 00050-Potential Clients, flagged
      firm(64.6, { nonBillableFlag: true }),    // other firm matters, flagged
      firm(186.8),                              // firm-self, billable-flagged, $0
      firm(0.2, { rate: 450, amount: 90 }),     // firm-self, billable-flagged, RATED
      e({ hours: 6.4, rate: 0, amount: 0, clientId: OTHER }), // $0/$0 on a client matter
      e({ hours: 1842.0, rate: 450, amount: 828900, clientId: OTHER }), // real billable
    ];
    const t = sumTotals(classifyRawEntries(raw, new Set()));
    expect(t.internalHours).toBeCloseTo(193.4, 6);
    expect(t.firmSelfClientHours).toBeCloseTo(187.0, 6);
    expect(t.firmSelfClientRatedHours).toBeCloseTo(0.2, 6);
    expect(t.zeroValueHours).toBeCloseTo(6.4, 6);
    expect(t.internalSelfFlaggedHours).toBeCloseTo(708.4, 6);
    expect(t.internalTotalHours).toBeCloseTo(901.8, 6);
    expect(t.billable).toBeCloseTo(1842.0, 6);
    expect(t.billableRaw - t.billable).toBeCloseTo(193.4, 6);
    expect(() => assertTotalsReconcile(t, "PAR")).not.toThrow();
  });

  it("the flag-agnostic rule ignores the flag; the reclassification rule does not", () => {
    const flagged = { rate: 0, amount: 0, clientId: FIRM_SELF_CLIENT_ID, nonBillableFlag: true };
    expect(matchesInternalRuleIgnoringFlag(flagged)).toBe(true);
    expect(internalReasonFor(flagged)).toBe("firm_self_client"); // rule matches…
    const [c] = classifyRawEntries([entry({ id: 1, ...flagged })], new Set());
    expect(c.internal).toBe(false);   // …but there is nothing to move
    expect(c.internalAny).toBe(true);
  });

  it("fee placeholders never count as internal on either measure", () => {
    const [c] = classifyRawEntries([entry({ id: 7, rate: 0, amount: 0 })], new Set([7]));
    expect(c.cls).toBe("excluded");
    expect(c.internalAny).toBe(false);
  });

  it("assertTotalsReconcile throws when the bases drift", () => {
    const t = sumTotals(classifyRawEntries([firm(4.0)], new Set()));
    expect(() => assertTotalsReconcile(t, "ok")).not.toThrow();
    expect(() => assertTotalsReconcile({ ...t, internalHours: t.internalHours - 1 }, "bad")).toThrow(/do not reconcile/);
    expect(() => assertTotalsReconcile({ ...t, internalTotalHours: t.internalTotalHours + 1 }, "bad")).toThrow(/do not reconcile/);
  });
});

describe("contingency hours", () => {
  it("counts all worked hours on contingency matters, billable subset separately, placeholders excluded", () => {
    const raw: RawTimeEntry[] = [
      entry({ id: 1, hours: 5.0, contingency: true }),                         // billable
      entry({ id: 2, hours: 1.5, contingency: true, nonBillableFlag: true }),  // nonbillable
      entry({ id: 3, hours: 1.0, contingency: true, rate: 25000, amount: 25000 }), // fee placeholder
      entry({ id: 4, hours: 2.0, contingency: true, clientId: FIRM_SELF_CLIENT_ID }), // e.g. 02671-Anike: reclassified
      entry({ id: 5, hours: 9.0, contingency: false }),                        // hourly matter
    ];
    const t = sumTotals(classifyRawEntries(raw, new Set([3])));
    expect(t.contingencyHours).toBeCloseTo(8.5, 6);        // 5.0 + 1.5 + 2.0
    expect(t.contingencyBillableHours).toBeCloseTo(5.0, 6);
  });

  it("an unknown contingency status stays null, never false", () => {
    const [c] = classifyRawEntries([entry({ id: 1 })], new Set());
    expect(c.contingency).toBeNull();
    const t = sumTotals([c]);
    expect(t.contingencyHours).toBe(0);
  });

  it("toRawTimeEntry tags contingency from the matter set, null when the lookup failed", () => {
    const act = { id: 1, date: "2026-03-05", rounded_quantity: 3600, price: 450, total: 450,
      non_billable: false, matter: { id: 1799152610 }, user: { id: 344117381, name: "Paul Romano" } };
    expect(toRawTimeEntry(act, 0, undefined, new Set([1799152610])).contingency).toBe(true);
    expect(toRawTimeEntry(act, 0, undefined, new Set([42])).contingency).toBe(false);
    expect(toRawTimeEntry(act, 0, undefined, null).contingency).toBeNull();
  });
});
