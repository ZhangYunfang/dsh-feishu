# dsh-feishu 交接文档

> 项目：`dsh-feishu` —— DeepSeek Harness 的飞书/Lark 集成插件
> 仓库：<https://github.com/ZhangYunfang/dsh-feishu>（`origin`）
> 上游：<https://github.com/2048lr/dsh-feishu>（`upstream`）
> 目标宿主：DeepSeek Harness `0.1.2-alpha.2`

---

## 接手 30 秒

不需要读完全文，按这三步就能接手：

1. **看现状**：`cd dsh-feishu && git log --oneline -3` 应为 `41b91fe fix…`（续期缺陷）/ `9f5add3 docs…` / `5ec70f6 fix…`
2. **跑自测**：`npm test` → 期望末行 `103 passed, 0 failed`
3. **读细节**：排障全过程在 `docs/dsh-feishu-安装与排障全记录.md`（本文件只给状态、入口与迁移）

要判断线上是否健康，一条命令：

```bash
curl -s http://localhost:3080/api/feishu/status
```

`appSecretConfigured: true` 且 `user.refreshable: true` 即为健康。

---

## 1. 这个项目是什么

一个把飞书（Feishu / Lark）接入 DSH 的第三方插件包：

- **宿主半边**（`lib/`）：注册 10 个 agent 工具、6 条 HTTP 路由、1 段 system prompt。
- **浏览器半边**（`lib/ui/client.js`）：注册两个槽位 —— `shell.overlay`（悬浮面板）与 `settings.section`（设置页）。
- **打包形态**：`package.json` 声明 `dsh.bundle.patch`，靠 `cordis.patch.yml` 把自己插进 profile 图层。

设计上**刻意不 import 任何 `@deepseek-ai/*`**，只用手写结构匹配宿主契约 —— 详见上游 README 的「为什么这个包不 import `@deepseek-ai/*`」。

---

## 2. 当前状态（数字取自 `.dsh/handover-draft/2026-10-27-facts.md` 采集，2026-10-27；授权一栏更新于 2026-10-28）

| 项 | 实测值 |
|---|---|
| 分支 / HEAD | `main @ 39c7396`（含续期修复与真接口测试；最新以 `git log -1` 为准） |
| 跟踪文件数 | 41 |
| 未提交改动 | 1 项（`pnpm-lock.yaml`，空 lockfile，故意不提交） |
| 文档 | `docs/` 下 3 篇 + 本文件 + `HANDOVER-MEMORY.md` |
| 自测 | `npm test` → `107 passed, 0 failed` |
| 真接口测试 | `node test/live/feishu-live.mjs` → **44 通过 / 0 失败 / 7 阻塞 / 10 跳过**（61 用例，详见 `docs/feishu-test-report.md`） |
| 宿主挂载实测 | 真实 `cordis@4.0.2` + 真实 `ToolRuntime`/`SystemPrompt`/`WebServer` → 10 工具 / 6 路由 / 无内部错误 |
| 线上接口 | `GET /api/feishu/status` → 200；`feishu_drive list_files`（用户身份）返回 38 条 |
| 设置页可写 | `patch.file = /Users/zyf/.dsh/profiles/web/cordis.patch.yml`（坑 7 已修） |
| 授权续期 | 🟡 **代码已修**（`41b91fe`，见 `docs/dsh-feishu-安装与排障全记录.md` §六 风险 4）；但旧 grant 的 refresh token 已被旧代码抹掉，**仍需重新授权一次**，且新代码要**重启 dsh-web** 才生效 |

**结论**：可用；续期缺陷已从代码层根除并加了 5 条回归用例，剩下的是「重启 + 重新授权 + 线上复验三步」，属操作项而非代码项。

---

## 3. 本阶段做了什么（2026-10-27）

### 3.1 结论：四类问题都在插件之外，只有一处需要改代码

| # | 问题 | 层次 | 落地状态 |
|---|---|---|---|
| 1 | profile 内失效的 `file:` 依赖让**任何**插件都装不上 | 依赖解析 | 已修（改 spec 指向新 tgz） |
| 2 | App Secret 没有落地位置 | 配置 | 已解决（写 DSH 凭据库 + supervisor 环境变量） |
| 3 | 工具输出含 `undefined`，被 DSH 无损 JSON 校验拒绝 | **代码** | **已修并推送**（`d2767b2`） |
| 4 | `cordis.patch.yml` 缩进错误，`appId` 未生效 | 配置 | 已修 |
| 5 | 本地鉴权插件 `SameSite=Strict` 导致 OAuth 回调死循环 | 第三方插件 | 已打补丁（**在 node_modules，会复发**） |
| 6 | 飞书权限分「应用 / 用户」两层 | 概念 | 已理清（须重授权） |

### 3.2 代码改动（第二轮全功能自测后又加了 6 处）

第一轮（`d2767b2`）：`lib/tools/kit.js` 新增 `sanitizeToJson()`，在 `defineTool` 的**唯一出口**净化结果：剔除 `undefined` 属性、数组空位补 `null`、`-0` → `0`、丢弃非有限数与循环引用。

第二轮（逐 action 扫全部 10 个工具后）：

| 文件 | 修复 | 触发症状 |
|---|---|---|
| `lib/tools/drive.js` | `download` 改走 `/drive/v1/files/{token}/download`（原用媒体通道） | HTTP 403 |
| `lib/tools/drive.js` | `create_folder` 未给父目录时先解析根目录 token | `field validation failed` |
| `lib/tools/drive.js` | `get_meta` 支持逐 token 类型 + 未钉住时自动轮询类型（新增 `docTypes`） | 混类型全 `970005` |
| `lib/tools/docx.js` | `convertMarkdown` 的 `content_type` 由 `'md'` 改 `'markdown'` | `field validation failed` |
| `lib/tools/docx.js` | `import_file` 的上传补 `extra` 字段 | `forbidden.` |
| `lib/identity.js` | 续期未返新 token 时无条件沿用旧 token（原被 `config.appSecret` 守卫拦掉） | `refreshable` 变 `false`，2 小时后全线不可用 |
| `lib/tools/auth.js` | `RECOMMENDED_SCOPES` 增加 `base:table:read`、`base:dashboard:read`、`docx:document.block:convert` | `feishu_query`/`feishu_dashboard`/`append_markdown` 报 `99991679` |

验证：`isJsonValue` 由 `false` → `true`；`npm test` → **99 passed, 0 failed**（新增 3 条回归锁住本轮修复）。

### 3.3 文档产出

`docs/` 下 3 篇（提交 `e89b80e`），索引见 `docs/README.md`。

---

## 4. 未做 / 未验证 / 待裁决

这一节是交接包的重点，**不要跳过**。

### 4.1 未做

| 项 | 说明 | 影响 |
|---|---|---|
| **在本机完成「重启 + 重新授权 + 线上复验」** | 代码已修（`41b91fe`），但**旧 grant 的 refresh token 已被旧代码抹掉**，无法自行续期；且运行中的 dsh-web 仍是旧代码（进程启动于修复之前） | 🔴 三步不做则插件仍不可用：① 重启 dsh-web ② `feishu_auth action=authorize_url` 重新授权 ③ 按 `docs/…全记录.md` §六 风险 4 的「线上验证」跑 refresh ×2 |
| 重置飞书 App Secret | App Secret 曾以明文出现在排查对话中，已写入会话日志 | 泄密面，建议后台重置后更新两处配置 |
| 给上游提 issue | `SameSite=Strict` 是通用缺陷（任何第三方 OAuth 回调都会死循环），尚未反馈给 `dsh-web-startup-auth` 作者 | 不修则每个用该插件的机器都要手工打补丁 |
| 修正 `dsh.client.inject` | 该字段列了 `@deepseek-ai/dsh-client-runtime`，此包在 `0.1.2-alpha.2` **不存在**（最接近的是 `dsh-client-modules`） | **不影响功能**：悬空依赖被 `system.ts` 静默跳过；仅声明与实际不符 |
| 清理自测留下的飞书对象 | `临时/dsh-feishu-测试-20261027` 下的 4 个对象与 1 条测试 DM | 不影响功能，验收后可删 |
| 补齐 workspace 逆向分析产物 | 只产了 `00-resource-index.md` 与 `07-gaps-and-questions.md` | 缺架构/数据流/模块图等，属可选项 |

### 4.2 未验证

| 项 | 为什么没验 |
|---|---|
| **本轮 6 处修复的线上复验** | 自测期间令牌到期、且旧 grant 无 refresh token，`refreshable` 为 `false`——必须先在飞书后台加开 3 个权限并发版、重启 DSH、重新授权，之后才能复验 `download` / 根目录建夹 / 混类型 `get_meta` / `import_file` |
| `feishu_query` / `feishu_dashboard` / `append_markdown` 的权限是否生效 | 同上，等重新授权 |
| `feishu_auth refresh` | 已实测：仍 `blocked`（`scope` 无 `offline_access`）⇒ 应用后台未开通/未发版，代码侧已就绪（`41b91fe`） |
| 7 条权限型阻塞用例 | `docx:document.block:convert` / `base:table:read` / `base:dashboard:read` / `base:dashboard:create` 均未授予，需后台开通并重授权 |
| 少数 action | `bitable` 的 `update_records`/`delete_records`/`get_record`、`sheet` 的 `add_sheet`、`drive.get_meta` 显式传 `docTypes` 未跑 |
| 浏览器半边的完整交互 | 悬浮面板与设置页能渲染（`patch.file` 已指向 profile 的 patch 文件），但表单**保存**未实点过 |
| 换机器重建 | 迁移清单为本机推演，**未在第二台机器实测** |

其余 action 已在 2026-10-27 逐个实跑通过（矩阵见 `docs/dsh-feishu-安装与排障全记录.md` §七）。

### 4.3 待裁决

| 项 | 选项 | 备注 |
|---|---|---|
| `pnpm-lock.yaml` 怎么处理 | ~~删除 / 加进 `.gitignore` / 提交~~ → **已裁决：加进 `.gitignore` 且不入库** | 本包无依赖（`importers: .: {}`），114 字节空 lockfile 属生成物；2026-10-28 已落地 |
| 是否继续增补 workspace 逆向分析产物 | 补全九份 / 保持现状 | 只影响知识基座完整度 |

---

## 5. 下一步与依赖顺序

顺序本身有理由，不要打乱：

0. **重启 dsh-web 让续期修复生效**（`41b91fe` 之前启动的进程仍在跑旧逻辑）
   → `supervisorctl -c /opt/homebrew/etc/supervisord.conf restart dsh-web`；会话已落盘，页面刷新即可回来
1. **重新授权一次并线上复验续期**（依赖 0：新 scope 列表与修复后的续期逻辑都要在重启后的进程里）
   → `feishu_auth action=authorize_url` → 打开链接授权 → `status`（期望 `refreshable: true`、`refreshExpiresInDays` 有值）→ `refresh` 连跑两次 → 每次 `status` 都应仍是 `refreshable: true` → `feishu_drive list_files identity=user` 取一次真实数据
2. **重置飞书 App Secret**（安全债，独立无依赖）
   → 后台重置 → 更新 `~/.dsh/.credentials.yaml` 的 `refs.FEISHU_APP_SECRET` 与 supervisor conf → `supervisorctl restart dsh-web`
3. **验证 `node_modules` 补丁是否还在**（依赖重启，顺手做）
   → `grep -n "SameSite" ~/.dsh/profiles/web/node_modules/dsh-web-startup-auth/lib/auth.js`，若回到 `Strict` 则按 §6 坑 5 重打
4. **逐个补验未验证的 7 个工具**（依赖 1 的可用凭据）
   → 每个工具跑一个最小 action，把结果贴进本文件「§2 当前状态」
5. **给上游提 issue**（不依赖其它项，可并行）
6. **裁决 §4.3 两项**

---

## 6. 本阶段踩的坑（价值最高的一节）

每条只给「现象 → 根因 → 判据」，完整过程见 `docs/dsh-feishu-安装与排障全记录.md` §三。

| 坑 | 现象 | 根因 | 判据 |
|---|---|---|---|
| 1 | `Failed to resolve dependency tree: Could not install from …dsh-tapd-mcp-0.0.5-local.1.tgz`，但错误指向的包与要装的插件无关 | profile `package.json` 的 `file:` 依赖指向已删除的 tgz；pnpm 每次操作重新解析整棵树 | `ls` 目标文件不存在，且目录里已有新版 `0.1.0.tgz` |
| 2 | 不知道 App Secret 该放哪 | supervisor 不支持从文件读环境变量，conf 默认 644 | 插件读取顺序是 凭据库 → 同名环境变量 → `config.appSecret` |
| 3 | `tool "feishu_auth" returned invalid output: value is not lossless JSON`，**未授权时正常、授权后必报** | `undefined` 属性：`userState()` 展开可能不存在的 `openId`/`name`；profile 合并带进 `email` | DSH 的 `walkJsonValue` 遇非 object 直接判失败；`JSON.stringify` 会静默丢弃而注册表不会 |
| 4 | `appId` 写了但状态里是空串 | `cordis.patch.yml` 里 feishu 行缩进 4 空格，成了 `insert:` 列表的第 2 项 | 用 yaml 解析器打印结构，看到它嵌在 `insert` 数组里 |
| 5 | 授权页 `ERR_TOO_MANY_REDIRECTS` | `dsh-web-startup-auth@0.1.9` 的浏览器 cookie 用 `SameSite=Strict`，跨站跳回不发送 → 反复铸 cookie 反复 303 | `curl -si <回调路径>` 返回 303 且 `location` 指向自身 + `Set-Cookie … Strict` |
| 6 | 后台开了权限，调用仍报 `99991679` | 飞书权限分两层：应用权限发版即生效，用户授权范围在点「同意」那刻固化 | 应用身份调同接口成功、用户身份失败；且 `expiresAt` 没变说明新授权根本没发生 |
| 7 | 设置页报「配置文件不可写：the profile patch file could not be located」。注意它**不影响显示**，只影响保存 | `link:` 安装时插件的四个候选全部落空：`patchFilePath` 未配、`DSH_PROFILE_DIR`/`DSH_PROFILE` 未设（第三项回退到 `desktop`）、从模块路径向上 6 层永远到不了 `~/.dsh/profiles/web/` | `GET /api/feishu/config` 返回的 `patch.file === null` 且 `entryFound === false` |

**最容易再踩的**：两点。
① 坑 5 的补丁在 `node_modules` 里，`dsh plugin update` 或重装依赖会覆盖，届时授权会**再次死循环**。
② 坑 7 在**每次 `link:` 安装**都会重现，所以它已写进 §7 重建步骤第 5 步 —— 别以为配了 appId 就够了。

---

## 7. 跨机器 / 换人迁移清单

### A. 必须手动搬的东西（不在 git 里）

| 项 | 位置 | 为什么手动 |
|---|---|---|
| 飞书应用凭据 | `~/.dsh/.credentials.yaml` 的 `refs.FEISHU_APP_SECRET` | 密钥不入库；只交接**名字与获取方式** |
| App ID | `~/.dsh/profiles/web/cordis.patch.yml` 的 `- id: feishu` 一节 | 属 profile 配置，不在插件仓库 |
| `dsh-web-startup-auth` 的补丁 | `~/.dsh/profiles/web/node_modules/dsh-web-startup-auth/lib/auth.js` | 第三方包内，重装即失；提交会污染 node_modules |
| supervisor 程序段 | `/opt/homebrew/etc/supervisor/conf.d/30-dsh-web.conf` | 含本机路径与环境变量 |
| DSH 源码副本 | `../dsh-src/deepseek-harness-dsh-v0.1.2-alpha.2/` | 79M，用于查源码；线上检出只读 |
| 采集草稿 | `.dsh/handover-draft/` | 一次性产物，可丢弃后重采 |

### B. 在新机器上重建（按顺序）

1. 装 Node（`^22.19 || >=24`）与 pnpm；克隆本仓库
2. 在目标机装 DSH `0.1.2-alpha.2`，确认 `~/.dsh/profiles/web/` 存在
3. **检查 profile 的 `file:` 依赖**（坑 1 的防线）：
   `grep -o 'file:[^"]*' ~/.dsh/profiles/web/package.json` 后逐个确认文件存在
4. 装插件：
   `cd <DSH 检出> && pnpm dsh plugin --profile web add <本仓库路径>`
5. 写 appId **与 `patchFilePath`** 到 profile 的 `cordis.patch.yml`（**顶层** `- id: feishu`，缩进 0）：

   ```yaml
   - id: feishu
     config:
       appId: 'cli_你的AppID'
       patchFilePath: '/Users/<你>/.dsh/profiles/web/cordis.patch.yml'
   ```

   🔴 `patchFilePath` 不能省 —— `link:` 安装时插件定位不到 profile 的 patch 文件，设置页会报「配置文件不可写」（坑 7）
6. 写 App Secret 到 `~/.dsh/.credentials.yaml` 的 `refs:` 段，`chmod 600`
7. **给 `dsh-web-startup-auth` 打 `SameSite=Lax` 补丁**（坑 5），否则浏览器授权必然死循环
8. `supervisorctl restart dsh-web`（或按本机实际方式重启）
9. 跑本文件「接手 30 秒」的两条自检；再跑一次浏览器授权流程
10. 按第 3 项「补验未验证的工具」继续

### C. 网络与代理

- 本机 git 走 **SSH over 443**（`ssh://git@ssh.github.com:443/...`），因为直连 22 端口超时。
- 本机开着系统代理（`127.0.0.1:7892`）。**判断连通性要用 TCP 实测**，不要只信 HTTP 客户端返回值 —— 系统代理会给出假阳性，也会把浏览器访问 `127.0.0.1` 的请求吞掉（这就是为什么回调地址同时登记了 `localhost` 变体）。

---

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| `docs/README.md` | 文档索引 + 三个核心结论 + 远程约定 |
| `docs/dsh-feishu-安装与排障全记录.md` | **主排障文档**：安装步骤、6 个坑的完整过程、诊断方法论、配置清单、复发风险与恢复命令、命令速查与源码索引 |
| `docs/dsh-plugin-contract-0.1.2-alpha.2.md` | DSH 插件包契约调研（逐条 `path:line`） |
| `docs/feishu-test-report.md` | 全功能测试报告：61 条用例矩阵、权限阻塞总账、复现命令、安全护栏 |
| `docs/feishu-issue-fix-log.md` | ISSUE-01…07 逐个问题的现象→根因→修复→回归 |
| `docs/workspace-understanding/` | 逆向分析产物（资源索引、缺口清单） |
| `HANDOVER-MEMORY.md` | 记忆清单：换机器时要灌进记忆库的短事实 |
| `.dsh/handover-draft/2026-10-27-facts.md` | 机器采集草稿（本文件数字的来源） |

---

## 溯源

| 项 | 值 |
|---|---|
| 编写会话 | `session-b920afcd-0a85-4866-b55a-f129fc90eb43` |
| 编写日期 | 2026-10-27（同日二次更新：补坑 7、refresh token 缺陷、`patchFilePath` 配置与重建步骤） |
| 写了哪几节 | 首次创建写全部（§接手 30 秒 ~ §8 与溯源）；二次更新改 §2 状态表、§4.1 未做、§6 坑表（加坑 7）、§7 B 重建步骤第 5 步 |
| 数字来源 | `.dsh/handover-draft/2026-10-27-facts.md`（`handover_draft.py` 采集）+ 本次实测（`feishu_auth status`、`GET /api/feishu/config`） |
| 为什么新建而非追加 | 本仓库此前无任何 `HANDOVER*.md`；已在 `docs/README.md` 登记；排障全过程留在 `docs/` 主文档，本文件只承载状态、入口与迁移，避免同一事实两处存放 |
