import https from "https";
import { ENV } from "../utils/env";
import { getAccessToken } from "../utils/tokenStore";
import { getContext } from "../auth/identity";
import { getGrowTokens } from "../auth/vault";
import { refreshAccessToken } from "./auth";
import { refreshGrowAccessToken } from "./growAuth";
import { withBackoff } from "./rateLimit";
import {
  buildQueryString,
  assertActingClioIdentity,
  formatClioWriteLog,
} from "./pagination";

// HTTP layer for the Clio Grow API v2 (docs/clio-grow-api-reference.md).
// Grow is a separate host from Manage v4 (api.clio.com/grow vs app.clio.com/api/v4).
// Token resolution is two-tier: if the attorney has connected the Clio Platform
// (Grow) app — per-user tokens in the vault under provider 'clio_grow', lazily
// loaded once per request — those are used and refreshed via the Grow OAuth
// app; otherwise Grow calls fall back to the Manage token (in case the account
// honors it via unified login). 429 backoff is shared with Manage.
// Grow has no `fields`/`order`/`limit` params — lists paginate purely via
// `page_token` cursors surfaced as absolute `meta.paging.next` URLs.

export type GrowTokenSource = "grow_oauth" | "manage_fallback";

/**
 * Resolve the bearer token for a Grow call. First Grow call in a request
 * loads the 'clio_grow' vault row into the context (growTokensLoaded guards
 * repeat reads, including the no-row case).
 */
export async function resolveGrowBearer(): Promise<{ token: string; source: GrowTokenSource }> {
  const ctx = getContext();
  if (!ctx) {
    throw new Error("No user context: Grow access is only available inside an authenticated /mcp request.");
  }
  if (!ctx.growTokensLoaded) {
    ctx.growTokensLoaded = true;
    try {
      const tokens = await getGrowTokens(ctx.userId);
      if (tokens) {
        ctx.growAccessToken = tokens.accessToken;
        ctx.growRefreshToken = tokens.refreshToken;
      }
    } catch (err: any) {
      // A vault read failure shouldn't kill the request — fall back to Manage.
      console.error("[grow] failed to read Grow tokens, falling back to Manage token:", err?.message ?? err);
    }
  }
  if (ctx.growAccessToken) return { token: ctx.growAccessToken, source: "grow_oauth" };
  return { token: getAccessToken(), source: "manage_fallback" };
}

function growRequest(
  method: "GET" | "POST" | "DELETE",
  fullUrl: string,
  token: string,
  body?: any,
  redirectsLeft = 3
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const path = fullUrl.slice(fullUrl.indexOf(parsed.pathname));
    const data = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string | number> = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (data !== undefined) headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(
      { hostname: parsed.hostname, port: 443, path, method, headers },
      (res) => {
        const status = res.statusCode ?? 0;

        // Redirects: some Grow endpoints canonicalize their path (e.g. a
        // trailing-slash 301/302). Follow SAME-HOST redirects transparently,
        // reusing the bearer. A CROSS-HOST redirect (e.g. to the auth host for
        // a step-up/insufficient-scope challenge) is NOT followed — forwarding
        // the bearer off-host would leak it — and is surfaced with its Location
        // so the cause (usually a missing scope) is diagnosable.
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume(); // drain the socket
          const loc = res.headers.location;
          if (!loc) {
            const err: any = new Error(`Redirect (${status}) with no Location header`);
            err.response = { status, data: {}, headers: res.headers };
            return reject(err);
          }
          if (redirectsLeft <= 0) {
            const err: any = new Error(`Too many redirects following ${fullUrl}`);
            err.response = { status, data: {}, headers: res.headers };
            return reject(err);
          }
          const target = new URL(loc, fullUrl);
          if (target.hostname === parsed.hostname) {
            // 303 (and legacy 302 on non-GET) → GET without a body; 307/308 keep method+body.
            const nextMethod = status === 303 ? "GET" : method;
            const nextBody = nextMethod === "GET" ? undefined : body;
            return resolve(growRequest(nextMethod, target.toString(), token, nextBody, redirectsLeft - 1));
          }
          const err: any = new Error(
            `Grow API redirected off-host (${status}) to ${target.origin}${target.pathname} — ` +
              `not followed (would leak the token). This usually means the endpoint requires a scope the ` +
              `token lacks; add the matching grow_* scope to the app and GROW_OAUTH_SCOPE, then reconnect.`
          );
          err.response = { status, data: {}, headers: res.headers, redirectLocation: loc };
          return reject(err);
        }

        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          try {
            const json = responseBody ? JSON.parse(responseBody) : {};
            if (status >= 200 && status < 300) {
              resolve(json);
            } else {
              const err: any = new Error(`Request failed with status code ${status}`);
              err.response = { status, data: json, headers: res.headers };
              reject(err);
            }
          } catch {
            const err: any = new Error(
              `Request failed with status ${status}: ${responseBody.slice(0, 200)}`
            );
            err.response = { status, data: responseBody.slice(0, 500), headers: res.headers };
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function growBaseUrl(): string {
  return ENV.GROW_API_BASE_URL.replace(/\/$/, "");
}

/**
 * Run a Grow request with the resolved bearer; on 401, refresh whichever
 * token was actually used (Grow OAuth pair vs Manage token) and retry once.
 */
async function withAuthRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
  return withBackoff(async () => {
    const bearer = await resolveGrowBearer();
    try {
      return await fn(bearer.token);
    } catch (err: any) {
      if (err.response?.status === 401) {
        const fresh =
          bearer.source === "grow_oauth"
            ? await refreshGrowAccessToken()
            : await refreshAccessToken();
        return await fn(fresh);
      }
      throw err;
    }
  });
}

/** GET a single Grow resource. Returns the full JSON body ({ data: ... }). */
export async function growGetSingle(
  url: string,
  params: Record<string, any> = {}
): Promise<any> {
  const qs = buildQueryString(params);
  const fullUrl = qs ? `${growBaseUrl()}${url}?${qs}` : `${growBaseUrl()}${url}`;
  return withAuthRetry((token) => growRequest("GET", fullUrl, token));
}

/**
 * Fetch all pages of a Grow list endpoint by following meta.paging.next
 * (absolute URLs). Stops early at maxResults when provided.
 */
export async function growFetchAllPages<T>(
  url: string,
  params: Record<string, any> = {},
  maxResults?: number
): Promise<T[]> {
  const results: T[] = [];
  const qs = buildQueryString(params);
  let nextUrl: string | undefined = qs
    ? `${growBaseUrl()}${url}?${qs}`
    : `${growBaseUrl()}${url}`;

  while (nextUrl) {
    const data = await withAuthRetry((token) => growRequest("GET", nextUrl!, token));
    results.push(...(data.data ?? []));
    if (maxResults && results.length >= maxResults) {
      return results.slice(0, maxResults);
    }
    nextUrl = data.meta?.paging?.next ?? undefined;
  }

  return results;
}

/**
 * growFetchAllPages with an exact truncation signal: overfetches one row past
 * `maxResults` so the caller can tell "there were exactly this many" from
 * "there are more". A caller that can't distinguish those silently reports a
 * partial list as complete. `maxResults` undefined means every page.
 */
export async function growFetchCapped<T>(
  url: string,
  params: Record<string, any> = {},
  maxResults?: number
): Promise<{ rows: T[]; truncated: boolean }> {
  if (maxResults === undefined) {
    return { rows: await growFetchAllPages<T>(url, params), truncated: false };
  }
  const rows = await growFetchAllPages<T>(url, params, maxResults + 1);
  return rows.length > maxResults
    ? { rows: rows.slice(0, maxResults), truncated: true }
    : { rows, truncated: false };
}

function logGrowWrite(method: string, path: string, outcome: string): void {
  const ctx = getContext();
  console.log(formatClioWriteLog(method, `grow:${path}`, ctx?.userEmail, ctx?.clioIdentity, outcome));
}

/** POST to Grow. Payloads are envelope-wrapped by the caller ({ data: {...} }). */
export async function growPostSingle(url: string, body: any): Promise<any> {
  await assertActingClioIdentity();
  const fullUrl = `${growBaseUrl()}${url}`;
  try {
    const result = await withAuthRetry((token) => growRequest("POST", fullUrl, token, body));
    const createdId = result?.data?.id;
    logGrowWrite("POST", url, createdId != null ? `ok id=${createdId}` : "ok");
    return result;
  } catch (err: any) {
    logGrowWrite("POST", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}

/** DELETE a Grow resource. */
export async function growDeleteSingle(url: string): Promise<any> {
  await assertActingClioIdentity();
  const fullUrl = `${growBaseUrl()}${url}`;
  try {
    const result = await withAuthRetry((token) => growRequest("DELETE", fullUrl, token));
    logGrowWrite("DELETE", url, "ok");
    return result;
  } catch (err: any) {
    logGrowWrite("DELETE", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}
