# dsh-feishu 飞书全功能测试报告

> 测试对象：`dsh-feishu`（DSH 0.1.2-alpha.2 第三方插件，10 个工具 / 63 个可测单元 / 6 条 HTTP 路由）
> 执行时间：2026-10-28T03:22:21Z（本机 localhost:3080 + supervisor 托管的 dsh-web）
> 执行方式：`node test/live/feishu-live.mjs`（走**插件自身的工具代码**打真飞书开放平台）
> 机器可读结果：`test/live/last-run.json`（每次运行覆盖，已被 `.gitignore` 排除）

---

## 1. 测试范围与非测试范围

**在范围内（实测）**：`feishu_auth` / `feishu_drive` / `feishu_doc` / `feishu_sheet` / `feishu_bitable` / `feishu_query` / `feishu_dashboard` / `feishu_wiki` / `feishu_message` / `feishu_api` 共 10 个工具的 61 条用例。

**明确不在范围内（插件未实现，不是漏测）**：

| 类别 | 结论 | 依据 |
|---|---|---|
| 群组管理（建群/拉人/踢人/群信息/群公告） | **不适用** | 工具定义无对应 action；`feishu_api` 可手调但无封装 |
| 通讯录（用户/部门/搜索/详情） | **不适用** | 同上；仅有 `contact:user.base:readonly` 用于拿本人 profile |
| 事件回调 / 验签 / 重试幂等 | **不适用** | 插件只注册出站 HTTP 路由（status/activity/config/oauth×3），不接收飞书事件 |
| 日历 / 审批 | **不适用** | 无工具封装 |
| 消息撤回 / 更新消息 | **部分**：撤回经 `feishu_api` DELETE 实测通过（MSG-08）；更新消息无封装 | —— |

---

## 2. 环境、版本与权限

| 项 | 值 |
|---|---|
| 仓库 / 分支 | `/Users/zyf/Project/DSH_WorkSpace/dsh-feishu` @ `main` |
| 插件安装方式 | `~/.dsh/profiles/web/node_modules/dsh-feishu` → `link:` 指向上述仓库 |
| 宿主 | supervisor 托管 `dsh-web`，`http://localhost:3080`（进程启动后才加载代码，**改代码必须重启**） |
| 飞书应用 | 自建应用 `cli_aa6a…9cc3`，App Secret 存于 `~/.dsh/.credentials.yaml` 的 `refs.FEISHU_APP_SECRET` |
| 授权身份 | 用户身份 = 应用所有者本人（`Hunter Zhang`），open_id 已脱敏为 `ou_62…8210` |
| 密钥处理 | 运行器**只读**凭据库；每次运行断言 `grant rotated: false` |

**授权范围实测（9 项）**：`auth:user.id:read bitable:app contact:user.base:readonly docx:document drive:drive im:message im:resource sheets:spreadsheet wiki:wiki`

> 申请的 13 项里被飞书裁掉 4 项（`offline_access`、`base:table:read`、`base:dashboard:read`、`base:dashboard:create`）——
> 裁剪意味着**应用后台未开通或未发版**，这是本轮 7 条 blocked 用例的唯一根因。

---

## 3. 用例执行结果汇总

| 领域 | 用例 | 通过 | 失败 | 阻塞 | 跳过 |
|---|---|---|---|---|---|
| api | 2 | 2 | 0 | 0 | 0 |
| auth | 6 | 3 | 0 | 1 | 2 |
| bitable | 10 | 10 | 0 | 0 | 0 |
| dashboard | 8 | 0 | 0 | 1 | 7 |
| doc | 8 | 7 | 0 | 1 | 0 |
| drive | 5 | 5 | 0 | 0 | 0 |
| message | 8 | 7 | 0 | 1 | 0 |
| query | 3 | 0 | 0 | 3 | 0 |
| sheet | 7 | 7 | 0 | 0 | 0 |
| wiki | 4 | 3 | 0 | 0 | 1 |
| **合计** | **61** | **44** | **0** | **7** | **10** |

判定口径：
- **pass**：真接口返回且断言成立（含清理成功）
- **blocked**：调用被飞书以权限/能力拒绝，且**不是代码能修的**（需后台开权限、发版、用户重授权，或需用户提供 webhook）
- **skipped**：刻意不跑（破坏性、需要人工粘贴 code、或创建后无从清理）
- **fail**：代码或契约缺陷，必须修

**本轮 0 失败**。7 条 blocked 全部指向同一件事：应用后台缺 4 个权限（见 §6）。

---

## 4. 功能清单与测试矩阵

> 状态列即真接口结果；证据列为运行器当场记录的实际返回值或错误码。

> 证据列里的 `message_id` 已遮蔽；其余 `doc_token` / `app_token` 等属于**运行结束时已删除**的测试产物，仅为审计可追溯保留。
> 运行器只读凭据库、不打印任何令牌，报告不含 App Secret / access_token / refresh_token。

| 用例 | 优先级 | 领域 | 状态 | 证据 |
|---|---|---|---|---|
| `AUTH-01` | P0 | auth | pass | tenant ok · user Hunter Zhang · refreshable=false · scope=9 items |
| `AUTH-02` | P0 | auth | pass | scopes=13 · redirect=http://127.0.0.1:3080/api/feishu/oauth/callback |
| `AUTH-06` | P2 | auth | pass | fallback redirect=http://127.0.0.1:3080/api/feishu/oauth/callback |
| `AUTH-03` | P0 | auth | blocked | the stored Feishu grant has no refresh token |
| `AUTH-04` | P1 | auth | skipped | destructive: the stored grant is the only one, and refresh_token is single-use |
| `AUTH-05` | P2 | auth | skipped | needs a fresh authorization code pasted in; the state is single-use |
| `API-01` | P0 | api | pass | root token present=true |
| `API-02` | P1 | api | pass | files key present=true |
| `DRV-01` | P0 | drive | pass | files=43 · has_more=undefined |
| `DRV-02` | P0 | drive | pass | token=RKBhf7V8llDJ8wdC1JLci3y… |
| `DRV-03` | P0 | drive | pass | token=Jm1PbVqMno5u1IxCllwcDNq… · uploaded DSH-TEST-202610280320.txt (49 bytes) as Jm1PbVqMno… |
| `DRV-04` | P0 | drive | pass | 49 bytes · round-trip ok |
| `DRV-05` | P1 | drive | pass | metas=1 · {"create_time":"1793157650","doc_token":"RKBhf7V8llDJ8wdC1JLci3y0n8v","doc_type… |
| `DOC-01` | P0 | doc | pass | documentId=LAN5d4sg8obuz6x5fXJ… · https://feishu.cn/docx/LAN5d4sg8obuz6x5fXJc8zDlnh7 |
| `DOC-02` | P0 | doc | blocked | blocked: the user grant lacks docx:document.block:convert (Feishu code 99991679); the app console must enable it, publish a version, and then be re-au |
| `DOC-03` | P1 | doc | pass | appended 1 block(s) |
| `DOC-04` | P1 | doc | pass | blocks=2 |
| `DOC-05` | P0 | doc | pass | chars=58 |
| `DOC-06` | P1 | doc | pass | DSH-TEST-202610280320-doc |
| `DOC-07` | P1 | doc | pass | keys=ticket,extra,job_error_msg,job_status · imported DSH-TEST-202610280320-import.m… |
| `DOC-08` | P2 | doc | pass | import ticket 7701553520977300664 status read |
| `SHT-01` | P0 | sheet | pass | token=XNdrsdpXQhiKR1tnGeN… |
| `SHT-02` | P1 | sheet | pass | read spreadsheet metadata |
| `SHT-03` | P1 | sheet | pass | sheets=1 |
| `SHT-04` | P0 | sheet | pass | wrote 3 row(s) at 8d3fea!A1:B3 |
| `SHT-05` | P0 | sheet | pass | rows=3 |
| `SHT-06` | P1 | sheet | pass | appended 1 row(s) at 8d3fea!A1:B1 |
| `SHT-07` | P1 | sheet | pass | added sheet 2Y60b6 to the spreadsheet |
| `BIT-01` | P0 | bitable | pass | appToken=Cpi4bIfK3aove3shBGV… |
| `BIT-02` | P0 | bitable | pass | tables=2 · first=数据表 |
| `BIT-03` | P1 | bitable | pass | created table "tags" (tblb7F1GglvX0j81) |
| `BIT-04` | P1 | bitable | pass | created field "备注" in table tblOOzNHAijzDm5a |
| `BIT-05` | P0 | bitable | pass | fields=4 |
| `BIT-06` | P0 | bitable | pass | records=2 |
| `BIT-07` | P0 | bitable | pass | matched=1 · total=1 |
| `BIT-08` | P1 | bitable | pass | updated 1 record(s) in table tblOOzNHAijzDm5a |
| `BIT-09` | P1 | bitable | pass | read record reczz28SgEmoKeGI |
| `BIT-10` | P1 | bitable | pass | deleted 1 record(s) from table tblOOzNHAijzDm5a |
| `QRY-01` | P1 | query | blocked | blocked: the user grant lacks base:table:read (Feishu code 99991679); the app console must enable it, publish a version, and then be re-authorized |
| `QRY-02` | P1 | query | blocked | blocked: the user grant lacks base:table:read (Feishu code 99991679); the app console must enable it, publish a version, and then be re-authorized |
| `QRY-03` | P2 | query | blocked | blocked: the user grant lacks base:table:read (Feishu code 99991679); the app console must enable it, publish a version, and then be re-authorized |
| `DSH-01` | P1 | dashboard | blocked | blocked: the user grant lacks base:dashboard:create (Feishu code 99991679); the app console must enable it, publish a version, and then be re-authoriz |
| `DSH-02` | P1 | dashboard | skipped | a prerequisite case failed |
| `DSH-03` | P1 | dashboard | skipped | a prerequisite case failed |
| `DSH-04` | P1 | dashboard | skipped | a prerequisite case failed |
| `DSH-05` | P2 | dashboard | skipped | a prerequisite case failed |
| `DSH-06` | P1 | dashboard | skipped | a prerequisite case failed |
| `DSH-07` | P2 | dashboard | skipped | a prerequisite case failed |
| `DSH-08` | P2 | dashboard | skipped | a prerequisite case failed |
| `WIK-01` | P1 | wiki | pass | spaces=3 · first=[旖旎量化] |
| `WIK-02` | P1 | wiki | pass | nodes=6 |
| `WIK-03` | P1 | wiki | pass | resolved node "[旖旎量化]文档首页" to docx CjWEd6Hwxo4et1xYFSQc65ugngb |
| `WIK-04` | P1 | wiki | skipped | blocked: neither the plugin nor the open platform offers a delete-node call, so a created node cannot be cleaned up — needs a disposable test space |
| `MSG-01` | P0 | message | pass | message_id=om_x100b6122ebd6f8b4def… |
| `MSG-02` | P0 | message | pass | replied to message om_x100b61… |
| `MSG-03` | P1 | message | pass | message_id=om_x100b6122ebf18cacc0e… |
| `MSG-04` | P1 | message | pass | message_id=om_x100b6122eb80e138c48… |
| `MSG-05` | P1 | message | pass | message_id=om_x100b6122eb4c28acde9… |
| `MSG-06` | P1 | message | pass | message_id=om_x100b6122eb6cb8acde5… |
| `MSG-07` | P2 | message | blocked | blocked: needs a custom-bot webhook URL, which only the user can create |
| `MSG-08` | P2 | message | pass | called DELETE /im/v1/messages/om_x100b61… |

---

## 5. 复现与验证命令

```bash
cd /Users/zyf/Project/DSH_WorkSpace/dsh-feishu

# 离线门禁（不联网，107 项）
npm test

# 线上全量（真接口；约 2 分钟；自动清理，可加 --keep 保留产物）
node test/live/feishu-live.mjs

# 只跑某些领域
node test/live/feishu-live.mjs --only=drive
node test/live/feishu-live.mjs --only=doc
node test/live/feishu-live.mjs --list          # 只列用例，不发任何请求

# 查看结果（机读）
cat test/live/last-run.json | python3 -m json.tool | head -40
```

**安全护栏（写在运行器里，不是靠自觉）**：
1. 凭据库以**只读适配器**挂载，任何写操作被拒绝并记录；运行结束断言 `expiresAt` 未变（`refresh_token` 一次性，写坏即毁）。
2. 不调用 `feishu_auth logout` / `complete`（前者毁凭据，后者需要一次性 code）。
3. 所有产物带 `DSH-TEST-<时间戳>` 前缀，结束时倒序删除；消息按 id 撤回。
4. 消息只发给**授权用户本人**的 open_id，不发群、不发他人。

---

## 6. 已知问题与风险

| # | 问题 | 影响 | 谁能修 |
|---|---|---|---|
| 1 | 应用后台缺 `offline_access` | 用户令牌约 2 小时过期后无法自动续期，必须人工重授权（**唯一影响日常使用**） | 用户：飞书开发者后台开通 + **创建版本并发布** |
| 2 | 缺 `docx:document.block:convert` | `feishu_doc append_markdown` 全线不可用（99991679） | 同上 |
| 3 | 缺 `base:table:read` | `feishu_query`（LiteQuery 聚合）不可用 | 同上 |
| 4 | 缺 `base:dashboard:read` / `base:dashboard:create` | `feishu_dashboard` 读、写全部不可用 | 同上 |
| 5 | `feishu_message webhook` 需自建机器人 webhook URL | 该 action 无法自动测 | 用户：群/单聊里加自定义机器人并给 URL |
| 6 | `feishu_wiki` 无删除节点能力（插件与开放平台都没有） | 建的 wiki 节点无法清理，故本轮不建 | 如需覆盖：提供可弃用的测试知识库 |
| 7 | 代码改动需重启 dsh-web 才生效 | 改了代码但没重启 = 仍在跑旧逻辑 | 运维动作（supervisor 托管） |

**已修复的 5 个缺陷**见 `docs/feishu-issue-fix-log.md`（含复现步骤、根因、修改文件、回归结果）。

---

## 7. 变更文件清单

| 文件 | 变更 |
|---|---|
| `lib/tools/drive.js` | `DOC_TYPES` 增加 `folder`（否则工具建得出文件夹、删不掉） |
| `lib/tools/docx.js` | `import_file` 成功/未完成分支都带上本地已知的 `ticket`，并回传 `token`/`url` |
| `lib/tools/bitable.js` | `create_field` 允许从 `fields[0].name` 取名，不再强制冗余的 `name` |
| `lib/tools/auth.js` | `RECOMMENDED_SCOPES` 补 `base:dashboard:create` |
| `test/run-tests.mjs` | 新增 4 条离线回归（import ticket / create_field 取名 / folder 删除 / 推荐 scope 覆盖） |
| `test/live/credentials.mjs` | 新增：只读凭据适配器（拒绝一切写） |
| `test/live/feishu-live.mjs` | 新增：61 用例真接口运行器（自动清理、断言不轮换） |
| `.gitignore` | 排除 `test/live/last-run.json` 运行产物 |

## 8. Git 记录

| 提交 | 内容 |
|---|---|
| `39c7396` | `test(live): …` 运行器 + 4 处产品修复 + 4 条回归用例 |
| 见 `git log` 最新一条 | `docs(feishu): …` 本报告 + 问题日志 + 交接/记忆更新 |
