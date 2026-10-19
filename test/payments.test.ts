import { describe, it, expect } from "vitest";
import { classifyAllocation, summarizePayments, checkAgainstBills } from "../src/tools/payments";

// Figures are the live Showers (01444) and Gholston (02681) rows seen 2026-10-19,
// when get_payments reported $812,874.75 collected on Showers against $298,380.65
// of real payments.

describe("classifyAllocation", () => {
  it("tags a credit-memo parent as credit", () => {
    expect(classifyAllocation({ parent: { id: 1, type: "CreditMemo" } })).toBe("credit");
  });
  it("tags a payment out of a trust account as trust", () => {
    expect(classifyAllocation({ parent: { type: "Payment" }, source_bank_account: { name: "Cadence IOLTA", type: "Trust" } })).toBe("trust");
  });
  it("tags a Clio Payments payment as online", () => {
    expect(classifyAllocation({ parent: { type: "Payment" }, has_online_payment: true })).toBe("online");
  });
  it("tags any other payment as direct", () => {
    expect(classifyAllocation({ parent: { type: "Payment" }, source_bank_account: { name: "Cadence Operating", type: "Operating" } })).toBe("direct");
  });
  it("says unknown when Clio gave no parent", () => {
    expect(classifyAllocation({ amount: 10 })).toBe("unknown");
  });
});

describe("summarizePayments", () => {
  it("keeps credits out of total_paid", () => {
    const s = summarizePayments([
      { amount: 171064.8, date: "2023-09-13", source: "direct" },
      { amount: 127315.85, date: "2023-11-22", source: "direct" },
      { amount: 54, date: "2025-05-30", source: "credit" },
      { amount: 1245.7, date: "2025-09-30", source: "credit" },
    ]);
    expect(s.total_paid).toBe(298380.65);
    expect(s.total_credits).toBe(1299.7);
    expect(s.last_payment_date).toBe("2023-11-22");
    expect(s.payment_count).toBe(2);
    expect(s.credit_count).toBe(2);
  });
  it("counts trust transfers as paid and breaks them out", () => {
    const s = summarizePayments([{ amount: 204791.08, date: "2025-04-16", source: "trust" }]);
    expect(s.total_paid).toBe(204791.08);
    expect(s.by_source.trust).toBe(204791.08);
  });
});

describe("checkAgainstBills", () => {
  const bill15323 = { id: 819786184, number: "15323", paid: 171064.8, credits_issued: 0 };

  it("passes when each bill's rows match its paid and credits", () => {
    const r = checkAgainstBills(
      [
        { amount: 171064.8, source: "direct", bill: { id: 819786184 } },
        { amount: 54, source: "credit", bill: { id: 1178211109 } },
      ],
      [bill15323, { id: 1178211109, number: "19141", paid: 0, credits_issued: 54 }],
    );
    expect(r.ok).toBe(true);
    expect(r.bills_checked).toBe(2);
  });

  it("flags a payment counted four times", () => {
    const row = { amount: 171064.8, source: "direct" as const, bill: { id: 819786184 } };
    const r = checkAgainstBills([row, row, row, row], [bill15323]);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ bill_number: "15323", allocations_paid: 684259.2, bill_paid: 171064.8 });
  });

  it("flags a credit counted as a payment", () => {
    const r = checkAgainstBills(
      [{ amount: 2445, source: "direct", bill: { id: 1232094230 } }],
      [{ id: 1232094230, number: "20359", paid: 0, credits_issued: 2445 }],
    );
    expect(r.ok).toBe(false);
  });

  it("compares combined totals when nothing could be classified", () => {
    const r = checkAgainstBills(
      [{ amount: 54, source: "unknown", bill: { id: 1 } }],
      [{ id: 1, number: "19141", paid: 0, credits_issued: 54 }],
    );
    expect(r.ok).toBe(true);
  });

  it("ignores bills with no money on either side (deleted versions)", () => {
    const r = checkAgainstBills([], [{ id: 819733339, number: "15323", paid: 0, credits_issued: 0 }]);
    expect(r.bills_checked).toBe(0);
    expect(r.ok).toBe(true);
  });
});
