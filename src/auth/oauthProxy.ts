import express, { Express, Request, Response } from "express";
import axios from "axios";
import { ENV } from "../utils/env";
import {
  checkRedirectUris,
  getStaticClient,
  isStaticClientId,
  verifyStaticClientSecret,
} from "./oauthClients";

/**
 * OAuth discovery + proxy endpoints. This is how the MCP connector logs in:
 * it discovers this server as a protected resource, then runs the auth-code
 * flow against /authorize + /token, which forward to Microsoft.
 *
 * We forward to Microsoft v2 and drop the RFC 8707 `resource` param, which
 * otherwise triggers AADSTS9010010.
 *
 * Three client shapes reach these endpoints, all landing on the same upstream
 * Microsoft app registration (see auth/oauthClients.ts for why):
 *
 *   1. DCR clients (Claude, ChatGPT) — POST /register, get MS_CLIENT_ID back
 *      as a public+PKCE client.
 *   2. The static client (Gemini Enterprise, which has no DCR) — presents its
 *      own local client_id/secret, which /token verifies and swaps for the
 *      Microsoft credentials.
 *   3. Anything else — passed through verbatim, exactly as before, so a
 *      connector already configured with a manually-entered client_id keeps
 *      working untouched.
 */

function msAuthorizeUrl(): string {
  return `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/oauth2/v2.0/authorize`;
}
function msTokenUrl(): string {
  return `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/oauth2/v2.0/token`;
}

/**
 * Build the scope string Microsoft needs for a durable, refreshable login:
 * the fully-qualified API scope (bare names resolve against Graph on the v2
 * endpoint), plus openid/profile/email and — critically — offline_access,
 * which is what makes Microsoft return a refresh token.
 */
/**
 * Undo the form-urlencoding RFC 6749 §2.3.1 requires on Basic-auth client
 * credentials. Falls back to the raw value when the string is not valid
 * percent-encoding: a secret containing a stray `%` would otherwise throw a
 * URIError and turn a client-auth attempt into a 500.
 */
function formUrlDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeScope(requested: string | null | undefined): string {
  const scopes = new Set((requested ?? "").split(/\s+/).filter(Boolean));
  scopes.delete(ENV.MCP_SCOPE_NAME);
  scopes.add(`${ENV.MCP_AUDIENCE}/${ENV.MCP_SCOPE_NAME}`);
  for (const s of ["openid", "profile", "email", "offline_access"]) scopes.add(s);
  return [...scopes].join(" ");
}

export function registerOAuthProxyRoutes(app: Express): void {
  const baseUrl = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

  // RFC 9728 — Protected Resource Metadata.
  //
  // `resource` stays MCP_AUDIENCE (the api://<app-id> value Microsoft puts in
  // the token's aud claim) rather than the more literal `${baseUrl}/mcp`.
  // That is what the live Claude connector already discovered, and /authorize
  // strips RFC 8707 `resource` on the way out regardless, so changing it would
  // buy nothing and risk a reconnect loop.
  function protectedResourceMetadata(_req: Request, res: Response): void {
    res.json({
      resource: ENV.MCP_AUDIENCE,
      authorization_servers: [baseUrl],
      scopes_supported: [ENV.MCP_SCOPE_NAME],
      bearer_methods_supported: ["header"],
    });
  }

  // RFC 8414 — Authorization Server Metadata. We are the authorization server
  // the connector talks to; we proxy to Microsoft underneath.
  function authorizationServerMetadata(_req: Request, res: Response): void {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      // Advertised only when DCR is on. A connector that sees no
      // registration_endpoint falls back to asking the operator for a
      // client_id — which is how this server behaved before /register existed.
      ...(ENV.OAUTH_DCR_ENABLED ? { registration_endpoint: `${baseUrl}/register` } : {}),
      jwks_uri: `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/discovery/v2.0/keys`,
      scopes_supported: [ENV.MCP_SCOPE_NAME, "openid", "profile", "email", "offline_access"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
    });
  }

  // Both metadata documents are served at the bare well-known path AND with
  // the resource path appended (`/.well-known/oauth-authorization-server/mcp`).
  // RFC 8414 §3.1 defines the path-insertion form, and MCP clients differ on
  // which they probe — serving both removes a whole class of "connector can't
  // discover the server" failures.
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", authorizationServerMetadata);

  // POST /register — RFC 7591 Dynamic Client Registration.
  //
  // A shim, not a registry. Microsoft Entra has no DCR of its own and this
  // server issues no tokens, so there is nothing to persist: every caller is
  // handed the one upstream client_id back, as a PUBLIC client with no secret.
  // PKCE is what actually protects the code exchange; /token adds
  // MS_CLIENT_SECRET server-side so the Microsoft app can stay confidential
  // without the secret ever crossing the wire.
  //
  // Statelessness is a feature here — there is no registration to lose across
  // a restart or a second replica, which is exactly how a DCR record backed by
  // in-memory storage would strand a connector.
  app.post("/register", (req: Request, res: Response) => {
    if (!ENV.OAUTH_DCR_ENABLED) {
      res.status(403).json({
        error: "access_denied",
        error_description: "Dynamic client registration is disabled on this server.",
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (redirectUris.length === 0) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be a non-empty array.",
      });
      return;
    }

    const verdict = checkRedirectUris(redirectUris);
    if (!verdict.ok) {
      console.warn(`[oauth] DCR rejected: ${verdict.reason}`);
      res.status(400).json({ error: "invalid_redirect_uri", error_description: verdict.reason });
      return;
    }

    const clientName = typeof body.client_name === "string" ? body.client_name : "mcp-client";
    console.log(
      `[oauth] DCR issued upstream client_id to name=${JSON.stringify(clientName).slice(0, 80)} ` +
        `redirect_uris=${redirectUris.join(" ")}`
    );

    // client_secret is deliberately absent: omitting it is what marks this a
    // public client, and it keeps /register — which RFC 7591 leaves open —
    // from being a way for any caller to read a secret.
    res.status(201).json({
      client_id: ENV.MS_CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: ENV.MCP_SCOPE_NAME,
    });
  });

  // GET /authorize -> 302 to Microsoft, forwarding all query params verbatim
  // EXCEPT `resource` (RFC 8707 — triggers AADSTS9010010 on v2).
  app.get("/authorize", (req: Request, res: Response) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "resource") continue;
      if (Array.isArray(value)) {
        value.forEach((v) => params.append(key, String(v)));
      } else if (value !== undefined) {
        params.append(key, String(value));
      }
    }
    // The static (Gemini) client_id only exists here — Microsoft has never
    // heard of it. Swap it for the real app registration before redirecting,
    // so the code Microsoft mints is bound to MS_CLIENT_ID, matching what
    // /token will present at exchange time.
    const requestedClientId = params.get("client_id") ?? "";
    if (requestedClientId && isStaticClientId(requestedClientId)) {
      params.set("client_id", ENV.MS_CLIENT_ID);
    }
    // Help connectors that don't carry a client_id of their own.
    if (!params.has("client_id")) params.set("client_id", ENV.MS_CLIENT_ID);
    // Connectors request only the scope advertised by the resource metadata
    // (the bare scope name), so never rely on them asking for more. Always:
    //  - qualify the bare scope name to api://<audience>/<scope> (Microsoft v2
    //    resolves unqualified names against Graph, not our app), and
    //  - merge in offline_access — WITHOUT it Microsoft issues no refresh
    //    token, the access token dies after ~1h, and the user is forced
    //    through an interactive reconnect every time it expires.
    params.set("scope", normalizeScope(params.get("scope")));
    res.redirect(302, `${msAuthorizeUrl()}?${params.toString()}`);
  });

  // POST /token -> proxy to Microsoft as application/x-www-form-urlencoded,
  // dropping `resource`. Fold HTTP Basic client creds into the body. Return
  // Microsoft's status + JSON unchanged.
  app.post("/token", express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
    const form = new URLSearchParams();
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (key === "resource") continue;
      if (Array.isArray(value)) {
        value.forEach((v) => form.append(key, String(v)));
      } else if (value !== undefined && value !== null) {
        form.append(key, String(value));
      }
    }

    // Fold HTTP Basic client creds into the body FIRST, so the static-client
    // check below sees credentials however the client chose to present them
    // (client_secret_post or client_secret_basic — Gemini uses Basic).
    const authz = req.headers.authorization;
    if (authz && authz.startsWith("Basic ")) {
      const decoded = Buffer.from(authz.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep >= 0) {
        const cid = formUrlDecode(decoded.slice(0, sep));
        const secret = formUrlDecode(decoded.slice(sep + 1));
        if (cid && !form.has("client_id")) form.set("client_id", cid);
        if (secret && !form.has("client_secret")) form.set("client_secret", secret);
      }
    }

    // Static (non-DCR) client: verify ITS secret, then substitute the upstream
    // Microsoft credentials. This is the whole reason Google never needs to
    // hold MS_CLIENT_SECRET — and the reason revoking Gemini's access is a
    // one-variable change rather than a tenant-wide secret rotation.
    const presentedClientId = form.get("client_id") ?? "";
    if (presentedClientId && isStaticClientId(presentedClientId)) {
      if (!verifyStaticClientSecret(form.get("client_secret") ?? "")) {
        console.warn("[oauth] static client presented an invalid client_secret");
        res.status(401).json({
          error: "invalid_client",
          error_description: "Client authentication failed.",
        });
        return;
      }
      form.set("client_id", ENV.MS_CLIENT_ID);
      // Dropped, not overwritten: the MS_CLIENT_SECRET fallback below is the
      // single place the upstream secret is attached.
      form.delete("client_secret");
    }

    // Scope handling differs by grant:
    //  - authorization_code: qualify the bare scope to api://<audience>/<scope>
    //    + offline_access (interactive consent supports the app tokening itself).
    //  - refresh_token: DROP scope entirely. This app is its own API resource
    //    (client_id == MCP_AUDIENCE app), and Azure rejects a non-interactive
    //    request for the app's own scope with AADSTS90009 ("requesting a token
    //    for itself"). With no scope, Azure reuses the scopes already consented
    //    at auth-code time, so the refreshed access token still carries
    //    aud=<MCP_AUDIENCE> — without tripping AADSTS90009.
    const grantType = String((body as Record<string, unknown>).grant_type ?? "");
    if (grantType === "refresh_token") {
      form.delete("scope");
    } else if (form.has("scope")) {
      form.set("scope", normalizeScope(form.get("scope")));
    }

    // Fallbacks so a confidential Microsoft app still authenticates when the
    // connector is a public client that only knows the client_id.
    if (!form.has("client_id")) form.set("client_id", ENV.MS_CLIENT_ID);
    if (!form.has("client_secret") && ENV.MS_CLIENT_SECRET) {
      form.set("client_secret", ENV.MS_CLIENT_SECRET);
    }

    try {
      const upstream = await axios.post(msTokenUrl(), form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: () => true,
      });
      // Diagnostic: never logs token values — only grant type, status, whether
      // a refresh_token came back (the thing that decides if the session can
      // survive past the ~1h access-token lifetime), and Microsoft's error
      // code on failure. Lets us tell "refresh worked" from "AADSTS rejected"
      // from "connector never refreshed" without guessing.
      const grant = String((body as Record<string, unknown>).grant_type ?? "unknown");
      const data = (upstream.data ?? {}) as Record<string, unknown>;
      if (upstream.status >= 200 && upstream.status < 300) {
        console.log(
          `[oauth] token grant=${grant} status=${upstream.status} ` +
            `access_token=${data.access_token ? "yes" : "no"} ` +
            `refresh_token=${data.refresh_token ? "yes" : "no"} ` +
            `expires_in=${data.expires_in ?? "?"}`
        );
      } else {
        console.warn(
          `[oauth] token grant=${grant} status=${upstream.status} ` +
            `error=${data.error ?? "?"} ` +
            `desc=${String(data.error_description ?? "").replace(/\s+/g, " ").slice(0, 200)}`
        );
      }
      res.status(upstream.status).json(upstream.data);
    } catch (err) {
      console.error("[oauth] token proxy error:", (err as Error).message);
      res.status(502).json({ error: "token_proxy_error" });
    }
  });
}
