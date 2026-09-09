import { createHash, timingSafeEqual } from "node:crypto";
import { ENV } from "../utils/env";

/**
 * OAuth client registry for the /authorize + /token facade.
 *
 * This server is NOT a token issuer — Microsoft Entra is. Every client that
 * logs in ultimately runs against the ONE upstream Microsoft app registration
 * (MS_CLIENT_ID). What differs is how each client learns a client_id:
 *
 *   - Claude / ChatGPT support RFC 7591 Dynamic Client Registration. They POST
 *     /register and are handed the upstream client_id back as a PUBLIC client
 *     (PKCE, no secret). Nothing is stored: the "registration" is a shim.
 *   - Gemini Enterprise does NOT support DCR. It needs a fixed client_id AND
 *     client_secret typed into its admin console. That pair is configured here
 *     (MCP_STATIC_CLIENT_ID / _SECRET) and is LOCAL to this server: /token
 *     verifies it, then substitutes the real Microsoft credentials upstream.
 *
 * The indirection matters. Handing Google the raw MS_CLIENT_SECRET would put
 * the tenant's app secret in a third-party console with no way to rotate it
 * independently of every other client. A local static secret is revocable on
 * its own by changing one env var.
 */

/** Constant-time compare of two secrets, via fixed-length digests. */
export function secretMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Constant-time compare of a presented secret against a stored sha256 hex digest. */
export function secretMatchesHash(presented: string, expectedSha256Hex: string): boolean {
  if (!presented || !expectedSha256Hex) return false;
  const expected = expectedSha256Hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = Buffer.from(expected, "hex");
  return timingSafeEqual(a, b);
}

export interface StaticClient {
  clientId: string;
  clientName: string;
}

/**
 * The configured static (non-DCR) client, or null when none is set up.
 *
 * Read fresh on every call rather than cached at module load: ENV uses lazy
 * getters, and both tests and a Railway variable change expect the new value
 * to take effect without a rebuild.
 */
export function getStaticClient(): StaticClient | null {
  const clientId = ENV.MCP_STATIC_CLIENT_ID.trim();
  if (!clientId) return null;
  // Guard a misconfiguration that would take Claude and ChatGPT down: if the
  // static id were set to the upstream app id, every DCR client — which is
  // handed exactly that id and holds no secret — would start failing /token
  // with invalid_client.
  if (clientId === ENV.MS_CLIENT_ID) {
    console.error(
      "[oauth] MCP_STATIC_CLIENT_ID must not equal MS_CLIENT_ID — it would force a client_secret " +
        "on every DCR client. Static client disabled; generate a distinct id with `npm run oauth:static-client`."
    );
    return null;
  }
  if (!ENV.MCP_STATIC_CLIENT_SECRET && !ENV.MCP_STATIC_CLIENT_SECRET_SHA256) {
    console.error(
      "[oauth] MCP_STATIC_CLIENT_ID is set but neither MCP_STATIC_CLIENT_SECRET nor " +
        "MCP_STATIC_CLIENT_SECRET_SHA256 is — static client disabled (fail closed)."
    );
    return null;
  }
  return { clientId, clientName: ENV.MCP_STATIC_CLIENT_NAME };
}

/** True when `clientId` is the configured static client. */
export function isStaticClientId(clientId: string): boolean {
  const client = getStaticClient();
  return client !== null && client.clientId === clientId;
}

/**
 * Verify the secret presented for the static client. Prefers the hashed form
 * when both are configured, so an operator can move to a hash without first
 * clearing the plaintext.
 */
export function verifyStaticClientSecret(presented: string): boolean {
  if (!getStaticClient()) return false;
  const hash = ENV.MCP_STATIC_CLIENT_SECRET_SHA256;
  const ok = hash
    ? secretMatchesHash(presented, hash)
    : secretMatches(presented, ENV.MCP_STATIC_CLIENT_SECRET);

  if (!ok) {
    // Lengths, never values. For a high-entropy secret the length leaks
    // nothing useful, and it separates failure modes that look identical from
    // outside: unequal lengths mean stray whitespace or truncation, a
    // presented length of 0 means the client sent nothing, equal lengths mean
    // genuinely different secrets, and mode=sha256 when the operator expected
    // plaintext means the _SHA256 var is silently overriding it.
    const configuredLen = hash ? hash.length : ENV.MCP_STATIC_CLIENT_SECRET.length;
    console.warn(
      `[oauth] static client secret mismatch: mode=${hash ? "sha256" : "plaintext"} ` +
        `presented_len=${presented.length} configured_len=${configuredLen}`
    );
  }
  return ok;
}

/**
 * Redirect-URI policy for Dynamic Client Registration.
 *
 * Default is permissive-with-a-warning, NOT deny: Claude and ChatGPT have
 * changed their callback hosts before, and a hardcoded allowlist would turn
 * that into a silent "can't connect" outage. Setting
 * OAUTH_ALLOWED_REDIRECT_URIS switches this to strict enforcement for
 * operators who want the lockdown.
 *
 * Note this is defence in depth only. Microsoft independently rejects any
 * redirect_uri not registered on the app (AADSTS50011), so an attacker cannot
 * redirect a code anywhere the tenant admin has not already approved.
 */
export function checkRedirectUris(redirectUris: string[]): { ok: true } | { ok: false; reason: string } {
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return { ok: false, reason: `redirect_uri is not an absolute URI: ${uri}` };
    }
    const isLoopback =
      parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !isLoopback) {
      return { ok: false, reason: `redirect_uri must use https (or http on loopback): ${uri}` };
    }
  }

  const allowed = ENV.OAUTH_ALLOWED_REDIRECT_URIS.split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    console.warn(
      `[oauth] DCR accepted redirect_uris without an allowlist (OAUTH_ALLOWED_REDIRECT_URIS unset): ` +
        redirectUris.join(" ")
    );
    return { ok: true };
  }

  for (const uri of redirectUris) {
    if (!allowed.includes(uri)) {
      return { ok: false, reason: `redirect_uri is not on OAUTH_ALLOWED_REDIRECT_URIS: ${uri}` };
    }
  }
  return { ok: true };
}
