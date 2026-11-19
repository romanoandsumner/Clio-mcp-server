import { describe, it, expect, vi, beforeEach } from "vitest";

const pg = vi.hoisted(() => ({ fetchAllPages: vi.fn() }));
vi.mock("../src/clio/pagination", () => ({
  buildQueryString: vi.fn(() => ""),
  fetchAllPages: pg.fetchAllPages,
  rawGetSingle: vi.fn(),
  rawGetBinarySingle: vi.fn(),
  rawPatchSingle: vi.fn(),
  rawPostSingle: vi.fn(),
}));

import { buildWorkedHoursSplitByMonth, WORKED_HOURS_PULL_ATTEMPTS } from "../src/dashboard/workedHours";

// Regression: PAR's September 2026 sat at 0 billable / 0 nonbillable in 26
// Compare's frozen snapshot (he worked 259.6 hrs). A failed per-person
// /activities pull was logged and SKIPPED, writing zeros while the run
// reported success.
const roster = [
  { name: "Paul Romano", initials: "PAR", user_id: 344117381 },
  { name: "Kenny Sumner", initials: "KES", user_id: 344134017 },
] as any;
const entry = (uid: number, hrs: number, nb = false) => ({
  id: Math.random(), date: "2026-09-10", rounded_quantity: hrs * 3600, price: 450, total: 450 * hrs,
  non_billable: nb, matter: { id: 1 }, user: { id: uid },
});

describe("worked-hours pull never writes a silent zero", () => {
  beforeEach(() => pg.fetchAllPages.mockReset());

  it("retries a transient failure and recovers the person's hours", async () => {
    pg.fetchAllPages.mockImplementation(async (url: string, p: any = {}) => {
      if (url === "/matters") return [];
      if (p.user_id === 344117381 && pg.fetchAllPages.mock.calls.filter((c: any[]) => (c[1] ?? {}).user_id === 344117381).length === 1) {
        throw new Error("ECONNRESET");
      }
      return p.user_id === 344117381 ? [entry(344117381, 154), entry(344117381, 105.6, true)] : [entry(344134017, 10)];
    });
    const out = await buildWorkedHoursSplitByMonth(2026, 9, roster, { months: [9], retryDelayMs: 0 });
    expect(out.billable[9][344117381]).toBeCloseTo(154, 6);
    expect(out.nonbillable[9][344117381]).toBeCloseTo(105.6, 6);
    expect(out.billable[9][344134017]).toBeCloseTo(10, 6);
  });

  it("fails the run, naming the person, when every attempt fails", async () => {
    pg.fetchAllPages.mockImplementation(async (url: string, p: any = {}) => {
      if (url === "/matters") return [];
      if (p.user_id === 344117381) throw new Error("429 Too Many Requests");
      return [entry(344134017, 10)];
    });
    await expect(buildWorkedHoursSplitByMonth(2026, 9, roster, { months: [9], retryDelayMs: 0 }))
      .rejects.toThrow(/PAR after 3 attempts/);
    const parCalls = pg.fetchAllPages.mock.calls.filter((c: any[]) => (c[1] ?? {}).user_id === 344117381).length;
    expect(parCalls).toBe(WORKED_HOURS_PULL_ATTEMPTS);
  });
});
