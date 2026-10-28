# dsh-feishu 问题排查与修复日志

> 配套文档：`docs/feishu-test-report.md`（范围、矩阵、结果）。
> 编号规则：`ISSUE-nn`，按发现顺序。
> 每条含：功能与用例 / 现象 / 复现 / 环境 / 关键错误码 / 根因 / 修复 / 修改文件 / 回归 / 遗留风险。
> 版本：DSH `0.1.2-alpha.2` · 插件 `main` · 飞书自建应用 `cli_aa6a…9cc3`（App ID 已脱敏）

---

## ISSUE-01 · 自动续期把 refresh token 丢掉（已修复 `41b91fe`，残留项需后台开权限）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_auth` · `AUTH-03`（refresh）、`AUTH-01`（status） |
| **现象** | 授权约 2 小时后 `refreshable` 变 `false`，所有用户身份调用同时失败：`the stored Feishu grant has no refresh token` |
| **复现** | ①`feishu_auth status` 记下 `expiresAt` 与 `refreshable`；②`feishu_auth refresh`；③再 `status`：旧版本下 `expiresAt` 变了但 `refreshable` 变 `false` |
| **环境** | 密钥存 `~/.dsh/.credentials.yaml`（推荐做法）⇒ `config.appSecret` 恒为空 |
| **关键错误码** | 本地错误 `the stored Feishu grant has no refresh token`；后续调用 `99991668`（user token 失效） |
| **根因** | ①**代码层**：旧 `lib/identity.js` 的「响应没带新 refresh_token 就沿用旧值」被 `config.appSecret.length > 0` 连坐守卫——密钥放凭据库时该守卫永假，旧 token 被覆盖成空串。②**协议层**：飞书 `refresh_token` **一次性**，且**只在授权含 `offline_access` 时才下发**（官方文档「字段权限要求」）；本次授权 `scope` 被裁掉 `offline_access`，所以后端根本不会给新 token。 |
| **修复** | 代码：无条件沿用旧 `refreshToken`/`refreshExpiresAt`（`41b91fe`），并补 `scope` 沿用、写盘失败重试+内存副本、OAuth 错误码透传、6 条可执行提示、`status` 报 `refreshExpiresInDays`。**但**后端权限不开，任何代码都拿不到 refresh token。 |
| **修改文件** | `lib/identity.js`、`lib/errors.js`、`lib/tools/auth.js`（`41b91fe`） |
| **回归** | 离线：5 条专项用例（省略即沿用 / 轮换即覆盖 / 只读库仍可续 / 失败码与提示 / 未知有效期不编造）→ `npm test` 全绿。线上：**未通过**，`AUTH-03` 仍 blocked —— 因为 `scope` 里没有 `offline_access`。 |
| **遗留风险** | 🔴 见 ISSUE-07：需在飞书后台开通 `offline_access` 并**创建版本发布**，之后重新授权，`refreshable` 才会是 `true`。飞书另有 365 天硬上限。 |

---

## ISSUE-02 · 工具能建文件夹，却删不掉（`feishu_drive`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_drive delete_file` / `move` · `DRV-02`、清理阶段 |
| **现象** | 运行器清理时报 `docType must be one of "doc","docx","sheet","bitable","mindnote","file","slides","wiki"`；`type=folder` 被参数校验直接拒掉，文件夹永久留在云空间 |
| **复现** | ①`feishu_drive action=create_folder name=DSH-TEST-x` → 成功；②`feishu_drive action=delete_file fileToken=<该文件夹> docType=folder` → 参数校验失败；③用 `feishu_api DELETE /drive/v1/files/<token>?type=folder` → **200 成功** |
| **环境** | 用户身份，云空间根目录 |
| **关键日志** | 插件侧：`docType must be one of …`；飞书侧：`type=folder` 删除返回成功（task_id） |
| **根因** | `lib/tools/drive.js` 的 `DOC_TYPES` 少了 `folder`。该枚举同时约束 `move` / `delete_file` / `get_meta`，于是**工具创建的资源类型不在工具自己能操作的类型集合里**——创建与清理能力不对称。 |
| **修复** | `DOC_TYPES` 增加 `'folder'`（已实测飞书接受 `type=folder`） |
| **修改文件** | `lib/tools/drive.js` |
| **回归** | 离线：`drive delete_file accepts a folder token`（断言请求带 `type=folder`）→ 通过。线上：`DRV-02…DRV-05` 全链路 + 清理两条全部成功 |
| **遗留风险** | 无（`shortcut` 类型仍未纳入，插件也不创建快捷方式） |

---

## ISSUE-03 · `import_file` 成功后无法再引用该任务/文档（`feishu_doc`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_doc import_file` / `list_import_tasks` · `DOC-07`、`DOC-08` |
| **现象** | 导入成功但返回的 `data` 只有 `{extra, job_error_msg, job_status}`：**没有 ticket、没有新文档 token、没有 url**。导致 ①无法再用 `list_import_tasks` 追查；②无法定位/清理刚导入的文档 |
| **复现** | `feishu_doc action=import_file filePath=xxx.md folderToken=<folder>`（需 `pollMs` 内完成）→ 检查返回 `data` 的键 |
| **环境** | 用户身份；导入任务要求显式目标文件夹（根目录不接受） |
| **关键日志** | 服务端 `GET /drive/v1/import_tasks/<ticket>` 原始返回含 `token`/`url`，但插件只回传 `status.result` 的**部分**字段 |
| **根因** | 成功分支直接 `data: result`（服务端形状），而**本地已知的 `ticket`** 没有并入；服务端在部分情况下不回 `token`/`url`，两者叠加后调用方拿到一个无法引用的结果 |
| **修复** | 成功与「仍在转换」两个分支统一 `withTicket(result)`：始终带 `ticket`，并把 `token`/`url` 提升到 `summary`/`url` 字段 |
| **修改文件** | `lib/tools/docx.js` |
| **回归** | 离线：`docx import_file reports the ticket it polled with` → 通过。线上：`DOC-07` 返回 `keys=ticket,extra,job_error_msg,job_status`，`DOC-08` 用该 ticket 查询成功 |
| **遗留风险** | 服务端偶发不回 `token` 时，仍只能靠 ticket 查；已在文档写明「用 ticket 追」 |

---

## ISSUE-04 · `create_field` 要求冗余的 `name`（`feishu_bitable`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_bitable create_field` · `BIT-04` |
| **现象** | 传 `fields: [{name:'备注', type:'text'}]`（与 `create_table`/`create_app` 同一套描述）→ 报 `create_field needs a name`，而名字就在 fields[0] 里 |
| **复现** | `feishu_bitable action=create_field appToken=<base> tableId=<table> fields=[{name:'备注',type:'text'}]` |
| **环境** | 用户身份，Base V1 字段接口 |
| **关键日志** | 本地校验错误 `create_field needs a name` |
| **根因** | 校验先看 `args.name`，再看 `args.fields[0]`；两个参数集语义重复，报错信息也没提示 `fields` 可用 |
| **修复** | 名字按 `name` → `fields[0].name` 顺序解析；两者都没有才报错，并在提示里写明两种传法 |
| **修改文件** | `lib/tools/bitable.js` |
| **回归** | 离线：`bitable create_field takes its name from fields when name is omitted` → 通过。线上：`BIT-04` 创建「备注」成功 |
| **遗留风险** | 无 |

---

## ISSUE-05 · 推荐 scope 缺 `base:dashboard:create`（`feishu_auth`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_auth authorize_url` / `feishu_dashboard` 写操作 · `DSH-01`、`DSH-03` |
| **现象** | 按插件推荐 scope 授权后，`create_dashboard`/`create_block` 一律 `99991679`，而插件本身提供这些 action ⇒ **能力与推荐权限不匹配** |
| **复现** | 用 `RECOMMENDED_SCOPES` 生成授权链接 → 授权 → `feishu_dashboard action=create_dashboard` |
| **环境** | 用户身份，Base V3 仪表盘接口 |
| **关键日志** | `99991679 … required one of these privileges under the user identity: [base:dashboard:create]`（实测逐个接口探测：`create_dashboard`/`create_block` 需 `base:dashboard:create`；`list_dashboards`/`get_block_data` 需 `base:dashboard:read`） |
| **根因** | `RECOMMENDED_SCOPES` 只加了 read，没有 write |
| **修复** | 补 `base:dashboard:create`（并保留 read） |
| **修改文件** | `lib/tools/auth.js` |
| **回归** | 离线：`the recommended scopes cover the Base dashboard write path` → 通过。线上：仍 blocked（**后台未开通**，属 ISSUE-07） |
| **遗留风险** | 后台开通后需重新授权一次才生效 |

---

## ISSUE-06 · 撤回必须用「发送方身份」（契约要点，非代码缺陷）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_message` 测试消息清理 · `MSG-08` |
| **现象** | 机器人发的消息用默认身份（`auto`→user）撤回 → `No permission to recall this message … Not allowed to recall messages sent by others` |
| **根因** | `feishu_api` 的 `identity` 默认 `auto`，本机有用户授权时会解析成 user；而该消息是 app（机器人）发的 |
| **处理** | 不改代码（默认行为是文档化的）；运行器与文档统一为「谁发的谁撤回」：发送用 `identity:'app'`，撤回也用 `identity:'app'` |
| **回归** | 线上 `MSG-08` 通过；清理阶段 6 条测试消息全部撤回成功 |
| **遗留风险** | 使用方需知道这条规则，已写入测试报告 §5 与本节 |

---

## ISSUE-07 · 应用后台权限缺口（**阻塞项，未修，需用户操作**）

| 项 | 内容 |
|---|---|
| **功能与用例** | 影响 `AUTH-03`、`DOC-02`、`QRY-01/02/03`、`DSH-01`（连带 `DSH-02…08` 跳过）共 7 条 blocked |
| **现象** | 授权链接申请 13 项 scope，飞书只授予 9 项；被裁掉的 4 项正是上述能力所需 |
| **判定依据** | 授权后在带 `offline_access` 的链接上仍未出现在 `scope` 里 ⇒ 不是用户拒绝，而是**应用只有这些权限可给** |
| **被裁掉** | `offline_access`、`base:table:read`、`base:dashboard:read`、`base:dashboard:create`（另有需开通的 `docx:document.block:convert`） |
| **影响范围** | ①令牌无法自动续期（每约 2 小时要重授权）；②`append_markdown` 不可用；③LiteQuery 聚合不可用；④仪表盘读写全部不可用 |
| **需要谁提供** | **用户**：飞书开发者后台 → 开发配置 → 权限管理，开通上述 5 项 → **创建版本并发布** → 回来重新授权一次 |
| **验收判据** | `feishu_auth status` 的 `scope` 含 `offline_access`、`refreshable: true`、`refreshExpiresInDays` 有值；随后 `feishu_auth refresh` 连做两次，`refreshable` 始终 `true` |
| **当前状态** | ⏳ 待用户在后台操作；代码侧已就绪（`41b91fe` + ISSUE-05） |


---

## ISSUE-08 · 工具生成的授权链接会被自己的回调拒绝（`feishu_auth authorize_url`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_auth authorize_url` + `GET /api/feishu/oauth/callback`；线上复验时暴露 |
| **现象** | 点开工具返回的授权链接、在飞书页面同意后，回跳本地得到 `Authorization state mismatch — This callback did not match an authorization this host started`，授权白做一次 |
| **复现** | ①任一次从设置面板发起授权（`/api/feishu/oauth/start` 会把 state 加进 `oauth.pending`）；②再调用 `feishu_auth action=authorize_url` 拿链接；③点开链接同意 → 回跳报 state mismatch |
| **环境** | dsh-web 由 supervisor 托管；浏览器回跳 `http://127.0.0.1:3080/api/feishu/oauth/callback` |
| **关键日志** | 回调判定：`if (state !== null && oauth.pending.size > 0 && !oauth.pending.has(state)) → 400 state mismatch`（`lib/routes.js`）；而 `oauth.pending.add()` 只出现在 `oauthStart` 里 |
| **根因** | 有**两个**生成授权 URL 的入口，但只有路由 `/api/feishu/oauth/start` 把 `state` 登记进 `oauth.pending`；工具 `authorize_url` 生成 URL 后什么都没登记。于是只要面板被用过（pending 非空），工具给的链接**必被拒**；pending 为空时才侥幸放行——典型的「能用一次、之后就坏」 |
| **修复** | `lib/index.js` 把 `oauth.pending` 以 `registerOAuthState(state)` 回调透传；`lib/tools/auth.js` 在生成 URL 后立即登记该 state。两个入口从此走同一套状态登记 |
| **修改文件** | `lib/index.js`、`lib/tools/auth.js`、`test/run-tests.mjs`（回归用例） |
| **回归** | 离线：新增用例断言「对外宣告的 state = 登记进 pending 的 state = URL 里携带的 state」→ 通过（`108 passed`）。线上：改用 `/api/feishu/oauth/start?json=1` 拿到**服务端已登记**的 state，再按该 state + 13 项 scope 拼链接，用户点开可正常回跳 |
| **遗留风险** | 修复需重启 dsh-web 才对工具生成的新链接生效；在此之前请用面板入口（或按 `start` 返回的 state 拼链接）。另：`/start` 生成的链接**不带 `scope` 参数**（`config.oauthScopes` 为空时 `scopes.join(' ')` 为空串被 query 跳过），等于放弃显式申请权限——本轮靠显式拼 13 项 scope 规避 |


---

## ISSUE-09 · `append_markdown` 追加含表格的 Markdown 必失败（`feishu_doc`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_doc append_markdown` · `DOC-02` |
| **现象** | 权限开通后真正走到「转换 → 追加」两步，追加报 `1770001 invalid param`；纯文本/列表/代码块都正常，**只有含表格时失败**，且只在**追加**这一步失败（转换本身成功） |
| **复现** | `feishu_doc action=append_markdown documentId=<doc> markdown="| a | b |\n|---|---|\n| 1 | 2 |"` |
| **环境** | 用户身份；`docx:document` + `docx:document.block:convert` 均已授予 |
| **关键日志** | `{"code":1770001,"msg":"invalid param","error":{"helps":[{"description":"确认参数是否合法"}]}}` |
| **根因** | 转换接口返回的表格块带 `table.property = {row_size, column_size, column_width, merge_info}`；`append_markdown` 把整个 `property` **原样**塞给「创建嵌套块」接口，而该接口的建表语义里 `column_width` / `merge_info` 不接受（文档存在后是「既定几何」，创建时不能声明）。二分实测：`property` 原样 → fail；只留 `{row_size, column_size}` → **OK**；整块删掉 `property` → `99992402 field validation failed`（必填）。 |
| **修复** | 新增 `withCreatableTable(block)`：对 `block_type === 31` 的块，把 `table.property` 归一到建表允许的键（`row_size` / `column_size` / `header_row`），其余丢弃。只作用于 `append_markdown` 的转换产物，不碰 `append_blocks` 的调用方数据。 |
| **修改文件** | `lib/tools/docx.js` |
| **回归** | 线上 `DOC-02` 由 fail → **pass**，整篇含标题/粗斜体/行内码/列表/表格/代码块的 Markdown 追加成功；`DOC-05` 读回 207 字符含标记。离线套件保持 108 通过。 |
| **遗留风险** | 表格列宽在创建时无法指定（飞书限制），会按默认宽度渲染 |

---

## ISSUE-10 · 推荐 scope 仍缺仪表盘改/删权限（`feishu_auth`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_dashboard update_block` / `delete_block` · `DSH-07`、`DSH-08` |
| **现象** | 开通 `base:dashboard:read` + `base:dashboard:create` 后，创建/列块都通过，但改块、删块仍 `99991679` |
| **复现** | 按推荐 scope 授权 → `feishu_dashboard action=update_block` → `required one of these privileges under the user identity: [base:dashboard:update]` |
| **根因** | 仪表盘的四种写操作**各自一个 scope**：create（建仪表盘/建块）、update（改块）、delete（删块）。推荐清单只补了 create |
| **修复** | `RECOMMENDED_SCOPES` 增补 `base:dashboard:update`、`base:dashboard:delete`；回归用例同步断言三件套 |
| **修改文件** | `lib/tools/auth.js`、`test/run-tests.mjs` |
| **回归** | 源码侧已就绪（108 通过）；**线上仍 blocked**，需后台开通这两个 scope 并重新授权 |
| **遗留风险** | 🔴 用户侧操作未完（见 ISSUE-07 的处置） |

---

## ISSUE-11 · 工具失败时 hint / 错误码 / 路径全部丢失（`lib/tools/kit.js`）

| 项 | 内容 |
|---|---|
| **功能与用例** | 所有工具的失败路径（本轮在 `feishu_auth refresh` 上撞见） |
| **现象** | 续期因 token 被撤销而失败，界面只显示 `Error: OAuth token refresh failed: invalid_grant (...)`,**完全没有** `code: 20064`、「该 token 一次性、请重新授权」这类可执行提示，也没 http 状态与路径 |
| **复现** | 让续期失败（例如 refresh token 已被使用）→ 观察工具报错文本 |
| **根因** | 宿主把失败的 tool 调用渲染成 `error.message` 一个字段；而 `FeishuError` 把可执行信息放在 `hint` / `code` / `path` / `detail` 里，只有 `toText()` 才会拼进去——于是 **`errors.js` 里精心写的提示在聊天里一次都没出现过** |
| **修复** | `defineTool` 的出口加 catch：若为 `FeishuError` 且 message 尚未展开，则把 `toText()` 的完整块写回 `error.message`（**保留 error 对象本身**，所以 `code` 仍可被程序读取），再抛出 |
| **修改文件** | `lib/tools/kit.js` |
| **回归** | 离线 108 通过（现有用例按子串断言，不受影响）；线上表现需**重启 dsh-web** 后生效 |
| **遗留风险** | 报错文本会变长（含 detail 前 600 字符），属有意为之：可读性换可诊断性 |

---

## ISSUE-12 · 测试运行器自己会消耗一次性 refresh token（方法论缺陷）

| 项 | 内容 |
|---|---|
| **现象** | 首次全量跑里 `AUTH-03` 真的调用了 `feishu_auth refresh`；由于运行器把凭据库挂成只读，轮换出的新 token **无处落盘** → 线上那份 grant 的 refresh token 被消费掉，之后续期报 `20064 已撤销` |
| **根因** | 把「破坏性 + 需要落盘」的动作放进自动用例；且运行器的只读护栏本意是保护凭据，却与「真续期」互斥 |
| **修复** | `AUTH-03` 改为**非破坏性**断言（读 status 校验 `refreshable` + `offline_access` + `refreshExpiresInDays`），真续期单独列为 `AUTH-07` 并显式标记为**故意跳过**，理由写在用例里；续期改由 `feishu_auth` 手动跑（它是唯一会把新 token 落盘的出口） |
| **教训** | ①「只读凭据库」的护栏必须同时约束**会轮换凭证的调用**，两者是一对；②`refreshable: true` 只是「记录里有 refresh token」的**存在性**检查，不代表它还有效——撤销后照样显示 true，只有真续期才能证伪 |
| **遗留风险** | 本次已消耗掉一份 grant（需重新授权一次），代价记在此处避免重犯 |


---

## ISSUE-13 · `create_app` 建表失败时把已建好的 Base token 弄丢（`feishu_bitable`）

| 项 | 内容 |
|---|---|
| **功能与用例** | `feishu_bitable create_app`（带 `tables` 一次建 Base + 表） |
| **现象** | 建 Base 成功、建表被飞书拒（`1254001 WrongRequestBody`），返回的异常里**只有 API 报错**，既没有 `app_token` 也没有 url。结果是**云端多了一个没人认领的 Base**，调用方无法继续操作它（我这次是从报错的 `path` 里把 token 挖出来的） |
| **复现** | `feishu_bitable action=create_app name=X tables=[{name:Y, fields:[{name:"进度", type:"number", property:{formatter:"0%"}}]}]` → 飞书答 `Invalid request parameter: 'property.formatter'. Correct format : Number formatter 0% is invalid`，而 Base 已经存在 |
| **环境** | 用户身份；0.1.1 |
| **关键日志** | `{"code":1254001,"msg":"WrongRequestBody","error":{"message":"Invalid request parameter: 'property.formatter'. Correct format : Number formatter 0% is invalid."}}` |
| **根因** | ①飞书 number 字段的 `formatter` **不接受 `0%`**（百分比要另想办法）；②插件的 `create_app` 是**两次调用**（建 app → 建表），第二步失败时直接抛原始错误，把第一步的成果信息丢了 |
| **修复** | `createTables` 逐表 catch：抛出「app 已创建 + 它的 token + 已建成功哪些表 + 怎么补建」的可执行错误，而不是裸 API 错误 |
| **修改文件** | `lib/tools/bitable.js`、`test/run-tests.mjs` |
| **回归** | 离线：新增用例断言错误信息里含 `app_token` 与 `create_table` 指引 → 109 通过。线上：真实创建「开发任务」Base 时遇到该问题，之后按报错里的 token 用 `create_table` + `create_field` 逐个补齐 14 个字段成功 |
| **遗留风险** | 无。另记下一条契约事实：**百分比不要用 `formatter:"0%"`**，直接建普通数字字段并在字段名里写明 `(0-100)` 更稳妥 |

---

## 汇总

| 编号 | 一句话 | 状态 | 提交 |
|---|---|---|---|
| ISSUE-01 | 自动续期丢 refresh token | 代码已修，线上待后台权限 | `41b91fe` |
| ISSUE-02 | 建得出文件夹删不掉 | 已修 | `39c7396` |
| ISSUE-03 | 导入成功但不回 ticket | 已修 | `39c7396` |
| ISSUE-04 | create_field 强制冗余 name | 已修 | `39c7396` |
| ISSUE-05 | 推荐 scope 缺仪表盘写权限 | 已修 | `39c7396` |
| ISSUE-06 | 撤回要用发送方身份 | 契约要点（文档化） | `39c7396` |
| ISSUE-07 | 后台缺 5 个权限 | 🔴 阻塞，需用户操作 | — |
| ISSUE-08 | 工具生成的授权链接被自己回调拒 | 已修（需重启生效） | `5918340` |
| ISSUE-09 | 含表格的 Markdown 追加必失败 | 已修，线上验证通过 | 本次提交 |
| ISSUE-10 | 推荐 scope 缺仪表盘改/删 | 源码已修，待后台开权限 | 本次提交 |
| ISSUE-11 | 工具失败的 hint/错误码被吞 | 已修（需重启生效） | 本次提交 |
| ISSUE-12 | 运行器消耗了一次性 refresh token | 已修（用例改非破坏性） | `c201591` |
| ISSUE-13 | `create_app` 建表失败会丢 Base token | 已修 | 本次提交 |
