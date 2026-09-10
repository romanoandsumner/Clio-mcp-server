import { describe, it, expect, beforeEach } from "vitest";
import { readTokenScopes, growScopeReport } from "../src/tools/grow";

/** Build a fake JWT (header.payload.signature) carrying the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("readTokenScopes", () => {
  it("reads Hydra-style `scp` array claims", () => {
    const token = jwt({ scp: ["grow_contact_read", "grow_matter_read"] });
    expect(readTokenScopes(token)).toEqual(["grow_contact_read", "grow_matter_read"]);
  });

  it("reads space-delimited `scope` string claims", () => {
    const token = jwt({ scope: "grow_contact_read grow_matter_read" });
    expect(readTokenScopes(token)).toEqual(["grow_contact_read", "grow_matter_read"]);
  });

  it("returns [] for a JWT with no scope claim (distinct from opaque)", () => {
    expect(readTokenScopes(jwt({ sub: "abc" }))).toEqual([]);
  });

  it("returns null for opaque (non-JWT) tokens and missing tokens", () => {
    expect(readTokenScopes("opaque-random-token")).toBeNull();
    expect(readTokenScopes(undefined)).toBeNull();
  });

  it("returns null when the payload segment is not valid base64/JSON", () => {
    expect(readTokenScopes("aaa.!!!not-json!!!.ccc")).toBeNull();
  });
});

describe("growScopeReport", () => {
  beforeEach(() => {
    process.env.GROW_OAUTH_SCOPE =
      "grow_contact_read grow_matter_read grow_matter_note_read";
  });

  it("flags the scopes a re-consent would add (requested minus granted)", () => {
    const token = jwt({ scp: ["grow_contact_read", "grow_matter_read"] });
    const report = growScopeReport(token);
    expect(report.requested_scope).toEqual([
      "grow_contact_read",
      "grow_matter_read",
      "grow_matter_note_read",
    ]);
    expect(report.token_scope).toEqual(["grow_contact_read", "grow_matter_read"]);
    // The stored token predates the note scope → surfaced as missing.
    expect(report.missing_scope).toEqual(["grow_matter_note_read"]);
  });

  it("reports no missing scopes when the token carries everything requested", () => {
    const token = jwt({
      scp: ["grow_contact_read", "grow_matter_read", "grow_matter_note_read"],
    });
    expect(growScopeReport(token).missing_scope).toEqual([]);
  });

  it("null missing_scope + a note when the token is opaque", () => {
    const report = growScopeReport("opaque-token");
    expect(report.token_scope).toBeNull();
    expect(report.missing_scope).toBeNull();
    expect(report.scope_note).toContain("/grow/oauth/start");
  });

  it("omits the lead-inbox-all note when the scope isn't requested at all", () => {
    const report = growScopeReport(jwt({ scp: ["grow_contact_read"] }));
    expect(report).not.toHaveProperty("lead_inbox_all_note");
  });
});

describe("growScopeReport — grow_lead_inbox_all_read", () => {
  beforeEach(() => {
    process.env.GROW_OAUTH_SCOPE = "grow_lead_inbox_read grow_lead_inbox_all_read";
  });

  it("requests the all-read scope alongside (not instead of) grow_lead_inbox_read", () => {
    const report = growScopeReport(jwt({ scp: [] }));
    expect(report.requested_scope).toContain("grow_lead_inbox_read");
    expect(report.requested_scope).toContain("grow_lead_inbox_all_read");
  });

  it("flags a legacy token that predates the scope and names the reauth path", () => {
    const report = growScopeReport(jwt({ scp: ["grow_lead_inbox_read"] }));
    expect(report.missing_scope).toEqual(["grow_lead_inbox_all_read"]);
    expect(report.lead_inbox_all_note).toContain("/grow/oauth/start");
    expect(report.lead_inbox_all_note).toContain("redacted_fields");
  });

  it("drops the note once the token carries the scope", () => {
    const report = growScopeReport(
      jwt({ scp: ["grow_lead_inbox_read", "grow_lead_inbox_all_read"] })
    );
    expect(report.missing_scope).toEqual([]);
    expect(report).not.toHaveProperty("lead_inbox_all_note");
  });

  it("still notes the scope when the token is opaque and can't be checked", () => {
    const report = growScopeReport("opaque-token");
    expect(report.lead_inbox_all_note).toContain("grow_lead_inbox_all_read");
  });
});
