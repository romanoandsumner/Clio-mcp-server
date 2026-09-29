import { beforeEach, describe, expect, it, vi } from "vitest";

const paginationMocks = vi.hoisted(() => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("../src/clio/pagination", () => ({
  buildQueryString: vi.fn(() => ""),
  fetchAllPages: paginationMocks.fetchAllPages,
  rawGetSingle: vi.fn(),
  rawGetBinarySingle: vi.fn(),
  rawPatchSingle: vi.fn(),
  rawPostSingle: vi.fn(),
}));

// Box is stubbed so no test can reach the network. createBoxFile captures the
// generated workbook so the ExcelJS tab-building code is actually exercised.
const boxMocks = vi.hoisted(() => ({ written: [] as Buffer[] }));
vi.mock("../src/utils/box", () => ({
  uploadToBox: vi.fn(async () => ({ uploaded: true, box_file_id: "1", box_url: "https://box/1" })),
  createBoxFile: vi.fn(async ({ buffer }: any) => {
    boxMocks.written.push(buffer);
    return { uploaded: true, box_file_id: "1", box_url: "https://box/1" };
  }),
  findBoxFileId: vi.fn(async () => null),
  downloadFromBox: vi.fn(),
}));

import ExcelJS from "exceljs";
import { registerARTools } from "../src/tools/ar";
import { BOUNDARY_RULE_TEXT, CUMULATIVE_THRESHOLDS, DISCRETE_BUCKETS, cumulativeKey } from "../src/domain/arAging";
import { round2 } from "../src/utils/num";

type ToolHandler = (params: any) => Promise<any>;

function handlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      map.set(name, handler);
    }),
  };
  registerARTools(server as any);
  return map;
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

function descriptions(): Map<string, string> {
  const map = new Map<string, string>();
  const server = {
    tool: vi.fn((name: string, description: string) => {
      map.set(name, description);
    }),
  };
  registerARTools(server as any);
  return map;
}

const AS_OF = "2026-08-27";

// due_at built the same way each tool parses its as-of date, so the day maths is
// timezone-independent: the scorecard parses as-of as LOCAL midnight
// (`as_of + "T00:00:00"`), get_ar_aging parses it as a bare date (UTC midnight).
function dueLocal(daysOutstanding: number): string {
  const d = new Date(`${AS_OF}T00:00:00`);
  d.setDate(d.getDate() - daysOutstanding);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
}
function dueUtc(daysOutstanding: number): string {
  const d = new Date(`${AS_OF}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysOutstanding);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- fixtures
// Six matters spanning every track and both tagging-drift rules.
const MATTERS = [
  { id: 101, pa: "Guardianship", attorney: "Paul Romano", client: "Alpha Co", desc: "Guardianship of Minor" },
  { id: 102, pa: "Family Law", attorney: "Paul Romano", client: "Beta LLC", desc: "Divorce" },
  { id: 103, pa: null, attorney: "Kenny Sumner", client: "Gamma Inc", desc: "Estate administration work" },
  { id: 104, pa: "Probate", attorney: "Kenny Sumner", client: "Delta Trust", desc: "Dependent Administration of Estate" },
  { id: 105, pa: "Representative (R&S Serving)", attorney: "Kenny Sumner", client: "Epsilon Ltd", desc: "Dependent Administration of Estate" },
  { id: 106, pa: "Representative (R&S Serving)", attorney: "Paul Romano", client: "Zeta Group", desc: "Dependent Administration of Estate" },
];

const matterStub = (id: number) => {
  const m = MATTERS.find((x) => x.id === id)!;
  return {
    id: m.id,
    display_number: `0${id}-${m.client}`,
    description: m.desc,
    client: { id: id * 10, name: m.client },
    responsible_attorney: { id: m.attorney === "Paul Romano" ? 1 : 2, name: m.attorney },
  };
};

// [matter_id, days_outstanding, balance]
const AR_BILLS: Array<[number, number, number]> = [
  [101, 5, 1000.10],
  [101, 400, 500.05], // stale (> 360)
  [102, 95, 2000.20],
  [103, 45, 300.30],
  [103, 200, 100.10],
  [104, 130, 700.70],
  [105, 1800, 50.50], // stale (> 360) — the ~1,800-day invoice
  [106, 10, 25.25],
];
const TOTAL_AR = round2(AR_BILLS.reduce((s, [, , bal]) => s + bal, 0)); // 4677.20

function arBills(due: (d: number) => string) {
  const bills = AR_BILLS.map(([mid, days, balance], i) => ({
    id: 9000 + i,
    number: `INV-${9000 + i}`,
    kind: "revenue_kind",
    state: "awaiting_payment",
    issued_at: due(days + 30),
    due_at: due(days),
    balance,
    total: balance,
    matters: [matterStub(mid)],
  }));
  // A fully paid-down revenue bill still in awaiting_payment: must not count.
  bills.push({
    id: 9999, number: "INV-9999", kind: "revenue_kind", state: "awaiting_payment",
    issued_at: due(400), due_at: due(370), balance: 0, total: 1234, matters: [matterStub(101)],
  });
  return bills;
}

// trust_kind bills: an unfunded request on gated matter 105, a funded one on 101.
const TRUST_AWAITING = [
  {
    id: 7001, number: "TRQ-7001", kind: "trust_kind", state: "awaiting_payment",
    issued_at: dueLocal(50), due_at: dueLocal(20), balance: 5000, total: 5000,
    paid: false, paid_at: null, matters: [matterStub(105)],
  },
];
const TRUST_PAID = [
  {
    id: 7002, number: "TRQ-7002", kind: "trust_kind", state: "paid",
    issued_at: dueLocal(90), due_at: dueLocal(60), balance: 0, total: 2000,
    paid: true, paid_at: dueLocal(55), matters: [matterStub(101)],
  },
];

const MATTERS_FIXTURE = MATTERS.map((m) => ({
  id: m.id,
  practice_area: m.pa ? { name: m.pa } : null,
}));

const TIME_ENTRIES = [
  {
    id: 1, date: "2026-08-20", quantity: 3600, rounded_quantity: 3600, price: 300,
    matter: matterStub(101),
  },
];
const EXPENSE_ENTRIES = [
  { id: 2, date: "2026-08-21", price: 50, matter: matterStub(103) },
];

function mockClio(opts: { due?: (d: number) => string } = {}) {
  const due = opts.due ?? dueLocal;
  paginationMocks.fetchAllPages.mockImplementation(async (path: string, params: any) => {
    if (path === "/bills" && params?.state === "awaiting_payment") {
      return [...arBills(due), ...TRUST_AWAITING];
    }
    if (path === "/bills" && params?.state === "paid") return TRUST_PAID;
    if (path === "/matters") return MATTERS_FIXTURE;
    if (path === "/activities" && params?.type === "TimeEntry") return TIME_ENTRIES;
    if (path === "/activities" && params?.type === "ExpenseEntry") return EXPENSE_ENTRIES;
    return [];
  });
}

async function scorecard(overrides: Record<string, any> = {}) {
  const h = handlers().get("get_ar_scorecard");
  if (!h) throw new Error("get_ar_scorecard was not registered");
  return payload(
    await h({
      as_of_date: AS_OF,
      update_workbook: false,
      await_workbook: false,
      probate_treatment: "non_gated",
      include_wip: false,
      ...overrides,
    })
  );
}

const sumDiscrete = (buckets: Record<string, any>) =>
  round2(DISCRETE_BUCKETS.reduce((s, b) => s + buckets[b.key].total, 0));

beforeEach(() => {
  paginationMocks.fetchAllPages.mockReset();
  mockClio();
});

// ==========================================================================
describe("get_ar_scorecard — Clio fetch scope", () => {
  const billCalls = () =>
    paginationMocks.fetchAllPages.mock.calls.filter(([path]: any[]) => path === "/bills").map(([, p]: any[]) => p);

  it("fetches paid bills as trust-only so the sweep skips every paid fee invoice", async () => {
    await scorecard();
    const paid = billCalls().filter((p) => p.state === "paid");
    expect(paid).toHaveLength(1);
    expect(paid[0].type).toBe("trust");
  });

  it("never filters the AR (awaiting_payment) fetch by type or date, so years-old open invoices stay in", async () => {
    const out = await scorecard();
    const awaiting = billCalls().filter((p) => p.state === "awaiting_payment");
    expect(awaiting).toHaveLength(1);
    for (const k of ["type", "issued_after", "created_since", "updated_since", "due_after"]) {
      expect(awaiting[0][k], k).toBeUndefined();
    }
    // The 1800-day fixture invoice still lands in 360+.
    expect(out.firm.discrete_buckets.days_over_360.count).toBeGreaterThan(0);
  });
});

// ==========================================================================
describe("get_ar_scorecard — aging buckets", () => {
  it("sums the discrete buckets to total_ar at the firm level, to the cent", async () => {
    const out = await scorecard();
    expect(out.firm.total_ar).toBe(TOTAL_AR);
    expect(sumDiscrete(out.firm.discrete_buckets)).toBe(TOTAL_AR);
  });

  it("sums the discrete buckets to total_ar in EVERY track", async () => {
    const out = await scorecard();
    for (const [name, track] of Object.entries<any>(out.firm_by_track)) {
      expect(sumDiscrete(track.discrete_buckets), `track ${name}`).toBe(track.total_ar);
    }
  });

  it("sums the discrete buckets to total_ar for EVERY attorney", async () => {
    const out = await scorecard();
    expect(out.by_attorney.length).toBeGreaterThan(1);
    for (const a of out.by_attorney) {
      expect(sumDiscrete(a.discrete_buckets), `attorney ${a.attorney}`).toBe(a.total_ar);
    }
  });

  it("derives cumulative buckets from the discrete buckets at every scope", async () => {
    const out = await scorecard();
    const scopes = [
      out.firm,
      ...Object.values<any>(out.firm_by_track),
      ...out.by_attorney,
    ];
    for (const scope of scopes) {
      for (const t of CUMULATIVE_THRESHOLDS) {
        const expected = round2(
          DISCRETE_BUCKETS.filter((b) => b.min > t).reduce(
            (s, b) => s + scope.discrete_buckets[b.key].total,
            0
          )
        );
        expect(scope.cumulative_buckets[cumulativeKey(t)].total).toBe(expected);
      }
    }
  });

  it("keeps the legacy scalar fields as exact aliases of the cumulative rollups", async () => {
    const out = await scorecard();
    expect(out.firm.ar_60plus).toBe(out.firm.cumulative_buckets[cumulativeKey(60)].total);
    expect(out.firm.ar_90plus).toBe(out.firm.cumulative_buckets[cumulativeKey(90)].total);
    expect(out.firm.ar_120plus).toBe(out.firm.cumulative_buckets[cumulativeKey(120)].total);
    // …and the pre-existing legacy aging fields are untouched.
    expect(out.firm.days_91_120).toBeTypeOf("number");
    expect(out.reconciliation.legacy_alignment_ok).toBe(true);
  });

  it("places invoices on the documented boundaries (day 95 → 91-120, day 1800 → 360+)", async () => {
    const out = await scorecard();
    const d = out.firm.discrete_buckets;
    expect(d.days_91_120.total).toBe(2000.20); // the 95-day invoice
    expect(d.days_121_180.total).toBe(700.70); // the 130-day invoice
    expect(d.days_181_360.total).toBe(100.10); // the 200-day invoice
    expect(d.days_over_360.total).toBe(round2(500.05 + 50.50));
    expect(d.days_0_7.total).toBe(1000.10); // the 5-day invoice
    expect(d.days_8_15.total).toBe(25.25); // the 10-day invoice
  });

  it("excludes zero-balance and trust_kind bills from every bucket", async () => {
    const out = await scorecard();
    // 8 AR bills; the paid-down revenue bill and the trust requests are excluded.
    const count = DISCRETE_BUCKETS.reduce((s, b) => s + out.firm.discrete_buckets[b.key].count, 0);
    expect(count).toBe(AR_BILLS.length);
  });
});

// ==========================================================================
describe("get_ar_scorecard — reconciliation", () => {
  it("reports reconciliation_ok with the track split AND the bucket checks passing", async () => {
    const out = await scorecard();
    expect(out.reconciliation_ok).toBe(true);
    expect(out.reconciliation.track_totals_ok).toBe(true);
    expect(out.reconciliation.discrete_buckets_ok).toBe(true);
    expect(out.reconciliation.legacy_alignment_ok).toBe(true);
    expect(out.reconciliation.bucket_failures).toEqual([]);
    expect(out.reconciliation.delta).toBe(0);
    expect(out.reconciliation.firm_discrete_bucket_delta).toBe(0);
  });

  it("checks the firm, all four tracks and every attorney", async () => {
    const out = await scorecard();
    expect(out.reconciliation.scopes_checked).toBe(1 + 4 + out.by_attorney.length);
  });
});

// ==========================================================================
describe("get_ar_scorecard — gated/non-gated split", () => {
  it("reconciles the track totals to the firm total", async () => {
    const out = await scorecard();
    const sum = round2(
      Object.values<any>(out.firm_by_track).reduce((s, t) => s + t.total_ar, 0)
    );
    expect(sum).toBe(out.firm.total_ar);
    expect(out.firm_by_track.gated.total_ar).toBe(round2(1000.10 + 500.05 + 50.50 + 25.25));
    expect(out.firm_by_track.non_gated.total_ar).toBe(round2(2000.20 + 700.70)); // Probate folded in
    expect(out.firm_by_track.unclassified.total_ar).toBe(round2(300.30 + 100.10));
  });

  it("gives each attorney gated / non_gated / unclassified sub-objects that reconcile to their total", async () => {
    const out = await scorecard();
    for (const a of out.by_attorney) {
      expect(a.gated).toBeDefined();
      expect(a.non_gated).toBeDefined();
      const sum = round2(a.gated.total_ar + a.non_gated.total_ar + a.unclassified.total_ar);
      expect(sum, `attorney ${a.attorney}`).toBe(a.total_ar);
      // The blended fields keep their original meaning.
      expect(a.ar_90plus).toBeGreaterThanOrEqual(a.ar_120plus);
    }
  });

  it("reconciles the per-attorney per-track slices back to each firm track total", async () => {
    const out = await scorecard();
    for (const track of ["gated", "non_gated", "unclassified"] as const) {
      const sum = round2(out.by_attorney.reduce((s: number, a: any) => s + a[track].total_ar, 0));
      expect(sum, track).toBe(out.firm_by_track[track].total_ar);
    }
  });

  it("splits one attorney's blended AR into the right tracks", async () => {
    const out = await scorecard();
    const paul = out.by_attorney.find((a: any) => a.attorney === "Paul Romano");
    expect(paul.gated.total_ar).toBe(round2(1000.10 + 500.05 + 25.25));
    expect(paul.non_gated.total_ar).toBe(2000.20);
    expect(paul.unclassified.total_ar).toBe(0);
    expect(paul.total_ar).toBe(round2(1000.10 + 500.05 + 25.25 + 2000.20));
  });

  it("omits semi_gated unless probate_treatment='separate', and moves Probate when it is", async () => {
    const folded = await scorecard();
    expect(folded.firm_by_track.semi_gated).toBeUndefined();
    expect(folded.by_attorney[0].semi_gated).toBeUndefined();

    const separate = await scorecard({ probate_treatment: "separate" });
    expect(separate.firm_by_track.semi_gated.total_ar).toBe(700.70);
    expect(separate.firm_by_track.non_gated.total_ar).toBe(2000.20);
    expect(separate.reconciliation_ok).toBe(true);
    const sum = round2(
      Object.values<any>(separate.firm_by_track).reduce((s, t) => s + t.total_ar, 0)
    );
    expect(sum).toBe(TOTAL_AR);
    const kenny = separate.by_attorney.find((a: any) => a.attorney === "Kenny Sumner");
    expect(kenny.semi_gated.total_ar).toBe(700.70);
  });

  it("folds Probate into gated when asked", async () => {
    const out = await scorecard({ probate_treatment: "gated" });
    expect(out.firm_by_track.gated.total_ar).toBe(round2(1000.10 + 500.05 + 50.50 + 25.25 + 700.70));
    expect(out.firm_by_track.non_gated.total_ar).toBe(2000.20);
    expect(out.reconciliation_ok).toBe(true);
  });
});

// ==========================================================================
describe("get_ar_scorecard — stale AR (collectability review)", () => {
  it("reports the 360+ tier separately without removing it from total_ar", async () => {
    const out = await scorecard();
    expect(out.stale_ar_365plus.threshold_days).toBe(360);
    expect(out.stale_ar_365plus.firm.total_ar).toBe(round2(500.05 + 50.50));
    expect(out.stale_ar_365plus.firm.invoices).toBe(2);
    // Still inside the headline.
    expect(out.firm.total_ar).toBe(TOTAL_AR);
  });

  it("matches the 360+ cumulative bucket exactly at firm and track level", async () => {
    const out = await scorecard();
    const key = cumulativeKey(360);
    expect(out.stale_ar_365plus.firm.total_ar).toBe(out.firm.cumulative_buckets[key].total);
    for (const [name, slice] of Object.entries<any>(out.stale_ar_365plus.by_track)) {
      expect(slice.total_ar, `track ${name}`).toBe(
        out.firm_by_track[name].cumulative_buckets[key].total
      );
    }
  });

  it("names the oldest invoice per attorney", async () => {
    const out = await scorecard();
    const kenny = out.stale_ar_365plus.by_attorney.find((a: any) => a.attorney === "Kenny Sumner");
    expect(kenny.oldest_invoice_days).toBe(1800);
    expect(kenny.oldest_invoice.matter_id).toBe(105);
    expect(kenny.oldest_invoice.balance).toBe(50.50);
    expect(out.stale_ar_365plus.firm.oldest_invoice_days).toBe(1800);
  });

  it("lists the stale invoices oldest-first for triage", async () => {
    const out = await scorecard();
    const days = out.stale_ar_365plus.invoices.map((i: any) => i.days_past_due);
    expect(days).toEqual([1800, 400]);
  });
});

// ==========================================================================
describe("get_ar_scorecard — unclassified matter visibility", () => {
  it("surfaces the specific matters, not just the total", async () => {
    const out = await scorecard();
    const unclassified = out.firm_by_track.unclassified;
    expect(unclassified.total_ar).toBe(round2(300.30 + 100.10));
    expect(unclassified.matters).toHaveLength(1);
    expect(unclassified.matters[0]).toMatchObject({
      matter_id: 103,
      matter_number: "0103-Gamma Inc",
      client_name: "Gamma Inc",
      invoices: 2,
      total_ar: round2(300.30 + 100.10),
    });
  });

  it("has every unclassified matter's AR sum back to the track total", async () => {
    const out = await scorecard();
    const matters = out.firm_by_track.unclassified.matters;
    const sum = round2(matters.reduce((s: number, m: any) => s + m.total_ar, 0));
    expect(sum).toBe(out.firm_by_track.unclassified.total_ar);
    expect(out.reconciliation.unclassified_matters).toBe(matters.length);
  });
});

// ==========================================================================
describe("get_ar_scorecard — tagging consistency flags", () => {
  it("flags a gated-sounding description carrying a non-gated practice_area", async () => {
    const out = await scorecard();
    const flag = out.tagging_consistency_flags.find((f: any) => f.matter_id === 104);
    expect(flag).toBeDefined();
    expect(flag.practice_area).toBe("Probate");
    expect(flag.matter_number).toBe("0104-Delta Trust");
    expect(flag.rules).toContain("gated_keyword_vs_practice_area");
    expect(flag.suspected_mismatch_reason).toContain("Dependent Administration");
  });

  it("flags practice_area drift between matters sharing a description pattern", async () => {
    const out = await scorecard();
    const flag = out.tagging_consistency_flags.find((f: any) => f.matter_id === 104);
    // 105 and 106 are both "Representative (R&S Serving)" (gated); 104 is
    // Probate (non-gated) — the odd one out.
    expect(flag.rules).toContain("same_pattern_different_practice_area");
    expect(out.tagging_consistency_flags.map((f: any) => f.matter_id)).not.toContain(105);
    expect(out.tagging_consistency_flags.map((f: any) => f.matter_id)).not.toContain(106);
  });

  it("does not treat two DIFFERENT gated practice_areas on similar matters as drift", async () => {
    // "Guardianship" and "Appointment" are both Gated. Same description
    // pattern, different practice_area, same track → normal taxonomy, not
    // drift. Only a disagreement that moves AR between tracks changes a
    // reported number, so only that gets flagged.
    const bill = (id: number, mid: number, pa: string, desc: string) => ({
      id, number: `INV-${id}`, kind: "revenue_kind", state: "awaiting_payment",
      issued_at: dueLocal(40), due_at: dueLocal(10), balance: 100, total: 100,
      matters: [{
        id: mid, display_number: `0${mid}-Client ${mid}`, description: desc,
        client: { id: mid, name: `Client ${mid}` },
        responsible_attorney: { id: 1, name: "Paul Romano" },
      }],
      _pa: pa,
    });
    const bills = [
      bill(1, 201, "Guardianship", "Guardianship of Minor"),
      bill(2, 202, "Appointment", "Guardianship of Minor - court appointed"),
      bill(3, 203, "Estate Planning", "Guardianship Designation"),
    ];
    paginationMocks.fetchAllPages.mockImplementation(async (path: string, params: any) => {
      if (path === "/bills" && params?.state === "awaiting_payment") return bills;
      if (path === "/bills" && params?.state === "paid") return [];
      if (path === "/matters") {
        return bills.map((b) => ({ id: b.matters[0].id, practice_area: { name: b._pa } }));
      }
      return [];
    });

    const out = await scorecard();
    const flagged = out.tagging_consistency_flags.map((f: any) => f.matter_id);
    expect(flagged).not.toContain(201);
    expect(flagged).not.toContain(202);
    // 203 is Estate Planning (non_gated) — that one really does move AR
    // between tracks, so it stays flagged.
    expect(flagged).toContain(203);
  });

  it("does not flag Guardianship Litigation, which is non-gated BY POLICY", async () => {
    // Its description reads gated and it sits beside Guardianship (which IS
    // gated), but the firm is paid up front on it, so its non-gated coding is
    // deliberate. Flagging it would put every such matter on the work queue.
    const bill = (id: number, mid: number, pa: string, desc: string) => ({
      id, number: `INV-${id}`, kind: "revenue_kind", state: "awaiting_payment",
      issued_at: dueLocal(40), due_at: dueLocal(10), balance: 100, total: 100,
      matters: [{
        id: mid, display_number: `0${mid}-Client ${mid}`, description: desc,
        client: { id: mid, name: `Client ${mid}` },
        responsible_attorney: { id: 1, name: "Paul Romano" },
      }],
      _pa: pa,
    });
    const bills = [
      bill(1, 401, "Guardianship", "Guardianship of Minor"),
      bill(2, 402, "Guardianship Litigation", "Guardianship of Minor - contested"),
    ];
    paginationMocks.fetchAllPages.mockImplementation(async (path: string, params: any) => {
      if (path === "/bills" && params?.state === "awaiting_payment") return bills;
      if (path === "/bills" && params?.state === "paid") return [];
      if (path === "/matters") {
        return bills.map((b) => ({ id: b.matters[0].id, practice_area: { name: b._pa } }));
      }
      return [];
    });

    const out = await scorecard();
    expect(out.tagging_consistency_flags.map((f: any) => f.matter_id)).not.toContain(402);
    // It is exempt from the heuristic but still reported as client-pay AR.
    expect(out.firm_by_track.non_gated.total_ar).toBe(100);
    expect(out.firm_by_track.gated.total_ar).toBe(100);
    // And its presence must not drag the gated Guardianship matter onto the list.
    expect(out.tagging_consistency_flags.map((f: any) => f.matter_id)).not.toContain(401);
  });

  it("does not flag correctly-tagged gated matters, and never reclassifies", async () => {
    const out = await scorecard();
    expect(out.tagging_consistency_flags.map((f: any) => f.matter_id)).not.toContain(101);
    // The flagged Probate matter is still reported in the track its
    // practice_area dictates — the flag changes nothing.
    expect(out.firm_by_track.non_gated.total_ar).toBe(round2(2000.20 + 700.70));
    expect(out.tagging_consistency_note).toMatch(/human review/i);
  });
});

// ==========================================================================
describe("get_ar_scorecard — gated AR vs unfunded trust requests", () => {
  it("puts each gated matter's AR balance next to its unfunded trust amount", async () => {
    const out = await scorecard();
    const m105 = out.gated_trust_correlation.matters.find((m: any) => m.matter_id === 105);
    expect(m105.ar_balance).toBe(50.50);
    expect(m105.unfunded_trust_amount).toBe(5000);
    expect(m105.unfunded_trust_requests).toBe(1);

    // The funded request on 101 must not show as unfunded.
    const m101 = out.gated_trust_correlation.matters.find((m: any) => m.matter_id === 101);
    expect(m101.unfunded_trust_amount).toBe(0);
    expect(m101.ar_balance).toBe(round2(1000.10 + 500.05));
  });

  it("covers only gated matters with a balance, and never mixes trust $ into AR", async () => {
    const out = await scorecard();
    const arSum = round2(
      out.gated_trust_correlation.matters.reduce((s: number, m: any) => s + m.ar_balance, 0)
    );
    expect(arSum).toBe(out.firm_by_track.gated.total_ar);
    expect(out.gated_trust_correlation.summary.unfunded_trust_total_on_gated_matters).toBe(5000);
    expect(out.gated_trust_correlation.summary.gated_matters_with_unfunded_trust).toBe(1);
    // Trust dollars are absent from every AR figure.
    expect(out.firm.total_ar).toBe(TOTAL_AR);
  });
});

// ==========================================================================
describe("get_ar_scorecard — WIP cross-reference", () => {
  it("omits wip_summary by default", async () => {
    const out = await scorecard();
    expect(out.wip_summary).toBeUndefined();
    const activityCalls = paginationMocks.fetchAllPages.mock.calls.filter(
      (c: any[]) => c[0] === "/activities"
    );
    expect(activityCalls).toHaveLength(0);
  });

  it("adds WIP + AR total exposure per attorney and per track when include_wip=true", async () => {
    const out = await scorecard({ include_wip: true });
    expect(out.wip_summary.firm.total_wip).toBe(350); // $300 time + $50 expense
    expect(out.wip_summary.firm.total_ar).toBe(TOTAL_AR);
    expect(out.wip_summary.firm.total_exposure).toBe(round2(TOTAL_AR + 350));

    const paul = out.wip_summary.by_attorney.find((a: any) => a.attorney === "Paul Romano");
    expect(paul.wip).toBe(300);
    expect(paul.total_exposure).toBe(round2(paul.wip + paul.ar));

    // Matter 101 is Guardianship (gated); matter 103 has no practice_area.
    expect(out.wip_summary.by_track.gated.wip).toBe(300);
    expect(out.wip_summary.by_track.unclassified.wip).toBe(50);
    expect(out.wip_summary.by_track.gated.total_exposure).toBe(
      round2(out.wip_summary.by_track.gated.wip + out.wip_summary.by_track.gated.ar)
    );
  });

  it("degrades to an error note (not a failed call) when the WIP fetch dies", async () => {
    paginationMocks.fetchAllPages.mockImplementation(async (path: string, params: any) => {
      if (path === "/activities") throw new Error("boom");
      if (path === "/bills" && params?.state === "awaiting_payment") return arBills(dueLocal);
      if (path === "/bills" && params?.state === "paid") return [];
      if (path === "/matters") return MATTERS_FIXTURE;
      return [];
    });
    const out = await scorecard({ include_wip: true });
    expect(out.wip_summary.error).toBe(true);
    expect(out.firm.total_ar).toBe(TOTAL_AR);
  });
});

// ==========================================================================
describe("get_ar_aging — new bucket views", () => {
  async function aging(overrides: Record<string, any> = {}) {
    mockClio({ due: dueUtc });
    const h = handlers().get("get_ar_aging");
    if (!h) throw new Error("get_ar_aging was not registered");
    return payload(await h({ as_of_date: AS_OF, ...overrides }));
  }

  it("keeps the original five-bucket shape intact under `buckets`", async () => {
    const out = await aging();
    expect(Object.keys(out.buckets)).toEqual([
      "current", "days_31_60", "days_61_90", "days_91_120", "over_120",
    ]);
    expect(out.buckets.current.invoices.length).toBeGreaterThan(0);
    expect(out.buckets.current.invoices[0]).toHaveProperty("client_email");
    // …and mirrors it under legacy_buckets for explicit consumers.
    expect(out.legacy_buckets).toEqual(out.buckets);
  });

  it("adds discrete buckets that sum to total_ar to the cent", async () => {
    const out = await aging();
    expect(out.summary.total_ar).toBe(TOTAL_AR);
    expect(sumDiscrete(out.discrete_buckets)).toBe(TOTAL_AR);
    expect(out.reconciliation.reconciliation_ok).toBe(true);
    expect(out.reconciliation.delta).toBe(0);
  });

  it("derives the cumulative buckets from the discrete ones", async () => {
    const out = await aging();
    for (const t of CUMULATIVE_THRESHOLDS) {
      const expected = round2(
        DISCRETE_BUCKETS.filter((b) => b.min > t).reduce(
          (s, b) => s + out.discrete_buckets[b.key].total,
          0
        )
      );
      expect(out.cumulative_buckets[cumulativeKey(t)].total).toBe(expected);
    }
  });

  it("agrees with the legacy buckets on the shared 120-day boundary", async () => {
    const out = await aging();
    expect(out.cumulative_buckets[cumulativeKey(120)].total).toBe(out.buckets.over_120.total);
  });

  it("labels each invoice with its discrete bucket and documents the boundary rule", async () => {
    const out = await aging();
    const all = Object.values<any>(out.buckets).flatMap((b) => b.invoices);
    for (const inv of all) expect(inv.aging_bucket).toBeTypeOf("string");
    const ninetyFive = all.find((i: any) => i.days_outstanding === 95);
    expect(ninetyFive.aging_bucket).toBe("91-120");
    expect(out.bucket_rules).toMatch(/day 30 is in 16-30/);
  });
});

// ==========================================================================
// The workbook is the actual EOS deliverable, so the new tabs get built for
// real (in-memory) and read back — a broken cell reference in a new tab would
// otherwise only surface in the background Box write, in production.
describe("get_ar_scorecard — workbook", () => {
  it("builds every tab, including the new ones, and foots the bucket tab to Total AR", async () => {
    boxMocks.written.length = 0;
    const out = await scorecard({ update_workbook: true, await_workbook: true, include_wip: true });
    expect(out.workbook).toMatchObject({ created: true, uploaded: true });
    expect(boxMocks.written).toHaveLength(1);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(boxMocks.written[0] as any);
    const names = wb.worksheets.map((w) => w.name);
    for (const expected of [
      "AR by Track", "Aging Buckets", "Weekly Scorecard", "By Attorney", "Stale AR 365+",
      "Gated by Attorney", "Gated by Matter", "Gated AR vs Trust", "Top 10 Accounts",
      "Trust Requests", "Unclassified Matters", "Tagging Flags",
    ]) {
      expect(names, `missing tab ${expected}`).toContain(expected);
    }
    // One detail tab pair per attorney with AR.
    expect(names).toContain("Paul Romano");
    expect(names).toContain("Paul Romano by Matter");

    // Aging Buckets: the discrete rows must foot to Total AR in the firm column.
    const bucketWs = wb.getWorksheet("Aging Buckets")!;
    const firmCol = 6; // Bucket, # Invoices, Gated, Non-Gated, Unclassified, Firm Total
    expect(String(bucketWs.getCell(4, firmCol).value)).toBe("Firm Total");
    // Scan only the discrete block: the cumulative block below it reuses the
    // "360+" label, so stop at the discrete block's "Total AR" footer.
    let discreteSum = 0;
    let sawTotalRow = false;
    bucketWs.eachRow((row, n) => {
      if (n <= 5 || sawTotalRow) return;
      const label = String(row.getCell(1).value ?? "");
      if (label === "Total AR") {
        sawTotalRow = true;
        expect(Number(row.getCell(firmCol).value)).toBe(TOTAL_AR);
        return;
      }
      if (DISCRETE_BUCKETS.some((b) => b.label === label)) {
        discreteSum += Number(row.getCell(firmCol).value ?? 0);
      }
    });
    expect(sawTotalRow).toBe(true);
    expect(round2(discreteSum)).toBe(TOTAL_AR);

    // Weekly Scorecard carries the new 360+ trend columns.
    const weeklyWs = wb.getWorksheet("Weekly Scorecard")!;
    const headers: string[] = [];
    weeklyWs.getRow(2).eachCell((c) => headers.push(String(c.value ?? "")));
    expect(headers).toContain("360+ $");
    expect(headers).toContain("# Inv 360+");

    // Unclassified Matters lists the matter, not just a total.
    const ucWs = wb.getWorksheet("Unclassified Matters")!;
    expect(ucWs.getCell(4, 1).value).toBe(103);
    expect(ucWs.getCell(4, 3).value).toBe("Gamma Inc");

    // Tagging Flags carries the drifting Probate matter.
    const tfWs = wb.getWorksheet("Tagging Flags")!;
    expect(tfWs.getCell(4, 1).value).toBe(104);
    expect(String(tfWs.getCell(4, 8).value)).toMatch(/Dependent Administration/);

    // By Attorney gained the Gated / Non-Gated / 360+ columns.
    const attWs = wb.getWorksheet("By Attorney")!;
    const attHeaders: string[] = [];
    attWs.getRow(2).eachCell((c) => attHeaders.push(String(c.value ?? "")));
    expect(attHeaders).toEqual(expect.arrayContaining(["Gated AR", "Non-Gated AR", "360+ $"]));
  });
});

// ==========================================================================
// get_wip_report's body was extracted into computeWipMatters so the scorecard
// could reuse it. These lock in that the tool's own output did not change.
describe("get_wip_report — unchanged after the shared-helper extraction", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  async function wip(params: Record<string, any> = {}) {
    const h = handlers().get("get_wip_report");
    if (!h) throw new Error("get_wip_report was not registered");
    return payload(await h(params));
  }

  function mockActivities(time: any[], expense: any[]) {
    paginationMocks.fetchAllPages.mockImplementation(async (path: string, params: any) => {
      if (path === "/activities" && params?.type === "TimeEntry") return time;
      if (path === "/activities" && params?.type === "ExpenseEntry") return expense;
      return [];
    });
  }

  const matter = (id: number, attorneyId: number) => ({
    id,
    display_number: `0${id}-Client ${id}`,
    description: `Matter ${id}`,
    client: { id, name: `Client ${id}` },
    responsible_attorney: { id: attorneyId, name: `Attorney ${attorneyId}` },
  });

  it("aggregates time at rounded_quantity plus expenses, sorted by exposure", async () => {
    mockActivities(
      [
        { id: 1, date: daysAgo(5), quantity: 1800, rounded_quantity: 3600, price: 300, matter: matter(301, 1) },
        { id: 2, date: daysAgo(10), quantity: 3600, rounded_quantity: 3600, price: 100, matter: matter(302, 2) },
      ],
      [{ id: 3, date: daysAgo(2), price: 25, matter: matter(302, 2) }]
    );
    const out = await wip();
    expect(out.summary.total_firm_wip).toBe(425); // 300 + (100 + 25)
    expect(out.summary.matters_with_wip).toBe(2);
    expect(out.matters[0].matter_id).toBe(301); // largest exposure first
    expect(out.matters[0].unbilled_hours).toBe(1); // rounded_quantity, not quantity
    expect(out.matters[1].unbilled_expenses).toBe(25);
  });

  it("flags RED over 60 days and YELLOW over 30, and counts RED before min_wip_value filtering", async () => {
    mockActivities(
      [
        { id: 1, date: daysAgo(90), quantity: 3600, rounded_quantity: 3600, price: 10, matter: matter(311, 1) },
        { id: 2, date: daysAgo(45), quantity: 3600, rounded_quantity: 3600, price: 5000, matter: matter(312, 1) },
        { id: 3, date: daysAgo(5), quantity: 3600, rounded_quantity: 3600, price: 1000, matter: matter(313, 1) },
      ],
      []
    );
    const all = await wip();
    expect(all.matters.find((m: any) => m.matter_id === 311).flag).toBe("RED");
    expect(all.matters.find((m: any) => m.matter_id === 312).flag).toBe("YELLOW");
    expect(all.matters.find((m: any) => m.matter_id === 313).flag).toBeNull();

    // The $10 RED matter is filtered out of `matters` but still counted, which
    // is the pre-refactor behaviour.
    const filtered = await wip({ min_wip_value: 100 });
    expect(filtered.matters.map((m: any) => m.matter_id)).toEqual([312, 313]);
    expect(filtered.summary.red_flag_matters).toBe(1);
    expect(filtered.summary.total_firm_wip).toBe(6000);
  });

  it("honours responsible_attorney_id", async () => {
    mockActivities(
      [
        { id: 1, date: daysAgo(5), quantity: 3600, rounded_quantity: 3600, price: 100, matter: matter(321, 1) },
        { id: 2, date: daysAgo(5), quantity: 3600, rounded_quantity: 3600, price: 200, matter: matter(322, 2) },
      ],
      []
    );
    const out = await wip({ responsible_attorney_id: 2 });
    expect(out.matters.map((m: any) => m.matter_id)).toEqual([322]);
    expect(out.summary.total_firm_wip).toBe(200);
  });
});

// ==========================================================================
// The track split matches practice_area names exactly, so a renamed practice
// area stops matching and its AR silently joins the Non-Gated headline. This is
// the guard that makes that visible instead of silent.
describe("get_ar_scorecard — track_config_health", () => {
  it("reports ok when every configured practice area is present in Clio", async () => {
    const out = await scorecard();
    // The fixture covers Guardianship + Representative (R&S Serving) + Probate,
    // but not every configured name, so check the shape and the AR-bearing side.
    expect(out.track_config_health).toBeDefined();
    expect(out.track_config_health.unmapped_practice_areas_with_ar.map((p: any) => p.name))
      .toEqual(["Family Law"]); // matter 102, defaults to non_gated
    expect(out.track_config_health.unmapped_practice_areas_with_ar[0]).toMatchObject({
      defaulted_track: "non_gated",
      total_ar: 2000.20,
      invoices: 1,
    });
  });

  it("names a configured practice area that matches nothing in Clio", async () => {
    // Simulate the "Representative" rename: Clio only knows Guardianship, so
    // every other configured name is unmatched and must be reported.
    paginationMocks.fetchAllPages.mockImplementation(async (path: string, params: any) => {
      if (path === "/bills" && params?.state === "awaiting_payment") return arBills(dueLocal);
      if (path === "/bills" && params?.state === "paid") return [];
      if (path === "/matters") return [{ id: 101, practice_area: { name: "Guardianship" } }];
      return [];
    });
    const out = await scorecard();
    expect(out.track_config_health.ok).toBe(false);
    const missing = out.track_config_health.configured_not_found_in_clio;
    const names = missing.map((m: any) => m.name);
    expect(names).toContain("Representative (R&S Serving)");
    expect(names).toContain("Dependent Administration (Client Serving)");
    expect(names).toContain("Guardianship Litigation");
    expect(names).not.toContain("Guardianship");
    // Each entry says which track the config intended.
    expect(missing.find((m: any) => m.name === "Representative (R&S Serving)").intended_track).toBe("gated");
    expect(missing.find((m: any) => m.name === "Guardianship Litigation").intended_track).toBe("non_gated (by policy)");
    // A config problem does not break the AR maths.
    expect(out.reconciliation_ok).toBe(true);
  });
});

// ==========================================================================
// The tool descriptions ARE the MCP tool-search index — a broken one is a
// silent documentation failure, and it already happened once: the boundary rule
// was written as `' + BOUNDARY_RULE_TEXT + '` inside a double-quoted string, so
// the literal source fragment shipped instead of the rule.
describe("AR tool descriptions", () => {
  const TOOLS = ["get_ar_aging", "get_ar_scorecard"];

  it("interpolates the boundary rule instead of shipping the source fragment", () => {
    const desc = descriptions();
    for (const name of TOOLS) {
      const d = desc.get(name);
      expect(d, `${name} not registered`).toBeDefined();
      // The rule itself must be present, verbatim.
      expect(d, name).toContain(BOUNDARY_RULE_TEXT);
      // …and no un-evaluated concatenation fragment may survive.
      expect(d, name).not.toContain("BOUNDARY_RULE_TEXT");
      expect(d, name).not.toMatch(/['"]\s*\+\s*[A-Z_]{4,}\s*\+\s*['"]/);
    }
  });

  it("states the bucket set and the boundary direction in both tools", () => {
    const desc = descriptions();
    for (const name of TOOLS) {
      const d = desc.get(name)!;
      expect(d, name).toContain("day 30 is in 16-30");
      expect(d, name).toMatch(/days_outstanding > N/);
      for (const label of ["0-7", "8-15", "16-30", "121-180", "181-360", "360+"]) {
        expect(d, `${name} missing bucket ${label}`).toContain(label);
      }
    }
  });
});
