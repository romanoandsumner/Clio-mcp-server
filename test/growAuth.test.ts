import { describe, it, expect } from "vitest";

process.env.GROW_CLIENT_ID = "test-grow-client";
process.env.GROW_CLIENT_SECRET = "test-grow-secret";
process.env.GROW_REDIRECT_URI = "https://example.test/grow/oauth/callback";
delete process.env.GROW_OAUTH_SCOPE; // exercise the default
delete process.env.GROW_OAUTH_PKCE; // PKCE on by default

import {
  issueOAuthState,
  consumeOAuthState,
  getGrowAuthorizationUrl,
} from "../src/clio/growAuth";

describe("Grow OAuth state", () => {
  it("issues single-use states carrying a PKCE verifier", () => {
    const state = issueOAuthState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    const entry = consumeOAuthState(state);
    expect(entry).not.toBeNull();
    expect(entry?.codeVerifier).toEqual(expect.any(String));
    // Single-use: a second consume of the same state returns null.
    expect(consumeOAuthState(state)).toBeNull();
  });

  it("rejects unknown or missing states", () => {
    expect(consumeOAuthState("not-a-real-state")).toBeNull();
    expect(consumeOAuthState(undefined)).toBeNull();
  });
});

describe("getGrowAuthorizationUrl", () => {
  it("builds the authorize URL with code flow params, state, scope, and PKCE", () => {
    const state = issueOAuthState();
    const url = new URL(getGrowAuthorizationUrl(state));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-grow-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/grow/oauth/callback");
    expect(url.searchParams.get("state")).toBe(state);
    // Grow uses Grow-specific scopes (not openid); default covers every scope
    // the Grow tools exercise — read AND write, incl. note + custom-action scopes.
    expect(url.searchParams.get("scope")).toBe(
      "grow_lead_inbox_read grow_lead_inbox_all_read grow_lead_inbox_write grow_custom_action_read grow_custom_action_write grow_matter_read grow_matter_note_read grow_matter_note_write grow_contact_read grow_contact_note_read grow_contact_note_write grow_user_read"
    );
    // PKCE S256 challenge is present and well-formed (base64url, no padding).
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("throws for a state that was never issued", () => {
    expect(() => getGrowAuthorizationUrl("never-issued")).toThrow(/Unknown OAuth state/);
  });

  it("omits PKCE params when the verifier flow is consumed (state gone)", () => {
    // A consumed state can't build an authorize URL — verifier is single-use.
    const state = issueOAuthState();
    consumeOAuthState(state);
    expect(() => getGrowAuthorizationUrl(state)).toThrow(/Unknown OAuth state/);
  });
});
