import axios from "axios";
import { ENV } from "../utils/env";

const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";

// Attorneys connect Box on the platform's /setup page, which writes their
// tokens to the vault. This server only refreshes them; it no longer runs a
// Box OAuth flow of its own.

/**
 * Exchange a Box refresh token for a fresh token pair WITHOUT persisting it.
 * Box rotates refresh tokens (single-use), so the caller MUST write the
 * returned refresh_token back to the vault (updateBoxTokens) immediately.
 */
export async function refreshBoxTokensRaw(
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  if (!refreshToken) throw new Error("No Box refresh token available for this user.");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: ENV.BOX_CLIENT_ID,
    client_secret: ENV.BOX_CLIENT_SECRET,
  });
  const response = await axios.post(BOX_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return response.data;
}
