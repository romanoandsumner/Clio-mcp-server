import { describe, it, expect, vi } from "vitest";
import { globalRegistry } from "zod/v4";

// auth/microsoft builds a remote JWKS at import time from strict env vars.
vi.mock("../src/auth/microsoft", () => ({
  AuthError: class AuthError extends Error {},
  verifyMicrosoftToken: async () => {
    throw new Error("unused");
  },
  isEmailAllowed: () => false,
}));

import { createMcpServer } from "../src/app";

// Regression for the 2026-11-10 production crash ("JavaScript heap out of
// memory" after ~4h). A fresh McpServer is built for every POST /mcp; the tool
// modules used to rebuild every zod schema each time, and zod/v4's
// `.describe()` stores each schema in the process-global `globalRegistry`,
// which holds them strongly. Every request therefore pinned ~10 MB for good.
// The registry size is the deterministic signal: it must not move once a
// profile's tool surface has been built.
const registrySize = (): number => (globalRegistry as unknown as { _map: Map<unknown, unknown> })._map.size;
const toolNames = (server: unknown): string[] =>
  Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools).sort();

describe("createMcpServer does not leak per request", () => {
  it.each(["full", "readonly"] as const)("builds the %s tool schemas only once", (profile) => {
    const first = createMcpServer(profile);
    const before = registrySize();
    expect(before).toBeGreaterThan(0);

    let last = first;
    for (let i = 0; i < 25; i++) last = createMcpServer(profile);

    expect(registrySize()).toBe(before);
    // Still a distinct server per request (the stateless-transport fix depends
    // on that), carrying the identical tool surface.
    expect(last).not.toBe(first);
    expect(toolNames(last)).toEqual(toolNames(first));
    expect(toolNames(last).length).toBeGreaterThan(0);
  });

  it("keeps the readonly profile restricted after the full one is cached", () => {
    const full = toolNames(createMcpServer("full"));
    const readonly = toolNames(createMcpServer("readonly"));
    expect(readonly.length).toBeLessThan(full.length);
    expect(readonly).not.toContain("create_time_entry");
    expect(full).toContain("create_time_entry");
  });
});
