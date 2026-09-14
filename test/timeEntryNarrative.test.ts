import { describe, it, expect } from "vitest";
import { resolveNarrative, narrativeDropped, NarrativeConflictError } from "../src/tools/time";

describe("resolveNarrative", () => {
  it("takes `note`", () => {
    expect(resolveNarrative({ note: "Review of motion to compel" })).toBe("Review of motion to compel");
  });

  // The regression this guards: the caller passed `description`, the schema
  // stripped the unknown key, and the entry posted with a blank narrative
  // while the tool reported success.
  it("takes `description` as the same field", () => {
    expect(resolveNarrative({ description: "Review of motion to compel" })).toBe("Review of motion to compel");
  });

  it("accepts both when they agree, ignoring surrounding whitespace", () => {
    expect(resolveNarrative({ note: "Draft discovery responses", description: "  Draft discovery responses " }))
      .toBe("Draft discovery responses");
  });

  it("refuses rather than guessing when the two disagree", () => {
    expect(() => resolveNarrative({ note: "Client call", description: "Deposition prep" }))
      .toThrow(NarrativeConflictError);
  });

  it("returns undefined when neither is given", () => {
    expect(resolveNarrative({})).toBeUndefined();
  });
});

describe("narrativeDropped", () => {
  it("flags an entry that came back with no narrative", () => {
    expect(narrativeDropped("Review of motion to compel", null, true)).toBe(true);
    expect(narrativeDropped("Review of motion to compel", "", true)).toBe(true);
  });

  it("flags an entry that came back with different text", () => {
    expect(narrativeDropped("Review of motion to compel", "Review of motio", true)).toBe(true);
  });

  it("passes an entry that came back with the requested narrative", () => {
    expect(narrativeDropped("Review of motion to compel", "Review of motion to compel", true)).toBe(false);
  });

  it("tolerates whitespace differences", () => {
    expect(narrativeDropped(" Client call ", "Client call", true)).toBe(false);
  });

  it("reports no drop when no narrative was requested", () => {
    expect(narrativeDropped(undefined, null, true)).toBe(false);
  });

  // A failed read-back is reported as unverified by the caller, not as a
  // confirmed drop — Clio's POST echo is not evidence either way.
  it("reports no drop when the read-back did not succeed", () => {
    expect(narrativeDropped("Review of motion to compel", null, false)).toBe(false);
  });
});
