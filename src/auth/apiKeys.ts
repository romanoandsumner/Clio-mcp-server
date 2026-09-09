import { createHash, timingSafeEqual } from "node:crypto";
import { ENV } from "../utils/env";

/**
 * Static API-key auth: the escape hatch for scripts and clients that cannot
 * run the OAuth dance (cron jobs, curl, an internal service).
 *
 * A key stands in for the Microsoft JWT and nothing else. It resolves to an
 * email, and from there the request takes the SAME path as an OAuth login:
 * the onboarding allowlist still applies, and buildUserContext() still loads
 * that attorney's own Clio token from the vault. A key therefore cannot reach
 * data its owner could not reach through Claude.
 *
 * Deliberately NOT reusing the `upload_keys` table behind resolveUploadKey():
 * those keys were issued for file uploads only, and silently promoting every
 * one of them to a full MCP credential would be a privilege escalation nobody
 * asked for.
 *
 * Inert until MCP_API_KEYS is set — an unset value changes no behaviour.
 */

export interface ApiKeyPrincipal {
  email: string;
}

interface ParsedKey {
  email: string;
  /** sha256 hex of the secret, however it was configured. */
  secretSha256: string;
}

/**
 * Parse MCP_API_KEYS. Entries are separated by commas or newlines; each is
 * either
 *
 *   user@firm.com:<secret>
 *   user@firm.com:sha256:<64 hex chars>
 *
 * The hashed form is preferred in production — the deployment env then never
 * holds a usable credential in plaintext.
 */
function parseKeys(raw: string): ParsedKey[] {
  const out: ParsedKey[] = [];
  for (const entry of raw.split(/[\n,]+/)) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const firstColon = trimmed.indexOf(":");
    if (firstColon <= 0) {
      console.error("[auth] MCP_API_KEYS entry is missing its 'email:secret' separator — skipped.");
      continue;
    }
    const email = trimmed.slice(0, firstColon).trim().toLowerCase();
    const rest = trimmed.slice(firstColon + 1).trim();
    if (!email || !rest) {
      console.error("[auth] MCP_API_KEYS entry has an empty email or secret — skipped.");
      continue;
    }

    if (rest.toLowerCase().startsWith("sha256:")) {
      const hex = rest.slice("sha256:".length).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        console.error(`[auth] MCP_API_KEYS entry for ${email} has a malformed sha256 digest — skipped.`);
        continue;
      }
      out.push({ email, secretSha256: hex });
      continue;
    }

    if (rest.length < 24) {
      console.error(
        `[auth] MCP_API_KEYS entry for ${email} is shorter than 24 chars — refusing to install a guessable key.`
      );
      continue;
    }
    out.push({ email, secretSha256: createHash("sha256").update(rest, "utf8").digest("hex") });
  }
  return out;
}

/**
 * Resolve a presented key to its owning email, or null.
 *
 * Compares against EVERY configured key rather than returning on first match,
 * so the time taken does not reveal which key (or how many) matched.
 */
export function resolveStaticApiKey(presented: string): ApiKeyPrincipal | null {
  if (!presented) return null;
  const configured = parseKeys(ENV.MCP_API_KEYS);
  if (configured.length === 0) return null;

  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  let match: ApiKeyPrincipal | null = null;
  for (const key of configured) {
    if (timingSafeEqual(presentedDigest, Buffer.from(key.secretSha256, "hex"))) {
      match = { email: key.email };
    }
  }
  return match;
}

/** True when at least one usable key is configured (for boot-time logging). */
export function staticApiKeysEnabled(): boolean {
  return parseKeys(ENV.MCP_API_KEYS).length > 0;
}
