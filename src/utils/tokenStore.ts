import { als } from "../auth/identity";

// --- Clio Tokens (per-user) ---
//
// Clio tokens are no longer a single shared secret. Each /mcp request runs
// inside an AsyncLocalStorage scope (see auth/identity.ts) carrying the acting
// attorney's own Clio token, preloaded from the platform vault. getAccessToken
// stays SYNCHRONOUS so the central HTTP layer (clio/pagination.ts) and the ~18
// tool modules need no changes — they just read the in-flight context.
//
// Box tokens used to live here too, as one shared login persisted in plaintext
// to a Railway variable. Box now reads the caller's own tokens from the vault
// (see box/client.ts), so nothing here touches Box or Railway anymore.

/**
 * Per-user Clio access token for the in-flight request. SYNCHRONOUS by design:
 * the token was preloaded into the request's ALS context before the MCP
 * handler ran. Throws (rather than returning "") when called outside a request
 * context or when the user has no usable Clio token, so failures are loud and
 * the message is actionable instead of producing a silent `Bearer ` 401.
 */
export function getAccessToken(): string {
    const ctx = als.getStore();
    if (!ctx) {
          throw new Error(
                "No user context: Clio access is only available inside an authenticated /mcp request.",
          );
    }
    if (!ctx.accessToken) {
          throw new Error(ctx.clioError || "No Clio access token available for this user.");
    }
    return ctx.accessToken;
}

export function getRefreshToken(): string {
    return als.getStore()?.refreshToken ?? "";
}
