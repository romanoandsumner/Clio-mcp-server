import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from "axios";
import FormData from "form-data";
import { als } from "../auth/identity";
import { getBoxTokens, updateBoxTokens } from "../auth/vault";
import { refreshBoxTokensRaw } from "./auth";

const BOX_API_BASE = "https://api.box.com/2.0";
const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";

export interface BoxFileMetadata {
  id: string;
  name: string;
  size: number;
  sha1: string;
  // Box's version sequence number for the file (e.g. "0" for a brand-new file,
  // bumped on each new version). Returned on every file object; surfaced so the
  // /upload route can report which version it just wrote.
  etag?: string;
  parent?: { id: string; name: string };
}

// ───── Whose Box account ─────
// Box calls act as the attorney making the /mcp request, with the Box login
// they connected on the platform's /setup page, read from the encrypted vault
// -- the same model as Clio. There is no shared Box login: the server used to
// keep one person's Box tokens in memory and in a plaintext Railway variable
// and act as them for everyone.

interface BoxSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

async function callerBoxSession(): Promise<BoxSession> {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error("No user context: Box access is only available inside an authenticated /mcp request.");
  }
  const tokens = await getBoxTokens(ctx.userId);
  if (!tokens) {
    throw new Error("Box is not connected for your account — connect Box on the platform's /setup page.");
  }
  return { userId: ctx.userId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

// Box refresh tokens are single-use, so two concurrent refreshes for one user
// would burn each other's token. One in-flight refresh per user; callers that
// arrive meanwhile share its result.
const refreshLocks = new Map<string, Promise<string>>();

async function refreshSession(session: BoxSession): Promise<string> {
  const pending = refreshLocks.get(session.userId);
  if (pending) {
    // The retry goes back through the request interceptor, which stamps
    // session.accessToken -- so a waiter must adopt the new token too, or it
    // retries with the expired one.
    session.accessToken = await pending;
    return session.accessToken;
  }

  const promise = (async () => {
    // The platform, or another replica, may have rotated the pair since this
    // session read it. Re-read first: a newer access token means there is
    // nothing to spend, and an older refresh token would already be burned.
    const latest = await getBoxTokens(session.userId);
    if (latest && latest.accessToken !== session.accessToken) {
      session.accessToken = latest.accessToken;
      session.refreshToken = latest.refreshToken;
      return latest.accessToken;
    }
    const refreshToken = latest?.refreshToken ?? session.refreshToken;
    const refreshed = await refreshBoxTokensRaw(refreshToken);
    const nextRefresh = refreshed.refresh_token ?? refreshToken;
    const expiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null;
    await updateBoxTokens(session.userId, refreshed.access_token, nextRefresh, expiresAt);
    session.accessToken = refreshed.access_token;
    session.refreshToken = nextRefresh;
    return refreshed.access_token;
  })();

  refreshLocks.set(session.userId, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(session.userId);
  }
}

function attachInterceptors(client: AxiosInstance, session: BoxSession): void {
  client.interceptors.request.use((config) => {
    config.headers.Authorization = `Bearer ${session.accessToken}`;
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };
      const status = error.response?.status;
      const method = (error.config?.method || "?").toUpperCase();
      const url = error.config?.url || "?";

      if (status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;
        console.log(`[Box] 401 — refreshing access token for user ${session.userId} (${method} ${url})`);
        try {
          const newToken = await refreshSession(session);
          originalRequest.headers = {
            ...originalRequest.headers,
            Authorization: `Bearer ${newToken}`,
          };
          return client(originalRequest);
        } catch (refreshErr: any) {
          console.error(
            `[Box] token refresh FAILED for user ${session.userId}: ${refreshErr?.message ?? "unknown"}`,
          );
          throw error;
        }
      }
      if (status === 429) {
        const retryAfter = parseInt(error.response?.headers["retry-after"] ?? "5", 10);
        console.warn(`[Box] 429 rate-limited ${method} ${url} — retrying after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return client(originalRequest);
      }

      // Log Box's error body on other 4xx/5xx so upstream callers can see
      // the actual cause rather than just an opaque axios error.
      if (status && status >= 400) {
        const body = error.response?.data;
        let bodyStr: string;
        if (body === null || body === undefined) {
          bodyStr = "<empty>";
        } else if (typeof body === "string") {
          bodyStr = body;
        } else if (Buffer.isBuffer(body)) {
          bodyStr = "<binary>";
        } else {
          try { bodyStr = JSON.stringify(body); } catch { bodyStr = "<unserializable>"; }
        }
        console.error(
          `[Box] HTTP ${status} ${method} ${url} — body=${bodyStr.slice(0, 500)}`,
        );
      }
      throw error;
    }
  );
}

async function createUploadClient(): Promise<AxiosInstance> {
  const client = axios.create({
    baseURL: BOX_UPLOAD_BASE,
    timeout: 300000,
  });
  attachInterceptors(client, await callerBoxSession());
  return client;
}

async function createApiClient(): Promise<AxiosInstance> {
  const client = axios.create({
    baseURL: BOX_API_BASE,
    timeout: 300000,
  });
  attachInterceptors(client, await callerBoxSession());
  return client;
}

export async function boxUploadFile(
  fileBuffer: Buffer,
  fileName: string,
  parentFolderId: string
): Promise<BoxFileMetadata> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({
    name: fileName,
    parent: { id: parentFolderId },
  }));
  form.append("file", fileBuffer, { filename: fileName });

  const client = await createUploadClient();
  const response = await client.post("/files/content", form, {
    headers: form.getHeaders(),
  });

  return response.data.entries[0];
}

export async function boxUploadNewVersion(
  fileBuffer: Buffer,
  fileName: string,
  fileId: string
): Promise<BoxFileMetadata> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({ name: fileName }));
  form.append("file", fileBuffer, { filename: fileName });

  const client = await createUploadClient();
  const response = await client.post(`/files/${fileId}/content`, form, {
    headers: form.getHeaders(),
  });

  return response.data.entries[0];
}

// ───── Explicit-token uploads (vault-backed per-user path) ─────
// These take a Box access token directly instead of pulling it from the local
// token store, so callers can upload as a specific attorney using that user's
// Box token read from the platform vault. Errors propagate with err.response
// (incl. status) so the caller can detect 401 and refresh.

export async function boxUploadFileWithToken(
  fileBuffer: Buffer,
  fileName: string,
  parentFolderId: string,
  accessToken: string
): Promise<BoxFileMetadata> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({ name: fileName, parent: { id: parentFolderId } }));
  form.append("file", fileBuffer, { filename: fileName });
  const response = await axios.post(`${BOX_UPLOAD_BASE}/files/content`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` },
    timeout: 300000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return response.data.entries[0];
}

export async function boxUploadNewVersionWithToken(
  fileBuffer: Buffer,
  fileName: string,
  fileId: string,
  accessToken: string
): Promise<BoxFileMetadata> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({ name: fileName }));
  form.append("file", fileBuffer, { filename: fileName });
  const response = await axios.post(`${BOX_UPLOAD_BASE}/files/${fileId}/content`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` },
    timeout: 300000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return response.data.entries[0];
}

export async function boxDownloadFile(fileId: string): Promise<Buffer> {
  const client = await createApiClient();
  const response = await client.get(`/files/${fileId}/content`, {
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
}

/**
 * Permanently delete a file by ID. Used to clean up orphan uploads when
 * boxUploadFile unexpectedly creates a new file (instead of hitting the
 * expected 409 conflict we use as a lookup mechanism).
 */
export async function boxDeleteFile(fileId: string): Promise<void> {
  const client = await createApiClient();
  await client.delete(`/files/${fileId}`);
}

/**
 * Find a file by exact name within a folder. Returns its id, or null if absent.
 * Pages through the folder's items (handles folders with >1000 entries).
 */
export async function boxFindFileInFolder(
  folderId: string,
  fileName: string,
): Promise<string | null> {
  const client = await createApiClient();
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const resp = await client.get(`/folders/${folderId}/items`, {
      params: { fields: "id,name,type", limit, offset },
    });
    const entries: any[] = resp.data?.entries ?? [];
    for (const e of entries) {
      if (e.type === "file" && e.name === fileName) return String(e.id);
    }
    const total = resp.data?.total_count ?? entries.length;
    if (offset + entries.length >= total || entries.length === 0) break;
  }
  return null;
}
