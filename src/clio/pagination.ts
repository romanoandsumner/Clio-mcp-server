import { ENV } from "../utils/env";
import { getAccessToken } from "../utils/tokenStore";
import { getContext } from "../auth/identity";
import { refreshAccessToken } from "./auth";
import { withBackoff } from "./rateLimit";
import https from "https";

/**
 * Build a query string preserving Clio field syntax (curly braces, commas).
 */
export function buildQueryString(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // Encode then restore { } , as literal chars — Clio requires these unencoded
    // (Clio's own pagination URLs use %7B/%7D but initial requests need literal braces)
    const encoded = encodeURIComponent(String(value))
      .replace(/%7B/gi, "{")
      .replace(/%7D/gi, "}")
      .replace(/%2C/gi, ",");
    parts.push(`${encodeURIComponent(key)}=${encoded}`);
  }
  return parts.join("&");
}

const RAW_GET_IDLE_TIMEOUT_MS = 30_000;

/**
 * Make a raw HTTPS GET request, bypassing axios entirely.
 * Axios mangles curly braces in URLs which breaks Clio field syntax.
 */
function rawGet(fullUrl: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const path = fullUrl.slice(fullUrl.indexOf(parsed.pathname));

    // No safety assertion needed — rawGet sends URLs as-is via https.request

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err: any = new Error(`Request failed with status code ${res.statusCode}`);
            err.response = { status: res.statusCode, data: parsed, headers: res.headers };
            reject(err);
          }
        } catch (parseErr) {
          const err: any = new Error(`Request failed with status ${res.statusCode}: ${body.slice(0, 200)}`);
          err.response = { status: res.statusCode, data: body.slice(0, 500), headers: res.headers };
          reject(err);
        }
      });
    });

    // Idle (socket-inactivity) timeout, not a total-duration cap: a response
    // that keeps streaming is never cut off, but a connection that goes silent
    // fails with a clear error instead of hanging until the MCP client gives up.
    req.setTimeout(RAW_GET_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Clio GET timed out after ${RAW_GET_IDLE_TIMEOUT_MS / 1000}s of inactivity: ${parsed.pathname}`));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch all pages from a Clio API endpoint.
 * Uses raw HTTPS to avoid axios mangling curly braces in field syntax.
 */
export async function fetchAllPages<T>(
  url: string,
  params: Record<string, any> = {},
  maxResults?: number
): Promise<T[]> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const results: T[] = [];

  // Build initial URL — use order=id(asc) for unlimited cursor pagination
  // unless the caller specifies their own order (which falls back to offset pagination)
  const allParams = { order: "id(asc)", ...params, limit: 200 };
  const qs = buildQueryString(allParams);
  let nextUrl: string | undefined = `${baseUrl}${url}?${qs}`;

  while (nextUrl) {
    const data = await withBackoff(async () => {
      try {
        return await rawGet(nextUrl!);
      } catch (err: any) {
        if (err.response?.status === 401) {
          await refreshAccessToken();
          return await rawGet(nextUrl!);
        }
        throw err;
      }
    });

    const items = data.data ?? [];
    results.push(...items);

    // Stop early if we've hit the max results cap
    if (maxResults && results.length >= maxResults) {
      return results.slice(0, maxResults);
    }

    // Follow Clio's next URL directly (cursor pagination)
    nextUrl = data.meta?.paging?.next ?? undefined;
  }

  return results;
}

/**
 * Fetch a single resource from Clio (non-paginated).
 * Uses raw HTTPS like fetchAllPages. Returns the full JSON body.
 */
export async function rawGetSingle(
  url: string,
  params: Record<string, any> = {}
): Promise<any> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const qs = buildQueryString(params);
  const fullUrl = qs ? `${baseUrl}${url}?${qs}` : `${baseUrl}${url}`;

  return withBackoff(async () => {
    try {
      return await rawGet(fullUrl);
    } catch (err: any) {
      if (err.response?.status === 401) {
        await refreshAccessToken();
        return await rawGet(fullUrl);
      }
      throw err;
    }
  });
}

// =====================================================================
// Identity guard — make sure the Clio token actually belongs to the
// signed-in attorney before any WRITE, so a misprovisioned token (e.g. a
// user's vault row holding someone else's Clio tokens) can't silently
// record actions under the wrong person. Clio attributes a created object
// to the token owner, so the only defense is verifying the token owner.
// =====================================================================

export class IdentityMismatchError extends Error {
  constructor(public readonly msEmail: string, public readonly clioEmail: string) {
    super(
      `Your Clio connection belongs to ${clioEmail}, but you signed in as ${msEmail}. ` +
        `No action was taken — reconnect Clio on the platform /setup so actions are recorded under your own account.`
    );
    this.name = "IdentityMismatchError";
  }
}

/** Pure mismatch check (unit-testable). Unknown/missing emails → not a mismatch (fail-open). */
export function isIdentityMismatch(msEmail: string | undefined, clioEmail: string | undefined): boolean {
  const a = (msEmail ?? "").trim().toLowerCase();
  const b = (clioEmail ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a !== b;
}

/** Resolve + cache the acting attorney's Clio identity (who_am_i) for this request. */
export async function getActingClioIdentity(): Promise<{ id: number; email: string; name: string }> {
  const ctx = getContext();
  if (!ctx) {
    throw new Error("No user context: Clio identity is only available inside an authenticated /mcp request.");
  }
  if (ctx.clioIdentity) return ctx.clioIdentity;
  const me = await rawGetSingle("/users/who_am_i", { fields: "id,name,email" });
  const u = me?.data ?? me;
  const identity = {
    id: Number(u?.id),
    email: String(u?.email ?? "").trim().toLowerCase(),
    name: String(u?.name ?? ""),
  };
  ctx.clioIdentity = identity;
  if (Number.isFinite(identity.id)) ctx.clioUserId = identity.id;
  return identity;
}

/**
 * Block a WRITE when the Clio token owner doesn't match the signed-in attorney.
 * Fail-OPEN: any inability to verify (no context, who_am_i error, missing
 * email) lets the write proceed — the guard only ever blocks on a CONFIRMED
 * email mismatch. Disable entirely with DISABLE_CLIO_IDENTITY_GUARD=true.
 */
export async function assertActingClioIdentity(): Promise<void> {
  if (process.env.DISABLE_CLIO_IDENTITY_GUARD === "true") return;
  const ctx = getContext();
  if (!ctx || !ctx.userEmail) return; // no signed-in identity to compare against
  let clioEmail: string;
  try {
    clioEmail = (await getActingClioIdentity()).email;
  } catch (e: any) {
    console.warn(`[identity-guard] verification skipped (who_am_i failed): ${e?.message ?? e}`);
    return; // fail open — never block a write because the check itself failed
  }
  if (isIdentityMismatch(ctx.userEmail, clioEmail)) {
    console.error(`[identity-guard] BLOCKED write: signed-in=${ctx.userEmail.toLowerCase()} clio_token_owner=${clioEmail}`);
    throw new IdentityMismatchError(ctx.userEmail.trim().toLowerCase(), clioEmail);
  }
}

/**
 * One audit line per Clio write, so attribution questions ("who created this
 * contact, under whose Clio token?") are answerable from server logs.
 * clio_user is the resolved token owner from who_am_i — "unverified" when the
 * identity guard failed open — and the created resource id is included on
 * successful POSTs so a specific Clio record can be matched to its log line.
 */
export function formatClioWriteLog(
  method: string,
  path: string,
  signedInEmail: string | undefined,
  clioIdentity: { id: number; email: string } | undefined,
  outcome: string
): string {
  const signedIn = (signedInEmail ?? "").trim().toLowerCase() || "unknown";
  const clioUser = clioIdentity ? `${clioIdentity.id} (${clioIdentity.email})` : "unverified";
  return `[clio-write] ${method} ${path} signed_in=${signedIn} clio_user=${clioUser} outcome=${outcome}`;
}

function logClioWrite(method: string, path: string, outcome: string): void {
  const ctx = getContext();
  console.log(formatClioWriteLog(method, path, ctx?.userEmail, ctx?.clioIdentity, outcome));
}

/**
 * Make a raw HTTPS GET request that returns binary data as a Buffer.
 * Follows 303/302/301 redirects (Clio redirects file downloads to S3).
 * Strips Authorization header on redirect since S3 doesn't need it.
 */
function rawGetBinary(
  fullUrl: string,
  extraHeaders?: Record<string, string>
): Promise<{ buffer: Buffer; contentType: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const path = fullUrl.slice(fullUrl.indexOf(parsed.pathname));

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      // Follow redirects (Clio sends 303 to S3 signed URLs for file downloads)
      if (res.statusCode === 303 || res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) return reject(new Error("No redirect URL in response"));

        // Follow redirect — no Authorization header needed for S3
        https.get(redirectUrl, (res2) => {
          const chunks: Buffer[] = [];
          res2.on("data", (chunk: Buffer) => chunks.push(chunk));
          res2.on("end", () => {
            const buffer = Buffer.concat(chunks);
            if (res2.statusCode && res2.statusCode >= 200 && res2.statusCode < 300) {
              resolve({
                buffer,
                contentType: res2.headers["content-type"] || "application/octet-stream",
                statusCode: res2.statusCode,
              });
            } else {
              const err: any = new Error(`Download failed with status ${res2.statusCode}`);
              err.response = { status: res2.statusCode, data: buffer.toString("utf8").slice(0, 500) };
              reject(err);
            }
          });
        }).on("error", reject);
      } else if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        // Direct binary response
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers["content-type"] || "application/octet-stream",
            statusCode: res.statusCode!,
          });
        });
      } else {
        // Error response — collect as string for the error message
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          const err: any = new Error(`Request failed with status code ${res.statusCode}`);
          err.response = { status: res.statusCode, data: body.slice(0, 500), headers: res.headers };
          reject(err);
        });
      }
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * GET an absolute URL and return binary content, following up to `redirectsLeft`
 * redirects. NO Authorization header is sent — the download URLs Clio hands back
 * (e.g. for asynchronously generated bill PDFs) are presigned S3-style links,
 * and S3 rejects requests that carry both a bearer header and signed query params.
 */
export function rawGetBinaryFromUrl(
  fullUrl: string,
  redirectsLeft = 5
): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    https.get(fullUrl, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume(); // discard body so the socket is freed
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`Redirect (${status}) without Location header`));
        if (redirectsLeft <= 0) return reject(new Error("Too many redirects following download URL"));
        resolve(rawGetBinaryFromUrl(new URL(loc, fullUrl).toString(), redirectsLeft - 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (status >= 200 && status < 300) {
          resolve({ buffer, contentType: res.headers["content-type"] || "application/octet-stream" });
        } else {
          const err: any = new Error(`Download failed with status ${status}`);
          err.response = { status, data: buffer.toString("utf8").slice(0, 500) };
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

/**
 * Fetch a single binary resource from Clio (e.g. bill PDF).
 * Handles auth refresh on 401 and rate-limit backoff.
 */
export async function rawGetBinarySingle(
  url: string,
  params: Record<string, any> = {},
  extraHeaders?: Record<string, string>
): Promise<{ buffer: Buffer; contentType: string }> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const qs = buildQueryString(params);
  const fullUrl = qs ? `${baseUrl}${url}?${qs}` : `${baseUrl}${url}`;

  return withBackoff(async () => {
    try {
      return await rawGetBinary(fullUrl, extraHeaders);
    } catch (err: any) {
      if (err.response?.status === 401) {
        await refreshAccessToken();
        return await rawGetBinary(fullUrl, extraHeaders);
      }
      throw err;
    }
  });
}

/**
 * Make a raw HTTPS POST request, bypassing axios entirely.
 */
function rawPost(fullUrl: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const data = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        try {
          const parsed = responseBody ? JSON.parse(responseBody) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err: any = new Error(`Request failed with status code ${res.statusCode}`);
            err.response = { status: res.statusCode, data: parsed, headers: res.headers };
            reject(err);
          }
        } catch (parseErr) {
          const err: any = new Error(`Request failed with status ${res.statusCode}: ${responseBody.slice(0, 200)}`);
          err.response = { status: res.statusCode, data: responseBody.slice(0, 500), headers: res.headers };
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * POST a resource to Clio. Returns the full JSON response body.
 */
export async function rawPostSingle(
  url: string,
  body: any
): Promise<any> {
  await assertActingClioIdentity();
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const fullUrl = `${baseUrl}${url}`;

  try {
    const result = await withBackoff(async () => {
      try {
        return await rawPost(fullUrl, body);
      } catch (err: any) {
        if (err.response?.status === 401) {
          await refreshAccessToken();
          return await rawPost(fullUrl, body);
        }
        throw err;
      }
    });
    const createdId = result?.data?.id;
    logClioWrite("POST", url, createdId != null ? `ok id=${createdId}` : "ok");
    return result;
  } catch (err: any) {
    logClioWrite("POST", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}

/**
 * Make a raw HTTPS PATCH request, bypassing axios entirely.
 */
function rawPatch(fullUrl: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const data = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        try {
          const parsed = responseBody ? JSON.parse(responseBody) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err: any = new Error(`Request failed with status code ${res.statusCode}`);
            err.response = { status: res.statusCode, data: parsed, headers: res.headers };
            reject(err);
          }
        } catch (parseErr) {
          const err: any = new Error(`Request failed with status ${res.statusCode}: ${responseBody.slice(0, 200)}`);
          err.response = { status: res.statusCode, data: responseBody.slice(0, 500), headers: res.headers };
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * PATCH a resource in Clio. Returns the full JSON response body.
 */
export async function rawPatchSingle(
  url: string,
  body: any
): Promise<any> {
  await assertActingClioIdentity();
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const fullUrl = `${baseUrl}${url}`;

  try {
    const result = await withBackoff(async () => {
      try {
        return await rawPatch(fullUrl, body);
      } catch (err: any) {
        if (err.response?.status === 401) {
          await refreshAccessToken();
          return await rawPatch(fullUrl, body);
        }
        throw err;
      }
    });
    logClioWrite("PATCH", url, "ok");
    return result;
  } catch (err: any) {
    logClioWrite("PATCH", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}

/**
 * Make a raw HTTPS DELETE request, bypassing axios entirely.
 */
function rawHttpDelete(fullUrl: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const path = fullUrl.slice(fullUrl.indexOf(parsed.pathname));

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path,
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err: any = new Error(`Request failed with status code ${res.statusCode}`);
            err.response = { status: res.statusCode, data: parsed, headers: res.headers };
            reject(err);
          }
        } catch (parseErr) {
          const err: any = new Error(`Request failed with status ${res.statusCode}: ${body.slice(0, 200)}`);
          err.response = { status: res.statusCode, data: body.slice(0, 500), headers: res.headers };
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * DELETE a resource in Clio. Returns the full JSON response body (usually empty).
 */
export async function rawDeleteSingle(url: string): Promise<any> {
  await assertActingClioIdentity();
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const fullUrl = `${baseUrl}${url}`;

  try {
    const result = await withBackoff(async () => {
      try {
        return await rawHttpDelete(fullUrl);
      } catch (err: any) {
        if (err.response?.status === 401) {
          await refreshAccessToken();
          return await rawHttpDelete(fullUrl);
        }
        throw err;
      }
    });
    logClioWrite("DELETE", url, "ok");
    return result;
  } catch (err: any) {
    logClioWrite("DELETE", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}

/**
 * Download a Clio report by following the 303 redirect to S3.
 * Returns the raw file content (CSV, HTML, PDF as string).
 */
export async function downloadReport(reportId: number): Promise<string> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const downloadUrl = `${baseUrl}/reports/${reportId}/download`;

  return withBackoff(async () => {
    return new Promise<string>((resolve, reject) => {
      const parsed = new URL(downloadUrl);
      const options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: "GET",
        headers: {
          "Authorization": `Bearer ${getAccessToken()}`,
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 303 || res.statusCode === 302 || res.statusCode === 301) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error("No redirect URL in 303 response"));

          // Follow redirect to S3
          https.get(redirectUrl, (res2) => {
            let body = "";
            res2.on("data", (chunk) => (body += chunk));
            res2.on("end", () => {
              if (res2.statusCode && res2.statusCode >= 200 && res2.statusCode < 300) {
                resolve(body);
              } else {
                reject(new Error(`S3 download failed with status ${res2.statusCode}`));
              }
            });
          }).on("error", reject);
        } else if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          // Direct response (unlikely but handle it)
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        } else {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const err: any = new Error(`Report download failed with status ${res.statusCode}`);
            err.response = { status: res.statusCode, data: body.slice(0, 500) };
            reject(err);
          });
        }
      });

      req.on("error", reject);
      req.end();
    });
  });
}
