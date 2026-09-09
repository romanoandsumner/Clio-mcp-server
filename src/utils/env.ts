import dotenv from "dotenv";
dotenv.config();

export function getEnv(key: string, fallback?: string): string {
    const value = process.env[key] ?? fallback;
    if (value === undefined) {
          throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

export const ENV = {
    PORT: parseInt(getEnv("PORT", "3000"), 10),
    get CLIO_BASE_URL() { return getEnv("CLIO_BASE_URL", "https://app.clio.com"); },
    get CLIO_API_BASE_URL() { return getEnv("CLIO_API_BASE_URL", "https://app.clio.com/api/v4"); },
    // Clio Grow API v2 (see docs/clio-grow-api-reference.md). Region-specific
    // hosts exist (eu./ca./au. prefixes) if the firm's Grow account is not US.
    get GROW_API_BASE_URL() { return getEnv("GROW_API_BASE_URL", "https://api.clio.com/grow"); },
    // Clio Platform app credentials for the Grow API (created in the developer
    // portal at developers.api.clio.com — a SEPARATE app from the legacy Manage
    // one behind CLIO_CLIENT_ID). When set, /grow/oauth/start runs the connect
    // flow and Grow calls use the per-user tokens it stores; when unset, Grow
    // calls fall back to the Manage token.
    get GROW_CLIENT_ID() { return process.env.GROW_CLIENT_ID ?? ""; },
    get GROW_CLIENT_SECRET() { return process.env.GROW_CLIENT_SECRET ?? ""; },
    // OAuth endpoints for the Platform (Grow) app. Clio Grow apps are created in
    // the API Hub developer portal (developers.api.clio.com) and authorize through
    // the API Hub auth server at auth.api.clio.com — confirmed by Clio API Support.
    // This is a THIRD host, distinct from Clio Identity/SSO (account.clio.com) and
    // the legacy Manage OAuth (app.clio.com); a Grow App Key exists in none of the
    // others' registries. US host shown; other regions may use a prefixed host —
    // override if so. Both endpoints stay env-overridable.
    get GROW_OAUTH_AUTHORIZE_URL() { return getEnv("GROW_OAUTH_AUTHORIZE_URL", "https://auth.api.clio.com/oauth/authorize"); },
    get GROW_OAUTH_TOKEN_URL() { return getEnv("GROW_OAUTH_TOKEN_URL", "https://auth.api.clio.com/oauth/token"); },
    // Space-separated OAuth scopes. Per Clio API Support, Grow uses Grow-SPECIFIC
    // scopes (grow_contact_read, grow_matter_read, grow_lead_inbox_read,
    // grow_user_read, note/custom-action scopes, and their _write counterparts) —
    // NOT openid/offline_access (a refresh_token is returned automatically on the
    // authorization_code grant). The requested scopes must be a subset of the App
    // Permissions selected on the app in the portal; set GROW_OAUTH_SCOPE to match
    // those exactly. The default now covers every scope the Grow tools exercise so
    // the read AND write tools work out of the box:
    //   - grow_lead_inbox_read/_write  → get/create_grow_inbox_lead
    //   - grow_custom_action_read/_write → get/create/delete_grow_custom_action
    //   - grow_matter_read             → get_grow_matters
    //   - grow_matter_note_read/_write → get/create_grow_note (matter)
    //   - grow_contact_read            → get_grow_contacts
    //   - grow_contact_note_read/_write → get/create_grow_note (contact)
    //   - grow_user_read               → get_grow_users
    // (Note: notes are gated by note-specific scopes, not the parent read scope,
    // and custom actions by their own scope — the previous 4-read-scope default
    // left the write/note/custom-action tools failing with an auth-host redirect.)
    get GROW_OAUTH_SCOPE() {
        return process.env.GROW_OAUTH_SCOPE ??
            "grow_lead_inbox_read grow_lead_inbox_write grow_custom_action_read grow_custom_action_write grow_matter_read grow_matter_note_read grow_matter_note_write grow_contact_read grow_contact_note_read grow_contact_note_write grow_user_read";
    },
    // PKCE (S256). Clio's Platform app has an optional "Use PKCE" toggle. Set
    // GROW_OAUTH_PKCE to match that toggle: on by default (sending a code_challenge
    // is RFC-recommended and normally accepted even by non-enforcing servers); set
    // GROW_OAUTH_PKCE=false if the app does NOT have PKCE enabled and it errors.
    get GROW_OAUTH_PKCE() {
        const v = (process.env.GROW_OAUTH_PKCE ?? "true").trim().toLowerCase();
        return !(v === "false" || v === "0" || v === "no" || v === "off");
    },
    get GROW_REDIRECT_URI() {
        return getEnv("GROW_REDIRECT_URI", `${ENV.PUBLIC_BASE_URL.replace(/\/$/, "")}/grow/oauth/callback`);
    },
    // CLIO_CLIENT_ID / SECRET are still required — they refresh each attorney's
    // per-user Clio token (must be the SAME Clio OAuth app the platform uses).
    get CLIO_CLIENT_ID() { return getEnv("CLIO_CLIENT_ID"); },
    get CLIO_CLIENT_SECRET() { return getEnv("CLIO_CLIENT_SECRET"); },

    // --- Platform vault (shared Postgres holding per-user Clio tokens) ---
    get DATABASE_URL() { return getEnv("DATABASE_URL"); },
    get APP_KEK_B64() { return getEnv("APP_KEK_B64"); },

    // --- Microsoft OAuth (per-user identity) ---
    get MS_CLIENT_ID() { return getEnv("MS_CLIENT_ID"); },
    // Optional: only needed when the upstream Microsoft app is a confidential
    // (web) client. Public/PKCE clients leave this unset.
    get MS_CLIENT_SECRET() { return process.env.MS_CLIENT_SECRET ?? ""; },
    get MS_TENANT_ID() { return getEnv("MS_TENANT_ID"); },
    // Audience expected on the Microsoft v2 access token, e.g. api://<client-id>.
    get MCP_AUDIENCE() { return getEnv("MCP_AUDIENCE"); },
    // Required scope name (matched against `scp` or `roles`), e.g. mcp.access.
    get MCP_SCOPE_NAME() { return getEnv("MCP_SCOPE_NAME"); },
    get ALLOWED_EMAILS() { return process.env.ALLOWED_EMAILS ?? ""; },
    get ALLOWED_EMAIL_DOMAINS() { return process.env.ALLOWED_EMAIL_DOMAINS ?? ""; },

    // --- OAuth facade: client registration (see auth/oauthClients.ts) ---
    // RFC 7591 Dynamic Client Registration, used by Claude and ChatGPT to
    // self-register. Kill-switch: set to false to stop advertising
    // registration_endpoint, reverting connectors to a manually-entered
    // client_id (the pre-DCR behaviour).
    get OAUTH_DCR_ENABLED() {
        const v = (process.env.OAUTH_DCR_ENABLED ?? "true").trim().toLowerCase();
        return !(v === "false" || v === "0" || v === "no" || v === "off");
    },
    // Optional strict allowlist of redirect URIs accepted at /register. Unset
    // = accept any https (or loopback http) URI and log it; Microsoft still
    // rejects anything not registered on the app registration.
    get OAUTH_ALLOWED_REDIRECT_URIS() { return process.env.OAUTH_ALLOWED_REDIRECT_URIS ?? ""; },
    // Fixed client credentials for a client that cannot do DCR — Gemini
    // Enterprise. Local to this server: /token verifies them and substitutes
    // the Microsoft app credentials upstream, so Google never holds
    // MS_CLIENT_SECRET. Generate with `npm run oauth:static-client`.
    get MCP_STATIC_CLIENT_ID() { return process.env.MCP_STATIC_CLIENT_ID ?? ""; },
    get MCP_STATIC_CLIENT_SECRET() { return process.env.MCP_STATIC_CLIENT_SECRET ?? ""; },
    // Preferred over the plaintext form: store only sha256(secret) here.
    get MCP_STATIC_CLIENT_SECRET_SHA256() { return process.env.MCP_STATIC_CLIENT_SECRET_SHA256 ?? ""; },
    get MCP_STATIC_CLIENT_NAME() { return process.env.MCP_STATIC_CLIENT_NAME ?? "Gemini Enterprise"; },
    // Static bearer keys for clients that skip OAuth entirely. Comma- or
    // newline-separated `email:secret` / `email:sha256:<hex>` entries. Unset =
    // the path is off. See auth/apiKeys.ts.
    get MCP_API_KEYS() { return process.env.MCP_API_KEYS ?? ""; },
    // Comma-separated emails of the "owner(s)" who can set the custom RomSum/NRN
    // calendar event types. Everyone else has those inputs ignored. Calendar
    // placement/reassignment is NOT gated by this. Defaults to the original
    // author when unset (see src/clio/owner.ts).
    get OWNER_EMAILS() { return process.env.OWNER_EMAILS ?? ""; },

    // --- Box (unchanged — out of scope) ---
    get BOX_CLIENT_ID() { return getEnv("BOX_CLIENT_ID", ""); },
    get BOX_CLIENT_SECRET() { return getEnv("BOX_CLIENT_SECRET", ""); },
    get BOX_REDIRECT_URI() { return getEnv("BOX_REDIRECT_URI", "https://clio-mcp-server-production-032d.up.railway.app/box/oauth/callback"); },
    // Public, externally reachable origin for this server. Used both for
    // /download/:token URLs (Box upload fallback) and as the OAuth
    // `baseUrl` advertised in the discovery + proxy endpoints.
    get PUBLIC_BASE_URL() { return getEnv("PUBLIC_BASE_URL", "https://clio-mcp-server-production-032d.up.railway.app"); },
};
