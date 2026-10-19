import { describe, it, expect } from "vitest";
import { isTrustAccount, summarizeTrustByMatter, reconcileTrustAccounts } from "../src/domain/trust";

// Trust balances come from the bank-transaction ledger. These lock in the
// netting (deposits less disbursements) that the old trust_line_items sum
// lacked: it reported Almadani (03171) at $85,593.74 when the ledger was
// $40,000 in and $40,000 out.

describe("isTrustAccount", () => {
  it("accepts Clio's trust type and IOLTA/trust names", () => {
    expect(isTrustAccount({ type: "Trust", name: "Hyak Estate" })).toBe(true);
    expect(isTrustAccount({ type: "Operating", name: "BOT IOLTA" })).toBe(true);
    expect(isTrustAccount({ type: "Operating", name: "Cadence Operating" })).toBe(false);
    expect(isTrustAccount(null)).toBe(false);
  });
});

describe("summarizeTrustByMatter", () => {
  const txns = [
    { id: 1, date: "2026-07-29", amount: 40000, matter: { id: 1805380429, display_number: "03171" }, bank_account: { id: 45043 } },
    { id: 2, date: "2026-08-31", amount: -2363.79, matter: { id: 1805380429, display_number: "03171" }, bank_account: { id: 45043 } },
    { id: 3, date: "2026-08-31", amount: -37636.21, matter: { id: 1805380429, display_number: "03171" }, bank_account: { id: 45043 } },
    { id: 4, date: "2026-09-01", amount: 500, matter: null, bank_account: { id: 45043 } },
  ];

  it("nets deposits against disbursements per matter", () => {
    const { matters } = summarizeTrustByMatter(txns);
    expect(matters).toHaveLength(1);
    expect(matters[0]).toMatchObject({ balance: 0, funds_in: 40000, funds_out: 40000, transaction_count: 3 });
    expect(matters[0].last_deposit_date).toBe("2026-07-29");
    expect(matters[0].last_disbursement_date).toBe("2026-08-31");
    expect(matters[0].last_activity_date).toBe("2026-08-31");
  });

  it("totals rows with no matter separately", () => {
    const { unassigned_total, unassigned_count } = summarizeTrustByMatter(txns);
    expect(unassigned_total).toBe(500);
    expect(unassigned_count).toBe(1);
  });
});

describe("reconcileTrustAccounts", () => {
  it("closes when the ledger sums to Clio's account balance", () => {
    const r = reconcileTrustAccounts(
      [{ id: 45043, name: "Cadence IOLTA", balance: 500 }],
      [
        { amount: 40000, bank_account: { id: 45043 } },
        { amount: -40000, bank_account: { id: 45043 } },
        { amount: 500, bank_account: { id: 45043 } },
      ],
    );
    expect(r.ok).toBe(true);
  });

  it("reports the difference when it does not", () => {
    const r = reconcileTrustAccounts([{ id: 45043, name: "Cadence IOLTA", balance: 1000 }], [{ amount: 400, bank_account: { id: 45043 } }]);
    expect(r.ok).toBe(false);
    expect(r.accounts[0].difference).toBe(600);
  });
});
