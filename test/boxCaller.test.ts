import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";

// Box calls act as the attorney making the request, with their own Box login
// from the vault. These tests run the real Box client (interceptors and all)
// against a fake axios adapter, so no request leaves the process.

const vault = vi.hoisted(() => ({
  tokens: new Map<string, { accessToken: string; refreshToken: string; expiresAt: Date | null }>(),
}));
vi.mock("../src/auth/vault", () => ({
  getBoxTokens: vi.fn(async (userId: string) => vault.tokens.get(userId) ?? null),
  updateBoxTokens: vi.fn(async (userId: string, accessToken: string, refreshToken: string, expiresAt: Date | null) => {
    vault.tokens.set(userId, { accessToken, refreshToken, expiresAt });
  }),
}));
vi.mock("../src/box/auth", () => ({
  refreshBoxTokensRaw: vi.fn(async (refreshToken: string) => ({
    access_token: `fresh-for-${refreshToken}`,
    refresh_token: `next-${refreshToken}`,
    expires_in: 3600,
  })),
}));

import { als } from "../src/auth/identity";
import { updateBoxTokens } from "../src/auth/vault";
import { refreshBoxTokensRaw } from "../src/box/auth";
import { downloadFromBox } from "../src/utils/box";

// Tokens Box will accept; anything else gets a 401.
let validTokens = new Set<string>();
const seenAuth: string[] = [];

const fakeAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const auth = String(config.headers?.Authorization ?? "");
  seenAuth.push(auth);
  const token = auth.replace(/^Bearer /, "");
  const ok = validTokens.has(token);
  const response = {
    data: ok ? Buffer.from(`file-for-${token}`) : { message: "unauthorized" },
    status: ok ? 200 : 401,
    statusText: ok ? "OK" : "Unauthorized",
    headers: {},
    config,
  };
  if (!ok) throw new AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, null, response as any);
  return response as any;
};

let originalAdapter: any;
beforeEach(() => {
  originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = fakeAdapter;
  vault.tokens.clear();
  validTokens = new Set();
  seenAuth.length = 0;
  vi.mocked(refreshBoxTokensRaw).mockClear();
  vi.mocked(updateBoxTokens).mockClear();
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  als.run({ userId, userEmail: `${userId}@firm.com`, accessToken: "", refreshToken: "" }, fn);

describe("Box acts as the calling attorney", () => {
  it("refuses outside an authenticated request", async () => {
    await expect(downloadFromBox("1")).rejects.toThrow(/No user context/);
  });

  it("tells an attorney with no Box login to connect it on /setup", async () => {
    await expect(asUser("u1", () => downloadFromBox("1"))).rejects.toThrow(/connect Box on the platform's \/setup/);
  });

  it("uses each caller's own Box token, never another attorney's", async () => {
    vault.tokens.set("alice", { accessToken: "alice-at", refreshToken: "alice-rt", expiresAt: null });
    vault.tokens.set("bob", { accessToken: "bob-at", refreshToken: "bob-rt", expiresAt: null });
    validTokens = new Set(["alice-at", "bob-at"]);

    const a = await asUser("alice", () => downloadFromBox("1"));
    const b = await asUser("bob", () => downloadFromBox("1"));

    expect(a.toString()).toBe("file-for-alice-at");
    expect(b.toString()).toBe("file-for-bob-at");
    expect(seenAuth).toEqual(["Bearer alice-at", "Bearer bob-at"]);
  });

  it("on a 401, refreshes once, writes the rotated pair back to the vault, and retries", async () => {
    vault.tokens.set("alice", { accessToken: "expired", refreshToken: "rt1", expiresAt: null });
    validTokens = new Set(["fresh-for-rt1"]);

    const out = await asUser("alice", () => downloadFromBox("1"));

    expect(out.toString()).toBe("file-for-fresh-for-rt1");
    expect(refreshBoxTokensRaw).toHaveBeenCalledTimes(1);
    expect(refreshBoxTokensRaw).toHaveBeenCalledWith("rt1");
    expect(updateBoxTokens).toHaveBeenCalledWith("alice", "fresh-for-rt1", "next-rt1", expect.any(Date));
    expect(vault.tokens.get("alice")?.refreshToken).toBe("next-rt1");
  });

  it("spends a single-use refresh token once when one attorney's calls 401 together", async () => {
    vault.tokens.set("alice", { accessToken: "expired", refreshToken: "rt1", expiresAt: null });
    validTokens = new Set(["fresh-for-rt1"]);

    const results = await asUser("alice", () =>
      Promise.all([downloadFromBox("1"), downloadFromBox("2"), downloadFromBox("3")]),
    );

    expect(results.map(String)).toEqual(Array(3).fill("file-for-fresh-for-rt1"));
    expect(refreshBoxTokensRaw).toHaveBeenCalledTimes(1);
  });

  it("uses a pair the platform already rotated instead of spending a stale refresh token", async () => {
    vault.tokens.set("alice", { accessToken: "expired", refreshToken: "rt-old", expiresAt: null });
    validTokens = new Set(["rotated-at"]);

    const out = await asUser("alice", async () => {
      // The request reads "expired"; before the 401 comes back, the platform
      // rotates the pair in the vault.
      const pending = downloadFromBox("1");
      vault.tokens.set("alice", { accessToken: "rotated-at", refreshToken: "rt-new", expiresAt: null });
      return pending;
    });

    expect(out.toString()).toBe("file-for-rotated-at");
    expect(refreshBoxTokensRaw).not.toHaveBeenCalled();
  });
});
