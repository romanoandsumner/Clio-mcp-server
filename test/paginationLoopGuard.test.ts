import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Fake the wire: each https.request resolves with the JSON body queued for its
// path+query, so the paging loops run for real against scripted `next` links.
const wire = vi.hoisted(() => ({
  respond: (_path: string): unknown => ({}),
  requested: [] as string[],
}));

vi.mock("https", () => {
  const request = (options: { path: string }, cb: (res: any) => void) => {
    const req: any = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => undefined;
    req.destroy = () => undefined;
    req.end = () => {
      wire.requested.push(options.path);
      const res: any = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      queueMicrotask(() => {
        res.emit("data", JSON.stringify(wire.respond(options.path)));
        res.emit("end");
      });
    };
    return req;
  };
  return { default: { request, get: request }, request, get: request };
});

import { als } from "../src/auth/identity";
import { fetchAllPages } from "../src/clio/pagination";
import { createPagingGuard, PaginationLoopError, MAX_PAGES_PER_FETCH } from "../src/clio/pagingGuard";

const ctx = { userEmail: "t@example.com", userId: "u", accessToken: "tok", refreshToken: "" };
const BASE = "https://app.clio.com/api/v4";
const row = (id: number) => ({ id });

beforeEach(() => {
  wire.requested = [];
});

describe("createPagingGuard", () => {
  it("allows distinct URLs and rejects a repeat", () => {
    const guard = createPagingGuard();
    guard.visit("https://x/a?page=1");
    guard.visit("https://x/a?page=2");
    expect(() => guard.visit("https://x/a?page=1")).toThrow(PaginationLoopError);
  });

  it("rejects once the page ceiling is reached", () => {
    const guard = createPagingGuard(3);
    for (let i = 0; i < 3; i++) guard.visit(`https://x/a?page=${i}`);
    expect(() => guard.visit("https://x/a?page=3")).toThrow(/exceeded 3 pages/);
  });

  it("keeps the query string out of the error", () => {
    const guard = createPagingGuard();
    guard.visit("https://x/api/v4/activities?page_token=SECRET");
    let message = "";
    try {
      guard.visit("https://x/api/v4/activities?page_token=SECRET");
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain("/api/v4/activities");
    expect(message).not.toContain("SECRET");
  });

  it("has a ceiling far above any real query", () => {
    expect(MAX_PAGES_PER_FETCH * 200).toBeGreaterThanOrEqual(400_000);
  });
});

describe("fetchAllPages", () => {
  it("still follows a normal chain of next links to the end", async () => {
    wire.respond = (path) => {
      if (path.includes("page_token=b")) return { data: [row(3)], meta: { paging: {} } };
      if (path.includes("page_token=a")) return { data: [row(2)], meta: { paging: { next: `${BASE}/matters?page_token=b` } } };
      return { data: [row(1)], meta: { paging: { next: `${BASE}/matters?page_token=a` } } };
    };
    const rows = await als.run({ ...ctx }, () => fetchAllPages<{ id: number }>("/matters"));
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(wire.requested).toHaveLength(3);
  });

  it("stops with an error when the next link points at itself", async () => {
    wire.respond = () => ({ data: [row(1)], meta: { paging: { next: `${BASE}/matters?page_token=same` } } });
    await expect(als.run({ ...ctx }, () => fetchAllPages("/matters"))).rejects.toThrow(PaginationLoopError);
    // first page + the self-linked page once; the repeat is never requested.
    expect(wire.requested).toHaveLength(2);
  });

  it("stops with an error when the next links cycle", async () => {
    wire.respond = (path) =>
      path.includes("page_token=a")
        ? { data: [row(2)], meta: { paging: { next: `${BASE}/matters?page_token=b` } } }
        : { data: [row(1)], meta: { paging: { next: `${BASE}/matters?page_token=a` } } };
    await expect(als.run({ ...ctx }, () => fetchAllPages("/matters"))).rejects.toThrow(/pagination loop/i);
    expect(wire.requested).toHaveLength(3);
  });
});
