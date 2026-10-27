# DSH Third-Party Plugin Package Contract — v0.1.2-alpha.2

Evidence base: `/Users/zyf/Project/deepseek-harness-dsh-v0.1.2-alpha.2` (read-only survey).
`path:line` always relative to that checkout root. `UNVERIFIABLE` marks anything I could not confirm.

**One-sentence summary.** A third-party DSH plugin is an ordinary npm package that (a) declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` so `dsh plugin add` appends it as a profile
layer, (b) ships a `cordis.patch.yml` whose top-level YAML array does `- insert: [{ id, name, config? }]`
to mount its own module as a Cordis loader entry, and (c) exports a Cordis plugin (`apply(ctx, config)`)
from the module `name` points at — optionally plus a browser half via `dsh.client` + `exports["./client"]`.

---

## 1. Profile / bundle resolution

**Where a profile lives.** `$DSH_HOME/profiles/<name>/` holds `package.json` (deps + `dsh.profile`) and
`cordis.patch.yml` (the user layer). Directory resolution and name validation:
`packages/boot/app-boot/src/profile.ts:5-13` (module doc), `:41-44` (`PROFILES_DIR='profiles'`,
`PROFILE_PATCH_FILENAME='cordis.patch.yml'`), `:127-134` (`resolveProfileDir`; rejects `/`, `\`, `.`,
`..`, `node_modules`).

**Manifest shapes (exact).**

- `dsh.bundle` = `{ patch: string }` — `packages/boot/app-boot/src/profile.ts:50-53`
- `dsh.profile` = `{ bundles?: string[], patchReload?: 'live' | 'startup' }` — `profile.ts:56-61`, `:64`
- Reader interface: `ProfileManifest { name?, dependencies?, peerDependencies?, dsh? }` — `profile.ts:86-91`
- Shipped templates (bundle order): `profile.ts:137-158` — `web: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`
  with `patchReload: 'live'`; `headless`/`sdk`/`acp` use `'startup'`; `sdk-minimal` is its own single bundle.
- Default for a name with no template: `['@deepseek-ai/dsh-base']` (`profile.ts:166`).

**How the tree is built.** `loadProfile` (`profile.ts:805-844`): reads `manifest.dsh?.profile?.bundles ?? []`
(`:821`), and for each name resolves the package dir, reads that package's `package.json`, requires
`dsh.bundle.patch`, and parses the file:

```
profile.ts:829-838
  const layers = bundles.map((packageName) => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir,'package.json'),'utf8'))
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) throw new Error(`... profile bundle "X" declares no dsh.bundle ...`)
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
```

Missing declaration error text: `profile.ts:833-835`. Resolution order is **installation anchor first,
then profile dir** — `resolveBundleDir` (`profile.ts:778-789`), error text `:785-788`. Directory probing
does *not* require the package to export `./package.json` (`profile.ts:745-764`).

**Patch semantics — the only implementation.** `applyEntryPatches` in
`vendor/include/src/index.ts:58-128` (shared by mounting and `--dump-config`, `:43-57`). A patch file is
**a top-level YAML array**; each element is a `PatchOptions`:

```
vendor/include/src/index.ts:145-156
  interface PatchOptions {
    id?: string; insert?: EntryOptions[]; name?: string; config?: any
    group?: boolean | null; disabled?: boolean | null
    inject?: any; intercept?: any; isolate?: any
    [key: string]: any
  }
```

Operations, exactly:

| Operation | Shape | Behaviour | Evidence |
|---|---|---|---|
| insert (root) | `- insert: [ {id,name,config?}, … ]` | appends rows to the entry list | `include/src/index.ts:93-95` |
| insert (into group) | `- id: <groupRowId>` + `insert: [...]` | pushes into that group's `config` array (must be `group: true`) | `:81-92`; warns `patch insert: entry %C not found` / `is not a group` |
| config override | `- id: X` + `config: {...}` | **replaces** `target.config` wholesale (no deep merge) | `:121-124` |
| disable / enable | `- id: X` + `disabled: true` | sets the row field | `:121-124` |
| any other row field | `- id: X` + `inject:`/`group:`/`intercept:`/`isolate:` | assigned verbatim (index signature) | `:121-124`, `:155` |
| name assertion | `- id: X` + `name: 'expected'` | *guard*: skip + warn if row's name differs | `:116-119` |
| expression values | `!!js <expr>` | round-trips as an expression node evaluated at activation | `:9-25` (`entryListSchema`) |

`EntryOptions` (fields an `insert` row accepts): `id` (required), `name` (required), `config?`,
`group?`, `disabled?`, `inject?` — `vendor/loader/src/config/entry.ts:9-22`.
A non-insert patch **without** `id` warns-and-skips (`include/src/index.ts:105-108`); a patch whose
`id` matches nothing warns-and-skips (`:110-114`) — a bundle patch that targets nothing does **not** fail
boot. But a *malformed* patch file (not an array, non-mapping element, unparseable YAML) throws —
`packages/boot/app-boot/src/index.ts:335-353`.

**Composition order** (later layer wins per row): bundle patches in `dsh.profile.bundles` order →
profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → each `--patch` in argv order.
`apps/cli/src/profile-boot.ts:136-143`, `:156-173`; canonical doc `docs/user/develop/basic/publish.md:114-126`,
`apps/cli/reference/README.md:9`.

**Mount.** The profile root `cordis.yml` is a pinned empty array (`apps/cli/src/profile-boot.ts:79-87`)
rewritten each boot (`:118-122`); `boot()` sets `ctx.baseUrl` to the profile dir and mounts one
`cordis:include` entry whose `config.patches` is the flattened layer stack —
`packages/boot/app-boot/src/index.ts:772-819`, `:501-538`.

> **Third-party checklist (1).** Ship `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` in
> package.json and list the patch file in `files`. In `cordis.patch.yml` use a top-level YAML array with
> `- insert:` rows carrying `id` + `name` (package name, not a relative path) + optional `config`. Use
> `- id: <existingRow>` + `config:`/`disabled:` to override earlier layers, restating the **whole**
> `config` object. Never rely on deep merge.

---

## 2. Loader entry / node naming

**Import path.** The loader tree imports each entry's `name` through
`vendor/loader/src/config/tree.ts:144-162`: `cordis:` builtins short-circuit (`:146-148`); otherwise
`ctx.loader.internal.import(name, ctx.baseUrl, {})` (Node's internal ESM loader, `:154-155`), or for
Node-less runtimes a relative URL resolved against `baseUrl` (`:156-157`) or a bare `import(name)` (`:159`).

**Registration.** `Entry._init` → `loader.unwrapExports(import(name))` → `_start` →
`ctx.registry.plugin(plugin, options.config, stack)` — `vendor/loader/src/config/entry.ts:277-302`.
`registry.plugin` accepts a function, a class, or an object with `apply` and throws otherwise:

```
vendor/cordis/src/registry.ts:9     const isApplicable = (o) => o && typeof o === 'object' && typeof o.apply === 'function'
vendor/cordis/src/registry.ts:316-336   plugin(plugin, config?, ...)   // uses plugin.name, plugin.Config, plugin.inject
vendor/cordis/src/registry.ts:319        throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
```

**Export normalisation** (so ESM/CJS/esbuild interop all work):
`vendor/loader/src/index.ts:191-199` — `exports.default ?? exports`, then `exports.default ?? exports` again
when `__esModule` is set. So `export default function apply(ctx){}`, `export function apply(){}`,
`export default class X extends Service`, and `module.exports = fn` all work.

**Exact failure message on import failure:**

```
vendor/loader/src/config/entry.ts:24-27
  function updateError(stage: 'import'|'dispose'|'apply'|'rollback', options, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return new Error(`failed to ${stage} loader entry ${options.id} (${options.name}): ${detail}`, { cause })
  }
```

i.e. **`failed to import loader entry <id> (<name>): <detail>`** — asserted verbatim in
`packages/client/ui-agent-preset/tests/apply.client.spec.ts:601`
(`'failed to import loader entry ctx (@deepseek-ai/dsh-gone): Cannot find package'`).
Boot wraps it once more as `<bin>: plugin tree failed to load: …` plus the deepest stack
(`packages/boot/app-boot/src/index.ts:801-818`), and after settling audits entries
(`assertEntriesLoaded` / `assertEntriesActivated`, `:679-687`, `:698-…`).

**Exports a plugin module should have** (all optional except `apply`):

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `apply` | `(ctx: Context, config: Config) => void \| Promise<void>` | the plugin body | `vendor/cordis/src/registry.ts:130-132, 316-336` |
| `name` | `string` | diagnostic name; also `plugin.name` | `registry.ts:324-326` |
| `inject` | `string[]` | services to wait for before `apply` | `registry.ts:330`; `docs/user/develop/basic/index.md:89-97` |
| `Config` | `Schema<Config>` (schemastery) | validates/normalises `config` | `registry.ts:326`; `docs/user/develop/basic/config.md:9-45` |
| `default` | anything above | ESM default interop | `vendor/loader/src/index.ts:191-199` |

> **Third-party checklist (2).** Export `apply(ctx, config)` (plus `name`, and `inject` for every service
> you touch). Reference the module from a patch row as the **bare package name** (`name: 'my-pkg'`) or an
> exported subpath (`name: 'my-pkg/startup'`); relative `./x` names are anchored to the *patch file's*
> directory (`packages/boot/app-boot/src/index.ts:310-321`), which is wrong for a bundle.

---

## 3. Host vs client split

**Declaration.** `package.json` → `dsh.client = { platform: string, inject?: string[], external?: string[],
immediately?: boolean }`. Parser and its exact errors:
`packages/client/modules/src/index.ts:200-221` (`has a non-object dsh.client declaration`,
`dsh.client.platform must be a string`, `dsh.client.inject`/`external` must be string arrays via
`optionalStringArray`, `dsh.client.immediately must be a boolean`).

**`platform` is a discriminator, not a free field.** Only `"web"` participates:
`index.ts:756` — `if (decl === undefined || decl.platform !== 'web') { this.pkgMeta.set(sourceKey, null); return null }`.
All 50 declarations in the workspace are `"web"` (grep of `"platform"` in `packages/**/package.json`).

**The bundle module.** `exports["./client"]` is required and must resolve to a file inside the package:

- `clientExportOf` — `index.ts:223-234`; accepts a string or `{ default: string }`; throws
  `exports["./client"] must be a string or an object with a string default`
- `index.ts:760-763` — throws `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`
- resolved to `join(dirname(pkgPath), clientRel)` — `index.ts:765`

**Discovery is by loader entry, not by node_modules scan.** The service `ClientModuleRegistry`
(`static inject = ['webServer','loader']`, `index.ts:533-534`) walks `ctx.loader.entries()`
(`:577`), resolves each entry's specifier back to its owning `package.json`
(`resolveMeta`/`locatePkgJson`, `:738-804`) and keeps only `platform === 'web'` packages. So **the host
half must itself be mounted as a loader row** for the browser half to exist.

**Build format — no Vite step for plugins.** Client bundles are *lazy-CJS closure factories*:

```
packages/client/ui-settings/lib/client.js:1-5   (built artifact)
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-settings",
  factory: (require) => {
    var module = { exports: {} }; …
    let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
```

The preset that emits this is `packages/client/tsdown.client.ts:1-9` ("Emits a closure-factory artifact:
the bundle calls `window.__ModuleLoader__.load({id, factory})` and resolves externals through the injected
require"). `apps/web` Vite builds only the **shell** and is explicitly not standalone:
`apps/web/vite.config.ts:9-12` (`apps/web is not a standalone application: bare Vite cannot inject
window.__DSH_BOOT__`).

**Serving + manifest.** Two artefacts, no build coupling to the shell:

1. **HTTP route**: `ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle })`
   — `index.ts:585-588`. Per-plugin URL `/plugins/<id>/client.js` (`:302-308`), plus a combo endpoint
   `/plugins/??<id>/client.js,<id2>/client.js&rev=<rev>` (`:253-256`).
2. **Injected manifest**: on every index render a `webserver/index-inject` listener pushes the boot
   injection rows (`index.ts:589-591` → `bootInjections`, `:489-524`): an inline script that installs
   `window.__ModuleLoader__` (`:491-512`), `script-preload`/`script-src` rows for the combo batches, and
   `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` (`:522`).

Wire types: `WebBootGraph { rev, entries: WebBootEntry[], batches: WebBootBatch[] }`,
`WebBootEntry { id, url, rev, inject?, immediately?, external? }` —
`packages/client/modules/src/client/manifest.d.ts` (`WebBootEntry` / `WebBootGraph` / `DshWindow`).
`inject` there is **package-name edges**, not service ids: "Package-name dependency edges used for factory
arrival and plugin composition".

**Valid module specifiers a bundle may `require()`** — the shell's frozen seed table, exactly 8:
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
`@deepseek-ai/dsh-client-ui-primitives` — `packages/client/web/src/platform.ts:8-13`.
Anything else must be another `dsh.client` row, declared in `external` (self-reference is an error,
`index.ts:454-461`; cycles throw `module graph cycle …`, `:446-452`). Everything else is inlined; the
cross-plugin value-import purity gate rejects the rest (`docs/cookbook/adding-a-settings-card.md:93-100`).

Canonical dual-face manifest to copy: `packages/client/modules/package.json` (`dsh` block:
`{"client":{"platform":"web","inject":[],"immediately":true}}`), `packages/client/ui-theme/package.json:32-45`.

> **Third-party checklist (3).** For a browser half add `dsh.client = { platform: "web", inject: [...] }`
> where `inject` lists the *client packages* whose factories must arrive first, add
> `exports["./client"]`, publish a `lib/client.js` in the `window.__ModuleLoader__.load({id, factory})`
> format (no published preset exists — reproduce it yourself, see
> `docs/cookbook/adding-a-settings-card.md:93-97`), and make sure the host half is mounted as a loader row.
> No plugin build step is registered with the web shell; drop the file and the page picks it up on next load.

---

## 4. Peer dependency expectations

**No runtime compatibility check exists.** I grepped `engines`, `dshVersion`, `requiresDsh`, `compatib*`,
`peerDependencies` across `packages/boot`, `apps/cli/src`, `packages/client/modules/src`,
`packages/host/plugin-inventory` — **zero** hits. Nothing inspects a plugin's `peerDependencies` at load
time. The only `peerDependencies` inspection in the repo is the *in-repo* lint
`scripts/check-workspace-constraints.ts:354-368` ("`@deepseek-ai/cordis` must be a peerDependency", must also
be a devDependency with matching range) — that gate only runs over `packages/`, not over user profiles.

**What actually keeps one `cordis` instance** is the linker, not a check: profiles are initialized with
`nodeLinker: hoisted` + `autoInstallPeers: false` so missing peers fall through to the healed
`$DSH_HOME/profiles/node_modules` installation fallback —

```
packages/boot/app-boot/src/profile.ts:177-187   PROFILE_PNPM_WORKSPACE = "packages: [.]  nodeLinker: hoisted  autoInstallPeers: false"
packages/boot/app-boot/src/profile.ts:15-22     (module doc: two-anchor resolution, single cordis instance)
apps/cli/src/profile-boot.ts:161                await healProfilesModuleFallback({ installAnchor, profile })
apps/cli/reference/README.md:11                 "A bare plugin name in any patch row resolves through the profile directory's Node parent walk, which reaches the maintained installation fallback $DSH_HOME/profiles/node_modules"
```

So declaring `@deepseek-ai/*` peers is **a correctness convention, not a loader requirement**: with
`autoInstallPeers: false` pnpm will not install them, and Node resolves them up the fallback walk.

**Canonical in-repo template** — `packages/bundle/web-app/package.json`:

```jsonc
"type": "module", "main": "lib/index.js", "types": "lib/types/index.d.ts",
"exports": { ".": {...}, "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
"files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
"peerDependencies": { "@deepseek-ai/cordis": "workspace:^", "@deepseek-ai/cordis-plugin-loader": "workspace:^", ... },
"devDependencies":  { /* same set, same ranges */ }
```

Client plugin equivalent: `packages/client/ui-theme/package.json:46-49` (`peerDependencies:
{"@deepseek-ai/cordis": "workspace:^"}`) with the peer mirrored into `devDependencies`.
Out-of-tree, replace `workspace:^` with the resolved range (all these packages are `access: public`).

> **Third-party checklist (4).** Declare `@deepseek-ai/cordis` (and any `@deepseek-ai/dsh-*` you import)
> in `peerDependencies` — **and** in `devDependencies` with the same range so you can build. Do not expect
> the loader to verify or warn; do not bundle your own copy of `@deepseek-ai/cordis`.

---

## 5. Tool registration

**API.** `ctx.tools.register(definition) => dispose`, where `definition` must carry
`output: { schema, render, presentationMeta? }`:

```
packages/core/tools/src/index.ts:1028-1054
  register(definition: ToolDefinition): () => void {
    if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function' …)
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    if (name === RUN_CODE_NAME) throw new Error(`tool name "${RUN_CODE_NAME}" is reserved …`)   // 'run_code'
    return this.layers.effect(this.ctx, … , { label: 'tools.register()' })
  }
```

Registration is an *effect* on the caller's fiber (auto-unwinds on unload). Scoped tools shadow globals
(`index.ts:1022-1027`). The typed helper `defineTool` is exported from `@deepseek-ai/dsh-tools`
(`packages/core/tools/src/index.ts:59`).

**Minimal working in-repo example** — `packages/interaction/tool-ask-user/src/index.ts:9-21`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-ask-user'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: { questions: { type: 'array', required: true, … } },
    output: { schema: { type: 'object', … }, render: … },
    async execute(args) { … },
  }))
}
```

The shortest documented form is `docs/user/develop/basic/tool.md:11-36`; policy hooks
(`tools/pre-execute`, `guard()`, `restrict()`) are listed in `docs/cookbook/extension-cookbook.md:7-33,113`.
`ctx.tools` arrives via `inject = ['tools']`; omitting it makes the row wait forever (see §2).

> **Third-party checklist (5).** `export const inject = ['tools']`, then
> `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`.
> `output.schema` + `output.render` are mandatory; `name: 'run_code'` is reserved.

---

## 6. Settings / config schema

**Two different things, do not conflate.**

- **Plugin `config`** (from the patch row) — export `const Config: Schema<Config>` from the plugin module
  using `@deepseek-ai/schemastery`; Cordis validates and fills defaults at load.
  `docs/user/develop/basic/config.md:9-45`; applied by `registry.plugin` via `plugin.Config`
  (`vendor/cordis/src/registry.ts:326`). A plain object is rejected — "it does not implement the Standard
  Schema interface required by Cordis" (`config.md:45`).
- **User settings namespace** (editable in the Web UI at runtime) — `ctx.settings`:

```
packages/settings/settings/src/index.ts:419-459   register(ns, schema: z<T>, options?: { base?, applies?: 'live'|'restart', validate? }): SettingsScope<T>
packages/settings/settings/src/index.ts:472-496   installSection(owner, ns, schema, entry, hooks)   // layers the cordis row as `base`, keeps working with no settings provider
packages/settings/settings/src/index.ts:40        ns must match NAMESPACE_PATTERN (lowercase hyphenated)
packages/settings/settings/src/index.ts:77-102    SettingsDescriptor { ns, schema: schema.toJSON(), value, revision, base?, user?, applies, secrets? }
```

Real call site: `packages/preset/agent-presets/src/index.ts:189-193` —
`settingsCtx.settings.register(SETTINGS_NAMESPACE, AgentPresetSettingsSchema, { base: … })`, guarded by
`ctx.inject(['settings'], …)`.

**How the Web UI picks it up — automatically, keyed by namespace.** No DSH-repo change needed:
"the Host serves every registered settings namespace, and the **Plugins** section keys its cards on the
namespace they edit, so a plugin that registers both halves is paired up automatically"
(`docs/cookbook/adding-a-settings-card.md:5-9`). The browser half registers a card into the keyed slot
`settings.plugin.item` under that same namespace
(`docs/cookbook/adding-a-settings-card.md:47-66`; slot type declared at
`packages/client/ui-settings-plugins/src/client/slot-contract.ts:19`;
`packages/client/ui-settings-plugins/src/index.ts:1-9`: "the browser half owns the section and its
configurable tab through `exports["./client"]`, discovered from the package.json dsh.client declaration").
"A card is rendered when the Host serves its key and skipped when it does not"
(`adding-a-settings-card.md:68-76`). `role('secret')` fields are stripped from every response (`:42-43`;
`SettingsDescribeOptions.redactSecrets`, `settings/src/index.ts:104-112`).

> **Third-party checklist (6).** For load-time config: export a schemastery `Config`. For user-editable
> settings: pick one lowercase-hyphenated namespace, call `ctx.settings.installSection(...)` (or
> `ctx.settings.register`) inside `ctx.inject(['settings'], …)`, and give the browser half a card in slot
> `settings.plugin.item` with `key === namespace`. Skip the card and the namespace simply renders nothing.

---

## 7. Web routes / HTTP

**Package:** `@deepseek-ai/dsh-host-webserver` (v0.1.2-alpha.2,
`packages/host/webserver/package.json`), exposed as `ctx.webServer` — declared
`packages/host/webserver/src/index.ts:22-25`.

**Registration API** (`packages/host/webserver/src/index.ts`):

| Call | Shape | Evidence |
|---|---|---|
| `ctx.webServer.register(route)` | `{ kind: 'exact' \| 'prefix', path: string /* no trailing slash */, handler(req,res) }` → disposer | `:41-48`, `:165-172` |
| `ctx.webServer.registerUpgrade(route)` | `{ path, handler(req, socket, head) }` → disposer (WebSocket/SSE upgrade) | `:50-56`, `:180-186` |
| `ctx.webServer.registerFallback(handler)` | one fallback seat (SPA dist server) | `:196-200` |
| `ctx.on('webserver/index-inject', table)` | push `IndexInjection` rows into the served `index.html` | `:26-35` |

Duplicate `(kind, path)` throws: `webserver: duplicate exact route "…"` (`:168-169`); duplicate upgrade
throws `:182-183`; second fallback throws `webserver: fallback already registered` (`:197-198`).
Routes register before listen and resolve to 404 until claimed (`:119-123`). `kind: 'prefix'` matches `p`
and `p/<anything>` (`:38`). Handler owns the full response lifecycle, so SSE is allowed (`:46-47`).
Config: `{ host: '127.0.0.1'|'0.0.0.0', port: number, compression?: 'none'|'gzip', compressionLevel?,
compressionThresholdBytes? }` — `:58-70`; mounted in the web bundle at
`packages/bundle/web-app/cordis.patch.yml:111-120`.

Real call sites to copy: `packages/webhook/webhook-github/src/index.ts:59`,
`packages/client/connection/src/index.ts:127` (both wrap in `ctx.effect(...)` so the route dies with the
fiber). `webserver` is a service you must `inject` (`static inject = ['webServer','loader']`,
`packages/client/modules/src/index.ts:534`).

> **Third-party checklist (7).** `export const inject = ['webServer']`, then
> `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/oauth/callback', handler }), 'my-plugin: route')`.
> Pick a path prefix you own; a duplicate path throws at activation.

---

## 8. Version drift (installed / workspace versions)

Resolved from `vendor/*/package.json` and `packages/*/*/package.json` in this checkout. Every DSH package
in the monorepo is pinned to the root version (enforced by `scripts/check-workspace-constraints.ts:363-365`).

| Package | Version | Source |
|---|---|---|
| `@deepseek-ai/cordis` | **4.0.2** | `vendor/cordis/package.json` |
| `@deepseek-ai/cordis-plugin-loader` | **1.0.3** | `vendor/loader/package.json` |
| `@deepseek-ai/cordis-plugin-include` | **1.0.7** | `vendor/include/package.json` |
| `@deepseek-ai/schemastery` | **3.18.2** | `vendor/schemastery/package.json` |
| `@deepseek-ai/dsh-tools` | **0.1.2-alpha.2** | `packages/core/tools/package.json` |
| `@deepseek-ai/dsh-settings` | **0.1.2-alpha.2** | `packages/settings/settings/package.json` |
| `@deepseek-ai/dsh-client-ui-settings` | **0.1.2-alpha.2** | `packages/client/ui-settings/package.json` |
| `@deepseek-ai/dsh-client-ui-slots` | **0.1.2-alpha.2** | `packages/client/ui-slots/package.json` |
| `@deepseek-ai/dsh-host-webserver` | **0.1.2-alpha.2** | `packages/host/webserver/package.json` |
| `@deepseek-ai/dsh-client-modules` | **0.1.2-alpha.2** | `packages/client/modules/package.json` |
| `@deepseek-ai/dsh-client-web` (the shell) | **0.1.2-alpha.2** | `packages/client/web/package.json` |
| `@deepseek-ai/dsh-app-boot` | **0.1.2-alpha.2** | `packages/boot/app-boot/package.json` |
| `@deepseek-ai/dsh-base` / `dsh-web-app` | **0.1.2-alpha.2** | `packages/bundle/{base,web-app}/package.json` |
| **`@deepseek-ai/dsh-client-runtime`** | **does not exist in this version** | not found by name across `packages/`, `apps/`, `vendor/`; nearest equivalents are `@deepseek-ai/dsh-client-modules` (the browser module system's node half + `./client`), `@deepseek-ai/dsh-client-web` (shell), `@deepseek-ai/dsh-client-store`, and test-only `@deepseek-ai/dsh-client-test-runtime` (`packages/test-support/client-runtime/package.json`). |

Toolchain: `packageManager: pnpm@11.7.0`, `engines.node: ^22.19.0 || >=24.0.0` —
`package.json:1-10`. Profile pnpm settings: `nodeLinker: hoisted`, `autoInstallPeers: false`
(`packages/boot/app-boot/src/profile.ts:182-187`). `node_modules/@deepseek-ai` at the checkout root holds
only two hoisted strays (`dsh-tool-session-query`, `dsh-web-fetch-http`); real installs are per-package
symlinks into `vendor/`/`packages/` (e.g. `packages/bundle/web-app/node_modules/@deepseek-ai/cordis` →
`../../../../../vendor/cordis`), so workspace `package.json` versions are the authoritative numbers.

> **Third-party checklist (8).** Pin your peer ranges against **cordis 4.0.2**, **schemastery 3.18.2**, and
> `@deepseek-ai/dsh-*` **0.1.2-alpha.2**. `@deepseek-ai/dsh-client-runtime` is not a package in this
> version — do not import it.

---

## 9. Authoring docs (official guidance)

| Doc | What it settles |
|---|---|
| `docs/user/develop/basic/index.md` | first plugin: `name` + `apply(ctx)`, function vs class form (`:120-137`), `inject` (`:89-97`) |
| `docs/user/develop/basic/config.md` | schemastery `Config` export, defaults, fail-loud rule (`:9-45`, `:76-96`) |
| `docs/user/develop/basic/tool.md` | `defineTool` + `ctx.tools.register` tutorial (`:11-36`) |
| **`docs/user/develop/basic/publish.md`** | **the third-party packaging contract**: bundle vs profile (`:9-16`), exact minimal bundle trio `package.json`+`cordis.patch.yml`+`index.js` (`:26-62`), install with `dsh plugin --profile <name> add ./hello-plugin` (`:75-110`), the 4-layer order + "a patch replaces a row's entire `config`" (`:112-128`), surface-bundle startup provider (`:130-151`), git-install `prepare`/`allowBuilds` catch (`:153-178`) |
| `docs/cookbook/adding-a-settings-card.md` | dual-face packaging for settings UI, `dsh.client` shape, lazy-CJS bundle requirement, purity gate (`:5-10`, `:44-66`, `:80-102`) |
| `docs/cookbook/adding-a-tool.md` | tool-definition source of truth (nested schemas, canonical values, PTC, UI cards) |
| `docs/cookbook/adding-a-package.md` | in-repo package checklist |
| `docs/cookbook/extension-cookbook.md` | extension-point map (tools, hooks, UI, MCP, skills) `:7-33`, `:104-124` |
| `apps/cli/reference/README.md` | authoritative layer precedence, bundle name resolution + `profiles/node_modules` fallback (`:9`, `:11`), `dsh plugin` semantics (`:46`), git-install allowance (`:66`) |
| `docs/api-gateway.md` | `dev:web` watches only `dsh.client` packages and rewrites `lib/client.js` (`:148`) |
| `docs/architecture.md` | "a profile is a named composition… it lists the bundles it stacks" (`:17-19`), shipped surfaces (`:43`) |
| `docs/cordis-tutorial/01-first-plugin.md`, `07-into-the-harness.md` | framework-level plugin authoring |
| `docs/config-catalog.md` | per-package config keys and required services (e.g. `:3418` client-modules requires `webServer`+`loader`) |

Notable gap, worth flagging: there is **no dedicated third-party doc for the browser (`dsh.client`) half** —
the only coverage is `docs/cookbook/adding-a-settings-card.md` §Packaging, which is settings-card-shaped and
says outright that no published tsdown preset exists for out-of-tree bundles.

---

## Canonical minimal third-party plugin (this version)

Derived from `docs/user/develop/basic/publish.md:26-62` (structure), `packages/bundle/web-app/package.json`
(`dsh.bundle` + `exports` + `files`), `packages/client/modules/package.json` and
`packages/client/ui-theme/package.json:32-45` (`dsh.client`), `packages/client/tsdown.client.ts:1-9`
(bundle format), `packages/interaction/tool-ask-user/src/index.ts:9-21` (plugin body).

### `package.json`

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/client.js", "lib/types/**/*.d.ts", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection"] }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@deepseek-ai/dsh-tools": "0.1.2-alpha.2",
    "@deepseek-ai/dsh-settings": "0.1.2-alpha.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@deepseek-ai/dsh-tools": "0.1.2-alpha.2",
    "@deepseek-ai/dsh-settings": "0.1.2-alpha.2"
  }
}
```

Omit `dsh.client` and `exports["./client"]` entirely for a headless (host-only) plugin. `inject` inside
`dsh.client` is optional (`packages/client/modules/src/index.ts:210,217`) — only list packages you
`require()` at runtime.

### `cordis.patch.yml`

```yaml
# A top-level YAML array of loader patch entries (cordis-plugin-include PatchOptions).
- insert:
    - id: hello                                  # unique; the id later patch layers target
      name: dsh-hello-plugin                     # bare package name → Node resolves the mounted row
      config:                                    # optional; validated by the exported Config schema
        greeting: 'Hello'
        retries: 3
    - id: hello-browser                          # the host half of the dsh.client package
      name: dsh-hello-plugin                     # (same package is fine — one id per row)
      disabled: false

# Later layers (user's profile cordis.patch.yml, --patch) override like this:
# - id: hello
#   config: { greeting: 'Hi', retries: 5 }      # REPLACES the whole config — restate every key
```

### `lib/index.js` (host half)

```js
// Plain JS is fine — the loader unwraps default/esModule interop
// (vendor/loader/src/index.ts:191-199).
export const name = 'hello-plugin'
export const inject = ['tools', 'settings']

export function apply(ctx, config) {
  // 1. agent tool
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'The name to greet' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { return `${config.greeting}, ${args.name}!` },
  }))

  // 2. user-editable settings namespace (namespace === the Web UI card key)
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, 'hello-plugin', Config, config, {
      setSource: () => {}, onChange: () => {},
    })
  })

  // 3. custom HTTP route
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/hello/callback', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
    } }),
    'hello-plugin: route',
  )
}
```

`ctx.webServer` needs `'webServer'` in `inject` (drop `'tools'` and step 1 if you ship no tools).

### `lib/client.js` (browser half — build-time target, not hand-written)

Must be a closure factory, not an ESM module (`packages/client/tsdown.client.ts:1-9`;
built sample `packages/client/ui-settings/lib/client.js:1-5`):

```js
window.__ModuleLoader__.load({
  id: "dsh-hello-plugin",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    let _cordis = require("@deepseek-ai/cordis")   // only PLATFORM_MODULES + own `external` rows
    // … plugin body: export const inject = [...]; export function apply(ctx) { ctx.slots.register(…) }
    exports.apply = function apply(ctx) { /* register into a slot, e.g. 'settings.plugin.item' keyed by 'hello-plugin' */ }
    return module.exports
  }
})
```

### Install & verify

```sh
dsh plugin --profile demo add ./dsh-hello-plugin   # appends to dsh.profile.bundles because dsh.bundle exists
dsh --profile demo --dump-config                   # shows a "# == dsh-hello-plugin" layer, patches unevaluated
dsh --profile demo                                 # boots; failures print "failed to import loader entry <id> (<name>): …"
```

---

## Cross-cutting traps (all evidenced above)

1. **`config` is replaced, never merged** — restate every key (`docs/user/develop/basic/publish.md:123-126`;
   `vendor/include/src/index.ts:121-124`).
2. **A patch that targets a missing id only warns** (`include/src/index.ts:110-114`), so a silently wrong
   `id` looks like success at boot. Check `--dump-config` stderr.
3. **`dsh.bundle` is the switch**: without it `dsh plugin add` installs a plain dependency and prints
   `warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`
   (`apps/cli/src/plugin.ts:70-75`).
4. **The browser half needs the host half mounted** — discovery iterates `ctx.loader.entries()`
   (`packages/client/modules/src/index.ts:577`), not `node_modules`.
5. **`inject` is mandatory or the row hangs**: Cordis waits on injected services before `apply`; a
   pending entry fails the post-boot audit (`packages/boot/app-boot/src/index.ts:698-…`,
   `docs/user/develop/basic/index.md:89-97`).
6. **Git installs don't run `build`** — ship a self-contained `prepare`, or a tarball, or npm-built `lib/`
   (`docs/user/develop/basic/publish.md:153-178`).
