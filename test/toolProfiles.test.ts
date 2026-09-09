import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyTool } from "../src/tools/profiles";

vi.mock("../src/auth/microsoft", () => ({
  AuthError: class AuthError extends Error {
    code = "invalid_token";
  },
  verifyMicrosoftToken: async () => ({ email: "test@romanosumner.com" }),
  isEmailAllowed: () => true,
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

import { createApp } from "../src/app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function listTools(path: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-jwt",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
    : [JSON.parse(text)];
  const reply = messages.find((m: any) => m.id === 1);
  return (reply.result?.tools ?? []).map((t: any) => t.name).sort();
}

/** Every tool name registered anywhere in the source tree. */
function allRegisteredToolNames(): string[] {
  const names = new Set<string>();
  for (const dir of ["src/tools", "src/dashboard"]) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const chunk of src.split(/\bserver\s*\)?\s*\.tool\(/).slice(1)) {
        const m = chunk.match(/^\s*"([a-z0-9_]+)"/);
        if (m) names.add(m[1]);
      }
    }
  }
  return [...names].sort();
}

const MUTATING_PREFIXES = [
  "create_", "update_", "delete_", "set_", "apply_", "prepare_", "merge_",
  "remove_", "convert_", "discount_", "expire_", "mark_", "upload_", "log_",
  "start_", "stop_", "add_", "render_", "reconcile_",
];

describe("tool profiles", () => {
  it("serves the full surface on /mcp", async () => {
    const tools = await listTools("/mcp");
    expect(tools.length).toBeGreaterThan(100);
    // Writes are present here — that is the point of the full endpoint.
    expect(tools).toContain("create_time_entry");
    expect(tools).toContain("get_matters");
  });

  it("serves only query tools on /mcp/readonly", async () => {
    const tools = await listTools("/mcp/readonly");
    expect(tools.length).toBeGreaterThan(50);
    expect(tools).toContain("get_matters");
    expect(tools).toContain("get_time_entries");
    expect(tools).toContain("who_am_i");
    expect(tools).not.toContain("create_time_entry");
    expect(tools).not.toContain("delete_task");
    expect(tools).not.toContain("set_bill_state");
  });

  // The whole reason the read-only endpoint exists: Gemini Enterprise caps a
  // data store at 100 enabled actions. If the query surface ever grows past
  // that, the endpoint silently stops solving the problem it was built for.
  it("keeps the read-only surface under Gemini's 100-action cap", async () => {
    const tools = await listTools("/mcp/readonly");
    expect(tools.length).toBeLessThanOrEqual(100);
  });

  it("exposes no mutating verb on the read-only endpoint", async () => {
    const tools = await listTools("/mcp/readonly");
    const offenders = tools.filter((n) => MUTATING_PREFIXES.some((p) => n.startsWith(p)));
    expect(offenders).toEqual([]);
  });

  it("excludes file-producing tools, whose download URLs a remote client cannot fetch", async () => {
    const tools = await listTools("/mcp/readonly");
    expect(tools.filter((n) => n.startsWith("download_") || n.startsWith("generate_"))).toEqual([]);
  });

  it("is a strict subset of the full surface", async () => {
    const [full, readonly] = [await listTools("/mcp"), await listTools("/mcp/readonly")];
    expect(readonly.length).toBeLessThan(full.length);
    for (const name of readonly) expect(full).toContain(name);
  });

  // Guard against silent drift: a new tool whose name matches no known verb
  // convention would be classified by accident. Failing here forces whoever
  // adds it to decide which profile it belongs to.
  it("classifies every registered tool under a recognised naming convention", () => {
    const KNOWN_READ = /^(get_|list_|search_|find_|compare_|audit_)/;
    const KNOWN_OTHER = /^(download_|generate_|render_|reconcile_|probe_|debug_|dump_|test_)/;
    const KNOWN_EXACT = new Set(["who_am_i", "grow_who_am_i"]);
    const unclassified = allRegisteredToolNames().filter(
      (n) =>
        !KNOWN_READ.test(n) &&
        !KNOWN_OTHER.test(n) &&
        !KNOWN_EXACT.has(n) &&
        !MUTATING_PREFIXES.some((p) => n.startsWith(p)),
    );
    expect(unclassified).toEqual([]);
  });

  it("isReadOnlyTool agrees with what the endpoint actually serves", async () => {
    const tools = await listTools("/mcp/readonly");
    for (const name of tools) expect(isReadOnlyTool(name)).toBe(true);
  });

  it("still rejects unauthenticated calls on the read-only endpoint", async () => {
    const res = await fetch(`${baseUrl}/mcp/readonly`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 405 for GET and DELETE on the read-only endpoint", async () => {
    const headers = { Authorization: "Bearer test-jwt" };
    expect((await fetch(`${baseUrl}/mcp/readonly`, { headers })).status).toBe(405);
    expect((await fetch(`${baseUrl}/mcp/readonly`, { method: "DELETE", headers })).status).toBe(405);
  });
});
