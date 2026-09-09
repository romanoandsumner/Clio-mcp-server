import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ENV } from "./utils/env";
import { als } from "./auth/identity";
import { verifyMicrosoftToken, isEmailAllowed, AuthError } from "./auth/microsoft";
import { buildUserContext, NotProvisionedError } from "./auth/vault";
import { registerOAuthProxyRoutes } from "./auth/oauthProxy";
import { resolveStaticApiKey } from "./auth/apiKeys";
import { getBoxAuthorizationUrl, exchangeBoxCodeForTokens } from "./box/auth";
import {
  getGrowAuthorizationUrl,
  exchangeGrowCodeForTokens,
  issueOAuthState,
  consumeOAuthState,
} from "./clio/growAuth";
import { registerMatterTools } from "./tools/matters";
import { registerMatterFinancialsTools } from "./tools/matterFinancials";
import { registerTimeTools } from "./tools/time";
import { registerExpenseTools } from "./tools/expenses";
import { registerContactTools } from "./tools/contacts";
import { registerTaskTools } from "./tools/tasks";
import { registerBillTools } from "./tools/bills";
import { registerPaymentTools } from "./tools/payments";
import { registerARTools } from "./tools/ar";
import { registerPerformanceTools } from "./tools/performance";
import { registerReconcileTools } from "./tools/reconcile";
import { registerScorecardTools } from "./tools/scorecard";
import { registerCalendarTools } from "./tools/calendar";
import { registerCustomFieldTools } from "./tools/customFields";
import { registerDocumentTools } from "./tools/documents";
import { registerAuditTools } from "./tools/audit";
import { registerAuditTimeTools } from "./tools/auditTime";
import { registerReviewTools } from "./tools/review";
import { registerMorningReportTools } from "./tools/morningReport";
import { registerVersionTools } from "./tools/version";
import { registerWhoAmITools } from "./tools/whoami";
import { registerNoteTools } from "./tools/notes";
import { registerGrowTools } from "./tools/grow";
import { registerClioDocumentTools } from "./tools/clioDocuments";
import { registerReminderTools } from "./tools/reminders";
import { registerTimerTools } from "./tools/timers";
import { registerLookupTools } from "./tools/lookups";
import { registerCommunicationTools } from "./tools/communications";
import { registerClioPaymentsTools } from "./tools/clioPayments";
import { registerBillingExtrasTools } from "./tools/billingExtras";
import { registerBillsGapTools } from "./tools/billsGap";
import { registerBillSentTools } from "./tools/billSent";
import reviewRouter from "./routes/review";
import uploadRouter from "./routes/upload";
import { getDownload } from "./utils/downloadStore";

// --- MCP Server Factory ---
// A fresh McpServer is created for every POST /mcp (see the stateless
// transport note below), so registration must be quiet on the hot path —
// the per-module checklist is logged only for the first instance.
let loggedRegistration = false;
export function createMcpServer(): McpServer {
  try {
    const server = new McpServer({
      name: "clio-mcp",
      version: "1.2.0",
    });

    registerMatterTools(server);
    registerMatterFinancialsTools(server);
    registerTimeTools(server);
    registerExpenseTools(server);
    registerContactTools(server);
    registerTaskTools(server);
    registerBillTools(server);
    registerPaymentTools(server);
    registerARTools(server);
    registerPerformanceTools(server);
    registerReconcileTools(server);
    registerScorecardTools(server);
    registerCalendarTools(server);
    registerCustomFieldTools(server);
    // ARCHIVED 2026-08-24 — get_attributable_collections (V&D Of Counsel comp)
    // is unwired; that calculation now lives in a separate skill. Source kept
    // in tools/calc.ts as registerArchivedCalcTools. Also unwired, same date:
    // generate_firm_scorecard (tools/scorecard.ts →
    // registerArchivedFirmScorecardTool) and download_firm_scorecard +
    // download_vd_statement (tools/documents.ts →
    // registerArchivedDocumentTools) — the firm scorecard is archival.
    registerDocumentTools(server);
    registerAuditTools(server);
    registerAuditTimeTools(server);
    registerMorningReportTools(server);
    registerReviewTools(server);
    registerVersionTools(server);
    registerWhoAmITools(server);
    registerNoteTools(server);
    registerGrowTools(server);
    registerClioDocumentTools(server);
    registerReminderTools(server);
    registerTimerTools(server);
    registerLookupTools(server);
    registerCommunicationTools(server);
    registerClioPaymentsTools(server);
    registerBillingExtrasTools(server);
    registerBillsGapTools(server);
    registerBillSentTools(server);

    if (!loggedRegistration) {
      loggedRegistration = true;
      console.log("[MCP] All tools registered successfully");
    }
    return server;
  } catch (err: any) {
    console.error("[MCP] FATAL: tool registration failed");
    console.error(err.stack || err);
    throw err;
  }
}

export function createApp(): express.Express {
  const BASE_URL = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

  const app = express();
  // Streamable HTTP works on the PARSED JSON body (unlike the old SSE /messages
  // route, which read the raw body). Parse JSON globally; the /token proxy adds
  // its own urlencoded parser at the route level.
  app.use(express.json({ limit: "10mb" }));

  // --- OAuth discovery + proxy (how the connector logs in via Microsoft) ---
  registerOAuthProxyRoutes(app);

  // --- Auth gate (per-user Microsoft identity) ---
  function send401(res: Response): void {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="clio-mcp", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({ error: "unauthorized" });
  }

  /**
   * Validate the credential from the Authorization header (never `?token=`).
   * Returns the verified, allowlisted email, or sends 401 and returns null.
   *
   * Two credential types, checked in that order:
   *   1. A static API key (Bearer or X-API-Key) — only when MCP_API_KEYS is
   *      configured; otherwise the check is a no-op and costs nothing.
   *   2. A Microsoft-issued Bearer JWT — the OAuth path, unchanged.
   *
   * Both converge on the same email, so the allowlist and the per-user Clio
   * vault lookup downstream are identical either way.
   */
  async function authenticate(req: Request, res: Response): Promise<string | null> {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const apiKeyHeader = req.headers["x-api-key"];
    const presentedKey = typeof apiKeyHeader === "string" ? apiKeyHeader.trim() : token;

    const principal = presentedKey ? resolveStaticApiKey(presentedKey) : null;
    if (principal) {
      if (!isEmailAllowed(principal.email)) {
        console.warn("[auth] API key owner is not on the onboarding allowlist");
        send401(res);
        return null;
      }
      return principal.email;
    }

    if (!token) {
      send401(res);
      return null;
    }
    let email: string;
    try {
      ({ email } = await verifyMicrosoftToken(token));
    } catch (err) {
      console.warn(`[auth] token rejected: ${err instanceof AuthError ? err.code : "invalid_token"}`);
      send401(res);
      return null;
    }
    if (!isEmailAllowed(email)) {
      console.warn("[auth] authenticated email is not on the onboarding allowlist");
      send401(res);
      return null;
    }
    return email;
  }

  // --- Streamable HTTP transport at /mcp (STATELESS: fresh transport per POST) ---
  //
  // The previous implementation kept ONE StreamableHTTPServerTransport per MCP
  // session and routed every POST for that session through it. The SDK routes
  // responses via a session-global map keyed only by JSON-RPC message id, with
  // no collision check — so when several clients share one session (parallel
  // claude.ai subagents on a single connector session) and their independently
  // numbered requests collide, each caller receives the OTHER caller's
  // response. Silently: the swapped response carries exactly the id the client
  // expected (reported 2026-07-02 — get_bill_line_items returning a different
  // bill's data under parallel load). The SDK's own stateless-mode guard says
  // it directly: "Reusing a stateless transport causes message ID collisions
  // between clients."
  //
  // This server is a pure request/response tool server — no sampling, no
  // server-initiated notifications — so it needs no session state at all. A
  // fresh transport + McpServer per POST makes id collisions structurally
  // impossible. validateSession is a no-op in stateless mode, so clients that
  // still send an mcp-session-id header from an older deploy keep working.
  app.post("/mcp", async (req: Request, res: Response) => {
    const email = await authenticate(req, res);
    if (!email) return;

    // Preload the user's Clio token from the vault, then run the handler inside
    // the per-request identity context so pagination.ts reads the right token.
    let ctx;
    try {
      ctx = await buildUserContext(email);
    } catch (err) {
      if (err instanceof NotProvisionedError) {
        send401(res);
        return;
      }
      console.error("[MCP] failed to build user context:", (err as Error).message);
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "User vault temporarily unavailable" },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createMcpServer();
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await als.run(ctx, () => transport.handleRequest(req, res, req.body));
  });

  // Stateless server: no server->client notification stream and no session to
  // tear down. 405 per the Streamable HTTP spec for unsupported methods.
  function methodNotAllowed(_req: Request, res: Response): void {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this server runs the Streamable HTTP transport in stateless mode." },
      id: null,
    });
  }
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // --- Health Check ---
  // Reports the deployed git SHA via RAILWAY_GIT_COMMIT_SHA (Railway sets this
  // automatically on each deploy). Lets callers verify "is my latest commit
  // actually live?" without guessing at deploy timing.
  const DEPLOY_SHA =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION || // Heroku
    "unknown";
  const DEPLOY_BRANCH = process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || "unknown";
  const STARTED_AT = new Date().toISOString();
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "clio-mcp",
      version: "1.2.0",
      build: "all-tools",
      transport: "streamable-http-stateless",
      git_sha: DEPLOY_SHA,
      git_sha_short: DEPLOY_SHA === "unknown" ? "unknown" : DEPLOY_SHA.slice(0, 7),
      git_branch: DEPLOY_BRANCH,
      started_at: STARTED_AT,
    });
  });

  // --- Token-addressed file downloads (Box upload fallback) ---
  // No auth: the unguessable token IS the authorization. See utils/downloadStore.ts.
  app.get("/download/:token", (req, res) => {
    const token = req.params.token;
    const entry = getDownload(token);
    if (!entry) {
      console.warn(`[Download] 404 token=${token.slice(0, 8)}…`);
      res.status(404).json({ error: "Download not found or expired" });
      return;
    }
    const safeName = entry.filename.replace(/["\\\r\n]/g, "");
    res.setHeader("Content-Type", entry.mimetype);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Length", entry.buffer.length.toString());
    res.setHeader("Cache-Control", "private, no-store");
    console.log(
      `[Download] served filename=${entry.filename} size_kb=${Math.round(entry.buffer.length / 1024)} token=${token.slice(0, 8)}…`,
    );
    res.end(entry.buffer);
  });

  // --- Review UI Routes ---
  app.use(reviewRouter);

  // --- Binary upload → Box (auth via X-Upload-Secret; see routes/upload.ts) ---
  app.use(uploadRouter);

  // --- Clio Grow OAuth (Clio Platform app; per-attorney tokens → vault) ---
  app.get("/grow/oauth/start", (_req, res) => {
    try {
      const url = getGrowAuthorizationUrl(issueOAuthState());
      res.redirect(url);
    } catch (err: any) {
      res.status(500).send(`Grow OAuth misconfigured: ${err.message}`);
    }
  });

  app.get("/grow/oauth/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
    if (error) {
      res.status(400).send(`<h1>Clio Grow authorization failed</h1><p>${error}: ${error_description ?? ""}</p>`);
      return;
    }
    const pending = consumeOAuthState(state);
    if (!pending) {
      res.status(400).send("Invalid or expired state parameter — restart at /grow/oauth/start.");
      return;
    }
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }
    try {
      const { email } = await exchangeGrowCodeForTokens(code, pending.codeVerifier);
      res.send(
        `<h1>Clio Grow Connected</h1><p>Grow tokens saved for ${email}. You can close this window.</p>`
      );
    } catch (err: any) {
      console.error("[grow-oauth] callback failed:", err?.response?.data ?? err.message);
      res.status(500).send(`Grow OAuth error: ${err.message}`);
    }
  });

  // --- Box OAuth (unchanged — out of scope) ---
  app.get("/box/oauth/start", (_req, res) => {
    const url = getBoxAuthorizationUrl();
    res.redirect(url);
  });

  app.get("/box/oauth/callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      const { email } = await exchangeBoxCodeForTokens(code);
      res.send(
        `<h1>Box OAuth Complete</h1><p>Tokens saved for ${email}. You can close this window.</p>`
      );
    } catch (err: any) {
      res.status(500).send(`Box OAuth error: ${err.message}`);
    }
  });

  return app;
}
