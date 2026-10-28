# 变更记录

本仓库是 `dsh-feishu` 的本地适配分支（上游 `2048lr/dsh-feishu`），目标是让它跑在 DeepSeek Harness `0.1.2-alpha.2` 上并逐项打通飞书能力。本文件按轮次记录改了什么、为什么改、怎么验的。

约定：每条都带**提交号**与**判据**；修复类问题在 `docs/feishu-issue-fix-log.md` 有编号（`ISSUE-nn`），过程细节在 `docs/dsh-feishu-安装与排障全记录.md`。

---

## v0.1.1+（未发版） · 2026-10-28 · 设置页把自己锁死的两个定位缺陷

用户侧症状：设置页保存过一次配置后，此后每次打开都报「配置文件不可写：the profile patch file could not be located」，重启无效。查下来是**写入口与读入口各有一个缺陷**，任一存在都会让 `link:` 安装永远找不到自己的 `cordis.patch.yml`。

| 位置 | 改动 | 判据 |
|---|---|---|
| `lib/entry-config.js` · `anchorDirectory()` | 锚点是**已存在的目录**时原样使用，不再 `dirname()`（Cordis 的 `ctx.baseUrl` 正是 `<profile>` 目录） | `resolvePatchFile({}, { baseUrl: '<profile>', env: {} })` 命中真实文件 |
| `lib/entry-config.js` · `locateBlock()` + 新增 `locateIdOnlyBlock()` | 认不出 `name:` 时按 `id: feishu` 查找；`insert:` 列表跳过 | 手写 id-only 条目保存后**只剩一条**同 id 条目（此前会追加第二条，后一条整块覆盖前一条的 `config`） |
| `lib/entry-config.js` · `writeEntry()` + 新增 `locatedIsOverride()` | 每次写入补 `merged.patchFilePath = file`；块形式跟随被替换的块 | 保存后 `patchFilePath` 仍在，且手写 override 不会被改写成 `insert:` |
| `test/run-tests.mjs` | 新增 3 条回归（baseUrl 指目录 / id-only 条目 / 不留两条同 id） | `node test/run-tests.mjs` → **112 passed, 0 failed**（原 109） |
| `docs/dsh-feishu-安装与排障全记录.md` | §一 缺陷表补第 9 条、状态块刷新为 2026-10-28 实测值；§六 新增「风险 6」全过程 | 线上 `GET /api/feishu/config` → `patch.file` 非 null、`entryFound: true`、`error: null` |

线上验证：`patchReload: live`，修好 yaml 当场生效（不用重启）；本修复改的是 `lib/`，需重启 dsh-web 才加载。
未做的事：**没有发新版本、也没重打 tgz** —— 版本号仍是 0.1.1，等下次发版一并带出。

---

## v0.1.1 · 2026-10-28 · 首个可分发版本（= 下面 v0.1.0-local.3 一轮）

打包发布：`dsh-feishu-0.1.1.tgz`（127084 B / 37 文件 / sha256 `ff07e4a2…2d99716f`）。

- `package.json`：版本 0.1.0 → **0.1.1**；`repository`/`homepage`/`bugs` 从上游改指本分支（否则别人的 issue 会提错地方）；`files` 纳入安装指南与能力目录
- `cordis.patch.yml`：安装示例同时给出本分支与上游
- 新增 [`docs/feishu-console-setup.md`](docs/feishu-console-setup.md)（**飞书后台配置全流程·权威**：八步、15 项权限逐条用途/缺失症状、重定向 URL 规则、可用范围、发版、错误码对照表、上线检查清单、免 DSH 的权限自检）
- 排障主文档里过时的「9 项权限版」后台流程已替换为指向该文档的指针（单一来源）
- 新增 [`docs/user-guide.md`](docs/user-guide.md)（**用户指南**：提示词配方 / 结果解读 / 安全边界 / 故障处置 / 3 个端到端例子）与 [`docs/RELEASE-0.1.1.md`](docs/RELEASE-0.1.1.md)（发布说明）
- 重写 [`docs/install-for-others.md`](docs/install-for-others.md)：**修正 `dsh plugin` 的真实语义**（必须带 `--profile <名>`；它会 pnpm add 后按已安装状态 reconcile `dsh.profile.bundles`，声明了 `dsh.bundle` 的依赖自动激活），补环境自查、无 CLI 的手动两步、跨平台路径、装完自检
- README / README.zh 顶部加本分支说明与文档入口
- 验证：tarball 解包后 `apply/inject/name` 可 load、10 工具 61 action、15 scope；临时 profile `pnpm add <tgz>` 成功；包内无密钥
- **GitHub Release 已发布**：<https://github.com/ZhangYunfang/dsh-feishu/releases/tag/v0.1.1>（tag `v0.1.1`，附件 `dsh-feishu-0.1.1.tgz`；发布后因补充文档重打过两次，现行 127084 B / 37 文件，实测下载 sha256 与本地一致）。为此安装了 `gh` CLI 2.103.0 并完成设备码授权
- 未做的事：**未发布到 npm**（本机 `npm whoami` 未登录，且 `dsh-feishu` 这个包名属上游）——若要走 npm，需改用自有 scope（如 `@zhangyunfang/dsh-feishu`）或请上游收编

## v0.1.0-local.3 · 2026-10-28 · 全功能测试与续期缺陷闭环

### 新增：真接口测试基建

| 提交 | 内容 |
|---|---|
| `39c7396` | `test/live/feishu-live.mjs`：**62 条用例**驱动插件自身的工具定义打真飞书。只读凭据适配器（拒绝一切写）、断言 `grant rotated: false`、`DSH-TEST-` 前缀 + 结束时删除产物并撤回消息、`blocked`（权限）与 `fail`（代码）分开记 |
| `39c7396` | `test/live/credentials.mjs`：凭据库只读适配器（`refresh_token` 一次性，写坏即永久失去授权） |
| `e2498fb` | `package.json` 加 `test:live` / `test:live:list`；`test/live/README.md` 写清前置、护栏、判定口径与新增用例写法 |

### 修复：5 个真缺陷

| ISSUE | 现象 | 根因 → 修法 | 提交 |
|---|---|---|---|
| 01 | 约 2 小时就要重新授权 | ①续期守卫按 `config.appSecret` 是否为空分支（密钥放凭据库时恒空 → 旧 token 被清空）；②`refresh_token` 一次性且只在 grant 含 `offline_access` 时下发 → 无条件沿用旧值 + 补 scope 沿用、写盘失败保内存副本、OAuth 错误码透传、6 条提示、`status` 报 `refreshExpiresInDays` | `41b91fe` |
| 02 | 建得出文件夹却删不掉/移不动 | `DOC_TYPES` 缺 `folder`（飞书接受 `type=folder`） | `39c7396` |
| 03 | `import_file` 成功后拿不到任何引用 | 成功分支回的是服务端 payload，本地已知的 `ticket` 被丢 → 两分支都并入 `ticket` 并回传 `token`/`url` | `39c7396` |
| 04 | `create_field` 传 `fields[]` 报「needs a name」 | 校验先看 `args.name` → 改为 `name` → `fields[0].name` 顺序解析 | `39c7396` |
| 05 | 含表格的 Markdown 追加必失败 `1770001` | convert 返回的 `table.property` 含 `column_width`/`merge_info`，建表接口不接受 → 归一化为 `{row_size, column_size, header_row}` | `c201591` |

### 修复：3 个契约/可用性缺陷

| ISSUE | 现象 | 修法 | 提交 |
|---|---|---|---|
| 08 | 工具生成的授权链接被自己的回调回 `state mismatch` | `/start` 是唯一登记 `state` 的入口 → `index.js` 透传 `registerOAuthState`，`authorize_url` 生成后立即登记 | `5918340` |
| 10 | 推荐 scope 缺仪表盘写权限 | 仪表盘四种写操作各一个 scope → 补 `base:dashboard:create/update/delete` | `39c7396` + `c201591` |
| 11 | 工具失败只剩一句 `invalid_grant`，`errors.js` 的提示从未出现 | 宿主只渲染 `error.message` → `defineTool` 出口把 `toText()`（状态码/路径/提示/detail）写回 message，**保留 error 对象**（`code` 仍可编程读） | `c201591` |

### 修复：测试方法学问题

| ISSUE | 现象 | 修法 | 提交 |
|---|---|---|---|
| 12 | 运行器的 `AUTH-03` 真调了 `refresh`，只读凭据库无法承接轮换 → 把线上那份 grant 的 refresh token 消耗掉 | 改为非破坏性断言（读 `status` 校验 `refreshable`/`offline_access`/`refreshExpiresInDays`）；真续期列为 `AUTH-07` 显式跳过并写明理由 | `c201591` |

### 文档

| 提交 | 内容 |
|---|---|
| `b28bd0b` `aebe2c2` | 主排障文档 §六 风险 4 重写：两层根因 → 修复表 → 离线/线上判据 → 残留边界；线上段落已换成**实测证据表**（授权后 status、连续两次 refresh、全量结果） |
| `f5a7c16` | 新增 `docs/feishu-test-report.md`（范围/环境/权限、61→62 条矩阵、复现命令、安全护栏、风险、变更清单） |
| `f5a7c16` | 新增 `docs/feishu-issue-fix-log.md`（`ISSUE-01…12`，每条含现象/复现/环境/错误码/根因/修复/文件/回归/遗留） |
| `dd28549` `aebe2c2` | `docs/记忆存档.md` 刷新到 2026-10-28；`HANDOVER.md` 状态与待办同步（续期项由「待重授权」改为已闭环） |
| 本文件 | 新增 `docs/feishu-capabilities.md`（10 工具 / 63 单元的能力目录与权限速查）与本变更记录 |

### 验收（全绿）

```text
npm test              → 108 passed, 0 failed          （离线，mock，不联网）
npm run test:live     → pass=57 fail=0 blocked=1 skipped=4 total=62
                        grant rotated during the run: false
feishu_auth status    → refreshable: true · scope 16 项含 offline_access · refreshExpiresInDays: 7
feishu_auth refresh   → 连跑两次均成功，refreshable 始终 true
```

**剩余事项**：`MSG-07 webhook`（需用户在群内自建机器人并给出 URL）；`feishu_wiki` 建/移/改标题（无删除手段，需可弃用知识库）；飞书 365 天硬上限到期需重授权。

---

## v0.1.0-local.2 · 2026-10-27 · 安装打通与接口契约修复

| 提交 | 内容 |
|---|---|
| `f37313e` | 记录设置页写入失败（`patchFilePath` 缺失）并纠正过期状态 |
| `5ec70f6` | 全功能自测（逐个 `action` 扫 10 个工具）修掉 6 处接口契约错误：drive 下载走错通道、根目录建夹缺 token、混类型 `get_meta` 全 970005、`append_markdown` 用错 `content_type`、`import_file` 缺 `extra`、续期守卫连坐 |
| `9f5add3` | 记录自测结论与记忆导出 |

坑：`dsh-web-startup-auth` 的 cookie 用 `SameSite=Strict` 会让所有第三方 OAuth 回调死循环（已在本机改为 `Lax`，补丁在 `node_modules` 里，插件更新会覆盖）。

---

## v0.1.0-local.1 · 2026-10-22 · 适配 DSH 0.1.2-alpha.2

| 提交 | 内容 |
|---|---|
| `d2767b2` | 工具返回值统一做无损 JSON 净化（`undefined`/`NaN`/`-0` 会让宿主拒收整次调用） |
| `17ed9c0` | 声明 `dsh.bundle` 清单，使包可被 profile 安装 |
| `e89b80e` `658b279` | 安装与排障全记录、交接包 |

---

## 怎么复现全部结论

```bash
cd dsh-feishu
npm test                        # 离线门禁，108 条
npm run test:live:list          # 看 62 条用例（零请求）
npm run test:live               # 真接口全量，约 2 分钟，自动清理
feishu_auth status              # 在 DSH 里查授权健康度（refreshable / scope / 剩余天数）
```

改完插件代码**必须重启托管它的 dsh-web**（supervisor：`supervisorctl -c /opt/homebrew/etc/supervisord.conf restart dsh-web`），否则跑的还是进程内存里的旧逻辑。
