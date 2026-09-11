import { describe, it, expect } from "vitest";
import { growListParams, resolveGrowCap, summarizeGrowPipeline } from "../src/tools/grow";

describe("growListParams", () => {
  it("passes through created_since/updated_since and drops ids", () => {
    expect(
      growListParams({
        created_since: "2026-01-01T00:00:00Z",
        updated_since: "2026-02-01T00:00:00Z",
        ids: [1, 2],
      })
    ).toEqual({
      created_since: "2026-01-01T00:00:00Z",
      updated_since: "2026-02-01T00:00:00Z",
    });
  });

  it("returns empty params when no filters given", () => {
    expect(growListParams({})).toEqual({});
  });
});

describe("summarizeGrowPipeline", () => {
  const matters = [
    { status_category: "intake", status: "Open", type: "Personal Injury", hired_date: null },
    { status_category: "hired", status: "Hired", type: "Personal Injury", hired_date: "2026-04-01" },
    { status_category: "hired", status: "Hired", type: "Family Law", hired_date: "2026-05-01" },
    { status_category: "declined", status: "Did Not Hire", type: null, hired_date: null },
    { status_category: null, status: null, type: "Family Law", hired_date: null },
  ];

  it("groups matters by status_category, status, and type", () => {
    const s = summarizeGrowPipeline(matters, { untriaged: 3, ignored: 1 });
    expect(s.matters_total).toBe(5);
    expect(s.by_status_category).toEqual({ intake: 1, hired: 2, declined: 1, unknown: 1 });
    expect(s.by_status).toEqual({ Open: 1, Hired: 2, "Did Not Hire": 1, unknown: 1 });
    expect(s.by_matter_type).toEqual({ "Personal Injury": 2, "Family Law": 2, unknown: 1 });
    expect(s.with_hired_date).toBe(2);
    expect(s.inbox_leads).toEqual({ untriaged: 3, ignored: 1 });
  });

  it("handles empty matters and null leads (include_leads=false)", () => {
    const s = summarizeGrowPipeline([], null);
    expect(s.matters_total).toBe(0);
    expect(s.by_status_category).toEqual({});
    expect(s.inbox_leads).toBeNull();
  });
});

describe("resolveGrowCap", () => {
  it("caps at the default when the caller asks for nothing", () => {
    expect(resolveGrowCap(undefined, undefined)).toBe(200);
    expect(resolveGrowCap(undefined, [])).toBe(200);
  });

  it("honours an explicit max_results, including above the default", () => {
    expect(resolveGrowCap(5, undefined)).toBe(5);
    expect(resolveGrowCap(1000, undefined)).toBe(1000);
    expect(resolveGrowCap(0, undefined)).toBe(0);
  });

  // ids[] is matched client-side after paging, so a default cap could stop
  // paging before the requested ids are reached and report them as absent.
  it("does not apply the default cap to an ids[] query", () => {
    expect(resolveGrowCap(undefined, [42])).toBeUndefined();
  });

  it("still honours an explicit max_results alongside ids[]", () => {
    expect(resolveGrowCap(10, [42])).toBe(10);
  });
});
