import { describe, it, expect } from "vitest";
import { excludeDeletedBillAllocations } from "../src/tools/payments";

// A regenerated bill leaves its prior versions behind as `deleted` bills under the
// same number, and the one payment surfaces once per version. Only the live
// version's allocation should count.

describe("excludeDeletedBillAllocations", () => {
  it("keeps the live bill's payment and drops the deleted versions'", () => {
    const rows = [
      { id: 1, amount: 171064.8, bill: { id: 10, number: "15323", state: "paid" } },
      { id: 2, amount: 171064.8, bill: { id: 11, number: "15323", state: "deleted" } },
      { id: 3, amount: 171064.8, bill: { id: 12, number: "15323", state: "deleted" } },
      { id: 4, amount: 171064.8, bill: { id: 13, number: "15323", state: "deleted" } },
    ];
    const { kept, excluded } = excludeDeletedBillAllocations(rows);
    expect(kept.map((r) => r.id)).toEqual([1]);
    expect(excluded).toBe(3);
  });

  it("keeps rows with no bill or no state rather than guessing", () => {
    const rows = [{ id: 1, bill: null }, { id: 2, bill: { state: null } }, { id: 3 }];
    expect(excludeDeletedBillAllocations(rows).kept).toHaveLength(3);
  });
});
