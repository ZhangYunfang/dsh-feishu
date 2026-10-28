# dsh-feishu

> **本分支（`ZhangYunfang/dsh-feishu`，v0.1.1）是针对 DeepSeek Harness `0.1.2-alpha.2` 维护的适配版。**
> 保留上游设计（不 import `@deepseek-ai/*`、单一 wire 契约），并修掉 12 个已复现问题——
> 最关键的三个是：用户授权**能真正自我续期**、含表格的 Markdown 能追加、**建出的文件夹能删掉**，
> 另附 62 条打真飞书接口的测试。
>
> - 装到别的机器：[`docs/install-for-others.md`](docs/install-for-others.md)
- 用户指南（怎么使唤 agent、各类任务配方）：[`docs/user-guide.md`](docs/user-guide.md)
> - 能做什么、每项能力要什么权限：[`docs/feishu-capabilities.md`](docs/feishu-capabilities.md)
> - 改了什么、怎么验的：[`CHANGELOG.md`](CHANGELOG.md)
> - 上游项目：<https://github.com/2048lr/dsh-feishu>

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**飞书 / Lark** 深度接入插件。

它给 agent 八个工具，直接操作真实飞书租户，并附带一个可视化设置页：

| 工具 | 作用 |
|---|---|
| `feishu_bitable` | 新建**多维表格**（一次调用建库 + 建表 + 建字段）；列出表与字段；批量增删改查记录 |
| `feishu_dashboard` | 在多维表格里建**仪表盘和图表**（柱状图／条形图／折线图／饼图／环形图／面积图／组合图／散点图／漏斗图／词云／雷达图／排行榜／指标卡／NPS／文本，共 15 种），可指定位置，并读回图表算好的数据 |
| `feishu_query` | 跑**分组聚合查询**（维度分组 + sum/avg/min/max/count/distinct_count + 筛选 + 排序 + Top N），聚合在服务端完成 |
| `feishu_doc` | 新建文档；把 **Markdown 转成原生块**追加；追加原始块；读纯文本；把本地 md/docx/xlsx/pptx/pdf **导入**成云文档 |
| `feishu_sheet` | 新建电子表格；加 sheet；按 A1 区域读 / 写 / 追加 |
| `feishu_drive` | 浏览目录、建文件夹、上传下载、移动、删除、批量取元数据 |
| `feishu_wiki` | 知识库空间与节点；把 wiki token 解析成真正的文档 token；建节点 |
| `feishu_message` | 发文本 / 卡片 / 富文本 / 文件 / 图片；回复；自定义机器人 webhook |
| `feishu_auth` | 诊断授权、生成授权链接、手工换 code、刷新、登出 |
| `feishu_api` | 任意 open-apis 路径的逃生舱（日历、任务、审批等） |

新内容会落在**用户自己的云空间**，因为工具默认以「已授权用户」身份行事；没有用户授权时会退回应用身份，**并在结果里给出警告**，不会把文档悄悄塞进用户看不见的地方。

---

## 快速开始

### 1. 新建飞书应用

1. 登录 [飞书开放平台](https://open.feishu.cn/app)，创建**企业自建应用**
2. 「凭证与基础信息」→ 复制 **App ID** 与 **App Secret**
3. 「安全设置 → 重定向 URL」→ 添加（端口以设置页显示为准）：

   ```
   http://127.0.0.1:19387/api/feishu/oauth/callback
   ```

4. 「权限管理」→ 开通权限，然后**创建版本并发布**：

   | 权限 | 用途 |
   |---|---|
   | `offline_access` | **必加** —— 没有它拿不到 refresh_token，用户每两小时就要重新授权 |
   | `bitable:app` | 多维表格 |
   | `docx:document` | 文档 |
   | `drive:drive` | 云空间、导入、上传 |
   | `sheets:spreadsheet` | 电子表格 |
   | `wiki:wiki` | 知识库 |
   | `im:message`、`im:resource` | 消息与文件 / 图片发送 |
   | `contact:user.base:readonly` | 读取授权用户昵称 |

   > **最容易踩的坑**：只勾权限不**发版**，接口照样报 `99991672`。

### 2. 启用插件

见下面的[安装](#安装)，然后重启 DeepSeek Harness。

### 3. 在图形界面里配置

打开 **设置 → 飞书 / Feishu**，全部字段都可视化编辑，不需要手写 YAML：

- **应用凭据** —— App ID、App Secret（只写）、凭据引用名、品牌（飞书 / Lark）
- **默认落点与身份** —— 新内容默认落在哪个文件夹、工具默认用哪个身份
- **功能开关** —— 是否注册工具、是否挂载 HTTP 路由、是否显示悬浮面板、工具名前缀
- **授权** —— 申请的 scopes、要登记的重定向 URL
- **高级** —— 端点覆盖与分页上限

**保存只会重写本插件在 `cordis.patch.yml` 里的那一个条目**，宿主会热加载，大部分改动无需重启。App Secret **不会**写进配置文件，而是直接进凭据库，页面只显示"是否已配置"。

### 4. 授权

在设置页点「授权飞书」。**如果新标签没打开，点「复制授权链接」粘贴到浏览器**即可（桌面壳有权拦截 window.open）。授权完成后回到页面点「刷新状态」。

---

## 安装

两种方式，**二选一，不要都做**。两种都会产生 id 为 `feishu` 的 loader 条目，而同一个 id 出现两次时宿主会直接拒绝加载（`duplicate loader entry id`）。

### 作为 bundle 安装（推荐）

包内声明了 `dsh.bundle` patch，支持 bundle 的 CLI 一条命令即可安装并挂载：

```sh
dsh plugin add github:2048lr/dsh-feishu
```

它会把 `dsh-feishu` 追加进 `dsh.profile.bundles`，profile 启动时合并 [cordis.patch.yml](cordis.patch.yml) 插入插件条目，**不需要再改任何文件**。

设置页也知道这一点：当 profile 以 bundle 方式挂载时，它写的是**按 id 的配置覆盖**，而不是再插一条，所以从图形界面保存不会破坏配置树。

### 手工安装（不用 CLI）

插件必须能从 profile 的 `node_modules` 解析到，所以要拷进去。**用拷贝而不是软链接**：软链接的插件会从真实路径解析裸导入，从而错过 SDK。

```powershell
# 在仓库根目录执行
pwsh -File scripts/install.ps1
```

脚本会把包拷进 profile 的 `node_modules`，并在 `cordis.patch.yml` 里插入条目，同时安装配套 skill。

**必须重启 DeepSeek Harness**（宿主半边是进程内缓存的 Node 模块），之后配置就可以完全在设置页里做了。

### 为什么这个包不 import `@deepseek-ai/*`

第三方插件是从软链接或拷贝目录加载的，在那个位置裸导入 `@deepseek-ai/dsh-tools` 会解析到**另一个** DSH 副本，而不是正在运行的宿主。所以宿主半边只 import Node 内置模块，工具定义与配置校验都是手写的；测试套件用**真实的** SDK 校验器验证每一份 schema，保证不会和注册表契约漂移。

---

## 配置项

除 `appId` 外全部可选，且都可以在设置页里改。

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` | — | 飞书应用 App ID，必填 |
| `appSecretRef` | `FEISHU_APP_SECRET` | 凭据引用名，先查凭据库再查环境变量 |
| `brand` | `feishu` | `feishu`（open.feishu.cn）或 `lark`（open.larksuite.com） |
| `defaultFolderToken` | `''` | 新建内容的默认落点 |
| `defaultIdentity` | `auto` | `auto` / `user` / `app` |
| `toolPrefix` | `feishu_` | 工具名前缀 |
| `enableTools` / `enableOAuth` / `enableUi` / `registerSystemPrompt` | `true` | 功能开关 |
| `requestTimeoutMs` / `maxRetries` | `30000` / `2` | 超时与尝试次数 |
| `oauthScopes` | 推荐集合 | 授权时申请的 scopes |
| `patchFilePath` | 自动 | 设置页编辑的配置文件；**不允许从浏览器写入** |

环境变量兜底：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BRAND`、`FEISHU_FOLDER_TOKEN`、`FEISHU_USER_ACCESS_TOKEN`。

---

## 两代多维表格接口

插件**刻意同时使用**两代接口：

- **V1**（`/bitable/v1/apps/...`）：建库、表、字段、记录。它是公开文档化的接口，也是官方 Lark/飞书 SDK 里有的那套。
- **V3**（`/base/v3/bases/...`）：只用于 V1 完全没有的两件事 —— **仪表盘图表**和**服务端聚合**。注意资源名是 `bases` 不是 `apps`：两代路径不能互换，问错版本只会得到纯文本的 `404 page not found`，而不是业务错误码。

V3 比已发布的 SDK 还新，所以从 SDK 的类型定义里找不到它；这里的参数结构取自官方 [Lark CLI](https://github.com/larksuite/cli)，并已对着线上接口逐一验证。

| | V1 | V3 |
|---|---|---|
| 字段类型 | 数字（`1`=文本） | 字符串（`"text"`） |
| 记录形态 | 行对象 `{record_id, fields}` | **列式矩阵** `data` + `field_id_list` |
| 批量写 | `{records: [{fields}]}` | `record_id_list` / `by_filter` + `patch` |
| 聚合 | 无 | `POST .../data/query`，DSL 用**表名／字段名** |
| 图表 | 无 | `dashboards` + `dashboards/{id}/blocks` |

一个图表 block 完全由一个 `data_config` 描述，里面用**表名和字段名**、不用 ID：

```json
{
  "table_name": "订单表",
  "series": [{ "field_name": "金额", "rollup": "SUM" }],
  "group_by": [{ "field_name": "类别", "mode": "integrated", "sort": { "type": "value", "order": "desc" } }],
  "filter": { "conjunction": "and", "conditions": [{ "field_name": "状态", "operator": "is", "value": "已完成" }] }
}
```

统计行数用 `count_all: true` 代替 `series`；`text` 类型 block 用 `{"text": "…"}`（支持 Markdown）。聚合问答交给 `feishu_query`，这样"哪个大区卖得最多"是一次调用，而不是把整表翻一遍。

## 工作原理

```
lib/
  index.js        组合根：配置、身份、客户端、工具、路由
  config.js       归一化、品牌端点、默认值
  identity.js     应用凭据、tenant/app token、用户授权、OAuth、刷新
  http.js         单次请求：超时、有限重试、字节上限
  client.js       飞书协议层：信封拆解、鉴权、multipart、分页
  errors.js       失败整形与按错误码给出的修复提示
  local-file.js   按会话工作目录解析路径、上传下载
  activity.js     给面板用的定长内存记录
  entry-config.js 安全读写本插件自己的 loader 条目
  routes.js       /api/feishu/{status,activity,config,oauth/*}
  tools/          八个工具 + schema 校验与结果信封
  ui/client.js    浏览器半边：悬浮面板与设置页
```

**令牌托管**：App Secret 按引用解析、永不外泄；tenant/app token 按需签发、内存缓存、过期前 2 分钟重签、并发单飞；用户令牌是长期授权，以凭据记录 `dsh-feishu/user-token` 持久化（含 refresh_token），临近过期惰性刷新，被飞书拒绝时再自动重试一次。

**两个飞书域名别搞混**：tenant/app token 与业务接口在 `open.feishu.cn/open-apis`，OAuth 在 `accounts.feishu.cn/open-apis`。用错域名会返回纯文本 404。

**失败处理**：飞书业务错误是 HTTP 200 + 非 0 `code`。客户端把两种形态统一成 `FeishuError`，带上错误码、HTTP 状态、路径、`permission_violations` 和修复提示；令牌过期只自动重试一次。

---

## 开发

```bash
npm test          # 等价于 node test/run-tests.mjs
```

测试不需要 harness，用一个假飞书租户驱动真实的 `fetch`。其中两项**必须对着真实 DSH SDK** 校验：每个工具的**参数与输出 schema** 通过 `assertSupportedJsonSchema`；每个参数 schema 能通过 `jsonSchemaToTs` 渲染（保证 PTC 模式可用）。

SDK 不是本包依赖，测试会在常见 profile / 全局位置查找它；找不到就跳过那两项（CI 里就是如此）。可用 `DSH_TOOLS_PATH` 指定。

---

## 安全说明

- App Secret 按引用读取，从不经 HTTP 返回；状态接口只说"是否配置"和来源
- OAuth 路由仅回环地址、同源；回调校验自己签发的 `state`，不匹配直接拒绝
- 令牌不落日志；操作记录只存摘要与链接
- `feishu_api` 是设计上的完整逃生舱，只在信任 agent 使用该应用权限的环境里启用

## 卸载

```powershell
pwsh -File scripts/uninstall.ps1
```

然后重启 DeepSeek Harness。想连用户授权一起清掉，先跑 `feishu_auth` 的 `logout`。

## 同类项目

飞书集成这个领域已经相当拥挤，所以有必要说清楚**这个插件是什么、不是什么**。以下描述只是**当时**的情况，最新状态请点进链接看。

### 官方

- **[larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)**
  （MIT，npm `@larksuiteoapi/lark-mcp`）—— 官方 Model Context Protocol 服务，覆盖面**远大于**本项目：把飞书开放平台整个 OpenAPI 包成 MCP 工具集，用 preset 启用，涵盖 IM、日历、通讯录、审批、云空间等等。
  但对"文档类"用途有两个要注意的点，**都来自它自己的 README 和工具清单**：一是它明确写了**云文档内容编辑暂不支持（仅导入和读取）**；二是它的多维表格覆盖的是 **V1** 面 —— 仪表盘只有 `list` 和 `copy`，**没有创建/更新仪表盘、没有图表 block、没有聚合查询**。
- **[larksuite/cli](https://github.com/larksuite/cli)** —— 官方 CLI，带 `lark-base` 技能与参考文档。本项目的 **V3 接口形态**和 **`data_config` 结构**都取自这里，并已对着线上 API 逐一验证。

### 社区飞书 MCP 服务

- [shou-nian/feishu-mcp-server](https://github.com/shou-nian/feishu-mcp-server)
- [leemysw/feishu-docx](https://github.com/leemysw/feishu-docx) —— 文档 / 表格 / 多维表格与 Markdown 双向转换，面向 agent

### 其他 DeepSeek Harness 插件

DSH 插件市场里有**一百多个**飞书/Lark 插件，但绝大多数是 **IM 桥**（在飞书里跟 agent 对话、审批卡片、通知推送），和本项目不是一回事。性质最接近的是：

- [zhengjy01/dsh-feishu-mcp](https://github.com/zhengjy01/dsh-feishu-mcp) —— 通过 MCP 把飞书 OpenAPI 接进 DSH
- [Mr-SYGao/dsh-feishu-reader](https://github.com/Mr-SYGao/dsh-feishu-reader) —— 读取飞书文档 / 知识库 / 表格 / 多维表格（**只读**）
- [meliwanx/dsh-office-cli](https://github.com/meliwanx/dsh-office-cli) —— 封装官方 企业微信 / 钉钉 / 飞书 CLI
- [shrekcg/dsh-im-channel](https://github.com/shrekcg/dsh-im-channel) —— IM 接入，顺带打包了一批飞书 MCP 工具

### 本项目的差异

本项目**刻意做得窄而深**。相比上面这些，多出来的能力是：

- **能写，不只是读** —— Markdown 转成原生文档块、本地文件服务端导入、电子表格写入、多维表格记录读写。
- **图表与仪表盘**（V3 接口），并且能读回图表**算好的数值**。
- **服务端聚合**（`feishu_query`）："按……取前 N" 是一次调用，而不是把整表翻一遍。
- **用户身份 OAuth** 且自动刷新，新内容落在**用户自己的云空间**，而不是应用空间。
- **可视化设置页**，以及按错误码给出修复提示的报错。

这个清单之外的（日历、审批、通讯录、IM），请用官方 MCP 或官方 CLI，或者直接走 `feishu_api` 逃生舱。

---

## 许可证

[MIT](LICENSE) © 2026 Run Liu

飞书 / Lark 是各自权利人的商标。本项目是独立集成，与官方无隶属或背书关系。
