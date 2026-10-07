import { describe, it, expect } from "vitest";
import { runBulk, parseIdList, BULK_MAX_ITEMS } from "../src/clio/bulk";

describe("parseIdList", () => {
  it("parses commas and whitespace, dropping duplicates", () => {
    expect(parseIdList("1, 2,3\n3 4")).toEqual([1, 2, 3, 4]);
  });
  it("rejects non-integer, non-positive and empty input", () => {
    expect(() => parseIdList("1,abc")).toThrow(/Invalid ID/);
    expect(() => parseIdList("0")).toThrow(/Invalid ID/);
    expect(() => parseIdList(" , ")).toThrow(/empty/);
  });
  it("enforces the per-call cap", () => {
    const csv = Array.from({ length: BULK_MAX_ITEMS + 1 }, (_, i) => i + 1).join(",");
    expect(() => parseIdList(csv)).toThrow(/exceeds the per-call cap/);
  });
});

describe("runBulk", () => {
  it("isolates per-item failures and keeps input order", async () => {
    const out = await runBulk([1, 2, 3], async (id) => {
      if (id === 2) {
        const e: any = new Error("boom");
        e.response = { status: 422, data: { context: "bill_not_draft" } };
        throw e;
      }
      return id * 10;
    });
    expect(out.results.map((r) => [r.id, r.status])).toEqual([[1, "ok"], [2, "failed"], [3, "ok"]]);
    expect(out.results[1].error).toMatchObject({ message: "boom", status: 422, context: "bill_not_draft" });
    expect(out.summary).toEqual({ requested: 3, succeeded: 2, failed: 1, not_attempted: 0 });
  });

  it("stops starting items once the time budget is spent and reports the rest", async () => {
    let clock = 0;
    const out = await runBulk(
      [1, 2, 3, 4, 5],
      async (id) => {
        clock += 10_000; // each item "takes" 10s
        return id;
      },
      { budgetSeconds: 25, concurrency: 1, now: () => clock },
    );
    // starts at 0, 10s, 20s -> three items; at 30s the budget is spent.
    expect(out.results.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.not_attempted).toEqual([4, 5]);
    expect(out.summary).toMatchObject({ requested: 5, succeeded: 3, not_attempted: 2 });
  });

  it("never exceeds the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    await runBulk(
      Array.from({ length: 12 }, (_, i) => i + 1),
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
