// WebCrypto polyfill guard — jose needs globalThis.crypto (present on Node 18+,
// but make it explicit so this is the first thing that runs).
import { webcrypto } from "node:crypto";
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

import dotenv from "dotenv";
dotenv.config();

import { ENV } from "./utils/env";
import { createApp } from "./app";
import { diagnosticToolsEnabled } from "./utils/diagnostics";
import { getStaticClient } from "./auth/oauthClients";
import { staticApiKeysEnabled } from "./auth/apiKeys";

const BASE_URL = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

// App construction (routes, auth, stateless /mcp transport) lives in app.ts so
// tests can drive the HTTP surface in-process; this file is just the entrypoint.
const app = createApp();

// --- Start Server ---
const PORT = ENV.PORT;
const httpServer = app.listen(PORT, () => {
  console.log(`Clio MCP Server running on port ${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  MCP:       http://localhost:${PORT}/mcp (Streamable HTTP, stateless)`);
  console.log(`  MCP (RO):  http://localhost:${PORT}/mcp/readonly (query tools only)`);
  console.log(`  Discovery: ${BASE_URL}/.well-known/oauth-protected-resource`);
  console.log(`  Box OAuth: http://localhost:${PORT}/box/oauth/start`);
  console.log(`  Auth:      per-user Microsoft OAuth (Bearer JWT required)`);
  // Which of the optional auth paths are actually live. Both are opt-in, and
  // "I set the variable but it isn't working" is otherwise invisible until a
  // client fails to connect.
  console.log(
    `  DCR:       ${ENV.OAUTH_DCR_ENABLED ? `enabled (${BASE_URL}/register)` : "disabled"}`
  );
  const staticClient = getStaticClient();
  console.log(
    `  Static client: ${staticClient ? `${staticClient.clientName} (${staticClient.clientId})` : "none configured"}`
  );
  console.log(`  API keys:  ${staticApiKeysEnabled() ? "ENABLED" : "disabled"}`);
  // Boot-visible so a mistyped flag value is diagnosable from deploy logs
  // instead of silently hiding the probe tools.
  console.log(
    `  Diag tools: ${diagnosticToolsEnabled() ? "ENABLED" : "disabled"} ` +
    `(ENABLE_DIAGNOSTIC_TOOLS=${JSON.stringify(process.env.ENABLE_DIAGNOSTIC_TOOLS ?? "(unset)")})`
  );
});
// Node's default keep-alive timeout (5s) is shorter than Railway's edge proxy
// idle timeout, so the proxy reuses sockets the server already closed —
// sporadic ECONNRESET/502 that the connector sees as a dropped connection.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;
