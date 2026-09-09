import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tool profiles: which subset of the tool surface an endpoint advertises.
 *
 * Motivation is Gemini Enterprise, which caps a data store at 100 enabled
 * actions — fewer than this server's ~147 tools — and which by default demands
 * per-call user confirmation because it assumes any action may mutate data.
 * Selecting a subset by hand in Google's console "works", but that choice is
 * invisible, unversioned, and silently drifts every time a tool is added here.
 *
 * Instead the server decides. `/mcp` keeps the full surface for Claude; a
 * read-only endpoint advertises only query tools, so a client pointed at it
 * cannot see a write tool because none is ever registered. The discriminator
 * is the URL path, deliberately:
 *
 *   - The OAuth client_id can't distinguish callers — every client is swapped
 *     to MS_CLIENT_ID upstream, so the Microsoft access token looks identical
 *     whoever presents it (see auth/oauthClients.ts).
 *   - `clientInfo` from `initialize` can't either: the transport is stateless
 *     (a fresh server per POST), so nothing from initialize survives to the
 *     tools/list call.
 *   - User-Agent sniffing is guesswork.
 *
 * A path is explicit, stateless, and testable.
 */

export type ToolProfile = "full" | "readonly";

/**
 * Read-only classification by name prefix rather than a hardcoded list of 78
 * names: a list would go stale the moment someone adds a tool, and the failure
 * would be silent (a new read tool quietly missing from Gemini). The prefixes
 * mirror the naming convention the tool surface already follows.
 *
 * Note what is deliberately NOT here: `download_*` and `generate_*` return a
 * URL to a generated file, which is useful in Claude and useless in a client
 * that cannot fetch it; `render_*`, `reconcile_*` and the mutating verbs
 * (`create_`, `update_`, `delete_`, `set_`, `apply_`, `prepare_`, `merge_`,
 * `start_`, `stop_`, …) mutate; and `probe_`/`debug_`/`dump_`/`test_` are
 * diagnostics already gated behind ENABLE_DIAGNOSTIC_TOOLS.
 */
const READ_ONLY_PREFIXES = [
  "get_",
  "list_",
  "search_",
  "find_",
  "compare_",
  "audit_",
] as const;

/** Read-only tools whose names carry no prefix. */
const READ_ONLY_EXACT = new Set(["who_am_i", "grow_who_am_i"]);

/**
 * `get_monthly_revenue` POSTs to Clio's /reports to generate a revenue CSV.
 * It is the one read-profile tool that issues a write verb, and it is benign:
 * it creates a report job, and mutates no matter, bill, time entry or contact.
 * Recorded here so an audit for "read tools that call a write helper" has a
 * documented answer instead of re-litigating it. See tools/performance.ts.
 */
export const REPORT_GENERATING_READ_TOOLS = new Set(["get_monthly_revenue"]);

export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY_EXACT.has(name)) return true;
  return READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Restrict a server to its profile's tools by filtering registration itself,
 * rather than threading a profile argument through all ~18 tool modules.
 *
 * Safe because no registration site uses the return value of `server.tool()` —
 * the same assumption `utils/diagnostics.ts` already relies on for its
 * `noopRegistrar`. Must be called BEFORE the register* functions run.
 */
export function applyToolProfile(server: McpServer, profile: ToolProfile): void {
  if (profile === "full") return;

  const register = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    return isReadOnlyTool(name) ? register(...args) : undefined;
  };
}
