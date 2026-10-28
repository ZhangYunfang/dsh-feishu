# dsh-feishu 功能能力目录

> 这份文件回答一个问题：**这个插件到底能做什么、需要什么权限、验到什么程度。**
> 数据来源：`lib/tools/*.js` 的工具定义（不是 README 转述）+ 2026-10-28 的真接口实测（`test/live`）。
> 配套：`docs/feishu-test-report.md`（测试矩阵）、`docs/feishu-issue-fix-log.md`（问题与修复）。

## 0. 总览

| 维度 | 数字 |
|---|---|
| 工具数 | **10** |
| 可测单元 | **63**（61 个 `action` + `feishu_query`、`feishu_api` 两个单操作工具） |
| HTTP 路由 | 6 条（`status` / `activity` / `config` / `oauth/start` / `oauth/callback` / `oauth/logout`） |
| 真接口实测 | **57 通过 · 0 失败 · 1 阻塞 · 4 跳过**（62 用例） |

身份三选一：`identity = auto | user | app`。`user` 让新文档落在**你本人**的云空间，`app` 以应用身份操作；`auto` 优先 user，没有授权时用 app **并在结果里显式告警**（不会悄悄落到错误的盘）。

权限分两层，缺任一层都会报 `99991679`：
① **应用权限**（开发者后台「权限管理」勾选 + **创建版本发布**，生效快）；
② **用户授权范围**（点「同意」那一刻固化，事后开权限**不会**自动扩，必须重新授权）。

---

## 1. 鉴权与配置 — `feishu_auth`

| action | 作用 | 所需权限 | 实测 |
|---|---|---|---|
| `status` | 报应用/用户/令牌状态、`scope`、`refreshExpiresInDays`、告警与处置建议 | 无（内部） | ✅ |
| `authorize_url` | 生成授权链接（默认申请 15 项 scope，并把 `state` 登记到本机） | 无 | ✅ |
| `complete` | 用粘来的 `code` 兑换授权（浏览器回调不可达时的兜底） | 无 | ⏭ 需一次性 code |
| `refresh` | 主动续期用户令牌（会轮换 refresh token 并落盘） | `offline_access` | ✅ 连跑两次成功 |
| `logout` | 清除本地授权 | 无 | ⏭ 破坏性，未自动测 |

**关键事实**：`refresh_token` **一次性**，且只在该 grant 含 `offline_access` 时才下发；响应没带新 token 时必须沿用旧值。`refreshable: true` 只是「记录里有 token」的**存在性**检查——token 被撤销后照样显示 true，要证实能续期只能真跑一次 `refresh`。

## 2. 云空间 — `feishu_drive`（权限：`drive:drive`）

| action | 作用 | 实测 |
|---|---|---|
| `list_files` | 列文件夹（分页/自动翻页） | ✅ |
| `create_folder` | 建文件夹（不传父目录时自动解析根目录 token） | ✅ |
| `upload` | 上传本地文件（multipart） | ✅ |
| `download` | 下载到本地（走 `/drive/v1/files/:token/download`，不是 media 通道） | ✅ 字节级往返一致 |
| `move` | 移动（`destFolderToken`） | ✅ |
| `delete_file` | 删除，`docType` 支持 `doc/docx/sheet/bitable/mindnote/file/slides/wiki/**folder**` | ✅ |
| `get_meta` | 批量取元信息，**支持混类型**（每个 token 自动识别，可显式 `docTypes` 钉死） | ✅ |

## 3. 云文档 — `feishu_doc`（权限：`docx:document`；`append_markdown` 另需 `docx:document.block:convert`）

| action | 作用 | 实测 |
|---|---|---|
| `create` | 新建文档（返回 `document_id` 与 url） | ✅ |
| `get` | 文档元信息 | ✅ |
| `get_raw_content` | 全文纯文本 | ✅ |
| `list_blocks` | 遍历块（自动翻页） | ✅ |
| `append_blocks` | 追加原生块（≤ 单次上限） | ✅ |
| `append_markdown` | Markdown → 原生块后追加（支持标题/样式/列表/**表格**/代码块） | ✅ |
| `import_file` | 导入本地 md/docx/xlsx… 为云文档（**需显式目标文件夹**，返回 `ticket` 与文档 token） | ✅ |
| `list_import_tasks` | 用 `ticket` 查导入任务状态 | ✅ |

## 4. 电子表格 — `feishu_sheet`（权限：`sheets:spreadsheet`）

`create` · `get_info` · `list_sheets` · `read` · `write` · `append` · `add_sheet` —— **7/7 实测通过**（A1 记法，支持 `sheetId!A1:B3`）。

## 5. 多维表格 — `feishu_bitable`（权限：`bitable:app`）

| action | 说明 | 实测 |
|---|---|---|
| `create_app` | 建 Base，**可同时建表与字段**（`tables[].fields`）；返回 `data.app.app_token` | ✅ |
| `list_tables` | 返回 `data.tables`（新建 Base 自带一张默认表，按 name 挑自己的表） | ✅ |
| `create_table` / `create_field` | 建表 / 建字段（`create_field` 允许用 `fields[0].name` 取名） | ✅ |
| `list_fields` | 返回 `data.fields` | ✅ |
| `insert_records` | 返回 `data.recordIds` 与完整记录 | ✅ |
| `search_records` | 过滤 + 排序（返回 `data.records` + `total`） | ✅ |
| `update_records` / `delete_records` / `get_record` | 改 / 删 / 读单条 | ✅ |

## 6. 聚合查询 — `feishu_query`（权限：`base:table:read`，Base V3 LiteQuery）

单操作工具：`dimensions`（分组）+ `measures`（`sum/avg/min/max/count/count_all/distinct_count`）+ `filters` + `sort` + `limit`，或用 `dsl` 透传原始查询。**聚合在服务端完成**，不要用 `search_records` 翻页算总数。实测：分组计数、sum/avg、排序+limit 全部通过。

## 7. 仪表盘 — `feishu_dashboard`

| action | 所需权限 | 实测 |
|---|---|---|
| `list_dashboards` `get_dashboard` `list_blocks` `get_block` `get_block_data` | `base:dashboard:read` | ✅ |
| `create_dashboard` `create_block` | `base:dashboard:create` | ✅ |
| `update_dashboard` `update_block` | `base:dashboard:update` | ✅ |
| `delete_dashboard` `delete_block` | `base:dashboard:delete` | ✅ |

图表完全由 `dataConfig` 描述（按**表名/字段名**，不用 id）：`{table_name, series:[{field_name, rollup}], group_by, filter, limit_size, number_format}`；文本块用 `{text:"markdown"}`。**四种写操作各有一个独立 scope**，只开 read 会全线 `99991679`。

## 8. 知识库 — `feishu_wiki`（权限：`wiki:wiki`）

`list_spaces` · `list_nodes` · `get_node`（wiki token → 底层文档 token 的桥） · `create_node` · `move_node` · `update_title`。
实测：读三项通过；建/移/改标题**跳过**——开放平台与插件都没有删除 wiki 节点的能力，建了清不掉，需可弃用的测试知识库才能覆盖。

## 9. 消息 — `feishu_message`（权限：`im:message`；传图传文件另需 `im:resource`）

| action | 说明 | 实测 |
|---|---|---|
| `send_text` / `send_card` / `send_post` | 文本 / 交互卡片 / 富文本 | ✅ |
| `send_image` / `send_file` | 先上传再发 | ✅ |
| `reply` | 回复指定消息 | ✅ |
| `webhook` | 自定义机器人 webhook 直发 | ⛔ **阻塞**：需用户自建机器人拿 URL |

**撤回必须用发送方身份**：机器人发的消息要用 `identity=app` 撤回，用默认（`auto`→user）会答 `Not allowed to recall messages sent by others`。

## 10. 原始逃生口 — `feishu_api`

任意 `GET/POST/PUT/PATCH/DELETE` 直达开放平台（path 相对 `open-apis`，`query` 传参，`body` 传 JSON），身份可选。用途：curated 工具没覆盖的端点、以及**清理**（如撤回消息、删 wiki 节点）。实测：GET、带 query 的 GET、DELETE 撤回均通过。

---

## 11. 明确**不支持**的能力（不是漏测）

| 类别 | 结论 |
|---|---|
| 群组管理（建群/拉人/踢人/群信息/群公告） | 无封装，只能用 `feishu_api` 手调 |
| 通讯录（用户/部门/搜索） | 无封装；仅用 `contact:user.base:readonly` 读本人 profile |
| 事件回调 / 验签 / 重试幂等 | 插件只注册**出站** HTTP 路由，不接收飞书事件 |
| 日历 / 审批 | 无封装 |
| 消息更新（编辑已发消息） | 无封装（撤回可用 `feishu_api`） |

## 12. 权限速查（最小可用集）

```text
必要（不给就基本不可用）
  offline_access            续期的前提，缺了约 2 小时就要重授权
  bitable:app               多维表格
  base:table:read           LiteQuery 聚合
  base:dashboard:read       仪表盘读
  base:dashboard:create     建仪表盘/图表块
  base:dashboard:update     改块
  base:dashboard:delete     删块
  docx:document             云文档增减改
  docx:document.block:convert  Markdown 转块（append_markdown）
  drive:drive               云空间读写
  sheets:spreadsheet        电子表格
  wiki:wiki                 知识库
  im:message                发消息
  im:resource               传图传文件
  contact:user.base:readonly  读本人 profile

插件默认授权链接就是这 15 项；profile 里不要手写 oauthScopes 把它缩水。
```

## 13. 验到什么程度（2026-10-28）

| 领域 | 用例 | 结果 |
|---|---|---|
| auth | 7 | 4 通过 / 3 跳过（logout、complete、refresh 均刻意不自动跑） |
| api | 2 | 2 通过 |
| drive | 5 | 5 通过 |
| doc | 8 | 8 通过 |
| sheet | 7 | 7 通过 |
| bitable | 10 | 10 通过 |
| query | 3 | 3 通过 |
| dashboard | 8 | 8 通过 |
| wiki | 4 | 3 通过 / 1 跳过（建节点无清理手段） |
| message | 8 | 7 通过 / 1 阻塞（webhook 需用户提供 URL） |

复跑：`npm run test:live`（约 2 分钟，自动清理）。用例清单：`npm run test:live:list`。
