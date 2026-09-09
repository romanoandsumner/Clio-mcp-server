import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  checkRedirectUris,
  getStaticClient,
  isStaticClientId,
  secretMatches,
  secretMatchesHash,
  verifyStaticClientSecret,
} from "../src/auth/oauthClients";
import { resolveStaticApiKey, staticApiKeysEnabled } from "../src/auth/apiKeys";

const UPSTREAM_CLIENT_ID = "11111111-2222-3333-4444-555555555555";

const OAUTH_VARS = [
  "MS_CLIENT_ID",
  "MCP_STATIC_CLIENT_ID",
  "MCP_STATIC_CLIENT_SECRET",
  "MCP_STATIC_CLIENT_SECRET_SHA256",
  "MCP_STATIC_CLIENT_NAME",
  "OAUTH_ALLOWED_REDIRECT_URIS",
  "MCP_API_KEYS",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of OAUTH_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // getStaticClient() compares against the upstream app id, which ENV requires.
  process.env.MS_CLIENT_ID = UPSTREAM_CLIENT_ID;
  // The modules log loudly on misconfiguration; that is the point, but it
  // should not spray the test output.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of OAUTH_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("constant-time secret comparison", () => {
  it("matches identical secrets and rejects near-misses", () => {
    expect(secretMatches("correct-horse-battery", "correct-horse-battery")).toBe(true);
    expect(secretMatches("correct-horse-battery", "correct-horse-batterY")).toBe(false);
    // Differing lengths must not throw (timingSafeEqual is length-sensitive —
    // hashing first is what makes this safe).
    expect(secretMatches("short", "a-considerably-longer-secret")).toBe(false);
    expect(secretMatches("", "anything")).toBe(false);
  });

  it("matches a secret against its stored sha256, and rejects malformed digests", () => {
    expect(secretMatchesHash("s3cret-value", sha256("s3cret-value"))).toBe(true);
    expect(secretMatchesHash("s3cret-value", sha256("other"))).toBe(false);
    expect(secretMatchesHash("s3cret-value", "not-hex")).toBe(false);
    expect(secretMatchesHash("s3cret-value", "")).toBe(false);
  });
});

describe("static (non-DCR) client", () => {
  it("is absent until configured, so nothing changes for existing clients", () => {
    expect(getStaticClient()).toBeNull();
    expect(isStaticClientId("anything")).toBe(false);
    expect(verifyStaticClientSecret("anything")).toBe(false);
  });

  it("fails closed when an id is set but no secret is", () => {
    process.env.MCP_STATIC_CLIENT_ID = "gemini-abc123";
    expect(getStaticClient()).toBeNull();
    expect(isStaticClientId("gemini-abc123")).toBe(false);
  });

  it("verifies a plaintext secret", () => {
    process.env.MCP_STATIC_CLIENT_ID = "gemini-abc123";
    process.env.MCP_STATIC_CLIENT_SECRET = "top-secret-value";
    expect(isStaticClientId("gemini-abc123")).toBe(true);
    expect(isStaticClientId("some-other-client")).toBe(false);
    expect(verifyStaticClientSecret("top-secret-value")).toBe(true);
    expect(verifyStaticClientSecret("wrong")).toBe(false);
    expect(verifyStaticClientSecret("")).toBe(false);
  });

  it("prefers the hashed secret when both forms are configured", () => {
    process.env.MCP_STATIC_CLIENT_ID = "gemini-abc123";
    process.env.MCP_STATIC_CLIENT_SECRET = "stale-plaintext";
    process.env.MCP_STATIC_CLIENT_SECRET_SHA256 = sha256("rotated-secret");
    expect(verifyStaticClientSecret("rotated-secret")).toBe(true);
    expect(verifyStaticClientSecret("stale-plaintext")).toBe(false);
  });

  // Regression: pasting into a dashboard field captures a trailing newline.
  // The client id was trimmed and the secret was not, so the id matched, the
  // secret did not, and the only symptom was "invalid client_secret" with
  // values that looked identical on both sides. Hit for real on the
  // courtlistener-mcp port of this code, 2026-09-09.
  it("tolerates trailing whitespace on the configured id and secret", () => {
    process.env.MCP_STATIC_CLIENT_ID = "gemini-abc123\n";
    process.env.MCP_STATIC_CLIENT_SECRET = "top-secret-value\n";
    expect(isStaticClientId("gemini-abc123")).toBe(true);
    expect(verifyStaticClientSecret("top-secret-value")).toBe(true);

    process.env.MCP_STATIC_CLIENT_SECRET = "  top-secret-value  ";
    expect(verifyStaticClientSecret("top-secret-value")).toBe(true);
    // A genuinely wrong secret must still fail.
    expect(verifyStaticClientSecret("top-secret-valuex")).toBe(false);
  });

  it("treats a whitespace-only secret as unset, disabling the client", () => {
    process.env.MCP_STATIC_CLIENT_ID = "gemini-abc123";
    process.env.MCP_STATIC_CLIENT_SECRET = "   ";
    expect(getStaticClient()).toBeNull();
  });

  // Setting the static id to the upstream app id would hand every DCR client
  // (which holds no secret) a client_id that suddenly requires one — Claude
  // and ChatGPT would start failing /token with invalid_client.
  it("refuses to shadow MS_CLIENT_ID, which would lock out every DCR client", () => {
    process.env.MCP_STATIC_CLIENT_ID = UPSTREAM_CLIENT_ID;
    process.env.MCP_STATIC_CLIENT_SECRET = "some-secret-value";
    expect(getStaticClient()).toBeNull();
    expect(isStaticClientId(UPSTREAM_CLIENT_ID)).toBe(false);
    expect(verifyStaticClientSecret("some-secret-value")).toBe(false);
  });

  it("reports the configured display name", () => {
    process.env.MCP_STATIC_CLIENT_ID = "gemini-abc123";
    process.env.MCP_STATIC_CLIENT_SECRET_SHA256 = sha256("s");
    expect(getStaticClient()?.clientName).toBe("Gemini Enterprise");
    process.env.MCP_STATIC_CLIENT_NAME = "Vertex Agent";
    expect(getStaticClient()?.clientName).toBe("Vertex Agent");
  });
});

describe("DCR redirect_uri policy", () => {
  it("accepts https and loopback http, rejects other schemes and junk", () => {
    expect(checkRedirectUris(["https://claude.ai/api/mcp/auth_callback"]).ok).toBe(true);
    expect(checkRedirectUris(["http://localhost:5173/cb"]).ok).toBe(true);
    expect(checkRedirectUris(["http://127.0.0.1:5173/cb"]).ok).toBe(true);
    expect(checkRedirectUris(["http://evil.example.com/cb"]).ok).toBe(false);
    expect(checkRedirectUris(["/relative/path"]).ok).toBe(false);
  });

  it("is permissive by default — an allowlist is opt-in, so a client changing its callback host cannot lock everyone out", () => {
    expect(checkRedirectUris(["https://brand-new-host.example/cb"]).ok).toBe(true);
  });

  it("enforces strictly once OAUTH_ALLOWED_REDIRECT_URIS is set", () => {
    process.env.OAUTH_ALLOWED_REDIRECT_URIS =
      "https://claude.ai/api/mcp/auth_callback, https://chatgpt.com/connector_platform_oauth_redirect";
    expect(checkRedirectUris(["https://claude.ai/api/mcp/auth_callback"]).ok).toBe(true);
    const denied = checkRedirectUris(["https://elsewhere.example/cb"]);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("OAUTH_ALLOWED_REDIRECT_URIS");
  });

  it("rejects when ANY uri in the set is disallowed, not just the first", () => {
    process.env.OAUTH_ALLOWED_REDIRECT_URIS = "https://claude.ai/api/mcp/auth_callback";
    expect(
      checkRedirectUris(["https://claude.ai/api/mcp/auth_callback", "https://elsewhere.example/cb"]).ok
    ).toBe(false);
  });
});

describe("static API keys", () => {
  it("are inert when MCP_API_KEYS is unset", () => {
    expect(staticApiKeysEnabled()).toBe(false);
    expect(resolveStaticApiKey("whatever")).toBeNull();
    expect(resolveStaticApiKey("")).toBeNull();
  });

  it("resolves a plaintext key to its owning email", () => {
    process.env.MCP_API_KEYS = "Attorney@RomanoSumner.com:0123456789abcdef0123456789abcdef";
    expect(resolveStaticApiKey("0123456789abcdef0123456789abcdef")).toEqual({
      email: "attorney@romanosumner.com",
    });
    expect(resolveStaticApiKey("wrong-key-0123456789abcdef012345")).toBeNull();
  });

  it("resolves a hashed key without the plaintext ever being configured", () => {
    process.env.MCP_API_KEYS = `ops@romanosumner.com:sha256:${sha256("s3cret-key-value")}`;
    expect(resolveStaticApiKey("s3cret-key-value")).toEqual({ email: "ops@romanosumner.com" });
    expect(resolveStaticApiKey("s3cret-key-valuf")).toBeNull();
  });

  it("supports several keys across commas and newlines", () => {
    process.env.MCP_API_KEYS = [
      "# reporting cron",
      `a@romanosumner.com:sha256:${sha256("key-a")}`,
      `b@romanosumner.com:sha256:${sha256("key-b")},c@romanosumner.com:sha256:${sha256("key-c")}`,
    ].join("\n");
    expect(resolveStaticApiKey("key-a")?.email).toBe("a@romanosumner.com");
    expect(resolveStaticApiKey("key-b")?.email).toBe("b@romanosumner.com");
    expect(resolveStaticApiKey("key-c")?.email).toBe("c@romanosumner.com");
    expect(staticApiKeysEnabled()).toBe(true);
  });

  it("refuses a short plaintext key rather than installing a guessable credential", () => {
    process.env.MCP_API_KEYS = "a@romanosumner.com:hunter2";
    expect(staticApiKeysEnabled()).toBe(false);
    expect(resolveStaticApiKey("hunter2")).toBeNull();
  });

  it("skips malformed entries but keeps the valid ones", () => {
    process.env.MCP_API_KEYS = [
      "no-separator-here",
      ":orphan-secret-0123456789abcdef0123",
      "bad@romanosumner.com:sha256:nothex",
      `good@romanosumner.com:sha256:${sha256("key-good")}`,
    ].join(",");
    expect(resolveStaticApiKey("key-good")?.email).toBe("good@romanosumner.com");
    expect(resolveStaticApiKey("nothex")).toBeNull();
  });
});
