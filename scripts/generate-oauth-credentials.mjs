#!/usr/bin/env node
/**
 * Generate credentials for the two non-OAuth-dance paths.
 *
 *   npm run oauth:static-client            # fixed client_id/secret for Gemini Enterprise
 *   npm run oauth:api-key -- user@firm.com # static bearer key for a script
 *
 * Nothing is written to disk or to the server: this prints the env variables
 * to set on the deployment, and (for the static client) the exact values to
 * paste into the Gemini Enterprise console. Secrets are shown ONCE — the
 * server can be configured to store only their sha256, at which point the
 * plaintext exists nowhere but the console you paste it into.
 *
 * Reads PUBLIC_BASE_URL / MCP_SCOPE_NAME from the environment (or a .env file
 * beside this repo) so the printed URLs are the real ones; override with
 * --base-url and --scope.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env reader — avoids taking a dependency for a one-shot script. */
function loadDotEnv() {
  try {
    const text = readFileSync(resolve(REPO_ROOT, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env — env vars or flags supply the values */
  }
}

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

loadDotEnv();

const mode = process.argv[2];
const baseUrl = flag("base-url", process.env.PUBLIC_BASE_URL || "https://<PUBLIC_BASE_URL>").replace(/\/$/, "");
const scope = flag("scope", process.env.MCP_SCOPE_NAME || "mcp.access");

/** URL-safe, ~256 bits of entropy. */
const secret = () => randomBytes(32).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

if (mode === "static-client") {
  const clientId = flag("client-id", `gemini-${randomBytes(8).toString("hex")}`);
  const clientSecret = secret();
  const name = flag("name", "Gemini Enterprise");

  console.log(`
=== Static OAuth client: ${name} ===

Set these on the server (Railway → Variables), then redeploy:

  MCP_STATIC_CLIENT_ID=${clientId}
  MCP_STATIC_CLIENT_SECRET_SHA256=${sha256(clientSecret)}
  MCP_STATIC_CLIENT_NAME=${name}

  (Or, if you would rather keep the plaintext on the server:
   MCP_STATIC_CLIENT_SECRET=${clientSecret})

--- Paste into Gemini Enterprise → Custom MCP Server ---

  MCP Server URL:      ${baseUrl}/mcp
  Authorization URL:   ${baseUrl}/authorize
  Token URL:           ${baseUrl}/token
  Client ID:           ${clientId}
  Client Secret:       ${clientSecret}
  Scopes:              ${scope}
  Auth URL Parameters: (leave empty)
  PKCE:                enabled (S256)

STILL REQUIRED, and not doable from here: add Gemini's redirect URI to the
Microsoft app registration (Entra ID → App registrations → your app →
Authentication → Web → Redirect URIs). Copy the exact URI from the Gemini
console. Without it Microsoft rejects the login with AADSTS50011.

The client secret above is shown once and is NOT recoverable. It is local to
this server — it is not the Microsoft app secret, and revoking it is a matter
of changing MCP_STATIC_CLIENT_ID/SECRET and redeploying.
`);
} else if (mode === "api-key") {
  const email = process.argv[3];
  if (!email || !email.includes("@")) {
    console.error("Usage: npm run oauth:api-key -- <email@firm.com>");
    process.exit(1);
  }
  const key = secret();
  console.log(`
=== Static API key for ${email} ===

Append to MCP_API_KEYS on the server (comma- or newline-separated entries):

  ${email}:sha256:${sha256(key)}

Use it from a script — either header works:

  curl -X POST ${baseUrl}/mcp \\
    -H 'Authorization: Bearer ${key}' \\
    -H 'Content-Type: application/json' \\
    -H 'Accept: application/json, text/event-stream' \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

The key acts as ${email} and reaches exactly what that attorney reaches —
the onboarding allowlist and their own Clio token still apply. Shown once.
`);
} else {
  console.error(`Usage:
  node scripts/generate-oauth-credentials.mjs static-client [--name <name>] [--client-id <id>] [--base-url <url>] [--scope <scope>]
  node scripts/generate-oauth-credentials.mjs api-key <email@firm.com> [--base-url <url>]`);
  process.exit(1);
}
