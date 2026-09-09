# Clio MCP Server

Model Context Protocol server integrating Claude with the Clio Manage API v4 over
**Streamable HTTP** (`/mcp`), with **per-user Microsoft OAuth identity** and
**per-user Clio tokens** read from the companion platform's shared Postgres vault.

Every Clio action is attributed to the **acting attorney's own Clio account** — there
is no shared bearer secret and no shared Clio identity.

## Architecture

- **Transport:** Streamable HTTP at a single `/mcp` endpoint (POST/GET/DELETE),
  stateful per `mcp-session-id`. (The deprecated `/sse` + `/messages` transport is gone.)
- **Auth:** each request must carry `Authorization: Bearer <Microsoft v2 JWT>`. The
  token is validated against Microsoft's JWKS (issuer/audience/scope), the email is
  extracted and checked against an onboarding allowlist, and the session is bound to
  that identity.
- **Clio tokens:** preloaded per request from the platform's Postgres vault
  (`user_integrations`, AES-256-GCM envelope-encrypted), decrypted in-process, and
  exposed to the unchanged Clio HTTP layer via an `AsyncLocalStorage` context.

## Prerequisites

- Node.js 18+
- The companion platform deployed, with each attorney's Clio token stored in the
  shared Postgres vault (attorneys connect Clio on the platform's `/setup` page).
- A Microsoft Entra app registration exposing an API scope (`MCP_AUDIENCE` +
  `MCP_SCOPE_NAME`).
- The **same** Clio OAuth app credentials the platform uses (to refresh tokens).

## Setup

```bash
cd clio-mcp-server
npm install
cp .env.example .env   # then fill in the values (see .env.example for the full list)
```

Key variables: `DATABASE_URL` (as the bounded `noe_app` role), `APP_KEK_B64` (identical
to the platform), `MS_TENANT_ID` / `MS_CLIENT_ID` / `MCP_AUDIENCE` / `MCP_SCOPE_NAME`,
`ALLOWED_EMAILS` and/or `ALLOWED_EMAIL_DOMAINS`, `CLIO_CLIENT_ID` / `CLIO_CLIENT_SECRET`,
and `PUBLIC_BASE_URL`.

## Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

Verify the server is running:

```bash
curl http://localhost:3000/health
# → {"status":"ok","server":"clio-mcp","version":"1.0.0"}
```

## Railway Deployment

1. Push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. **Set all environment variables in the Railway dashboard** — Railway does NOT read `.env` files.
   At minimum: `DATABASE_URL` (the `noe_app` public-proxy URL), `APP_KEK_B64` (identical to the platform),
   `MS_TENANT_ID`, `MS_CLIENT_ID` (+ `MS_CLIENT_SECRET` if confidential), `MCP_AUDIENCE`, `MCP_SCOPE_NAME`,
   `ALLOWED_EMAILS`/`ALLOWED_EMAIL_DOMAINS`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, and `PUBLIC_BASE_URL`.
   Set `UPLOAD_SECRET` too if you use the [binary upload endpoint](#binary-upload-endpoint-post-upload).
5. Deploy
6. Test: `curl https://your-railway-url.up.railway.app/health` (expect `"transport":"streamable-http-stateless"`)

## Client Integration

The server speaks **Streamable HTTP** at `POST /mcp` (stateless; `GET`/`DELETE`
return `405`). There is no SSE or stdio transport — that is what Gemini
Enterprise requires, and Claude and ChatGPT accept it too.

### How auth is wired

This server is **not a token issuer**. Microsoft Entra is. `/authorize` and
`/token` are a facade that forwards to Microsoft (stripping the RFC 8707
`resource` param, which trips `AADSTS9010010`), and `/mcp` verifies the
Microsoft-issued JWT against Microsoft's JWKS, extracts the email, and loads
that attorney's own Clio token from the vault.

Every client therefore ends up on the **same** upstream Microsoft app
registration. What differs is only how each learns a `client_id`:

| Client | Registration | Credential |
| --- | --- | --- |
| Claude, ChatGPT | RFC 7591 DCR at `POST /register` | Public client + PKCE, no secret |
| Gemini Enterprise | No DCR — fixed pair configured on the server | `MCP_STATIC_CLIENT_ID` / `_SECRET`, verified locally then swapped for the Microsoft credentials |
| Scripts, cron | None | Static bearer key (`MCP_API_KEYS`) |

Endpoints: `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, `/authorize`, `/token`, `/register`.
Both well-known documents are also served with `/mcp` appended (RFC 8414 §3.1
path-insertion form) because clients disagree on which they probe.

### Claude.ai / Claude Code

1. Claude.ai → **Settings** → **Connectors** → **Add custom connector**
2. URL: `https://<PUBLIC_BASE_URL>/mcp` — nothing else to fill in
3. Complete the Microsoft sign-in when prompted

Claude discovers the server, self-registers at `/register`, and runs the
auth-code + PKCE flow. Claude Code: `claude mcp add --transport http clio https://<PUBLIC_BASE_URL>/mcp`.

### ChatGPT

**Settings** → **Connectors** → **Create** → MCP Server URL
`https://<PUBLIC_BASE_URL>/mcp`, authentication **OAuth**. Same DCR path as
Claude; no client ID or secret to enter.

### Gemini Enterprise (no DCR — static client required)

Gemini cannot self-register, so mint a fixed pair first:

```bash
npm run oauth:static-client
```

Set the printed `MCP_STATIC_CLIENT_ID` and `MCP_STATIC_CLIENT_SECRET_SHA256`
on the server and redeploy, then fill in **Custom MCP Server → OAuth 2.0**:

| Field | Value |
| --- | --- |
| MCP Server URL | `https://<PUBLIC_BASE_URL>/mcp` |
| Authorization URL | `https://<PUBLIC_BASE_URL>/authorize` |
| Token URL | `https://<PUBLIC_BASE_URL>/token` |
| Client ID | the generated `MCP_STATIC_CLIENT_ID` |
| Client Secret | the generated secret (shown once) |
| Scopes | `mcp.access` (your `MCP_SCOPE_NAME`) |
| Authorization URL Parameters | leave empty |
| PKCE | enabled (S256) |

> **One manual step this cannot do for you:** copy Gemini's redirect URI out of
> its console and add it to the Microsoft app registration (Entra ID → App
> registrations → Authentication → Web → Redirect URIs). Microsoft rejects any
> redirect it has not been told about, with `AADSTS50011`.

The client secret is **local to this server** — it is not `MS_CLIENT_SECRET`.
Revoking Gemini is a one-variable change, not a tenant-wide secret rotation.

### Scripts and cron (no OAuth)

```bash
npm run oauth:api-key -- attorney@romanosumner.com
```

Append the printed `email:sha256:<hex>` entry to `MCP_API_KEYS`, then send the
key as `Authorization: Bearer <key>` or `X-API-Key: <key>`. The key acts as
that attorney and reaches exactly what they reach — the onboarding allowlist
and their own Clio token both still apply. Unset `MCP_API_KEYS` disables the
path entirely.

In every case, only allowlisted attorneys who have connected Clio on the
platform can actually use the tools.

## Binary Upload Endpoint (`POST /upload`)

A plain `multipart/form-data` route for streaming a binary file (`.docx` / `.pdf` /
`.xlsx`) straight into Box — created as a new file or versioned onto an existing one.
It reuses the same Box upload code as the dashboard updater (`uploadToBox` /
`createBoxFile`), so a remote client can `curl -F` raw bytes instead of base64-ing a
binary into an MCP tool argument.

**Auth:** send a secret in the `X-Upload-Secret` header. It's resolved as one of two
credentials (a mismatch on both returns `401`):

- A **per-user upload key** (issued per attorney on the platform `/setup`, looked up by
  hash in `upload_keys`). The upload then runs as **that attorney's own Box account**,
  using their Box token from the vault. The response includes `"acted_as": "user"`.
- The legacy **shared `UPLOAD_SECRET`** (constant-time compared) → the shared service Box
  account. Response includes `"acted_as": "shared"`.

A per-user key takes precedence; if `upload_keys` isn't provisioned yet, the shared
secret is used. Setting neither (or an unset `UPLOAD_SECRET` with no matching key)
rejects all requests.

**Form fields:**

| Field | Required | Meaning |
|-------|----------|---------|
| `file` | yes | The binary, parsed in memory (50 MB max — Box's single-shot cap; larger → `413`). |
| `overwrite_file_id` | one of these two | Upload a **new version** of this existing Box file. |
| `parent_folder_id` | one of these two | Create a **new** Box file in this folder. |
| `file_name` | no | Name to store as; falls back to the multipart filename. |

Provide **exactly one** of `overwrite_file_id` / `parent_folder_id` (neither or both →
`400`).

**Response** (`200`):

```json
{ "ok": true, "file_id": "1234567890", "file_name": "report.pdf", "version": "3", "size": 81920 }
```

`version` is Box's version sequence number (etag) after the upload, or `null` if Box
omitted it. On a Box failure the route returns `502` with `{ "ok": false, "error": ... }`.

**Examples:**

```bash
# Create a NEW file in a Box folder
curl -X POST https://your-railway-url.up.railway.app/upload \
  -H "X-Upload-Secret: $UPLOAD_SECRET" \
  -F "file=@./report.pdf" \
  -F "parent_folder_id=390781679459" \
  -F "file_name=Q2 Report.pdf"

# Upload a NEW VERSION of an existing Box file
curl -X POST https://your-railway-url.up.railway.app/upload \
  -H "X-Upload-Secret: $UPLOAD_SECRET" \
  -F "file=@./report.pdf" \
  -F "overwrite_file_id=1234567890"
```

> The uploading Box account is the one connected via `/box/oauth/start`. If no Box
> account is connected the endpoint returns `502`.

### `POST /version` — version an existing file (one-shot)

Symmetric with `/upload` but dedicated to the version case, so the call is a clean
one-shot — just `file_id` + `file` (no `parent_folder_id` / "exactly one of" rule).
Same auth (`X-Upload-Secret`), same 50 MB limit, same JSON response. Under the hood it
calls Box's version endpoint (`POST upload.box.com/api/2.0/files/{id}/content`) — the
same path `/upload` takes when given `overwrite_file_id`.

| Field | Required | Meaning |
|-------|----------|---------|
| `file_id` | yes | Box file id to upload a new version of. |
| `file` | yes | The new binary. |
| `file_name` | no | Name to store as; falls back to the multipart filename. |

```bash
curl -X POST https://your-railway-url.up.railway.app/version \
  -H "X-Upload-Secret: $UPLOAD_SECRET" \
  -F "file=@./petition.docx" \
  -F "file_id=2310830265427"
```

## Tool Reference

| Tool | Description |
|------|-------------|
| `get_matters` | List matters with status/attorney/client filters |
| `get_matter` | Get single matter by ID or search query |
| `get_matter_financial_summary` | Per-matter snapshot: trust balance, WIP, outstanding AR |
| `get_stale_matters` | Find open matters with no recent activity |
| `get_billing_gaps` | Matters with WIP but no recent bill issued |
| `get_time_entries` | Time entries with date/user/matter/billed filters |
| `get_unbilled_time` | Unbilled time grouped by matter with totals |
| `get_expenses` | Expense entries with filters |
| `get_unbilled_expenses` | Unbilled expenses grouped by matter |
| `list_expense_categories` | Firm's expense categories (id, name, rate) — feeds `create_expense` |
| `create_expense` | Create an expense entry (date, matter, amount, category by id or name); attribution defaults to the acting attorney with the same `on_behalf_of` guard as `create_time_entry` |
| `convert_time_entry_to_expense` | Replace a TimeEntry with an ExpenseEntry (create-then-delete; amount defaults to hours × rate; handles draft-bill removal; refuses non-draft bills; on delete failure it re-reads the actual state, rolls back the expense when the entry survived, and reports recovery steps for partial bill changes) |
| `get_contacts` | Search contacts by name or email |
| `create_contact` | Create a client/contact (Person or Company); returns the id to use as `create_matter`'s `client_id` |
| `get_tasks` | Tasks with status/assignee/due date filters |
| `get_bills` | Bills with state/date filters and aging flags |
| `get_payments` | Individual payments/credits applied to bills (Clio allocations), incl. reversals |
| `get_ar_aging` | Full AR aging report. Discrete buckets at 7/15/30/60/90/120/180/360 days (0-7, 8-15, 16-30, 31-60, 61-90, 91-120, 121-180, 181-360, 360+, inclusive both ends, summing to `total_ar`), cumulative `N+` rollups derived from them (`N+` = days_outstanding > N), plus the original five-bucket shape under `buckets`/`legacy_buckets` |
| `get_wip_report` | Work-in-progress report with aging flags |
| `get_trust_balances` | Trust/IOLTA balances with low-balance and dormancy flags |
| `get_user_productivity` | Timekeeper hours and top matters |
| `get_billable_target_report` | Hours vs daily billable target per timekeeper with weekly trends (not the dashboard's utilization rate) |
| `get_realization_rate` | Billed vs worked value by timekeeper and matter |
| `get_timekeeper_realization` | Deep per-attorney: worked, billed, collected, effective rate |
| `reconcile_statement` | Match bank transactions against Clio expenses |
| `list_custom_fields` | List Clio CustomField definitions firm-wide (Matter / Contact / Activity / Bill etc.) |
| `get_matter_custom_field_values` | Read the custom field values set on a specific matter (picklist/contact labels auto-resolved) |
| `find_matters_by_custom_field` | Find matters by a CustomField value via ONE bulk paginated query (avoids per-matter brute force) |
| `set_matter_custom_field_value` | Write/update/clear a single Matter CustomField value (handles picklist label lookup, checkbox booleans, contact ids, etc.) |

### Clio Grow (intake CRM) tools

Full coverage of the Clio Grow API v2 (see `docs/clio-grow-api-reference.md`).
Grow is a separate host (`GROW_API_BASE_URL`, default `https://api.clio.com/grow`)
authorized by a **separate Clio Platform app** (`GROW_CLIENT_ID`/`GROW_CLIENT_SECRET`,
created at developers.api.clio.com with redirect URL
`<PUBLIC_BASE_URL>/grow/oauth/callback`). Each attorney connects once at
`<PUBLIC_BASE_URL>/grow/oauth/start`; their token pair is stored in the vault
under provider `clio_grow` and auto-refreshed. Without a stored Grow token the
tools fall back to the Manage token. Run `grow_who_am_i` first — it reports
which token was used (`token_source`) and diagnoses 401/403s.

| Tool | Description |
|------|-------------|
| `grow_who_am_i` | Verify Grow API access; returns the current Grow user + firm (the auth probe) |
| `get_grow_contacts` | List/search Grow contacts or fetch one; includes intake `status` and `clio_id` (synced Manage contact ID) |
| `get_grow_matters` | List Grow pipeline matters or fetch one; `status_category` (intake/hired/declined), `hired_date`, `clio_id` join key, `inbox_lead_id`/`submitted_only` filters |
| `get_grow_notes` / `create_grow_note` | Read/write notes on a Grow contact or matter |
| `get_grow_inbox_leads` | List untriaged/ignored inbox leads or fetch one |
| `create_grow_inbox_lead` | Submit a lead into the Grow lead inbox (API successor to the legacy form endpoint) |
| `get_grow_sources` / `create_grow_source` | List/create the firm's lead (marketing) sources |
| `get_grow_users` | List Grow account users (IDs match `matter_assignee_ids`) |
| `get_grow_custom_actions` / `create_grow_custom_action` / `delete_grow_custom_action` | Manage links injected into the Grow matter-page dropdown |
| `get_grow_pipeline_report` | Intake funnel snapshot: matter counts by status category/status/type, hired count, lead counts |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Calendar entries: custom event types don't apply** | The custom RomSum/NRN **event types** (`event_type` / `event_type_id`) are **owner-only**. Set `OWNER_EMAILS` (comma-separated, defaults to the original author) to control who gets them. For every other user, `create_calendar_entry` / `update_calendar_entry` ignore those inputs; the response lists what was ignored. Calendar placement/reassignment is NOT gated — see the next row. |
| **Calendar entry lands on the wrong calendar** | Reassignment (`calendar_owner_id` / `assign_to_user_id`) works for all users — Clio enforces write permission on the target calendar. Note `calendar_owner` on a CalendarEntry is a **Calendar ID**, not a User ID (separate Clio resources); passing a User ID where Clio expects a Calendar ID returns 404. To place an event on a specific user's personal calendar: (a) use `assign_to_user_id` (looks up the Calendar resource automatically); or (b) use `list_calendars(creator_user_id=N)` to find the Calendar ID and pass it via `calendar_owner_id`. With no targeting param, the event defaults to the acting user's own personal calendar. |
| **`get_calendar_entries(user_id=N)` returns everyone's entries (filter ignored)** | Same Calendar-vs-User trap on the read side. Clio's `calendar_entries` list filter is `calendar_id` (a **Calendar** resource ID), not a User ID, and there is no `calendar_owner_id` list filter — a raw user_id passed there is silently ignored, so the whole firm's entries in the range come back. `get_calendar_entries` now resolves `user_id` to the Calendar(s) that user owns (`creator.id === user_id`) and queries each with `calendar_id`, merging results. If the user owns no calendar visible to the firm OAuth user, it returns 0 entries with a note (rather than everyone's). |
| **Which events count as "my events"** | `get_calendar_entries(user_id=N)` returns **both** entries on calendars the user owns **and** entries on other people's calendars where the user is an attendee — `include_attending` defaults to **true**, because an event a paralegal calendared and added you to is still your event. Each entry carries `match`: `"owner"`, `"attendee"`, or `"both"`, plus an `attendee_only_count` in the response. Clio has **no attendee query filter** (verified against the OpenAPI spec: the only ownership filter on `/calendar_entries` is `calendar_id`), so the attendee half sweeps the date range and matches `attendees[]` client-side — keep ranges tight on large firms, or pass `include_attending=false` for the cheaper owned-only path that filters server-side. |
| **Attendees: `attendees` is PLURAL, and attendee ids are CALENDAR ids** | Two separate bugs came from this. `CalendarEntry.attendees` is an array of `Attendee_base`; a singular `attendee` field **does not exist**, and requesting it makes Clio reject the whole request (that silently zeroed the scorecard's `potential_calls` for every timekeeper, because the failure was swallowed by a bare `catch`). `Attendee_base.type` is `"Contact"` or `"Calendar"` — a *person* attendee is identified by their **Calendar** id, so attendee ids must be mapped to Clio User ids before being compared against anything user-keyed, and `"Contact"` attendees (clients, opposing counsel) carry ids from a different namespace that must never be matched against calendar ids. Use `src/clio/calendarIdentity.ts` (`ATTENDEE_FIELDS`, `buildCalendarIdToUserId`, `resolveAttendeeUserIds`) rather than re-deriving this per call site. |
| **Empty/null nested data** | Every API call must include explicit `fields` parameter |
| **Missing records** | Pagination is required — without it, only first 200 records return |
| **Need to see exactly what's on a specific bill (invoice review)** | Use `get_bill_line_items(bill_id)` — it filters by bill_id directly via Clio's `/line_items?bill_id=X` and returns only the lines currently on that bill, ordered as they appear (group_ordering, then date, then id). Do NOT use `get_time_entries(matter_id=X, billed="true")` for this — that filters by matter and sweeps in prior-bill entries plus unbilled activities, contaminating any per-bill review. |
| **Hours look wrong** | Clio stores time on `/activities` as seconds, but on `/line_items` as decimal hours — see `lineItems.ts:88-107` for the routing-aware conversion. `test_update_line_item` writes hours directly. |
| **Need to add a line to an existing draft bill** | Clio's API does not support `POST /line_items` (this was attempted in #28–#29 and removed in #30 after Clio rejected every shape). `POST /bills` doesn't exist either, and there's no `/refresh` endpoint — verified against Clio's full OpenAPI. Line items are only created by Clio when activities are pulled into a (regenerated) draft. To add work to an existing draft, log a new time entry via `create_time_entry`, then in Clio UI either click "Regenerate Draft" on the bill, or — if your plan doesn't expose Regenerate — run `delete_draft_bill(bill_id)` and click "Generate Bill" on the matter. The fresh draft will include all unbilled activities. |
| **Splitting a block-billed entry into multiple sub-entries** | Use `prepare_line_split(line_item_id, splits_json)`. It creates N new activities (inheriting date/user/rate from the original) and DELETES the original activity. To finalize on the bill: open Clio UI → bill → "Regenerate Draft" if available (varies by Clio plan); otherwise run `delete_draft_bill(bill_id)` then click "Generate Bill" on the matter in Clio UI. Strict total: split hours must equal the original line's hours. |
| **Combining multiple entries on a draft bill into one** | Use `merge_line_items(primary_line_item_id, secondary_line_item_ids_csv, new_note?)`. It optionally rewrites the primary's note with a merged narrative, then applies a 100% discount to each secondary so they stay visible at $0 on the bill (firm rule: don't delete, preserve audit trail). All lines must be on the same draft bill. Note: hours don't roll up to the primary — Clio silently ignores quantity edits for ActivityLineItem (see next entry), so this is a soft-combine that preserves per-line hours but zeroes secondaries' dollar contribution. Per-secondary errors are isolated. |
| **Hour edits on billed entries: rounding, and the no-op guard** | Hours written through `patchTimeEntrySmart` on a billed line are **snapped UP to the firm's billing increment before the write** — the increment is read live from `GET /settings/billing` (`rounding`, in MINUTES; this firm reports 12 = 0.2h), never hardcoded, with a named `FALLBACK_BILLING_INCREMENT_HOURS` used only when that call fails. Reason (KES, 2026-09-03, bill 23620): a 0.25h request on a 0.2h grid was stored by Clio as 0.4h, and the read-back guard — which compared the *requested* value against the *stored* value — called that a silent no-op and returned 422 **after the change had already persisted to the draft bill**. The applied value now comes back in `quantity_rounding`. Clio does still sometimes ignore `quantity` on `PATCH /line_items` for ActivityLineItem types (probed 2026-05-04 on bill 22263; the quantity is sourced from the activity, locked while billed), so the guard remains: when the read-back does not reach the **snapped** value it throws 422 `billed_quantity_silently_ignored`. That guard **never rolls back quantity** — only sibling note/price — so its message and payload now report whether the quantity change persisted (`quantity_persisted`) and which siblings were actually reverted, instead of asserting an atomicity this path does not provide. For a predictable hour change, use `prepare_hour_change` (next entry). |
| **Reducing/increasing hours on a billed line** | Use `prepare_hour_change(line_item_id, new_hours, new_note?)`. It removes the line from the draft (unbilling the activity, unlocking `/activities`), then PATCHes the activity with the new quantity. The line is gone from the bill until you finalize in Clio UI: "Regenerate Draft" on the bill if available, or `delete_draft_bill(bill_id)` + "Generate Bill" on the matter. Multiple `prepare_hour_change` calls can be batched before a single finalize step. **Sequencing matters for invoice review:** either finalize path rebuilds the draft's line items from their activities, which **wipes every line-item discount** (discounts live on the line item, not the activity) — so on a review that also takes write-offs, do all the hour changes and the regenerate FIRST, then apply discounts to the rebuilt lines. On a Clio plan with no per-bill "Regenerate Draft" option, the finalize step is `delete_draft_bill` + "Generate Bill", which also loses note edits and custom ordering — on such a plan an hour change mid-review is not safe, and the reduction belongs with the reviewing attorney in the Clio UI. |
| **Hard-combining multiple lines into one (sum hours into primary, delete secondaries)** | Use `prepare_hard_combine(primary_line_item_id, secondary_line_item_ids_csv, new_primary_hours, new_note?, secondary_treatment?)`. Composition: prepare_hour_change on the primary (with new hours + optional new note), then delete_activity (default) or discount-100% (`secondary_treatment="discount_100pct"`) on each secondary. Per-secondary errors are isolated. Use this when you want one line containing the consolidated work; use `merge_line_items` when you want all original lines preserved (firm rule for routine combines). Finalize via "Regenerate Draft" or `delete_draft_bill` + "Generate Bill" — see hour-change entry. |
| **A cost was logged as time (e.g. filing fee as a 1.0h entry)** | Use `convert_time_entry_to_expense(activity_id, expense_category_name?, amount?)`. Clio's API cannot change an activity's `type`, so the tool creates a new ExpenseEntry (same matter/date/user; note preserved; amount defaults to the entry's hours × rate) and then deletes the original TimeEntry. On delete failure the tool re-reads the entry's actual state: the expense is rolled back when the entry survived, with explicit recovery steps if the draft-bill line was already removed (`context: "line_removed_but_activity_survived"`); if the entry turns out to be deleted despite the error, the conversion is reported complete. If the entry was on a DRAFT bill, the line is removed as part of the delete and the new expense sits unbilled; finalize via "Regenerate Draft" (or `delete_draft_bill` + "Generate Bill"). Entries on issued/paid bills are refused. |
| **Stale draft bill needs a fresh regenerate** | If your Clio UI doesn't expose a per-bill "Regenerate Draft" option (varies by plan/matter type), use `delete_draft_bill(bill_id)`. Refuses if the bill is not in 'draft' state. The underlying activities are NOT deleted — they revert to unbilled and you can immediately rebuild a clean draft via Clio UI ("Generate Bill" on the matter). The new draft includes all unbilled activities for the matter within the relevant date range. **Tradeoff**: any manual edits previously made to the deleted draft (note tweaks, line-level discounts, custom ordering) are lost; the new draft starts from raw activities. Use only when the manual-edit cost is acceptable. |
| **`sum_hours` from `get_bill_line_items` looks too high** | Expense lines report `hours: 1` with `rate == total`, so a naive sum adds a phantom hour per expense (bill 23521 read 4.2 hrs against 1.2 hrs of real service time). `sum_hours` now counts SERVICE lines only; expenses are reported separately as `expense_count` / `sum_expense_amount`, and each line carries `is_expense`. Never treat `sum_hours` from an older client as billable time on a bill carrying an expense. |
| **Line-item `type` is useless for detection** | Across a read-only scan of 73 draft bills / 724 line items (2026-09), **every** line reported `type: "ActivityLineItem"` — no `NoChargeLineItem`, no `SummaryLineItem`. Any branch keyed on `type` will never fire. Expenses are distinguishable only by `kind == "Expense"`. |
| **Two different "unbilled" counts on the same matter** | `get_time_entries(status="unbilled")` returns BILLABLE unbilled time only. Entries created with `non_billable: true` are excluded and come back only under `status="non_billable"` (this is Clio's behavior, not a bug) — that is the usual source of a discrepancy like 75 vs 81 on matter 00183. Pull both statuses when you need every not-yet-billed entry. |
| **Claude.ai won't connect** | Use the Streamable HTTP endpoint (`/mcp`), not `/sse`. Confirm `PUBLIC_BASE_URL` matches the externally reachable origin so OAuth discovery resolves. |
| **401 with `WWW-Authenticate`** | The Microsoft JWT is missing/invalid, lacks the required scope, the email isn't on the allowlist, or the user isn't provisioned on the platform. |
| **`Clio not connected` on a tool call** | The authenticated attorney has no `clio` row in the vault — they must connect Clio on the platform's `/setup` page. |
| **Token not refreshing** | Verify `CLIO_CLIENT_ID`/`CLIO_CLIENT_SECRET` match the platform's Clio app; refreshed tokens are written back to the vault. |
| **`set_config`/RLS returns no rows** | Connect as the bounded `noe_app` role (not the superuser); the tenant context is set per transaction automatically. |
| **Railway env vars** | Railway ignores `.env` files — set every variable in the Railway dashboard |
