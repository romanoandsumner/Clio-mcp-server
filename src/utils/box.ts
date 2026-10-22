import { boxUploadFile, boxUploadNewVersion, boxUploadFileWithToken, boxUploadNewVersionWithToken, boxDownloadFile, boxDeleteFile, boxFindFileInFolder } from "../box/client";
import { refreshBoxTokensRaw } from "../box/auth";
import { getBoxTokens, updateBoxTokens } from "../auth/vault";
import { registerDownload, mimeForFilename } from "./downloadStore";

// =====================================================================
// uploadToBox — version-preferred with direct-download fallback.
//
// Upload flow (three paths, in order):
//
//   1. Direct version (only if overwriteFileId supplied):
//        boxUploadNewVersion(overwriteFileId). On 404 (target file was
//        deleted) fall through to step 2; any other error → DL fallback.
//
//   2. 409-lookup version (the primary path for files without a known
//      ID — this is how the old code kept versioning weekly goals etc.):
//        boxUploadFile(...) is called as a PROBE. Box normally responds
//        409 "file with this name already exists, id=X". We extract X
//        from the 409 body and boxUploadNewVersion(X) to version it.
//
//      Edge case: if boxUploadFile unexpectedly SUCCEEDS (filename did
//      not exist — first upload ever), we treat that as "not what we
//      wanted" per the caller's contract, DELETE the orphan via
//      boxDeleteFile, and fall to step 3. We never silently create new
//      files in Box.
//
//   3. Direct-download fallback: register the buffer in the in-process
//      download store (1-hour TTL) and return a /download/:token URL.
//      Used on every genuine failure above, and in the refuse-new-file
//      case.
//
// The prior base64-in-MCP-response fallback is gone entirely — that
// path was responsible for multi-minute client streaming lag.
//
// UploadResult is discriminated by `uploaded`. Callers branch on it.
// =====================================================================

export interface UploadSuccess {
  uploaded: true;
  box_file_id: string;
  box_url: string;
  filename: string;
  size_kb: number;
  elapsed_ms: number;
  via: "direct_version" | "conflict_lookup_version";
  // Box version sequence number (etag) of the file after this upload, when Box
  // returned it. Undefined if Box omitted it from the response.
  version?: string;
}

export interface UploadFallback {
  uploaded: false;
  filename: string;
  size_kb: number;
  direct_download_url: string;
  expires_at: string;
  expires_in_seconds: number;
  reason: string;
  note: string;
}

export type UploadResult = UploadSuccess | UploadFallback;

function fallback(buffer: Buffer, filename: string, reason: string): UploadFallback {
  const reg = registerDownload(buffer, filename, mimeForFilename(filename));
  const size_kb = Math.round(buffer.length / 1024);
  console.warn(
    `[Box] upload fallback — serving direct_download_url filename=${filename} size_kb=${size_kb} reason=${reason}`,
  );
  return {
    uploaded: false,
    filename,
    size_kb,
    direct_download_url: reg.url,
    expires_at: reg.expires_at,
    expires_in_seconds: reg.expires_in_seconds,
    reason,
    note: "Box upload unavailable. Download the file from direct_download_url within 1 hour.",
  };
}

function extractConflictId(err: any): string | null {
  const c = err?.response?.data?.context_info?.conflicts;
  if (!c) return null;
  if (Array.isArray(c) && c[0]?.id) return String(c[0].id);
  if (typeof c === "object" && (c as any).id) return String((c as any).id);
  return null;
}

/**
 * Download a file from Box by its file ID.
 */
export async function downloadFromBox(fileId: string): Promise<Buffer> {
  return boxDownloadFile(fileId);
}

/**
 * Look up a file id by exact name within a folder (null if not present).
 * Use before uploadToBox/createBoxFile to decide version-vs-create and to
 * download prior contents.
 */
export async function findBoxFileId(folderId: string, fileName: string): Promise<string | null> {
  try {
    return await boxFindFileInFolder(folderId, fileName);
  } catch (e: any) {
    console.warn(`[Box] findBoxFileId failed for ${fileName}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Create a BRAND-NEW file in Box (used for first-ever creation of a managed
 * file like the AR Scorecard). uploadToBox deliberately refuses to create
 * files; this is the explicit-create counterpart. Falls back to a download
 * link on failure, same as uploadToBox.
 */
export async function createBoxFile(opts: {
  buffer: Buffer;
  filename: string;
  folderId: string;
}): Promise<UploadResult> {
  const { buffer, filename, folderId } = opts;
  const size_kb = Math.round(buffer.length / 1024);
  try {
    const meta = await boxUploadFile(buffer, filename, folderId);
    return {
      uploaded: true,
      box_file_id: meta.id,
      box_url: `https://app.box.com/file/${meta.id}`,
      filename,
      size_kb,
      elapsed_ms: 0,
      via: "direct_version",
      version: meta.etag,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const boxMsg = err?.response?.data?.message ?? err?.message ?? "unknown";
    return fallback(buffer, filename, `create_failed status=${status ?? "?"} msg=${boxMsg}`);
  }
}

/**
 * Per-user upload: act as a SPECIFIC attorney's Box account (the owner of an
 * upload key, not the in-flight /mcp caller), using their Box token from the
 * platform vault. On a 401 the
 * token is refreshed against Box and the rotated pair is written BACK to the
 * vault (never the local store / Railway env). Returns a discriminated result
 * like uploadToBox; all failures resolve to { uploaded: false } so the route
 * surfaces a clean error rather than throwing.
 */
export async function uploadToBoxAsUser(opts: {
  buffer: Buffer;
  filename: string;
  userId: string;
  target: { create: string } | { version: string };
}): Promise<
  | { uploaded: true; box_file_id: string; filename: string; version?: string }
  | { uploaded: false; reason: string }
> {
  const { buffer, filename, userId, target } = opts;

  const tokens = await getBoxTokens(userId);
  if (!tokens) {
    return { uploaded: false, reason: "box-not-connected-for-user (connect Box on the platform /setup)" };
  }

  const attempt = (accessToken: string) =>
    "version" in target
      ? boxUploadNewVersionWithToken(buffer, filename, target.version, accessToken)
      : boxUploadFileWithToken(buffer, filename, target.create, accessToken);

  let meta: { id: string; etag?: string };
  try {
    meta = await attempt(tokens.accessToken);
  } catch (err: any) {
    if (err?.response?.status !== 401) {
      const status = err?.response?.status;
      const boxMsg = err?.response?.data?.message ?? err?.message ?? "unknown";
      return { uploaded: false, reason: `box_upload_failed status=${status ?? "?"} msg=${boxMsg}` };
    }
    // Access token expired — refresh against Box, persist the rotated pair to
    // the vault, and retry once.
    try {
      const refreshed = await refreshBoxTokensRaw(tokens.refreshToken);
      const expiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null;
      await updateBoxTokens(userId, refreshed.access_token, refreshed.refresh_token ?? tokens.refreshToken, expiresAt);
      meta = await attempt(refreshed.access_token);
    } catch (e2: any) {
      const status = e2?.response?.status;
      const boxMsg = e2?.response?.data?.message ?? e2?.message ?? "unknown";
      return { uploaded: false, reason: `box_reauth_failed status=${status ?? "?"} msg=${boxMsg} (reconnect Box on /setup)` };
    }
  }
  return { uploaded: true, box_file_id: meta.id, filename, version: meta.etag };
}

/**
 * Upload (version) a file to Box. See module header for the full flow.
 */
export async function uploadToBox(opts: {
  buffer: Buffer;
  filename: string;
  folderId: string;
  overwriteFileId?: string;
}): Promise<UploadResult> {
  const start = Date.now();
  const { buffer, filename, folderId, overwriteFileId } = opts;
  const size_kb = Math.round(buffer.length / 1024);

  console.log(
    `[Box] upload start filename=${filename} size_kb=${size_kb} folderId=${folderId} overwriteFileId=${overwriteFileId ?? "<none>"}`,
  );

  // ───── Path 1: direct version (only if caller gave us an ID) ─────
  if (overwriteFileId) {
    try {
      const meta = await boxUploadNewVersion(buffer, filename, overwriteFileId);
      const elapsed_ms = Date.now() - start;
      console.log(
        `[Box] upload ok via=direct_version filename=${filename} file_id=${meta.id} size_kb=${size_kb} elapsed_ms=${elapsed_ms}`,
      );
      return {
        uploaded: true,
        box_file_id: meta.id,
        box_url: `https://app.box.com/file/${meta.id}`,
        filename,
        size_kb,
        elapsed_ms,
        via: "direct_version",
        version: meta.etag,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        // Target file was deleted — drop through to 409-lookup path.
        console.warn(
          `[Box] direct_version 404 — overwriteFileId=${overwriteFileId} missing, falling back to conflict-lookup`,
        );
      } else {
        const boxMsg = err?.response?.data?.message ?? err?.message ?? "unknown";
        console.error(
          `[Box] direct_version FAIL filename=${filename} overwriteFileId=${overwriteFileId} status=${status ?? "?"} message=${boxMsg}`,
        );
        return fallback(buffer, filename, `direct_version_failed status=${status ?? "?"} msg=${boxMsg}`);
      }
    }
  }

  // ───── Path 2: 409-lookup version (the common path) ─────
  // We call boxUploadFile as a probe. If the file exists (normal case),
  // Box returns 409 with the existing file's ID, which we then version.
  // If the file genuinely doesn't exist, Box accepts the upload and
  // creates a new file — we don't want that, so we delete it and fall
  // back to a download link (per caller's contract: don't silently
  // create new Box files).
  try {
    const meta = await boxUploadFile(buffer, filename, folderId);
    // Unexpected success — Box accepted our probe as a real new-file
    // upload. Clean up the orphan and return a DL link instead.
    console.warn(
      `[Box] conflict_lookup UNEXPECTED_SUCCESS filename=${filename} file_id=${meta.id} — deleting orphan and falling back to direct_download_url`,
    );
    try {
      await boxDeleteFile(meta.id);
      console.log(`[Box] orphan deleted file_id=${meta.id}`);
    } catch (delErr: any) {
      console.error(
        `[Box] orphan delete FAILED file_id=${meta.id} message=${delErr?.message ?? "unknown"} — orphan will remain in Box until cleaned up manually`,
      );
    }
    return fallback(buffer, filename, `no_existing_file_to_version (orphan ${meta.id} deleted)`);
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 409) {
      const conflictId = extractConflictId(err);
      if (!conflictId) {
        const boxMsg = err?.response?.data?.message ?? "unknown";
        console.error(
          `[Box] conflict_lookup 409 but no conflict ID in body filename=${filename} message=${boxMsg}`,
        );
        return fallback(buffer, filename, `409_no_conflict_id msg=${boxMsg}`);
      }
      try {
        const meta = await boxUploadNewVersion(buffer, filename, conflictId);
        const elapsed_ms = Date.now() - start;
        console.log(
          `[Box] upload ok via=conflict_lookup_version filename=${filename} file_id=${meta.id} size_kb=${size_kb} elapsed_ms=${elapsed_ms}`,
        );
        return {
          uploaded: true,
          box_file_id: meta.id,
          box_url: `https://app.box.com/file/${meta.id}`,
          filename,
          size_kb,
          elapsed_ms,
          via: "conflict_lookup_version",
          version: meta.etag,
        };
      } catch (vErr: any) {
        const vStatus = vErr?.response?.status;
        const vMsg = vErr?.response?.data?.message ?? vErr?.message ?? "unknown";
        console.error(
          `[Box] conflict_lookup_version FAIL filename=${filename} conflictId=${conflictId} status=${vStatus ?? "?"} message=${vMsg}`,
        );
        return fallback(buffer, filename, `conflict_lookup_version_failed status=${vStatus ?? "?"} msg=${vMsg}`);
      }
    }
    const boxMsg = err?.response?.data?.message ?? err?.message ?? "unknown";
    console.error(
      `[Box] conflict_lookup FAIL (non-409) filename=${filename} status=${status ?? "?"} message=${boxMsg}`,
    );
    return fallback(buffer, filename, `conflict_lookup_failed status=${status ?? "?"} msg=${boxMsg}`);
  }
}
