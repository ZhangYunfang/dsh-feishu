# dsh-feishu

English | [中文](README.zh.md)

Deep **Feishu / Lark** integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It gives the agent eight tools that act on a real Feishu tenant (and a browser
panel that shows what it did and fixes authorization in one click):

| Tool | What it does |
|---|---|
| `feishu_bitable` | Create **Bitable (多维表格)** apps with their tables and fields in one call; list tables and fields; insert, search, update, and delete records in batches |
| `feishu_dashboard` | Create dashboards and **chart blocks** inside a Bitable (柱状图 / 折线图 / 饼图 / 排行榜 / 指标卡 / NPS … 15 types), position them, and read a chart's computed numbers |
| `feishu_query` | Run a **grouped, aggregated query** over a table (group by, sum / avg / min / max / count / distinct_count, filter, sort, top-N) with the aggregation done server-side |
| `feishu_doc` | Create documents; append Markdown (converted to native blocks), append raw blocks, read plain text, or import a local Markdown/Word/Excel/PowerPoint/PDF file as a new cloud document |
| `feishu_sheet` | Create spreadsheets; add sheets; read, write, and append ranges |
| `feishu_drive` | Browse folders, create folders, upload and download files, move, delete, read metadata |
| `feishu_wiki` | List wiki spaces and nodes, resolve a wiki token to its document, create and move nodes |
| `feishu_message` | Send text, interactive cards, rich posts, files, and images; reply in a thread; post through a custom-bot webhook |
| `feishu_auth` | Diagnose authorization, produce the authorization URL, complete a manual code exchange, refresh, and log out |
| `feishu_api` | Call any documented Feishu open-platform path, with the same auth, retry, and error mapping |

New content lands in **the user's own cloud drive** because the tools act as the
authorized user, not as the app. When no user grant is stored they fall back to
the app identity and say so in a warning rather than silently filing documents
into a space the user cannot see.

---

## Quick start

### 1. Create a Feishu app

1. Open the [Feishu Open Platform](https://open.feishu.cn/app) (or
   [Lark](https://open.larksuite.com/app)) and create a **custom app**.
2. Under **凭证与基础信息**, note the **App ID** and **App Secret**.
3. Under **安全设置 → 重定向 URL**, add the callback this plugin serves:

   ```
   http://127.0.0.1:19387/api/feishu/oauth/callback
   ```

   The port is whatever DeepSeek Harness serves on (the plugin reads it from the
   host and reports the exact URI in `feishu_auth` action `status`).
4. Under **权限管理**, add the scopes below, then **publish a version** — scopes
   only apply after the version is released:

   | Scope | Needed for |
   |---|---|
   | `offline_access` | **Required** — without it Feishu returns no refresh token and the user must re-authorize every couple of hours |
   | `bitable:app` | Bitable |
   | `docx:document` | Documents |
   | `drive:drive` | Drive, imports, uploads |
   | `sheets:spreadsheet` | Spreadsheets |
   | `wiki:wiki` | Wiki |
   | `im:message`, `im:resource` | Messages and file/image sending |
   | `contact:user.base:readonly` | Reading the authorized user's name |

### 2. Enable the plugin

See [Install](#install) below, then restart DeepSeek Harness.

### 3. Configure it in the GUI

Open **设置 → 飞书 / Feishu**. Everything is editable there — no YAML by hand:

- **应用凭据** — the App ID, the App Secret (write-only), the credential
  reference name, and the brand (飞书 / Lark).
- **默认落点与身份** — the folder new content lands in, and which identity the
  tools use by default.
- **功能开关** — whether the tools register, whether the HTTP routes mount,
  whether the floating panel shows, and the tool-name prefix.
- **授权** — the scopes to request and the redirect URL to register.
- **高级** — endpoint overrides and the page-size caps.

**Saving writes only this plugin's entry** in the profile's `cordis.patch.yml`,
which the harness hot-reloads, so most changes apply without a restart. The App
Secret is *never* written to that file: it goes straight into the credential
store under the reference name, and the page only ever shows whether it is set.

### 4. Authorize

Press **授权飞书** on the settings page, or ask the agent to run `feishu_auth`
with action `authorize_url`. The browser lands on the callback, the grant is
stored, and every later call acts as that user. The same form shows the redirect
URL to register on the Feishu app and lists the scopes to grant.

> Host without a reachable browser callback (a remote or headless session)? Open
> the URL anywhere, then pass the `code` query parameter to `feishu_auth` with
> action `complete`.

---

## Install

Two ways, and they are alternatives — **do not do both.** Each creates a loader
entry with id `feishu`, and the loader rejects a composition that defines one id
twice with `duplicate loader entry id`.

### As a bundle (recommended)

The package declares a `dsh.bundle` patch, so a bundle-aware CLI installs and
mounts it in one step:

```sh
dsh plugin add github:2048lr/dsh-feishu
```

That appends `dsh-feishu` to `dsh.profile.bundles` and profile boot merges
[cordis.patch.yml](cordis.patch.yml), which inserts the plugin row. Nothing else
needs editing.

The settings page is aware of this: when the profile mounts the bundle, it writes
an **id-targeted config override** rather than a second `insert`, so saving from
the GUI never breaks the composition.

### By hand (no CLI)

The plugin must be resolvable from the profile's `node_modules`, so it is copied
there:

```powershell
# from the repository root
pwsh -File scripts/install.ps1
```

The script copies the package into the profile's `node_modules` and inserts the
entry into `cordis.patch.yml`:

```yaml
- insert:
    - id: feishu
      name: dsh-feishu
      config:
        appId: cli_xxxxxxxxxxxx
        # appSecretRef: FEISHU_APP_SECRET
        # brand: feishu          # or lark
        # defaultFolderToken: fldcnxxxxxxxx
```

**Restart DeepSeek Harness.** The host half is a Node module cached in-process,
so a reload alone does not pick it up. The browser half reloads with the page.

After that first restart, use **设置 → 飞书 / Feishu** instead of editing the YAML:
the page rewrites the block the installer added and the harness hot-reloads it.

### Why the package avoids `@deepseek-ai/*` imports

A third-party plugin is loaded from a junction or a copied directory inside the
profile, where a bare `@deepseek-ai/dsh-tools` specifier resolves to whichever
DSH installation is reachable — which may not be the running host. The host half
therefore imports **only Node builtins** and hand-writes its tool definitions
and its configuration validation. The test suite checks every generated schema
against the real SDK validator, so the hand-written form cannot drift from what
the registry accepts.

---

## Configuration

All fields are optional except `appId`.

| Field | Default | Meaning |
|---|---|---|
| `appId` | — | The Feishu app id. Required. |
| `appSecretRef` | `FEISHU_APP_SECRET` | Credential reference resolved through the harness credential store, then the environment. |
| `appSecret` | `''` | Literal fallback. Discouraged: it puts a secret in configuration. |
| `brand` | `feishu` | `feishu` (open.feishu.cn) or `lark` (open.larksuite.com). |
| `apiBaseUrl` / `accountsBaseUrl` | per brand | Override the endpoints (for a proxy or a private gateway). |
| `defaultFolderToken` | `''` | Where new documents, sheets, Bitable apps, and uploads go when a call omits a folder. |
| `defaultIdentity` | `auto` | `auto`, `user`, or `app`. `auto` uses the user when authorized and otherwise the app, reporting the fallback. |
| `toolPrefix` | `feishu_` | Rename the tools (for example `fs_`). |
| `requestTimeoutMs` | `30000` | Per-attempt timeout. |
| `maxRetries` | `2` | Total attempts for rate-limited or transient failures (capped at 6). |
| `enableTools` | `true` | Register the model-facing tools. |
| `enableOAuth` | `true` | Mount the `/api/feishu/*` routes (status, activity, config, OAuth). |
| `enableUi` | `true` | Show the floating panel. |
| `oauthRedirectUri` | auto | Override the callback. Empty means "use the host webserver's loopback address". |
| `oauthScopes` | recommended set | Scopes requested by the authorization flow. |
| `registerSystemPrompt` | `true` | Append the Feishu guidance section to the system prompt. |
| `activityLogSize` | `50` | Entries retained for the browser panel. |
| `maxRecordsPerPage` | `500` | Page-size cap for paginated Feishu reads. |
| `patchFilePath` | auto | The profile patch file the settings page edits. Not writable from the browser. |
| `userAccessToken` | `''` | Static user token for headless use; skips OAuth entirely. |

Environment fallbacks: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_BRAND`,
`FEISHU_FOLDER_TOKEN`, `FEISHU_USER_ACCESS_TOKEN`.

---

## The two Bitable API generations

The plugin uses both, deliberately:

- **V1** (`/bitable/v1/apps/...`) for apps, tables, fields, and records. It is the
  documented public API, and it is what the official Lark/Feishu SDK ships.
- **V3** (`/base/v3/bases/...`) for the two capabilities V1 does not have at all:
  dashboards with charts, and server-side aggregation. Note the resource is
  `bases`, not `apps` — the V1 and V3 paths are not interchangeable, and asking
  the wrong one answers a plain-text `404 page not found`, not a business error.

V3 is newer than the published SDK, so it is not discoverable from the SDK's
typings; the shapes here were taken from the official
[Lark CLI](https://github.com/larksuite/cli) and verified against the live API.

| | V1 | V3 |
|---|---|---|
| Field types | numbers (`1` = text) | strings (`"text"`) |
| Records | row objects `{record_id, fields}` | columnar `data` matrix + `field_id_list` |
| Batch writes | `{records: [{fields}]}` | `record_id_list` / `by_filter` + `patch` |
| Aggregation | none | `POST .../data/query`, a DSL naming tables and fields |
| Charts | none | `dashboards` + `dashboards/{id}/blocks` |

A chart block is described by one `data_config` object, which names a table and
its fields rather than addressing them by id:

```json
{
  "table_name": "订单表",
  "series": [{ "field_name": "金额", "rollup": "SUM" }],
  "group_by": [{ "field_name": "类别", "mode": "integrated", "sort": { "type": "value", "order": "desc" } }],
  "filter": { "conjunction": "and", "conditions": [{ "field_name": "状态", "operator": "is", "value": "已完成" }] }
}
```

Use `count_all: true` instead of `series` to count rows, and `{"text": "…"}`
for a `text` block. Aggregations live in `feishu_query` rather than here, so a
question like "which region sold most" is one call instead of a table scan.

## How it works

```
lib/
  index.js        composition root: config, identity, client, tools, routes
  config.js       normalization, brand endpoints, defaults
  identity.js     app credentials, tenant/app tokens, user grant, OAuth, refresh
  http.js         one HTTP request: timeout, bounded retries, byte ceiling
  client.js       the Feishu wire contract: envelope, auth, multipart, pagination
  errors.js       failure shaping and per-code remediation hints
  local-file.js   path resolution against the session workspace, upload/download
  activity.js     bounded in-memory record for the panel
  entry-config.js safe reader/writer for this plugin's own loader entry
  routes.js       /api/feishu/{status,activity,config,oauth/*}
  tools/
    kit.js        JSON-Schema-subset validator, definition helper, result envelope
    auth.js  bitable.js  docx.js  sheet.js  drive.js  wiki.js  im.js  raw.js
    index.js      assembly, prefixing, activity tracing
  ui/client.js    browser half: the floating panel and the settings page
```

### The settings page

The page is self-contained: it talks to this plugin's own
`/api/feishu/config` endpoint rather than the harness settings service, so the
plugin keeps importing nothing from the SDK. A save does three things:

1. validates every field against the table in `routes.js` — the redirect URL and
   the API base URLs must be `http(s)://`, the brand and identity are
   enumerations, the numeric fields are range-checked, and `patchFilePath` is not
   writable from the browser at all;
2. rewrites **only this plugin's entry** in the profile patch file, which the
   harness hot-reloads. `entry-config.js` accepts only a path shaped like
   `.../profiles/<name>/cordis.patch.yml`, locates the block by its markers (or
   by a structural scan for the entry that names the plugin), carries over any
   key the page does not manage verbatim, writes atomically, and keeps one
   backup;
3. stores the App Secret through `ctx.credentials.set`, so the secret never
   reaches the file and is never returned by any endpoint.

A field submitted as `null` is removed from the entry, which is how the page
resets a value to the plugin default.

### Token custody

- **App secret** — resolved through the credential store, then the environment,
  then literal configuration. It never leaves the host and is never returned by
  the status endpoints.
- **Tenant / app access tokens** — minted on demand, cached in memory, re-minted
  two minutes before expiry, single-flight so concurrent calls do not race.
- **User access token** — a durable grant, so it lives in the credential store
  as the record `dsh-feishu/user-token`, together with its refresh token, and
  survives restarts. It is refreshed lazily when it nears expiry, and once more
  if Feishu rejects it mid-call.

### Failure handling

Feishu reports business failures as HTTP 200 with a non-zero `code`. The client
unwraps both shapes into a `FeishuError` carrying the code, the HTTP status, the
path, any `permission_violations`, and a remediation hint. A token-expiry code
earns exactly one automatic refresh-and-retry; everything else is surfaced with
the hint attached, because "the app lacks a scope" and "the user never
authorized" need different fixes.

### Identity

Every tool takes an `identity` argument (`auto`, `user`, `app`). `user` puts
new documents in the authorized person's drive and is the default; `app` acts as
the application. `auto` prefers the user and, when none is stored, uses the app
**and reports the fallback as a warning**, so a document never quietly ends up in
the wrong drive.

---

## Development

```bash
npm test          # or: node test/run-tests.mjs
```

The suite runs without the harness. It drives a mock Feishu tenant through a
fake `fetch`, and it validates two things against the **real** DSH SDK rather
than a local reimplementation:

- every tool parameter and output schema passes the SDK's
  `assertSupportedJsonSchema`;
- every parameter schema renders through `jsonSchemaToTs`, so PTC mode keeps
  working.

The SDK is deliberately not a dependency, so the suite looks for the real
`@deepseek-ai/dsh-tools` in the usual profile and global locations and skips
those two checks when it cannot find it (which is what happens in CI). Point
`DSH_TOOLS_PATH` at `dsh-tools/lib/index.js` to force a specific copy.

### Live tests against the real Feishu API

`npm test` proves the code is self-consistent. It cannot prove Feishu agrees, so
`test/live/` drives the same tool definitions against the real open platform.

```bash
npm run test:live:list      # print the 61 cases; sends no request
npm run test:live           # run them all, then clean up (about 2 minutes)
node test/live/feishu-live.mjs --only=doc    # one family: auth api drive doc
                                             # sheet bitable query dashboard
                                             # wiki message
node test/live/feishu-live.mjs --keep        # leave the artifacts in place
```

It needs a working installation (app id from the profile patch, app secret and
user grant from the credential store) and it takes its safety rails seriously:

- the credential store is mounted **read-only**, because a refresh rotates a
  single-use token — a half-written grant would be unrecoverable. The run
  asserts `grant rotated: false` at the end;
- `feishu_auth logout` and `complete` are never called;
- every artifact is named `DSH-TEST-<stamp>` and deleted at the end; sent
  messages are recalled by the identity that sent them;
- messages only ever go to the authorizing user's own open_id.

Results are written to `test/live/last-run.json` (gitignored) and summarised in
`docs/feishu-test-report.md`. Exit code is 0 only when no case failed; a blocked
case (the app console has not granted a scope) is reported as `blocked`, not
`fail`, because no code change can clear it. See
[`docs/feishu-issue-fix-log.md`](docs/feishu-issue-fix-log.md) for the defects
this harness found.


---

## Security notes

- The app secret is read by reference and never returned over HTTP; the status
  endpoint reports only whether it is set and where it came from.
- The OAuth routes are loopback-only and same-origin. The callback validates the
  `state` it issued and refuses a mismatch.
- Bearer tokens are never logged, and the activity ring stores summaries and
  URLs, not credentials.
- `feishu_api` is a full escape hatch by design. Register it only in
  compositions where the agent is trusted with the app's scopes.

## Uninstall

```powershell
pwsh -File scripts/uninstall.ps1
```

Then restart DeepSeek Harness and delete the stored grant if you want the user
authorization gone as well.

## Related projects

Feishu / Lark integrations are a crowded space, so it is worth being precise
about what this plugin is and is not. Everything below is a point-in-time
description; follow the links for the current state.

### Official

- **[larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)**
  (MIT, npm `@larksuiteoapi/lark-mcp`) — the official Model Context Protocol
  server, and by far the broadest option: it wraps the published OpenAPI as MCP
  tools with presets, spanning IM, calendar, contacts, approval, drive, and more.
  Two caveats matter for document work, and both come from its own README and
  tool list: editing Feishu cloud-document *content* is stated as unsupported
  (import and read only), and its Bitable coverage is the V1 surface, where a
  dashboard appears only as `list` and `copy` — no creating or updating a
  dashboard or a chart block, and no aggregation.
- **[larksuite/cli](https://github.com/larksuite/cli)** — the official CLI, with
  `lark-base` skills and reference documents. This plugin's V3 endpoint shapes
  and its `data_config` schema were taken from here and then verified against
  the live API.

### Community Feishu MCP servers

- [shou-nian/feishu-mcp-server](https://github.com/shou-nian/feishu-mcp-server)
- [leemysw/feishu-docx](https://github.com/leemysw/feishu-docx) — Docs, Sheets,
  and Bitable in both directions with Markdown, built for agents

### Other DeepSeek Harness plugins

The DSH plugin market lists well over a hundred Feishu/Lark plugins, but the
overwhelming majority are **IM bridges** — talk to your agent from Feishu,
approval cards, notifications — which is a different job from this one. The
closest in kind are:

- [zhengjy01/dsh-feishu-mcp](https://github.com/zhengjy01/dsh-feishu-mcp) — Feishu
  OpenAPI exposed to DSH over MCP
- [Mr-SYGao/dsh-feishu-reader](https://github.com/Mr-SYGao/dsh-feishu-reader) —
  reads Feishu docs, wiki, sheets, and Bitable (read-only)
- [meliwanx/dsh-office-cli](https://github.com/meliwanx/dsh-office-cli) — wraps
  the official WeCom / DingTalk / Feishu CLIs
- [shrekcg/dsh-im-channel](https://github.com/shrekcg/dsh-im-channel) — IM access
  that also bundles a set of Feishu MCP tools

### What is different here

This plugin is deliberately narrow and deep. Where it goes beyond the
alternatives above:

- **Writing, not just reading** — Markdown converted into native document blocks,
  local files imported server-side, spreadsheet writes, Bitable records.
- **Charts and dashboards** through the V3 API, including reading back a chart's
  computed numbers.
- **Server-side aggregation** (`feishu_query`), so "top N by …" is one call
  instead of a table scan.
- **User-identity OAuth** with an auto-refreshing grant, so new content lands in
  the user's own drive rather than the app's space.
- A **visual settings page**, and errors carrying a per-code remediation hint.

For anything outside that list — calendar, approval, contacts, IM — reach for the
official MCP or the official CLI, or use the `feishu_api` escape hatch.

---

## License

[MIT](LICENSE) © 2026 Run Liu

Feishu, Lark, and 飞书 are trademarks of their respective owners. This project
is an independent integration and is not affiliated with or endorsed by them.
