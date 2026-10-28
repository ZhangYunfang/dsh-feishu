# dsh-feishu 记忆清单（可迁移）

> 给「换一台机器 / 换一个会话」用：这里是要灌进新机器记忆库的**短事实**。
> 配套主文档：`HANDOVER.md`。数字来源：`.dsh/handover-draft/2026-10-27-facts.md`。
> 🔴 本文件**不含任何凭据值**，只有「凭据在哪里」。

---

## 1. 必须灌入的条目（与本项目强相关）

这些是本项目排查中沉淀的**长期事实**，缺了会导致接手方重新踩同样的坑。

| # | 类型 | 短事实 | 为什么必须 |
|---|---|---|---|
| 1 | `memory`（全局环境） | DSH 工具返回值必须是**严格无损 JSON**：任一层出现 `undefined` / `NaN` / `Infinity` / `-0` / 稀疏数组 / 循环引用都会让整次工具调用失败（`packages/util/values/src/index.ts` 的 `walkJsonValue`）。正解是在工具定义的**单一口**做一次深度净化。 | 这是本项目唯一的代码级修复点的依据 |
| 2 | `memory` | 工具返回值净化后仍可能出现「活动面板显示成功、工具却报错」——活动记录发生在注册表校验**之前**，判断成败要看模型侧结果。 | 会误导排障方向 |
| 3 | `memory` | `~/.dsh/profiles/<name>/package.json` 里的 `file:` 依赖一旦目标文件被删/改名，pnpm 每次操作都会在解析整棵依赖树时失败，报错却指向那个**无关**的包。排查：读 profile 找所有 `file:` → 逐个确认文件存在 → 对比源仓库 git log 判断该更新 spec 还是回滚。 | 表现为「任何插件都装不上」，极易误判 |
| 4 | `memory` | DSH 凭据库 `~/.dsh/.credentials.yaml`（0600）是给插件存密钥的首选位置，优先于环境变量与 YAML。结构：`version: 1` + `refs:`（扁平 `KEY: value`，用 `credentials.resolve('KEY')` 读）+ `records:`。验证时 `parseCredentialsDocument(text, filename)` 要传**两个**参数，且返回的 `refs`/`records` 是 **`Map`**（用 `Object.keys` 会得到空数组）。 | 验证方法错了会误判文件损坏 |
| 5 | `memory` | 飞书权限分**两层**：应用权限（tenant）勾选 + 创建版本发布后立即生效；用户授权范围（user scope）在点「同意」那一刻固化，事后开权限**不会**自动扩，必须重新授权。快速判别：同一接口用 app 身份成功、user 身份失败 ⇒ 就是这问题；`expiresAt` 没变说明新授权根本没发生。 | 本次卡最久的概念坑 |
| 6 | `memory` | 本地鉴权类插件（如 `dsh-web-startup-auth`）若用 303 + `Set-Cookie` 给未认证请求补 cookie，而 cookie 是 `SameSite=Strict`，则**任何外部 IdP 的 OAuth 回调**（飞书/GitHub…）都会 `ERR_TOO_MANY_REDIRECTS`。判别：`curl -si <回调路径>` 返回 303 且 `location` 指向自身。正解改 `SameSite=Lax`；补丁在 `node_modules` 里，插件更新会覆盖。 | 会复发，且现象与业务无关 |
| 7 | `memory` | 飞书重定向 URL 规则：`http` 与自定义端口均支持（官方示例即 `http://example.com:8080/...`）；必须**逐字匹配**，不匹配报 `{code: 2000, redirect_uri unmatch}`；必须含完整路径但 `?`/`#` 后缀不生效；单应用上限 300 条；不支持动态路由；IP/localhost 官方未明文写但实践可行。权限勾选后必须**创建版本并发布**才生效。 | 授权失败的第一嫌疑点 |
| 8 | `memory` | 核验第三方插件与 DSH 是否兼容，**不要读源码猜**：用 `~/.dsh/profiles/node_modules` 里的真实包搭一个 cordis `Context` 实测挂载。要点：真实 `ToolRuntime` 需要先提供 `systemPrompt` 服务且该服务要有 `tools()` 方法；`WebServer` 用 `port: 0` 挂载但会保持事件循环，探针脚本末尾必须 `process.exit(0)`。 | 本项目靠它推翻了「API 不兼容」的假设 |
| 9 | `user`（用户偏好） | 线上 DSH 检出 `/Users/zyf/Project/deepseek-harness-dsh-v0.1.2-alpha.2/` **只读**；查源码用工作区里的解压副本 `dsh-src/deepseek-harness-dsh-v0.1.2-alpha.2/`。 | 用户明确约束，违反即返工 |
| 10 | `user`（用户偏好） | 所有结论必须带 `path:line` 或「命令 + 输出」证据；无法验证的标 `UNVERIFIABLE`，禁止猜测。 | 用户明确要求 |
| 11 | `memory` | 飞书 `refresh_token` **一次性**，且只在 grant 含 `offline_access` 时才随续期响应下发（`refresh_token_expires_in` 同）；响应**没带**新 token 时必须**无条件沿用旧值**，不能按「密钥写在 `config.appSecret` 还是凭据库」分支判断——密钥放凭据库时 `config.appSecret` 恒为空，按它判断必然把旧 token 清空（`lib/identity.js` 旧 `:363`）。判据：`feishu_auth status` 连续两次续期后 `refreshable` 仍为 `true`。失败码：`20037` 过期 / `20064` 已撤销 / `20073` 已用过 / `20074` 后台没开「刷新 user_access_token」开关。飞书硬上限：用户授权满 **365 天**必须重新授权。 | 本机唯一影响日常使用的缺陷，修法反直觉 |

### 已写入状态

| 项 | 状态 |
|---|---|
| 第 1–8、11 条（`memory` 轨） | 第 1–8 条**已写入**（本机 `KEY.md` 可见，最近的条目日期为 2026-10-27）；第 11 条于 2026-10-28 提交写入 |
| 第 9–10 条（`user` 轨） | **已写入**（`preferences.md` 可见） |
| 待确认队列 `~/.dsh/memories/SUGGESTIONS.jsonl` | **0 条**（采集时实测，无未生效的建议） |

---

## 2. 如何灌入新机器

### 2.1 首选：用 `memory` 工具逐条写入

在新机器的 DSH 会话里，对第 1–8、11 条用 `memory` 工具的 `add` 动作：

```
memory(action="add", target="memory", content="<第 1 条的短事实>")
```

第 9–10 条走用户轨：

```
memory(action="add", target="user", content="<第 9 条的短事实>")
```

> 注意：`target=key`（项目关键记忆）写入需用户确认后才生效；`target=memory` / `target=user` 直接生效。
> 本项目没有需要进 `key` 轨的**新**条目 —— `key` 轨按**工作目录**隔离，换机器后工作目录不同，条目不适用。

### 2.2 批量核对是否灌全

灌完跑一次：

```
memory(action="list", target="memory", filter="无损")     # 应命中第 1 条
memory(action="list", target="memory", filter="file:")    # 应命中第 3 条
memory(action="list", target="user",   filter="只读")     # 应命中第 9 条
```

### 2.3 不要把长内容塞进记忆

长内容（完整排障过程、源码索引、契约调研）留在 `docs/` 下，记忆里只放**一句话能复述的判据**。
把长文塞进 `key` 轨会导致每轮整包注入，等于持续交上下文税。

---

## 3. 未做 / 未验证 / 待裁决

| 类别 | 项 |
|---|---|
| 未做 | 未在**第二台机器**上实际执行过本文件 §2 的灌入流程（流程为本机推演） |
| 未做 | 未导出机器可读的记忆快照（只人工列出 10 条短事实，未做全量 JSON 导出） |
| 未验证 | 第 1–8 条的表述是否与原 `KEY.md` 逐字一致 —— 本文件是**摘要重写**，不是原文拷贝 |
| 未验证 | 新机器上 `memory` 工具是否支持同样的 `target` 取值（取决于该机 DSH 版本） |
| 待裁决 | 是否把第 1–8 条同步进 `~/.agents/skills/` 或团队共享记忆（决定跨机扩散范围） |

---

## 溯源

| 项 | 值 |
|---|---|
| 编写会话 | `session-b920afcd-0a85-4866-b55a-f129fc90eb43`（初版）· `session-0b7d44ac-eb3e-49be-908a-de8e84fc8a5e`（2026-10-28 增补第 11 条） |
| 编写日期 | 2026-10-27（初版）/ 2026-10-28（第 11 条） |
| 写了哪几节 | 全部（§1 条目、§2 灌入方法、§3 未做、本溯源表） |
| 事实来源 | `.dsh/handover-draft/2026-10-27-facts.md`（记忆清单段落）+ 本次会话中已确认写入的记忆条目 |
| 不含 | 任何凭据值；凭据位置见 `HANDOVER.md` §7A |
