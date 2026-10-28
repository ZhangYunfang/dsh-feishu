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
