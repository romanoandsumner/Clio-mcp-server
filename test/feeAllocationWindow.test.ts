import { describe, it, expect, vi, beforeEach } from "vitest";

// get_fee_allocation and get_responsible_collections used to require a date
// range, read the latest scheduled report regardless, and echo the requested
// dates back as the period. These lock in that the requested window is what
// gets generated, and that a report_id run reports its own period instead.

vi.mock("../src/clio/reportCsv", () => ({
  genFeeAllocationByMonth: vi.fn(async () => [{ User: "Paul Romano", "Total Funds Collected": "100" }]),
  getFeeAllocationCSV: vi.fn(async (id: number) => ({ rows: [], report: { id, name: "Scheduled FA" } })),
  assertReportPeriod: vi.fn(),
  parseCSV: vi.fn(),
}));
vi.mock("../src/clio/pagination", () => ({
  fetchAllPages: vi.fn(),
  downloadReport: vi.fn(),
  rawPostSingle: vi.fn(),
  rawGetSingle: vi.fn(async () => ({ data: { id: 77, start_date: "2026-01-01", end_date: "2026-03-31" } })),
}));

import { loadFeeAllocationRows } from "../src/tools/performance";
import { genFeeAllocationByMonth } from "../src/clio/reportCsv";

describe("loadFeeAllocationRows", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates a report for exactly the requested window", async () => {
    const { source } = await loadFeeAllocationRows({ start_date: "2026-01-15", end_date: "2026-04-30" });
    expect(genFeeAllocationByMonth).toHaveBeenCalledWith(2026, 1, {
      filterByPayment: true,
      startOverride: "2026-01-15",
      endOverride: "2026-04-30",
    });
    expect(source).toMatchObject({ kind: "generated_report", basis: "payment", period: { start: "2026-01-15", end: "2026-04-30" } });
  });

  it("uses issue-date filtering when basis=issue", async () => {
    await loadFeeAllocationRows({ start_date: "2026-02-01", end_date: "2026-02-28", basis: "issue" });
    expect(genFeeAllocationByMonth).toHaveBeenCalledWith(2026, 2, expect.objectContaining({ filterByPayment: false }));
  });

  it("reports an existing report's own period and flags ignored dates", async () => {
    const { source } = await loadFeeAllocationRows({ report_id: 77, start_date: "2026-09-01", end_date: "2026-09-30" });
    expect(genFeeAllocationByMonth).not.toHaveBeenCalled();
    expect(source).toMatchObject({ kind: "existing_report", period: { start: "2026-01-01", end: "2026-03-31" } });
    expect(source.warning).toMatch(/ignored/);
  });

  it("refuses to guess when given neither dates nor a report", async () => {
    await expect(loadFeeAllocationRows({})).rejects.toThrow(/start_date and end_date/);
  });
});
