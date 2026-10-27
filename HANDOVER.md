# dsh-feishu 交接文档

> 项目：`dsh-feishu` —— DeepSeek Harness 的飞书/Lark 集成插件
> 仓库：<https://github.com/ZhangYunfang/dsh-feishu>（`origin`）
> 上游：<https://github.com/2048lr/dsh-feishu>（`upstream`）
> 目标宿主：DeepSeek Harness `0.1.2-alpha.2`

---

## 接手 30 秒

不需要读完全文，按这三步就能接手：

1. **看现状**：`cd dsh-feishu && git log --oneline -3` 应为 `e89b80e docs…` / `d2767b2 fix…` / `17ed9c0 feat…`
2. **跑自测**：`npm test` → 期望末行 `96 passed, 0 failed`
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

## 2. 当前状态（数字取自 `.dsh/handover-draft/2026-10-27-facts.md` 采集，2026-10-27）

| 项 | 实测值 |
|---|---|
| 分支 / HEAD | `main @ e89b80e` |
| 跟踪文件数 | 41 |
| 未提交改动 | 1 项（`pnpm-lock.yaml`，空 lockfile，故意不提交） |
| 文档 | `docs/` 下 3 篇 |
| 自测 | `npm test` → `96 passed, 0 failed` |
| 宿主挂载实测 | 真实 `cordis@4.0.2` + 真实 `ToolRuntime`/`SystemPrompt`/`WebServer` → 10 工具 / 6 路由 / 无内部错误 |
| 线上状态 | `GET /api/feishu/status` → 200；`refreshable: true`；用户身份 `feishu_drive list_files` 返回 38 条 |

**结论**：可用。插件与 DSH `0.1.2-alpha.2` **没有 API 不兼容**。

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

### 3.2 代码改动（唯一一处）

`lib/tools/kit.js` 新增 `sanitizeToJson()`，在 `defineTool` 的**唯一出口**净化结果：剔除 `undefined` 属性、数组空位补 `null`、`-0` → `0`、丢弃非有限数与循环引用。

验证：`isJsonValue` 由 `false` → `true`；`npm test` 仍 `96 passed, 0 failed`。

### 3.3 文档产出

`docs/` 下 3 篇（提交 `e89b80e`），索引见 `docs/README.md`。

---

## 4. 未做 / 未验证 / 待裁决

这一节是交接包的重点，**不要跳过**。

### 4.1 未做

| 项 | 说明 | 影响 |
|---|---|---|
| 重置飞书 App Secret | App Secret 曾以明文出现在排查对话中，已写入会话日志 | 泄密面，建议后台重置后更新两处配置 |
| 给上游提 issue | `SameSite=Strict` 是通用缺陷（任何第三方 OAuth 回调都会死循环），尚未反馈给 `dsh-web-startup-auth` 作者 | 不修则每个用该插件的机器都要手工打补丁 |
| 修正 `dsh.client.inject` | 该字段列了 `@deepseek-ai/dsh-client-runtime`，此包在 `0.1.2-alpha.2` **不存在**（最接近的是 `dsh-client-modules`） | **不影响功能**：悬空依赖被 `system.ts` 静默跳过；仅声明与实际不符 |
| 补齐 workspace 逆向分析产物 | 只产了 `00-resource-index.md` 与 `07-gaps-and-questions.md` | 缺架构/数据流/模块图等，属可选项 |

### 4.2 未验证

| 项 | 为什么没验 |
|---|---|
| 10 个业务工具的**全部** action | 只验证了 `feishu_auth` 的 5 个 action 与 `feishu_drive list_files`；`feishu_bitable` / `feishu_doc` / `feishu_sheet` / `feishu_wiki` / `feishu_query` / `feishu_dashboard` / `feishu_message` 尚未逐个实跑 |
| 浏览器半边的完整交互 | 悬浮面板能渲染、设置页能打开（状态接口 200），但表单保存路径**未点过**（本次配置是直接写文件完成的） |
| 令牌自动续期 | `refreshable: true` 只证明拿了 refresh token，**未等到真正过期那一刻**验证自动刷新 |
| 换机器重建 | 迁移清单为本机推演，**未在第二台机器实测** |

### 4.3 待裁决

| 项 | 选项 | 备注 |
|---|---|---|
| `pnpm-lock.yaml` 怎么处理 | 删除 / 加进 `.gitignore` / 提交 | 114 字节空 lockfile，本项目无依赖，属生成物 |
| 是否继续增补 workspace 逆向分析产物 | 补全九份 / 保持现状 | 只影响知识基座完整度 |

---

## 5. 下一步与依赖顺序

顺序本身有理由，不要打乱：

1. **重置飞书 App Secret**（安全债，独立无依赖）
   → 后台重置 → 更新 `~/.dsh/.credentials.yaml` 的 `refs.FEISHU_APP_SECRET` 与 supervisor conf → `supervisorctl restart dsh-web`
2. **验证 `node_modules` 补丁是否还在**（依赖 1 的重启，顺手做）
   → `grep -n "SameSite" ~/.dsh/profiles/web/node_modules/dsh-web-startup-auth/lib/auth.js`，若回到 `Strict` 则按 §6 坑 5 重打
3. **逐个补验未验证的 7 个工具**（依赖 1 的可用凭据）
   → 每个工具跑一个最小 action，把结果贴进本文件「§2 当前状态」
4. **给上游提 issue**（不依赖其它项，可并行）
5. **裁决 §4.3 两项**

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

**最容易再踩的**：坑 5 的补丁在 `node_modules` 里，`dsh plugin update` 或重装依赖会覆盖，届时授权会**再次死循环**。

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
5. 写 appId 到 profile 的 `cordis.patch.yml`（**顶层** `- id: feishu`，缩进 0）
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
| `docs/workspace-understanding/` | 逆向分析产物（资源索引、缺口清单） |
| `HANDOVER-MEMORY.md` | 记忆清单：换机器时要灌进记忆库的短事实 |
| `.dsh/handover-draft/2026-10-27-facts.md` | 机器采集草稿（本文件数字的来源） |

---

## 溯源

| 项 | 值 |
|---|---|
| 编写会话 | `session-b920afcd-0a85-4866-b55a-f129fc90eb43` |
| 编写日期 | 2026-10-27 |
| 写了哪几节 | 全部（§接手 30 秒 ~ §8 与溯源）；本文件为首次创建，无历史追加 |
| 数字来源 | `.dsh/handover-draft/2026-10-27-facts.md`（`handover_draft.py` 采集） |
| 为什么新建而非追加 | 本仓库此前无任何 `HANDOVER*.md`；已在 `docs/README.md` 登记；排障全过程留在 `docs/` 主文档，本文件只承载状态、入口与迁移，避免同一事实两处存放 |
