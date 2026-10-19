import { describe, it, expect } from "vitest";
import { billAging, openBalances } from "../src/tools/bills";

// Showers (01444) on 2026-10-19: get_bills reported total_balance $587,556.86
// because deleted and void bills keep their full balance. The client owed $0.

describe("openBalances", () => {
  it("counts only open fee invoices as owed", () => {
    const r = openBalances([
      { state: "deleted", kind: "revenue_kind", balance: 198341.68 },
      { state: "void", kind: "revenue_kind", balance: 118797.12 },
      { state: "draft", kind: "revenue_kind", balance: 5000 },
      { state: "paid", kind: "revenue_kind", balance: 0 },
      { state: "awaiting_payment", kind: "revenue_kind", balance: 1115.79 },
      { state: "awaiting_payment", kind: "trust_kind", balance: 2500 },
    ]);
    expect(r.receivable).toBe(1115.79);
    expect(r.trust_requests).toBe(2500);
  });
});

describe("billAging", () => {
  const today = new Date("2026-10-19T12:00:00Z");

  it("flags an open bill by days past due", () => {
    expect(billAging({ state: "awaiting_payment", due_at: "2026-06-15" }, today)).toEqual({ days_outstanding: 126, aging_flag: "90+ days" });
    expect(billAging({ state: "awaiting_payment", due_at: "2026-09-15" }, today).aging_flag).toBe("30+ days");
  });

  it("leaves paid, void and deleted bills unaged", () => {
    expect(billAging({ state: "paid", due_at: "2023-09-28" }, today)).toEqual({ days_outstanding: null, aging_flag: null });
    expect(billAging({ state: "deleted", due_at: "2019-10-15" }, today).days_outstanding).toBeNull();
  });
});
