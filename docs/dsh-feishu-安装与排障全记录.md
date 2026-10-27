# dsh-feishu 安装与排障全记录

> **适用版本**：DeepSeek Harness `0.1.2-alpha.2` · `dsh-feishu` `0.1.0`（commit `17ed9c0`）
> **编写日期**：2026-10-27
> **工作副本**：`/Users/zyf/Project/DSH_WorkSpace/dsh-feishu`
> **证据口径**：文中所有结论都标注了 `文件:行` 或「命令 + 输出」。无法验证的标 `UNVERIFIABLE`。

---

## 目录

- [一、结论速览](#一结论速览)
- [二、安装步骤（从零到可用）](#二安装步骤从零到可用)
- [三、问题与解法（7 个坑）](#三问题与解法7-个坑)
- [四、诊断方法论（可复用）](#四诊断方法论可复用)
- [五、当前配置与文件清单](#五当前配置与文件清单)
- [六、维护与复发风险](#六维护与复发风险)
- [七、全功能自测与修复（2026-10-27）](#七全功能自测与修复2026-10-27)
- [八、附录：命令速查与源码索引](#八附录命令速查与源码索引)

---

## 一、结论速览

**`dsh-feishu` 本身与 DSH 0.1.2-alpha.2 没有 API 不兼容**。当初「装了但用不了」是六类非插件原因叠加，另有两个插件侧的缺陷：

| # | 问题 | 层次 |
|---|---|---|
| 1 | profile 内失效的 `file:` 依赖导致**任何**插件都装不上 | 依赖解析 |
| 2 | App Secret 没有落地的存放位置 | 配置 |
| 3 | 工具输出含 `undefined`，被 DSH 无损 JSON 校验拒绝 | **代码（已修，`d2767b2`）** |
| 4 | `cordis.patch.yml` 缩进错误，`appId` 没生效 | 配置 |
| 5 | 本地鉴权插件 `SameSite=Strict` 导致 OAuth 回调死循环 | 第三方插件 |
| 6 | 飞书权限分「应用 / 用户」两层，后台开权限后用户 grant 不自动扩 | 概念 |
| 7 | 设置页报「配置文件不可写」：`patchFilePath` 未配，`link:` 安装时定位不到 profile 的 patch 文件 | 配置 |
| 8 | 自动续期后 refresh token 丢失（`lib/identity.js` 的连坐守卫） | **代码（未修，见 §六 风险 5）** |

当前状态（实测，2026-10-27）：

```
user.authorized      : true
user.scope           : auth:user.id:read bitable:app contact:user.base:readonly
                       docx:document drive:drive im:message im:resource
                       sheets:spreadsheet wiki:wiki        ← offline_access 已因缺陷 8 丢失
user.refreshable     : false        ← 缺陷 8 的直接后果，约 2 小时后需重新授权
feishu_drive(用户身份) : found 38 item(s) in the drive root
配置可写             : patch.file = /Users/zyf/.dsh/profiles/web/cordis.patch.yml（坑 7 已修）
```

---

## 二、安装步骤（从零到可用）

### A. 飞书云端（浏览器操作）

**A1 · 创建应用**
打开 <https://open.feishu.cn/app> → 创建**企业自建应用** → 记下 **App ID**（形如 `cli_xxx`）与 **App Secret**。

**A2 · 添加机器人能力**
「添加应用能力」→ 勾选 **机器人**（不加则 `im:*` 类工具不可用）。

**A3 · 配置重定向 URL**
「开发配置 → 安全设置 → 重定向 URL」，两条都加（飞书单应用上限 300 条）：

```
http://127.0.0.1:3080/api/feishu/oauth/callback
http://localhost:3080/api/feishu/oauth/callback
```

> **规则要点**（查证自 [官方文档](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN.md?lang=zh-CN)）：
> ① `http` 与自定义端口均支持，官方示例本身即 `http://example.com:8080/...`；
> ② 必须**逐字匹配**，不匹配会重定向到失败页并报 `{code: 2000, message: "redirect_uri unmatch"}`；
> ③ 必须含完整路径，但 `?` / `#` 后缀不生效；
> ④ 不支持动态路由。

**A4 · 开通权限**
「权限管理」搜索并开通这 9 个：

```
offline_access
bitable:app
docx:document
drive:drive
sheets:spreadsheet
wiki:wiki
im:message
im:resource
contact:user.base:readonly
```

**A5 · 创建版本并发布** ⚠️ 最容易漏

「版本管理与发布 → 创建版本 → 申请发布」。

> **只勾权限不发版 = 权限不生效**，调用会返回 `99991679`。发版后回「权限管理」页，每个权限状态应显示 **已生效**，而不是「待发布」。

---

### B. DSH 本地

**B1 · 安装插件**

```bash
cd /Users/zyf/Project/deepseek-harness-dsh-v0.1.2-alpha.2
pnpm dsh plugin --profile web add /Users/zyf/Project/DSH_WorkSpace/dsh-feishu
```

确认落地（应出现在 `dependencies` 与 `dsh.profile.bundles` 两处）：

```bash
grep -n "dsh-feishu" ~/.dsh/profiles/web/package.json
```

**B2 · 写入 appId 与 patchFilePath**

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**末尾追加顶层条目**（注意必须是**顶层**，缩进 0）：

```yaml
- id: feishu
  config:
    appId: 'cli_你的AppID'
    patchFilePath: '/Users/<你>/.dsh/profiles/web/cordis.patch.yml'
```

> 机制：插件自带的 bundle patch 已经 `insert` 了 `id: feishu` 的行（`appId` 为空串），此处按 `id` 覆盖它的 `config`。
> 参考 `cordis.patch.yml` 里的 `- insert:` 列表——**不要**把 feishu 行写进那个列表里（那会变成第二个插入行）。
>
> 🔴 **`patchFilePath` 不能省**：它决定设置页把改动写回哪个文件。`link:` 安装时插件无法自动定位 profile 的 patch 文件，不配它设置页会报「配置文件不可写」，详见 §三 坑 7。

**B3 · 写入 App Secret（推荐走凭据库）**

编辑 `~/.dsh/.credentials.yaml`（注意文件名**以点开头**），在 `refs:` 段追加一行（保持 0600）：

```yaml
refs:
  # ... 原有条目 ...
  FEISHU_APP_SECRET: 你的AppSecret
```

```bash
chmod 600 ~/.dsh/.credentials.yaml
```

> 插件读取顺序（`lib/identity.js:101-114`）：
> ① 凭据库 `credentials.resolve(config.appSecretRef)` → ② 同名环境变量 → ③ `config.appSecret`。
> `appSecretRef` 默认就是 `FEISHU_APP_SECRET`。
>
> **为什么不直接写 config**：YAML 里明文不如凭据库（0600）；**为什么不写 shell `export`**：会进 `~/.zsh_history`。

**B3 备选 · 走 supervisor 环境变量**

若坚持用环境变量，改 `/opt/homebrew/etc/supervisor/conf.d/30-dsh-web.conf`：

```ini
environment=HOME="/Users/zyf",COREPACK_ENABLE_DOWNLOAD_PROMPT="0",PATH="...",FEISHU_APP_SECRET="你的AppSecret"
```

```bash
chmod 600 /opt/homebrew/etc/supervisor/conf.d/30-dsh-web.conf
```

**B4 · 重启 DSH**

```bash
supervisorctl restart dsh-web
supervisorctl status dsh-web     # 应为 RUNNING
```

> 插件属 `hot=false` 类型，**必须重启**，热加载不生效。

---

### C. 授权与验证

**C1 · 接口自检**

```bash
curl -s http://localhost:3080/api/feishu/status
```

预期 200 + `"ok": true` + `"appSecretConfigured": true`。

**C2 · 拿授权链接**

在对话里说「跑 feishu_auth authorize_url」，或直接调工具：

```
feishu_auth(action: "authorize_url", scopes: ["offline_access", "bitable:app", ...])
```

**C3 · 浏览器授权**

打开返回的 URL → 确认权限列表是**一整套**（不是只有一个「读取你的用户 ID」）→ 点同意。

成功后浏览器落在回调页，显示 `Feishu is connected / Authorized as <姓名>`。

**C4 · 三项终验**

| 检查 | 期望 |
|---|---|
| `feishu_auth status` → `refreshable` | `true`（能自动续期） |
| `feishu_auth status` → `scope` | 含 `offline_access` + 8 个业务权限 |
| `feishu_drive list_files`（`identity: user`） | 返回文件列表，不报 `99991679` |

**若浏览器回调打不开**，用兜底通道：把回调 URL 里 `code=` 后面那串交给 `feishu_auth(action: "complete", code: "...")` 手动兑换。这条路经实测可用。

---

## 三、问题与解法（7 个坑）

### 坑 1 · 任何插件都装不上（失效的 `file:` 依赖）

**现象**

```
$ pnpm dsh plugin --profile web add /Users/zyf/Project/DSH_WorkSpace/dsh-feishu
Error:   × adding a new package
  ╰─▶ Failed to resolve dependency tree: Failed to resolve dependency:
      Could not install from "/Users/zyf/Project/DSH_WorkSpace/dsh-tapd-oauth/
      dsh-tapd-mcp-0.0.5-local.1.tgz" as it does not exist.
```

错误信息指向 `dsh-tapd-mcp`——**和要装的插件毫无关系**，极易误判成「这个插件有问题」。

**根因**

`~/.dsh/profiles/web/package.json:31`（修复前）：

```json
"dsh-tapd-mcp": "file:/Users/zyf/Project/DSH_WorkSpace/dsh-tapd-oauth/dsh-tapd-mcp-0.0.5-local.1.tgz"
```

但目录里实际只有 `dsh-tapd-mcp-0.1.0.tgz`。源仓库 commit `38174a9 release: dsh-tapd-mcp 0.1.0` 明确写着 `bump version 0.0.5-local.1 -> 0.1.0`——**发布时重新打了包、删了旧包，但忘了同步 profile 的依赖路径**。

pnpm 每次操作都要重新解析**整棵依赖树**，只要有一个 `file:` 目标不存在，全部操作失败。

**解法**

改成实际存在的 tgz（改前已备份 `package.json.bak-20261027-200412`）：

```diff
- "dsh-tapd-mcp": "file:.../dsh-tapd-mcp-0.0.5-local.1.tgz"
+ "dsh-tapd-mcp": "file:.../dsh-tapd-mcp-0.1.0.tgz"
```

**验证**：`node -p "require('.../package.json').dependencies"` 合法；重跑安装命令通过。

**教训**：profile 里每个 `file:` 依赖都是地雷。排查顺序——读 profile `package.json` 找所有 `file:` → 逐个确认文件存在 → 对比源仓库 `git log` 判断是「该更新 spec」还是「该回滚」。

---

### 坑 2 · App Secret 没有落地位置

**现象**：需要给 DSH 进程一个环境变量，但 DSH 由 supervisor 托管，且 supervisor conf 默认 `644`。

**机制（关键判断依据）**

`dsh-feishu/lib/identity.js:101-114` 的三级读取顺序：

```js
async function appSecret() {
  // 1) 凭据库
  const hit = await credentials.resolve(config.appSecretRef);   // :104
  // 2) 同名环境变量
  const fromEnv = process.env[config.appSecretRef];             // :112-113
  // 3) config.appSecret
  if (config.appSecret.length > 0) return { value: config.appSecret, source: 'config' };  // :114
}
```

`config.appSecretRef` 默认 `FEISHU_APP_SECRET`（`lib/config.js:40`）。

**解法（推荐）**：写进 DSH 凭据库 `~/.dsh/.credentials.yaml` 的 `refs:` 段。

该文件结构：

```yaml
version: 1
records:
  client-connection/browser-session:
    kind: ...
    payload: { version: 1, secret: ... }
refs:
  TAPD_ACCESS_TOKEN: ...
  DEEPSEEK_API_KEY: ...
  FEISHU_APP_SECRET: ...        # 新增
```

**验证方法（含一个易踩的坑）**

```bash
node -e "
import('@deepseek-ai/dsh-credentials-local').then(m => {
  const fs = require('node:fs');
  const p = '/Users/zyf/.dsh/.credentials.yaml';
  const doc = m.parseCredentialsDocument(fs.readFileSync(p,'utf8'), p);
  console.log([...doc.refs.keys()]);     // ⚠️ 必须用 [...map.keys()]
})"
```

> ⚠️ `parseCredentialsDocument(text, filename)` **必须传两个参数**，且返回的 `refs` / `records` 是 **`Map`**——
> 用 `Object.keys(doc.refs)` 得到的是 `[]`（会把正常文件误判成空）。

端到端确认（真实 provider + 插件自己的 identity 模块）：

```
refs 键: [ 'TAPD_ACCESS_TOKEN', 'DEEPSEEK_API_KEY', 'FEISHU_APP_SECRET' ]
provider.resolve 命中: 是 (长度 32)
插件看到的凭据状态:
  secretConfigured : true
  secretSource     : credential:FEISHU_APP_SECRET
```

**备选解法**：supervisor `environment=` 行。可行但要注意——
- supervisor **不支持**从文件读环境变量，只能写死值；
- 该 conf 默认 `644`，写完必须 `chmod 600`；
- 验证方法：临时挂一个探针程序打印 `env | grep FEISHU` 确认传参成功，**不要**为此再起第二个 DSH（同一个 `~/.dsh` 双实例会互踩会话/插件目录）。

---

### 坑 3 · `feishu_auth status` 报 `value is not lossless JSON`（唯一真实代码适配点）

**现象**

```
Error: tool "feishu_auth" returned invalid output: value is not lossless JSON
```

触发条件很特别：**未授权时正常，一旦存了 user grant 就必然报错**。

**根因（两处叠加）**

① `lib/identity.js:466-482` 的 `userState()` 在授权后会返回带 `undefined` 的对象：

```js
return {
  authorized: true, source: 'store',
  expiresAt: stored.expiresAt, expired: ...,
  refreshable: ...,
  scope: ...,
  openId: stored.openId,   // ← stored 里没有时就是 undefined
  name: stored.name,       // ← 同上
};
```

② `lib/tools/auth.js:106` 合并飞书 profile 时又引入一个：

```js
data.user = { ...user, name: profile.name, openId: profile.open_id,
              unionId: profile.union_id, email: profile.email,   // ← 常为 undefined
              avatarUrl: profile.avatar_url };
```

而 DSH 的工具注册表要求结果是**严格无损 JSON**——`packages/util/values/src/index.ts` 的 `walkJsonValue()` 中：

```js
if (typeof current !== 'object') return undefined;   // undefined 走到这里直接判失败
```

`JSON.stringify` 会静默丢弃 `undefined` 属性，但注册表不会。**任一 `undefined` 属性废掉整个调用。**

**解法**

在工具定义的唯一出口做一次深度净化——`lib/tools/kit.js` 新增 `sanitizeToJson()`，并在 `defineTool` 的 `execute` 里调用：

```js
export function sanitizeToJson(value, seen = new Set(), depth = 64) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return Object.is(value, -0) ? 0 : value;
  }
  if (type !== 'object') return undefined;          // undefined / function / symbol / bigint
  if (depth <= 0 || seen.has(value)) return undefined;   // 深度上限 + 循环引用
  // 对象：值为 undefined 的属性剔除；数组：空位补 null
  ...
}

// defineTool 内
const value = await options.execute(args, exec);
const clean = sanitizeToJson(value);
return clean === undefined ? null : clean;
```

规则对齐注册表自身的遍历：对象里 `undefined` 属性剔除、数组空位补 `null`、`-0` → `0`、非有限数与循环引用丢弃。

**一处修复覆盖全部 10 个工具**，不必在每个调用点手写判断。

**验证**

| 项 | 结果 |
|---|---|
| `isJsonValue(payload)` 修复前 / 后 | `false` → **`true`** |
| `npm test` | **96 passed, 0 failed** |
| 边界：`NaN` | → `{}`（属性剔除） |
| 边界：`-0` | → `0`，且 `isJsonValue: true` |
| 边界：`[1, undefined, 3]` | → `[1,null,3]` |
| 边界：循环引用 | → 截断，且 `isJsonValue: true` |
| 线上复核 | 之前每次报错，现在正常返回，且 `unionId`/`avatarUrl`/`name` 都有值 |

**连带发现的一个「假成功」现象**

活动面板（悬浮浮层）在 **20:23:31** 记录了 `feishu_auth` 成功 —— 而模型侧同一时刻收到的是报错。

原因：`lib/tools/index.js` 的 `traced()` **先** `activity.record(...)` 再 `return value`，注册表**之后**才校验：

```js
const value = await inner(args, exec);
activity.record({ ..., summary: value.summary, ... });   // 先记活动
return value;                                            // 再交给注册表 → 可能被拒
```

所以「活动面板显示成功、工具却报错」是正常的——排查时不要以面板为准。

---

### 坑 4 · `appId` 不生效（坏 YAML）

**现象**：`cordis.patch.yml` 里明明写了 `appId`，但状态里一直是空串。

**根因**：写成了这样（缩进错位）：

```yaml
- insert:
    - id: mcp-dbx
      ...
    - id: feishu            # ← 4 空格缩进
      config:               # ← 空的（null）
      appId: 'cli_...'      # ← 与 config 同级，非法行字段
```

后果有两个：
- `- id: feishu` 被解析成**上面 `insert:` 列表的第 2 个插入项**，而插入行必须有 `name`；
- `appId` 成了行对象的非法字段；
- 还会与插件自带 bundle patch 里的 `id: feishu` 撞成重复行。

**解法**：改成独立的**顶层** `id` 定位条目：

```yaml
- id: feishu
  config:
    appId: 'cli_aa6a2c729df89cc3'
```

**验证**（用 DSH 依赖树里的 yaml 包解析，而不是肉眼判断）：

```bash
node -e "
const Y = require('/Users/zyf/.dsh/profiles/node_modules/yaml');
const fs = require('fs');
const d = Y.parse(fs.readFileSync('/Users/zyf/.dsh/profiles/web/cordis.patch.yml','utf8'));
d.forEach((e,i) => console.log(i, JSON.stringify(e)));
"
```

期望：

```
0 {"insert":[{"id":"mcp-dbx","name":"@deepseek-ai/dsh-mcp-client","config":{...}}]}
1 {"id":"feishu","config":{"appId":"cli_aa6a2c729df89cc3"}}
```

> 补丁层语义（`vendor/include/src/index.ts:58-128`）：`- id: X` + `config:` 会**整体替换**该行的 config，不做深合并（`:121-124`）。

---

### 坑 5 · 授权回调 `ERR_TOO_MANY_REDIRECTS`

**现象**

```
该网页无法正常运作
127.0.0.1 将您重定向的次数过多。
ERR_TOO_MANY_REDIRECTS
```

**定位过程（决定性一步）**

先排除了插件自身：`lib/routes.js:369-401` 的回调处理器**从不发 302/303**，每条分支都是 `sendPage()` 或 `sendJson()`。

于是直接看响应头：

```bash
curl -si --noproxy '*' http://127.0.0.1:3080/api/feishu/oauth/callback
```

```
HTTP/1.1 303 See Other
location: /api/feishu/oauth/callback          ← 重定向到它自己
set-cookie: dsh-auth-VPhEE...=...; HttpOnly; SameSite=Strict
```

站点根路径同样：

```bash
curl -si --noproxy '*' http://127.0.0.1:3080/
# HTTP/1.1 303 See Other
# location: /
```

跟随重定向确认循环：

```bash
curl -sS -o /dev/null -w '最终URL: %{url_effective}\n重定向次数: %{num_redirects}\n状态码: %{http_code}\n' \
  -L --noproxy '*' http://127.0.0.1:3080/api/feishu/oauth/callback
# curl: (47) Maximum (50) redirects followed
# 重定向次数: 50
```

**根因**

`dsh-web-startup-auth@0.1.9` 的启动鉴权：它包装 `webServer.register`，对未带 cookie 的请求**铸一个 cookie 并 303 回同一地址**。但该 cookie 用的是 `SameSite=Strict`（`lib/auth.js:389`）。

从飞书 `accounts.feishu.cn` 跳回 `127.0.0.1` 属于**跨站顶层导航**，`SameSite=Strict` 的 cookie **不会被发送** → 闸门再次铸 → 再次 303 → **死循环**。

平时手输地址访问 GUI 是同站导航，所以一直不暴露——**只有外部 IdP 回调会触发**。

**解法**

```diff
# ~/.dsh/profiles/web/node_modules/dsh-web-startup-auth/lib/auth.js
- :389  ... HttpOnly; SameSite=Strict`     ← 铸 cookie
+ :389  ... HttpOnly; SameSite=Lax`
- :416  ... HttpOnly; SameSite=Strict`     ← 清 cookie
+ :416  ... HttpOnly; SameSite=Lax`
```

`Lax` 对**顶层 GET 跳转**是放行的，正好覆盖 OAuth 回调语义。

> 旁证：该插件自己的**会话** cookie 在 `lib/auth.js:113` 用的就是 `SameSite=Lax`——说明 `Strict` 是浏览 cookie 这一处的疏漏。

补丁前已备份：`lib/auth.js.bak-20261027-203911`；`node --check lib/auth.js` 通过。

**生效方式**：`supervisorctl restart dsh-web`（加载期读入，热改无效）。

**结果**：同一授权链接重新点击后，浏览器直接落在 `Feishu is connected / Authorized as Hunter Zhang`。

---

### 坑 6（概念坑）· 飞书权限分两层，别混

这个不是 bug，却是本次卡最久的地方。

| 层 | 何时生效 | 存储位置 |
|---|---|---|
| **应用权限（tenant）** | 「权限管理」勾选 + **创建版本并发布** → 立即生效 | 应用配置 |
| **用户授权范围（user scope）** | **用户点「同意」那一刻固化** | 每份 user grant |

**所以**：后台补开权限后，**旧的 user grant 不会自动扩权**，必须**重新授权一次**。

**快速判别法**：同一个接口，用不同身份各调一次——

```
身份 app  → GET /drive/v1/files → {"files": [], "has_more": false}   ✅ 应用权限已生效
身份 user → GET /drive/v1/files → 99991679 缺 drive:drive            ❌ 用户 grant 还是旧的
```

再看 `expiresAt` 有没有变化：**没变化就说明新授权根本没发生**（不是权限问题）。

`offline_access` 缺失时 `refreshable` 为 `false`，令牌约 2 小时过期，需反复重授——这就是「必须先修权限再授权」的原因。

---

### 坑 7 · 设置页报「配置文件不可写」（`patchFilePath` 未配）

**现象**

设置页能打开、19 个字段能渲染出来，但顶部挂一条红字：

```
配置文件不可写：the profile patch file could not be located.
Looked in: /Users/zyf/.dsh/profiles/cordis.patch.yml,
           /Users/zyf/.dsh/cordis.patch.yml,
           /Users/zyf/cordis.patch.yml,
           /Users/cordis/cordis.patch.yml
```

后果不是「不能看」，而是**不能存**：页面上改任何字段都会失败。

**先做的三层排除（这一步比结论更重要）**

现象是「设置里看不到飞书配置」，很容易一头扎进前端代码。实测下来三层都是好的：

| 层 | 检查命令 | 结果 |
|---|---|---|
| 后端接口 | `curl -sL -c ck -b ck http://localhost:3080/api/feishu/config` | **HTTP 200**，`values`/`fields`/`effective` 全齐 |
| 客户端 bundle | 从 `index.html` 的 `__DSH_BOOT__.entries` 取出真实 URL（`/plugins/??dsh-feishu/client.js&rev=…`）再取 | **200 / 38,877 字节**，含 `__ModuleLoader__` |
| 组件渲染 | 用真实 payload 跑 `FeishuSettingsSection`（复用插件自带的 hook shim） | 不抛错，**渲染出 1113 个节点**，19 字段全在 |

所以问题既不在后端、也不在 bundle、更不在组件——只剩 payload 里的 `patch` 字段：

```json
"patch": { "file": null, "entryFound": false, "readable": false, "error": "the profile patch file could not be located…" }
```

**根因：配置文件定位的四个候选全部落空**

`lib/entry-config.js` 的 `patchFileCandidates()` 按顺序给候选，`resolvePatchFile()` 取第一个「形状匹配 + 真实存在」的：

| # | 候选来源 | 本机实际 |
|---|---|---|
| 1 | `config.patchFilePath` | 未配置（空串）→ 跳过 |
| 2 | `$DSH_PROFILE_DIR/cordis.patch.yml` | 环境变量未设 → 跳过 |
| 3 | `$DSH_HOME/profiles/${DSH_PROFILE \|\| 'desktop'}/cordis.patch.yml` | `DSH_PROFILE` 未设 → **回退到 desktop**，命中错文件 |
| 4 | **从模块路径向上找 6 层**（`ANCESTOR_DEPTH = 6`） | 见下 |

第 4 条是设计里的兜底：「插件装在 `<profile>/node_modules/dsh-feishu/lib/`，向上必然找到 profile」。但**本项目是 `link:` 安装**，Node 会解析软链到真实路径，`import.meta.url` 落在：

```
/Users/zyf/Project/DSH_WorkSpace/dsh-feishu/lib/
```

向上 6 层依次是 `lib → dsh-feishu → DSH_WorkSpace → Project → zyf → Users`，**永远到不了 `~/.dsh/profiles/web/`**。这就是报错里那串「Looked in」的来源。

> 判据：`patch.file === null` 且 `entryFound === false`。不要看界面文字去猜，直接看接口返回的 `patch` 对象。

**解法：显式指定 `patchFilePath`（纯配置，不改代码）**

`patchFilePath` 是候选 #1，优先级最高。它**故意不允许从浏览器写入**（见 README 配置表：`patchFilePath`「不允许从浏览器写入」），防止页面把写目标改到别处，所以只能写在 profile 的 patch 文件里：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 末尾
- id: feishu
  config:
    appId: 'cli_你的AppID'
    patchFilePath: '/Users/<你>/.dsh/profiles/web/cordis.patch.yml'
```

**验证（用插件自己的解析器，不靠肉眼）**

```bash
cd <插件工作副本>
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const B = '<插件工作副本>/lib';
const { normalizeConfig } = await import(B + '/config.js');
const ec = await import(B + '/entry-config.js');
const cfg = normalizeConfig({ appId: 'cli_x', patchFilePath: '/Users/<你>/.dsh/profiles/web/cordis.patch.yml' });
console.log('形状校验:', ec.isProfilePatchPath(cfg.patchFilePath));   // 必须 true
const file = ec.resolvePatchFile(cfg, { env: process.env });
console.log('解析到:', file);                                        // 必须非空
const entry = ec.readEntry(readFileSync(file, 'utf8'), ec.KNOWN_KEYS);
console.log('entryFound:', entry.found);                              // 必须 true
"
```

实测输出：

```
形状校验: true
解析到:   /Users/zyf/.dsh/profiles/web/cordis.patch.yml
entryFound: true
```

`patchFilePath` 的路径**必须**匹配 `/profiles/<名>/cordis.patch.yml` 的形状（`isProfilePatchPath` 的正则），否则会被静默丢弃。

**生效方式**：`supervisorctl restart dsh-web`（配置在启动时读入）。重启后设置页顶部就从红字变成 `配置文件：/Users/zyf/.dsh/profiles/web/cordis.patch.yml`。

**为什么不能靠 `DSH_PROFILE` 绕过**

理论上设 `DSH_PROFILE=web` 也能让候选 #3 命中。但 `DSH_PROFILE` 由启动器注入，supervisor 托管时环境极简、不保证存在；而 `patchFilePath` 是插件自己读的配置，**不依赖宿主给什么环境变量**，更稳。换机器重建时同理——`link:` 安装形态不变，这个坑就必犯一次，所以写进安装步骤 B2。

---

## 四、诊断方法论（可复用）

本次结论全部来自实测，没有一条是读代码猜的。以下方法可直接复用：

### 1. 用真实宿主服务挂载插件，而不是读源码判断兼容性

```js
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

const ctx = new Context()
await ctx.plugin(SystemPrompt)                       // ToolRuntime 依赖它
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await ctx.plugin(ToolRuntime)
ctx.plugin({ name, inject, apply }, { appId: 'x', appSecret: 'y' })
// 结果：10 工具 / 6 路由 / 无内部错误
process.exit(0)      // ⚠️ WebServer 会保持事件循环，必须显式退出
```

要点：
- 真实 `ToolRuntime` **需要** `systemPrompt` 服务先就位，且该服务要有 `tools()` 方法；
- `WebServer` 用 `port: 0`（OS 分配）安全，但**必须 `process.exit(0)`**否则脚本挂住。

### 2. 不要用「装成功」推断「能用」

dshmarket 日志里 `exit=0 hot=false` 只代表**依赖装上了**，不代表插件挂载成功。真正的信号是 **工具是否可调用**：

```
feishu_auth → 能返回 → 插件确实挂载了
```

### 3. 会话日志里搜不到工具名，只能证明「没被调用」

我曾据此误判「插件从未挂载」，后来被用户的现象推翻。**工具名缺失 ≠ 未注册**——用户没配置就永远不会去调。

### 4. 「面板显示成功但工具报错」是可能的

见坑 3 末尾：活动记录发生在注册表校验**之前**。判断成败要看**模型侧的结果**，不是面板。

### 5. `curl -si` 看响应头，比看浏览器报错省事

浏览器只说「重定向太多」，而响应头直接暴露了「303 + `location` 指向自身 + `SameSite=Strict`」，一步定位到第三方插件。

> 注意：`curl -L` **不带 cookie jar** 时会跑满重定向上限，这个现象本身也可能是假阳性——务必同时看 `Set-Cookie` 的属性。

### 6. 本机特有的两个干扰项

| 干扰 | 表现 | 判别 |
|---|---|---|
| 系统代理吃掉 `127.0.0.1` | 浏览器 502/转圈，但服务端日志**零请求** | `curl --noproxy '*'` 对照；换 `localhost` 绕开 |
| `SameSite=Strict` 跨站不回传 | OAuth 回调死循环 | `curl -si` 看 `Set-Cookie` 属性 |

### 7. 「界面没显示」先分层排除，别一头扎进前端

设置页不显示配置时，按三层从下往上打，每层都有**一条可执行的判据**：

| 层 | 判据 | 本机结论 |
|---|---|---|
| 后端接口 | `curl -sL -c ck -b ck http://localhost:3080/api/feishu/config` 是否 200 + 有 `values`/`fields` | 200，数据齐全 |
| 客户端 bundle | 从 `index.html` 里解析 `__DSH_BOOT__.entries` 拿到**真实** URL（`/plugins/??<id>/client.js&rev=…`）再取，看是否 200 且含 `__ModuleLoader__` | 200 / 38,877 字节 |
| 组件渲染 | 用**真实 payload** 跑组件（复用插件测试里的 hook shim），看是否抛错、渲染出多少节点 | 不抛错，1113 节点 |

三层都过 ⇒ 问题一定在 **payload 的某个字段**，而不是「前端坏了」。本机正是这样落到 `patch.file: null` 上的（坑 7）。

> 两个易错点：
> ① **别用 `/plugins/<id>/client.js` 直接判死**——真实路由是 `??combo` 形式，裸路径 404 是正常的；
> ② 页面里的 `__DSH_BOOT__` 是 `globalThis["__DSH_BOOT__"] = {…}`，正则匹配要用**括号配平**（JSON 里也可能出现 `};`），否则解析失败会让你误以为「插件不在启动图里」。

---

## 五、当前配置与文件清单

### 已修改的文件

| 文件 | 改动 | 备份 |
|---|---|---|
| `~/.dsh/profiles/web/package.json` | `dsh-tapd-mcp` 依赖指向 `0.1.0.tgz`；新增 `dsh-feishu: link:...` | `package.json.bak-20261027-200412` |
| `~/.dsh/profiles/web/cordis.patch.yml` | 新增顶层 `- id: feishu` + `config.appId` | `cordis.patch.yml.bak-20261027-200925` |
| `~/.dsh/.credentials.yaml` | `refs:` 新增 `FEISHU_APP_SECRET` | `.credentials.yaml.bak-20261027-200807` |
| `/opt/homebrew/etc/supervisor/conf.d/30-dsh-web.conf` | `environment` 加 Secret；`autostart=true`；`chmod 600` | `30-dsh-web.conf.bak-20261027-200909` |
| `~/.dsh/profiles/web/node_modules/dsh-web-startup-auth/lib/auth.js` | 2 处 `SameSite=Strict` → `Lax` | `lib/auth.js.bak-20261027-203911` |
| **`dsh-feishu/lib/tools/kit.js`** | **新增 `sanitizeToJson()` 并接入 `defineTool`** | 未提交（建议 commit） |

### 关键配置值

```yaml
# ~/.dsh/profiles/web/package.json
"dsh-feishu": "link:/Users/zyf/Project/DSH_WorkSpace/dsh-feishu"
# dsh.profile.bundles 中也含 "dsh-feishu"
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（末尾）
- id: feishu
  config:
    appId: 'cli_aa6a2c729df89cc3'
    patchFilePath: '/Users/zyf/.dsh/profiles/web/cordis.patch.yml'   # 坑 7：不配则设置页不可写
```

```
App Secret  →  ~/.dsh/.credentials.yaml 的 refs.FEISHU_APP_SECRET（0600）
               + supervisor conf 的 environment（0600）
重定向 URL  →  http://127.0.0.1:3080/api/feishu/oauth/callback
               http://localhost:3080/api/feishu/oauth/callback
配置文件      →  patchFilePath 指向 ~/.dsh/profiles/web/cordis.patch.yml
               （设置页写回这个文件；该字段故意不允许从浏览器改）
```

### 磁盘上的其他产物

| 路径 | 说明 |
|---|---|
| `/Users/zyf/Project/DSH_WorkSpace/dsh-src/deepseek-harness-dsh-v0.1.2-alpha.2/` | DSH 源码副本（79M，无 node_modules），查源码用这个 |
| `/Users/zyf/Project/DSH_WorkSpace/.dsh/workspace-understanding/` | 早期排查留下的产物（`00-resource-index.md`、`07-gaps-and-questions.md`） |
| `/Users/zyf/Project/DSH_WorkSpace/dsh-plugin-contract-0.1.2-alpha.2.md` | DSH 插件契约调研（逐条 `path:line`） |

> ⚠️ **`/Users/zyf/Project/deepseek-harness-dsh-v0.1.2-alpha.2/` 是线上运行系统，只读，不要改。** 查源码一律用上面那个解压副本。

---

## 六、维护与复发风险

### 风险 1 · `dsh-web-startup-auth` 的补丁会被覆盖 ⚠️ 最主要

补丁打在 `node_modules` 里，以下操作会让它失效，届时飞书授权会**再次死循环**：

- `dsh plugin update`
- 重装依赖（`pnpm install` / 删除 `node_modules` 后重装）
- 升级 `dsh-web-startup-auth`

**恢复方法**：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-web-startup-auth
grep -n "SameSite" lib/auth.js          # 确认是否回到 Strict
python3 -c "
import pathlib
p = pathlib.Path('lib/auth.js'); s = p.read_text()
p.write_text(s.replace('HttpOnly; SameSite=Strict\`', 'HttpOnly; SameSite=Lax\`'))
print('已重新打补丁')"
supervisorctl restart dsh-web
```

**根治**：向 `dsh-web-startup-auth`（`github:GDWhisper/dsh-web-startup-auth`）提 issue —— 浏览器 cookie 应使用 `SameSite=Lax`，否则任何第三方 OAuth 回调都会死循环。

### 风险 2 · App Secret 已出现在会话日志

本次排查中 App Secret 以明文形式出现在对话里，已写入 `~/.dsh/sessions/.../session.jsonl.zstd`。

**建议**：飞书后台重置 App Secret，然后更新两处（凭据库 + supervisor conf），`supervisorctl restart dsh-web`。

### 风险 3 · 令牌过期

`refreshable: true` 表示有 refresh token，插件会自动续期。若哪天又需要手动授权，先查 `feishu_auth status` 的 `refreshable` 是否变回 `false`（那意味着 `offline_access` 掉了）。

### 风险 4 · 自动续期会把 refresh token 丢掉（已定位，**未修**）

这是本次实测发现的**真缺陷**，与坑 7 是两条独立的问题。

**现象**

连续两次 `feishu_auth status`：

```
第一次：expiresAt 1793112036698  refreshable true   scope 含 offline_access
第二次：expiresAt 1793112494154  refreshable false  scope 不含 offline_access
```

`expiresAt` 变了 ⇒ **续期确实跑过一次**；但 `refreshable` 变成 `false` ⇒ 续期后的记录里**没有 refresh token** 了。后果：约 2 小时后必须重新授权。

**根因**

`lib/identity.js:363`：

```js
const record = userRecordFrom(parsed);              // refreshToken 取 parsed.refresh_token，缺失即 ''
record.openId = stored.openId;
record.name = stored.name;
if (config.appSecret.length > 0 && (record.refreshToken === undefined || record.refreshToken.length === 0)) {
  record.refreshToken = stored.refreshToken;        // ← 只有 config.appSecret 非空才沿用旧 token
}
await storeUserToken(record);
```

那个 `config.appSecret.length > 0` 守卫是**连坐错误**：它假设「密钥写在 `config.appSecret` 里」才谈得上续期，但续期实际用的是 `appSecret()`——该方法会依次查凭据库、环境变量、config。本机密钥在**凭据库**，`config.appSecret` 为空 ⇒ 守卫不成立 ⇒ 飞书这次没回 `refresh_token` 时，**旧 token 被覆盖成空串**。

> 也就是说：**越是按推荐做法把密钥放凭据库，越会触发这个 bug。**

**正解（待落地）**

响应未带新 token 时**无条件**沿用旧值，不按密钥来源分支：

```js
if (record.refreshToken.length === 0) {
  record.refreshToken = stored.refreshToken;
  record.refreshExpiresAt = stored.refreshExpiresAt;
}
```

**判据**：对比前后两次 `feishu_auth status` 的 `expiresAt`（变了=续期跑过）与 `refreshable`（`false`=token 丢了）。修好后应长期保持 `refreshable: true`。

**临时缓解**：发现 `refreshable` 变 `false` 时，重新走一次授权流程即可恢复（`feishu_auth action=authorize_url`）。

### 风险 5 · 代码改动的提交状态

| 修复 | 提交 | 状态 |
|---|---|---|
| 无损 JSON 净化（坑 3） | `d2767b2` | ✅ 已提交并推送 |
| 文档与交接包 | `e89b80e` / `658b279` | ✅ 已提交并推送 |
| refresh token 连坐守卫（风险 4） | — | ❌ **尚未实现** |

踩坑提醒：坑 3 的修复**必须**留在代码里 —— 丢了它，`feishu_auth status` 会在授权后重新报 `value is not lossless JSON`。改完代码记得跑 `npm test`（期望 `96 passed, 0 failed`）再提交。

---

## 七、全功能自测与修复（2026-10-27）

前六节解决的是「装不上、连不通」。这一节是**逐个 action 扫全部 10 个工具**的结果，发现了 7 个此前没暴露的缺陷。

### 7.1 自测矩阵

| 工具 | 测过的 action | 结果 |
|---|---|---|
| `feishu_auth` | `status` `authorize_url` `complete` | ✅ |
| `feishu_drive` | `list_files` `upload` `move` `delete_file` `get_meta` | ✅ |
| | `download` | ❌→✅ 缺陷 1 |
| | `create_folder`（带父目录 / 不带给） | ✅ / ❌→✅ 缺陷 2 |
| | `get_meta`（单类型 / 混类型） | ✅ / ❌→✅ 缺陷 3 |
| `feishu_doc` | `create` `get` `get_raw_content` `list_blocks` `append_blocks` | ✅ |
| | `append_markdown` | ❌→⛔ 缺陷 4（代码）+ 缺陷 5（权限） |
| | `import_file` | ❌ 缺陷 7（已修，未复验） |
| `feishu_sheet` | `create` `get_info` `list_sheets` `write` `read` `append` | ✅ |
| `feishu_bitable` | `create_app` `list_tables` `list_fields` `create_field` `insert_records` `search_records` | ✅ |
| `feishu_query` | 聚合计数 | ⛔ 缺陷 5（权限） |
| `feishu_dashboard` | `list_dashboards` | ⛔ 缺陷 5（权限） |
| `feishu_wiki` | `list_spaces` `list_nodes` | ✅ |
| `feishu_message` | `send_text` | ✅（实测发出一条 DM） |
| `feishu_api` | GET/POST 直连 | ✅ |

**图例**：✅ 通过 · ❌ 失败 · ⛔ 被权限阻塞 · → 表示已修复

### 7.2 缺陷 1 · `download` 用错了端点

**现象**：`download` 报 `downloading /drive/v1/medias/<token>/download failed with HTTP 403`。

**排查**：`feishu_api` 直接打同一个 media 端点 → 同样 403 且**没有响应体**；改打 `/drive/v1/files/<token>/download` → 返回「非 JSON 响应」（= 文件二进制），即成功。

**根因**：`feishu_drive upload` 用 `parent_type: 'explorer'` 上传的是**云盘文件**，下载要走 `/drive/v1/files/{file_token}/download`；`/drive/v1/medias/*` 是**媒体**（图片等）通道，拿文件 token 去查必然 403。

**修复**（`lib/tools/drive.js`）：下载路径改成 `/drive/v1/files/<token>/download`。

### 7.3 缺陷 2 · `create_folder` 在根目录建不了

**现象**：不传 `folderToken` 时 `create_folder` 报 `field validation failed`；传了父目录 token 就成功。

**根因**：飞书的建文件夹接口**要求** `folder_token`，而插件在没配默认目录时直接省略该字段，飞书回一个没有上下文的 `field validation failed`。工具描述里写的「不传即在根目录创建」做不到。

**修复**（`lib/tools/drive.js`）：未给父目录时先调 `GET /drive/explorer/v2/root_folder/meta` 取根目录 token（实测返回 `nodcnx043PvbQ0msv7fXYrQnOOc`，与文件列表里的 `parent_token` 一致），再带着它建目录；拿不到就明确报错让调用方显式传 `folderToken`。

### 7.4 缺陷 3 · `get_meta` 一次只能查一种类型

**现象**：`get_meta` 传 docx / sheet / bitable 三个 token → `metas: []`，`failed` 里三条全是 `code: 970005`；单独传普通文件 token 却能成功。

**根因**：`/drive/v1/metas/batch_query` 要求 **每个 token 各自带 `doc_type`**（missing/错误即 970005），而插件把**同一个** `doc_type`（默认 `'file'`）套给了整批。实测：省略 `doc_type` 直接报 `field validation failed`，所以不能靠「不传」自动识别。

**修复**（`lib/tools/drive.js`）：
- 新增 `docTypes` 参数（与 `tokens` 平行），可显式钉住类型；
- 未钉住的 token 若首轮失败，**自动轮询剩余类型**直到命中（每个 token 最多试 6 次），彻底解决混类型调用；
- 结果里保留真正没解析出来的 token，summary 会写「N unresolved」。

### 7.5 缺陷 4 · `append_markdown` 传错枚举值

**现象**：`append_markdown`（标题+段落+列表，不含表格）报 `field validation failed`。

**排查**：先确认不是表格的锅——用最小原生 block 走 `append_blocks` 成功；再用递减法确认「纯标题+段落」也失败 → 问题在 Markdown 转换那一步。直接打 `POST /docx/v1/documents/blocks/convert` 对比两个枚举值：

```
content_type: 'md'        →  field validation failed
content_type: 'markdown'  →  通过校验（转到权限检查）
```

**根因**：`lib/tools/docx.js` 的 `convertMarkdown` 把 `content_type` 写成了 `'md'`，飞书只认 `'markdown'`。

**修复**：改成 `'markdown'`。

### 7.6 缺陷 5 · 三个必需的权限不在推荐清单里

上面把 `content_type` 改对之后，才暴露出真正的权限缺口：

| 工具 | 缺的 scope |
|---|---|
| `feishu_doc` `append_markdown` | `docx:document.block:convert` |
| `feishu_query` | `base:table:read` |
| `feishu_dashboard` | `base:dashboard:read` |

`bitable:app` **不覆盖** Base V3（LiteQuery 聚合与仪表盘）——这是两代接口各自独立的权限。

**修复**（`lib/tools/auth.js`）：把三个 scope 加进 `RECOMMENDED_SCOPES`，这样新装用户的授权链接会自动申请它们；已装用户需要**在飞书后台加开 + 发版 + 重新授权**。

### 7.7 缺陷 6 · 自动续期丢 refresh token（见 §六 风险 4）

自测期间这个缺陷**真的把整套功能打瘫了**：令牌到期后 `refreshable` 为 `false`，所有工具统一报 `the stored Feishu grant has no refresh token`。

**修复**（`lib/identity.js`）：续期响应未带新 token 时**无条件**沿用旧 token 与 `refreshExpiresAt`，不再按「密钥是否写在 `config.appSecret`」分支。

### 7.8 缺陷 7 · `import_file` 缺 `extra` 字段

**现象**：`import_file` 只报一句 `forbidden.`。

**排查**：先排除端点与权限——`POST /drive/v1/import_tasks` 直接打，返回的是「file token not found」（校验错，**不是**权限错）→ 说明被拒的是**上传那一步**（`medias/upload_all` + `parent_type: 'ccm_import_open'`）。飞书对这个分支要求额外的 `extra` 字段描述要导入什么。

**修复**（`lib/tools/docx.js`）：上传时补

```js
extra: JSON.stringify({ obj_type: targetType, file_extension: extension })
```

**状态**：已修，**未复验**（需要有效令牌，见 7.9）。

### 7.9 验证方式与当前的收口状态

**已经验证的**：

```
npm test  →  99 passed, 0 failed      （新增 3 条回归：转换枚举、根目录解析、混类型 get_meta）
```

三条回归测试直接锁定本次修复的行为，防止以后被改回去。其中「混类型 get_meta」这条还**抓到了我自己第一版实现里的逻辑漏洞**（把「默认类型」误当成「用户钉住的类型」，导致类型轮询被跳过）。

**还没验证的**（因为令牌已过期，需要重新授权）：

- 缺陷 1/2/3/7 在真实 API 上的复验
- `feishu_query` / `feishu_dashboard` / `append_markdown` 的权限是否随重新授权生效
- `feishu_auth refresh`（必须有 refresh token 才能测）
- `bitable` 的 `update_records` / `delete_records` / `get_record`，`sheet` 的 `add_sheet`，`drive` 的 `get_meta` 显式 `docTypes`

**收口三步**（缺一不可，顺序不能换）：

1. 飞书后台「权限管理」加开 `base:table:read`、`base:dashboard:read`、`docx:document.block:convert` → **创建版本并发布**
2. `supervisorctl restart dsh-web`（加载修复后的代码）
3. 重新授权（链接见下），然后重跑 7.9 里那批未验证项

> 重新授权时请确认同意页列出的是**一整套**权限；`state` 存在插件内存里，**重启后旧链接失效**，所以第 3 步必须在第 2 步之后。

### 7.10 自测在飞书里留下的测试数据

为了验证写路径，在你自己的云盘里建了这些对象（都在「临时」目录下的 `dsh-feishu-测试-20261027` 文件夹里）：

| 对象 | token |
|---|---|
| 文件夹 `dsh-feishu-测试-20261027` | `GwWVfKmIPlN1Ogd2q7ucWed6nqW` |
| 文档「DSH 飞书插件功能自测」 | `HjqAdVnjdoZkx4xcJZucdxcbnxc` |
| 电子表格「DSH 飞书插件自测表」 | `EAemsaJThh6CJ1t0AI6cH28AnIh` |
| 多维表格「DSH 插件自测多维表格」 | `JCZSbVNzsayprIsJfBNcO2LBnTb` |

另外发出一条测试 DM。**验收完成后可整目录删除**，不影响插件。

---

## 八、附录：命令速查与源码索引

### 常用命令

```bash
# 安装 / 卸载插件
cd /Users/zyf/Project/deepseek-harness-dsh-v0.1.2-alpha.2
pnpm dsh plugin --profile web add /Users/zyf/Project/DSH_WorkSpace/dsh-feishu
pnpm dsh plugin --profile web remove dsh-feishu

# 重启（插件改动生效）
supervisorctl restart dsh-web
supervisorctl status dsh-web

# 接口自检
curl -s http://localhost:3080/api/feishu/status
curl -si --noproxy '*' http://127.0.0.1:3080/api/feishu/status   # 带响应头

# 凭据校验（注意是两个参数 + Map）
node -e "
import('@deepseek-ai/dsh-credentials-local').then(m => {
  const fs = require('node:fs'), p = '/Users/zyf/.dsh/.credentials.yaml';
  const doc = m.parseCredentialsDocument(fs.readFileSync(p,'utf8'), p);
  console.log([...doc.refs.keys()]);
})"

# 插件自测
cd /Users/zyf/Project/DSH_WorkSpace/dsh-feishu && npm test
```

### 源码位置索引（源码副本根目录下）

| 主题 | 位置 |
|---|---|
| 补丁方言（`insert` / `id` 覆盖 / `config` 整体替换） | `vendor/include/src/index.ts:58-128` |
| loader 导入与导出归一化 | `vendor/loader/src/index.ts:191-199` |
| 工具定义契约（`ToolDefinition`、`output` 必填） | `packages/core/tools/src/schema.ts:545+` |
| 无损 JSON 遍历 | `packages/util/values/src/index.ts` 的 `walkJsonValue` |
| webserver 路由注册与服务名 | `packages/host/webserver/src/index.ts:144,150,165` |
| 路由分发（精确表优先） | `packages/host/webserver/src/index.ts:319-324` |
| `systemPrompt.section()` 签名 | `packages/core/system-prompt/src/index.ts:432` |
| credentials 服务与方法 | `packages/credentials/credentials/src/index.ts:172,217,224,247` |
| 客户端基线平台模块（含 `react`） | `packages/client/web/src/platform.ts:8-13` |
| 客户端插件槽位 `inject` / `register` | `packages/client/ui-renderer/src/client/registry.ts:172`、`packages/client/ui-slots/src/index.ts:785` |
| 第三方插件安装契约 | `docs/user/develop/basic/publish.md` |
| profile / bundle 解析 | `packages/boot/app-boot/src/profile.ts:805-844` |

### `dsh-feishu` 自身关键位置（工作副本下）

| 主题 | 位置 |
|---|---|
| 插件入口（`inject` / `name` / `apply`） | `lib/index.js:29,32,102` |
| 重定向 URI 拼装（硬编码 `127.0.0.1`） | `lib/index.js:114-121` |
| OAuth 路由路径常量 | `lib/routes.js:57-64` |
| 回调处理器（从不发 302） | `lib/routes.js:369-401` |
| **无损 JSON 净化（本次新增）** | `lib/tools/kit.js` `sanitizeToJson()` + `defineTool` |
| 工具注册 | `lib/tools/index.js:123-134` |
| 活动记录包装（先记录后校验） | `lib/tools/index.js:65-99` |
| App Secret 三级读取 | `lib/identity.js:101-114` |
| `userState()`（`undefined` 来源） | `lib/identity.js:466-482` |
| profile patch 定位逻辑 | `lib/entry-config.js:118-172` |

---

**文档结束。** 有任何一步与实际不符，以磁盘现状和实测输出为准。
