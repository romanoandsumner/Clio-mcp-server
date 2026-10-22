import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// "test-secret" is a per-user upload key for attorney user 7, who has not
// connected Box (getBoxTokens → null), so a valid request reaches the Box layer
// and comes back as the not-connected fallback. No DB needed.
vi.mock("../src/auth/vault", () => ({
  resolveUploadKey: vi.fn(async (key: string) =>
    key === "test-secret" ? { userId: "7", email: "someone@firm.com" } : null
  ),
  getBoxTokens: vi.fn(async () => null),
  updateBoxTokens: vi.fn(async () => undefined),
}));

import uploadRouter from "../src/routes/upload";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(uploadRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

function form(fields: Record<string, string>, withFile = true): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (withFile) fd.append("file", new Blob([Buffer.from("hello")], { type: "application/pdf" }), "x.pdf");
  return fd;
}

describe("POST /upload", () => {
  it("401 when secret missing/wrong", async () => {
    const r = await fetch(`${base}/upload`, { method: "POST", body: form({ parent_folder_id: "123" }) });
    expect(r.status).toBe(401);
  });

  it("400 when neither target provided", async () => {
    const r = await fetch(`${base}/upload`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" }, body: form({}),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/exactly one/);
  });

  it("400 when both targets provided", async () => {
    const r = await fetch(`${base}/upload`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" },
      body: form({ overwrite_file_id: "1", parent_folder_id: "2" }),
    });
    expect(r.status).toBe(400);
  });

  it("400 when file part missing", async () => {
    const r = await fetch(`${base}/upload`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" },
      body: form({ parent_folder_id: "123" }, false),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/file/);
  });

  it("valid request reaches Box layer (502 when the attorney has not connected Box)", async () => {
    const r = await fetch(`${base}/upload`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" },
      body: form({ parent_folder_id: "123" }),
    });
    // Auth + parse + validation all passed; the attorney has no Box login in
    // the vault, which the route maps to 502.
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/box-not-connected-for-user/);
  });
});

describe("POST /version", () => {
  it("401 when secret missing/wrong", async () => {
    const r = await fetch(`${base}/version`, { method: "POST", body: form({ file_id: "123" }) });
    expect(r.status).toBe(401);
  });

  it("400 when file_id missing", async () => {
    const r = await fetch(`${base}/version`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" }, body: form({}),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/file_id/);
  });

  it("400 when file part missing", async () => {
    const r = await fetch(`${base}/version`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" },
      body: form({ file_id: "123" }, false),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/file/);
  });

  it("valid request reaches Box layer (502 when the attorney has not connected Box)", async () => {
    const r = await fetch(`${base}/version`, {
      method: "POST", headers: { "X-Upload-Secret": "test-secret" },
      body: form({ file_id: "2310830265427" }),
    });
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/box-not-connected-for-user/);
  });
});
