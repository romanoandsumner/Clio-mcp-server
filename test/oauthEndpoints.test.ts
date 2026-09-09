import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash } from "node:crypto";

// auth/microsoft builds a remote JWKS at import time from strict env vars.
// Mock it, and make JWT verification ALWAYS fail: every request that succeeds
// in this file therefore proves the static-API-key path stands on its own,
// with no OAuth token involved.
vi.mock("../src/auth/microsoft", () => ({
  AuthError: class AuthError extends Error {
    code = "invalid_token";
  },
  verifyMicrosoftToken: async () => {
    throw new Error("no JWT path in this test");
  },
  isEmailAllowed: (email: string) => email === "keyowner@romanosumner.com",
}));

vi.mock("../src/auth/vault", () => ({
  NotProvisionedError: class NotProvisionedError extends Error {},
  buildUserContext: async (email: string) => ({
    userEmail: email,
    accessToken: "test-clio-token",
    refreshToken: "",
  }),
  getUserByEmail: async () => null,
  getClioTokens: async () => null,
  updateClioTokens: async () => undefined,
  getBoxTokens: async () => null,
  updateBoxTokens: async () => undefined,
  resolveUploadKey: async () => null,
}));

const axiosPost = vi.fn();
vi.mock("axios", () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...args),
    get: vi.fn(),
    create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
    isAxiosError: () => false,
  },
}));

import { createApp } from "../src/app";

const BASE = "https://mcp.test.invalid";
const MS_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const MS_CLIENT_SECRET = "upstream-microsoft-secret";
const MS_TENANT_ID = "tenant-abc";
const AUDIENCE = `api://${MS_CLIENT_ID}`;
const SCOPE_NAME = "mcp.access";

const STATIC_CLIENT_ID = "gemini-deadbeef";
const STATIC_CLIENT_SECRET = "gemini-local-secret-value";

const TEST_VARS = [
  "PUBLIC_BASE_URL",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "MS_TENANT_ID",
  "MCP_AUDIENCE",
  "MCP_SCOPE_NAME",
  "MCP_STATIC_CLIENT_ID",
  "MCP_STATIC_CLIENT_SECRET",
  "MCP_STATIC_CLIENT_SECRET_SHA256",
  "OAUTH_DCR_ENABLED",
  "OAUTH_ALLOWED_REDIRECT_URIS",
  "MCP_API_KEYS",
] as const;

const saved: Record<string, string | undefined> = {};
let server: Server;
let baseUrl: string;

function applyBaseEnv(): void {
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.MS_CLIENT_ID = MS_CLIENT_ID;
  process.env.MS_CLIENT_SECRET = MS_CLIENT_SECRET;
  process.env.MS_TENANT_ID = MS_TENANT_ID;
  process.env.MCP_AUDIENCE = AUDIENCE;
  process.env.MCP_SCOPE_NAME = SCOPE_NAME;
  process.env.MCP_STATIC_CLIENT_ID = STATIC_CLIENT_ID;
  process.env.MCP_STATIC_CLIENT_SECRET = STATIC_CLIENT_SECRET;
  delete process.env.MCP_STATIC_CLIENT_SECRET_SHA256;
  delete process.env.OAUTH_DCR_ENABLED;
  delete process.env.OAUTH_ALLOWED_REDIRECT_URIS;
  delete process.env.MCP_API_KEYS;
}

beforeAll(async () => {
  for (const key of TEST_VARS) saved[key] = process.env[key];
  applyBaseEnv();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const key of TEST_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  applyBaseEnv();
  axiosPost.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The form body handed to Microsoft on the last proxied /token call. */
function lastUpstreamForm(): URLSearchParams {
  expect(axiosPost).toHaveBeenCalledTimes(1);
  return new URLSearchParams(axiosPost.mock.calls[0][1] as string);
}

describe("discovery metadata", () => {
  it("advertises the endpoints, PKCE and the registration endpoint", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.issuer).toBe(BASE);
    expect(meta.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE}/token`);
    expect(meta.registration_endpoint).toBe(`${BASE}/register`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.scopes_supported).toContain(SCOPE_NAME);
    expect(meta.scopes_supported).toContain("offline_access");
  });

  it("serves protected-resource metadata pointing at this server as the AS", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.resource).toBe(AUDIENCE);
    expect(meta.authorization_servers).toEqual([BASE]);
    expect(meta.scopes_supported).toEqual([SCOPE_NAME]);
  });

  // RFC 8414 §3.1 path-insertion form. Clients disagree on which they probe.
  it("serves both documents at the /mcp-suffixed well-known paths too", async () => {
    const as = await fetch(`${baseUrl}/.well-known/oauth-authorization-server/mcp`);
    const pr = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(as.status).toBe(200);
    expect(pr.status).toBe(200);
    expect((await as.json()).token_endpoint).toBe(`${BASE}/token`);
    expect((await pr.json()).resource).toBe(AUDIENCE);
  });

  it("hides the registration endpoint when DCR is switched off", async () => {
    process.env.OAUTH_DCR_ENABLED = "false";
    const meta = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(meta.registration_endpoint).toBeUndefined();
    // …and the endpoint itself stops accepting registrations.
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /register (RFC 7591 dynamic client registration)", () => {
  function register(body: unknown) {
    return fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("hands back the upstream client_id as a public PKCE client", async () => {
    const res = await register({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(res.status).toBe(201);
    const reg = await res.json();
    expect(reg.client_id).toBe(MS_CLIENT_ID);
    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(reg.grant_types).toContain("refresh_token");
    // No secret is issued, so RFC 7591 wants no expiry field either — and its
    // absence is what tells the client this is a public client.
    expect(reg.client_secret_expires_at).toBeUndefined();
  });

  // /register is unauthenticated by design (RFC 7591). It must therefore never
  // be a way to read the tenant's app secret.
  it("never returns a client_secret, even though the upstream app has one", async () => {
    const reg = await (
      await register({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] })
    ).json();
    expect(reg.client_secret).toBeUndefined();
    expect(JSON.stringify(reg)).not.toContain(MS_CLIENT_SECRET);
  });

  it("rejects a registration with no redirect_uris", async () => {
    const res = await register({ client_name: "Claude" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-https redirect_uri", async () => {
    const res = await register({ redirect_uris: ["http://evil.example.com/cb"] });
    expect(res.status).toBe(400);
  });

  it("honours the strict redirect allowlist when one is configured", async () => {
    process.env.OAUTH_ALLOWED_REDIRECT_URIS = "https://claude.ai/api/mcp/auth_callback";
    expect((await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).status).toBe(201);
    expect((await register({ redirect_uris: ["https://elsewhere.example/cb"] })).status).toBe(400);
  });
});

describe("GET /authorize", () => {
  async function authorizeLocation(query: Record<string, string>): Promise<URL> {
    const res = await fetch(`${baseUrl}/authorize?${new URLSearchParams(query)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") as string);
  }

  it("translates the static client_id to the upstream Microsoft app", async () => {
    const loc = await authorizeLocation({
      client_id: STATIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: "https://gemini.example/callback",
      code_challenge: "abc123",
      code_challenge_method: "S256",
      state: "xyz",
      scope: SCOPE_NAME,
    });
    expect(loc.origin + loc.pathname).toBe(
      `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize`,
    );
    // Microsoft has never heard of the local client id.
    expect(loc.searchParams.get("client_id")).toBe(MS_CLIENT_ID);
    // PKCE and state ride through untouched.
    expect(loc.searchParams.get("code_challenge")).toBe("abc123");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://gemini.example/callback");
    // Bare scope qualified, and offline_access merged in so a refresh token
    // actually comes back.
    const scopes = (loc.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain(`${AUDIENCE}/${SCOPE_NAME}`);
    expect(scopes).toContain("offline_access");
    expect(scopes).not.toContain(SCOPE_NAME);
  });

  it("leaves an unrecognised client_id alone (pre-existing connectors are untouched)", async () => {
    const loc = await authorizeLocation({
      client_id: "some-other-registered-client",
      response_type: "code",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    });
    expect(loc.searchParams.get("client_id")).toBe("some-other-registered-client");
  });

  it("still strips the RFC 8707 resource param (AADSTS9010010)", async () => {
    const loc = await authorizeLocation({
      client_id: STATIC_CLIENT_ID,
      response_type: "code",
      resource: AUDIENCE,
    });
    expect(loc.searchParams.has("resource")).toBe(false);
  });
});

describe("POST /token", () => {
  beforeEach(() => {
    axiosPost.mockResolvedValue({
      status: 200,
      data: { access_token: "at", refresh_token: "rt", expires_in: 3599 },
    });
  });

  it("exchanges a code for the static client, swapping in the Microsoft credentials", async () => {
    const res = await postForm("/token", {
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://gemini.example/callback",
      code_verifier: "the-verifier",
      client_id: STATIC_CLIENT_ID,
      client_secret: STATIC_CLIENT_SECRET,
      scope: SCOPE_NAME,
    });
    expect(res.status).toBe(200);

    const sent = lastUpstreamForm();
    expect(sent.get("client_id")).toBe(MS_CLIENT_ID);
    expect(sent.get("client_secret")).toBe(MS_CLIENT_SECRET);
    // The local secret must never travel upstream.
    expect(sent.toString()).not.toContain(STATIC_CLIENT_SECRET);
    expect(sent.toString()).not.toContain(STATIC_CLIENT_ID);
    // PKCE verifier forwarded verbatim.
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(sent.get("scope")?.split(" ")).toContain(`${AUDIENCE}/${SCOPE_NAME}`);
  });

  it("accepts the static client's credentials over HTTP Basic", async () => {
    const basic = Buffer.from(`${STATIC_CLIENT_ID}:${STATIC_CLIENT_SECRET}`).toString("base64");
    const res = await postForm(
      "/token",
      { grant_type: "authorization_code", code: "the-code" },
      { Authorization: `Basic ${basic}` },
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamForm().get("client_id")).toBe(MS_CLIENT_ID);
  });

  it("rejects a wrong static client_secret without ever calling Microsoft", async () => {
    const res = await postForm("/token", {
      grant_type: "authorization_code",
      code: "the-code",
      client_id: STATIC_CLIENT_ID,
      client_secret: "wrong-secret",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("verifies the static secret against its sha256 when only the hash is configured", async () => {
    delete process.env.MCP_STATIC_CLIENT_SECRET;
    process.env.MCP_STATIC_CLIENT_SECRET_SHA256 = sha256("hashed-only-secret");

    const bad = await postForm("/token", {
      grant_type: "authorization_code",
      code: "c",
      client_id: STATIC_CLIENT_ID,
      client_secret: "hashed-only-secre",
    });
    expect(bad.status).toBe(401);

    const good = await postForm("/token", {
      grant_type: "authorization_code",
      code: "c",
      client_id: STATIC_CLIENT_ID,
      client_secret: "hashed-only-secret",
    });
    expect(good.status).toBe(200);
  });

  it("refreshes for the static client, and drops scope (AADSTS90009)", async () => {
    const res = await postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: "the-refresh-token",
      client_id: STATIC_CLIENT_ID,
      client_secret: STATIC_CLIENT_SECRET,
      scope: SCOPE_NAME,
    });
    expect(res.status).toBe(200);
    const sent = lastUpstreamForm();
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("the-refresh-token");
    expect(sent.get("client_id")).toBe(MS_CLIENT_ID);
    expect(sent.get("client_secret")).toBe(MS_CLIENT_SECRET);
    expect(sent.has("scope")).toBe(false);
  });

  // The DCR path: a public client sends no secret at all, and the server
  // attaches the confidential app's secret on its behalf.
  it("still attaches the Microsoft secret for a public client that sends none", async () => {
    const res = await postForm("/token", {
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "v",
      client_id: MS_CLIENT_ID,
    });
    expect(res.status).toBe(200);
    const sent = lastUpstreamForm();
    expect(sent.get("client_id")).toBe(MS_CLIENT_ID);
    expect(sent.get("client_secret")).toBe(MS_CLIENT_SECRET);
  });

  it("passes an upstream Microsoft error through untouched", async () => {
    axiosPost.mockResolvedValue({
      status: 400,
      data: { error: "invalid_grant", error_description: "AADSTS70008: expired" },
    });
    const res = await postForm("/token", {
      grant_type: "authorization_code",
      code: "stale",
      client_id: STATIC_CLIENT_ID,
      client_secret: STATIC_CLIENT_SECRET,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("static API-key auth on /mcp", () => {
  const KEY = "a-long-enough-static-api-key-value";

  function callMcp(headers: Record<string, string>) {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  }

  it("authenticates a valid key as its owner, with no OAuth token in play", async () => {
    process.env.MCP_API_KEYS = `keyowner@romanosumner.com:sha256:${sha256(KEY)}`;
    const res = await callMcp({ Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(200);
  });

  it("accepts the key via X-API-Key for clients that cannot set Authorization", async () => {
    process.env.MCP_API_KEYS = `keyowner@romanosumner.com:sha256:${sha256(KEY)}`;
    const res = await callMcp({ "X-API-Key": KEY });
    expect(res.status).toBe(200);
  });

  it("still applies the onboarding allowlist to key owners", async () => {
    process.env.MCP_API_KEYS = `outsider@example.com:sha256:${sha256(KEY)}`;
    const res = await callMcp({ Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown key", async () => {
    process.env.MCP_API_KEYS = `keyowner@romanosumner.com:sha256:${sha256(KEY)}`;
    const res = await callMcp({ Authorization: "Bearer not-the-key-at-all-but-long" });
    expect(res.status).toBe(401);
  });

  it("is off entirely when MCP_API_KEYS is unset", async () => {
    delete process.env.MCP_API_KEYS;
    const res = await callMcp({ Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});
