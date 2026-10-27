# 07 · 缺口、未决问题与「无法使用」根因分析

> 分析对象：`dsh-feishu` v0.1.0（commit `17ed9c0`）适配目标 `deepseek-harness-dsh-v0.1.2-alpha.2`
> 证据口径：每条断言带 `path:line` 或命令+输出。无法验证者标 `UNVERIFIABLE`。

## 一、结论先行

**没有找到 API 漂移导致的硬性不兼容。** 用真实的 `cordis@4.0.2` + 真实 `@deepseek-ai/dsh-tools@0.1.2-alpha.2` 把插件宿主半边实际挂载，`apply()` 成功，注册 **10 个工具 / 6 条 HTTP 路由 / 1 个 prompt 段**。

因此「装了但无法使用」的原因是**它从未真正挂载**，而不是挂载后报错。

### 证据链

| # | 证据 | 出处 |
|---|---|---|
| E1 | 安装成功但是 **`hot=false`**，且**没有** `hot-mount` 行（成功热挂载的插件都有 `hot-mount …: live`） | `~/.dsh/profiles/web/.dsh-market/log.ndjson` · `2026-10-21T06:23:25.941Z info install \| github:2048lr/dsh-feishu#17ed9c0… exit=0 hot=false` |
| E2 | 当前 profile 里 `dsh-feishu` **既不在 dependencies，也不在 `dsh.profile.bundles`** | `~/.dsh/profiles/web/package.json`（全文无 feishu） |
| E3 | 扫描 66 个历史会话日志，**没有任何一个**出现过 `feishu_bitable` / `feishu_auth` / `feishu_dashboard` / `feishu_wiki` / `feishu_api`；仅本会话（因读源码）出现 | python + `zstandard` 扫描 `~/.dsh/sessions/**/session.jsonl.zstd` |
| E4 | 真实挂载测试通过：10 工具 = `feishu_auth, feishu_bitable, feishu_dashboard, feishu_query, feishu_doc, feishu_sheet, feishu_drive, feishu_wiki, feishu_message, feishu_api` | `/tmp/feishu-probe/full.mjs` 运行输出 |
| E5 | 插件工具 schema 通过**真实**校验器 | `assertObjectJsonSchema` / `validateJsonSchemaValue`，来自 `@deepseek-ai/dsh-tools@0.1.2-alpha.2` |

> E3 是最硬的一条：工具若曾挂载，会话日志的 tool schema 清单里必然出现 `feishu_*`。没有 → 从未挂载。

## 二、逐个 API 面核验结果（均兼容）

| 插件用法 | 0.1.2-alpha.2 现状 | 结论 |
|---|---|---|
| `export const inject = ['tools']` / `name` / `apply(ctx, config)` | loader 接受 function/class/`{apply}`，`unwrapExports` 归一化 `exports.default ?? exports`，`vendor/loader/src/index.ts:191-199` | ✓ |
| `ctx.tools.register(definition)` | `register(definition: ToolDefinition): () => void`，`@deepseek-ai/dsh-tools/lib/types/index.d.ts:602`；`ToolDefinition extends ToolSchema` + 必填 `output`，`index.d.ts:106-119` | ✓ |
| 工具 `{name, description, parameters, output:{schema,render}, execute, timeoutMs}` | 与 `defineTool()` 产出的对象同构，`packages/core/tools/src/schema.ts:545+` | ✓ |
| `RESULT_SCHEMA` 中 `data:{description}` 无 `type` | 实测 `assertObjectJsonSchema` 与 `validateJsonSchemaValue` 均通过（宽松节点=接受任意 JSON） | ✓ |
| `ctx.inject(['webServer'], scope => …)` + `webServer.register({kind:'exact',path,handler})` + `webServer.port` | `packages/host/webserver/src/index.ts:144`（`super(ctx,'webServer')`）、`:150`（port）、`:165`（register） | ✓ |
| `ctx.effect(() => () => …, 'feishu: http routes')` | cordis 4.0.2 接受 `(fn, label)`；实测路由 6 条全部注册成功 | ✓ |
| `ctx.get('credentials')` → `readRecord/describeRecord/modifyRecord/set/unset` | 服务名 `credentials`（`packages/credentials/credentials/src/index.ts:172`），方法在 `:217,:224,:247` | ✓ |
| `scope.systemPrompt.section({name,order,text})` | `section(section: PromptSection)` 恰为 `{name,order,text}`，`packages/core/system-prompt/src/index.ts:432` | ✓ |
| `dsh.bundle.patch` + `cordis.patch.yml` 的 `- insert: [{id,name,config}]` | patch 方言唯一实现 `vendor/include/src/index.ts:58-128`；`insert` 根级追加 `:93-95`；`config` **整体替换不深合并** `:121-124` | ✓ |
| `dsh.client` = `{platform:'web', inject:[…]}` + `exports["./client"]` | 解析器 `packages/client/modules/src/index.ts:200-221`；缺 `exports["./client"]` 才抛错 `:760-763`（本包有） | ✓ |
| 客户端产物 `window.__ModuleLoader__.load({id, factory})` | 仍是唯一客户端格式，`packages/client/tsdown.client.ts:3` | ✓ |
| 客户端 `require("react")`（未声明 `external`） | `react` 属于 8 个基线平台模块之一，`packages/client/web/src/platform.ts:8-13` | ✓ |
| `scope.slots.inject(key, cb)` | `inject(key, callback): () => void`，`packages/client/ui-renderer/src/client/registry.ts:172` | ✓ |
| `slots.register({name,id,order,label}, Component)` | `register(options, component)`，`packages/client/ui-slots/src/index.ts:785`；`options` 合法字段含 `id/order/label`，`:557` | ✓ |
| 槽位名 `shell.overlay` / `settings.section` | 均已声明：`packages/client/ui-layout/src/client/index.ts:86`、`packages/client/ui-settings/lib/types/client/contract/slots.d.ts:67` | ✓ |

## 三、真实发现的缺陷（非致命，但应修）

### C-01 · `dsh.client.inject` 指向不存在的包

- **文档主张**：`package.json` 声明 `dsh.client.inject = ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-slots"]`
- **代码证据**：`@deepseek-ai/dsh-client-runtime` **在 0.1.2-alpha.2 中不存在**（最接近的是 `dsh-client-modules` / `dsh-client-web` / `dsh-client-store`）。
- **后果**：**不致命**。消费处在 `packages/client/modules/src/client/system.ts:165`，`const dependency = this.graphRows.get(packageName); if (dependency !== undefined) …` —— 悬空的 `inject` 被静默跳过；`orderByModuleGraph` 只遍历 `external`（`packages/client/modules/src/index.ts:456`），也不校验 `inject`。
- **仍应修**：它让声明与实际不符，且是「此包为老版本 DSH 编写」的直接标记。

### C-02 · 安装后 profile 层丢失，未留下可诊断痕迹

- E1 显示安装 `exit=0`，E2 显示当前 profile 无此包，market 日志里**也没有对应 uninstall 事件**。`dsh.profile.bundles` 的增删由 `apps/cli/src/plugin.ts:59-91` 按「已安装状态」对账，不是按依赖 diff，因此「装上但没进 bundles」只可能发生在 `exportsPatch()` 判定为 false（`:36-45`，要求 `dsh.bundle.patch !== undefined`）。
- **未决**：`17ed9c0` 已声明 `dsh.bundle.patch`，理论上应进 bundles。为何最终不在 —— `UNVERIFIABLE`（缺当时的 profile package.json 快照）。

## 四、必须由用户回答的问题

1. **「无法使用」的具体现象是哪种？**（这决定后续修法，四选一或补充）
   - (a) DSH 启动报错 / 整个 Web 界面打不开
   - (b) Web 设置页里找不到「飞书 / Feishu」页，界面上也没有飞书面板
   - (c) 面板/设置页都在，但工具调用全部失败
   - (d) 工具列表里根本没有 `feishu_*` 工具
2. **飞书应用是否已经创建并拿到 App ID / App Secret？**（若没有，10 个工具即便挂载也必然失败，看起来就像「不能用」）
3. **是否允许把插件装进在线的 `web` profile 做端到端验证？**（会改动 `~/.dsh/profiles/web`，且层变更需重启 DSH Web 才生效）

## 五、其他缺口

- `scripts/install.ps1` / `uninstall.ps1` 是 **PowerShell**，本机 macOS 不可用；手工安装路径在 macOS 上等于不存在。
- `test/run-tests.mjs`（1806 行，96 断言全过）**自建 mock**，不引入真实 SDK；因此它能证明「插件自洽」，不能证明「与宿主兼容」——这与上面 E4 的实测结论互为补充。
- `README` 未声明所面向的 DSH 版本区间，`package.json` **无 `peerDependencies`**（0.1.2-alpha.2 也确实没有运行时 peer 校验，见 `apps/cli/src/plugin.ts` 全文无 compat 检查）。
