import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// auth/microsoft builds a remote JWKS at import time from strict env vars.
vi.mock("../src/auth/microsoft", () => ({
  AuthError: class AuthError extends Error {},
  verifyMicrosoftToken: async () => {
    throw new Error("unused");
  },
  isEmailAllowed: () => false,
}));

import { createApp, createMcpServer } from "../src/app";
import { CLIO_ICON_PNG } from "../src/branding/clioIcon";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
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

describe("Clio branding", () => {
  it("embeds a valid PNG", () => {
    expect(CLIO_ICON_PNG.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  it.each(["/favicon.ico", "/favicon.png", "/icon.png", "/apple-touch-icon.png"])(
    "serves the Clio icon at %s without auth",
    async (path) => {
      const res = await fetch(baseUrl + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(CLIO_ICON_PNG)).toBe(true);
    },
  );

  it("root page links the favicon", async () => {
    const res = await fetch(baseUrl + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('rel="icon"');
  });

  it("advertises icons in the MCP serverInfo", () => {
    const info = (createMcpServer().server as any)._serverInfo;
    expect(info.title).toBe("Clio");
    expect(info.icons.length).toBeGreaterThan(0);
    expect(info.icons[0].src).toMatch(/\/icon\.png$/);
  });
});
