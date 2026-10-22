import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AUDIT_LINE_ITEM_FIELDS, detectFlags } from "../src/tools/audit";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

// Regression guard for the draft-bill audit bug: the /line_items endpoint
// does NOT support `rounded_quantity` (that field lives on /activities).
// Requesting it returns 400 InvalidFields, which broke audit_draft_bills,
// and download_bill_audit. It also means
// /line_items `quantity` is already decimal HOURS (not seconds), so the
// hours math must not divide by 3600.
describe("audit /line_items field selector", () => {
  it("does not request `rounded_quantity` (invalid on /line_items)", () => {
    expect(AUDIT_LINE_ITEM_FIELDS).not.toContain("rounded_quantity");
  });

  it("requests `quantity` (the decimal-hours billable amount)", () => {
    expect(AUDIT_LINE_ITEM_FIELDS.split(/[,{}]/)).toContain("quantity");
  });

  it("no /line_items query in the codebase asks for rounded_quantity", () => {
    // /line_items quantity is hours; rounded_quantity only exists on
    // /activities. Guard the audit tool against a copy-paste reintroduction
    // of the field.
    for (const rel of ["src/tools/audit.ts"]) {
      const text = src(rel);
      const lineItemQueries = text.match(/"\/line_items"[\s\S]{0,600}?bill_id/g) ?? [];
      for (const q of lineItemQueries) {
        expect(q, `${rel} /line_items query`).not.toContain("rounded_quantity");
      }
    }
  });

  it("audit hours math treats /line_items quantity as hours, not seconds", () => {
    // The original bug divided li.quantity by 3600, silently zeroing hours and
    // defeating every hours-based flag. Guard against the `/ 3600` reappearing
    // next to a line_item quantity read in the audit tool. Strip comment lines
    // first so prose that mentions "/3600" (like the field-constant docs) can't
    // trip the check — we only care about executable code.
    const code = src("src/tools/audit.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/li\.(rounded_quantity|quantity)[^\n]*\/\s*3600/);
  });
});

// Sanity check that the flag detector — which the fix feeds real decimal
// hours into — still fires on hours-driven rules. With the old seconds bug,
// hours arrived as ~0 and these never triggered.
describe("detectFlags hours-driven rules", () => {
  it("flags round-number billing on whole-hour entries", () => {
    const flags = detectFlags("Reviewed correspondence and drafted response", 300, 3, false);
    expect(flags.some((f) => f.code === "ROUND_NUMBER")).toBe(true);
  });

  it("does not flag ROUND_NUMBER when hours are fractional", () => {
    const flags = detectFlags("Reviewed correspondence and drafted response", 300, 2.3, false);
    expect(flags.some((f) => f.code === "ROUND_NUMBER")).toBe(false);
  });
});
