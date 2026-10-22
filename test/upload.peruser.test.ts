import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// A per-user upload key "kenny-key" resolves to attorney user 42; anything else
// is unknown. The Box layer is mocked so we test the route's per-user wiring.
vi.mock("../src/auth/vault", () => ({
  resolveUploadKey: vi.fn(async (key: string) =>
    key === "kenny-key" ? { userId: "42", email: "kenny@firm.com" } : null
  ),
}));
vi.mock("../src/utils/box", () => ({
  uploadToBox: vi.fn(),
  createBoxFile: vi.fn(),
  uploadToBoxAsUser: vi.fn(async (opts: any) =>
    opts.userId === "42"
      ? { uploaded: true, box_file_id: "999", filename: opts.filename, version: "0" }
      : { uploaded: false, reason: "box-not-connected-for-user" }
  ),
}));

import uploadRouter from "../src/routes/upload";
import { uploadToBoxAsUser } from "../src/utils/box";

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

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([Buffer.from("hello")], { type: "application/pdf" }), "x.pdf");
  return fd;
}

const KEY = { "X-Upload-Secret": "kenny-key" };

describe("per-user upload key", () => {
  it("/upload create runs as the key's attorney (acted_as=user, target=create)", async () => {
    const r = await fetch(`${base}/upload`, { method: "POST", headers: KEY, body: form({ parent_folder_id: "123" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.acted_as).toBe("user");
    expect(body.file_id).toBe("999");
    expect(uploadToBoxAsUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "42", target: { create: "123" } })
    );
  });

  it("/version runs as the key's attorney (target=version)", async () => {
    const r = await fetch(`${base}/version`, { method: "POST", headers: KEY, body: form({ file_id: "555" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.acted_as).toBe("user");
    expect(uploadToBoxAsUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "42", target: { version: "555" } })
    );
  });

  it("an unknown key → 401", async () => {
    const r = await fetch(`${base}/upload`, {
      method: "POST", headers: { "X-Upload-Secret": "bogus" }, body: form({ parent_folder_id: "123" }),
    });
    expect(r.status).toBe(401);
  });

  it("the retired shared UPLOAD_SECRET no longer authorizes anything", async () => {
    process.env.UPLOAD_SECRET = "old-shared-secret";
    try {
      const r = await fetch(`${base}/upload`, {
        method: "POST", headers: { "X-Upload-Secret": "old-shared-secret" }, body: form({ parent_folder_id: "123" }),
      });
      expect(r.status).toBe(401);
    } finally {
      delete process.env.UPLOAD_SECRET;
    }
  });
});
