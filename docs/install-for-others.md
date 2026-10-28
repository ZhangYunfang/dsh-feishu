# 安装到另一台机器 / 给其他人用

> 目标：让**没有这台机器任何上下文**的人，从零把 `dsh-feishu` 装进自己的 DeepSeek Harness 并跑通。
> 本文用占位符：`$DSH_HOME`（默认 `~/.dsh`）、`$PROFILE`（默认 `web`，即 `$DSH_HOME/profiles/web`）。
> 版本：**0.1.1**，实测宿主 DeepSeek Harness `0.1.2-alpha.2`，Node ≥ 20。

---

## 0. 前提

| 项 | 要求 | 自检 |
|---|---|---|
| DeepSeek Harness | `0.1.2-alpha.2`（其它版本未验证） | `dsh --version` |
| Node | ≥ 20 | `node -v` |
| 包管理器 | pnpm（DSH profile 用它） | `pnpm -v` |
| 飞书应用 | 自建应用，你有开发者后台权限 | 见 §2 |

装之前先确认 DSH 本身能用：`dsh web` 能起来、浏览器能打开。

---

## 1. 装包（三选一）

### 方式 A：直接装 GitHub（最简单，仓库是 public）

```bash
cd "$DSH_HOME/profiles/$PROFILE"
pnpm add github:ZhangYunfang/dsh-feishu
```

### 方式 B：装本地 tarball（适合内网/离线分发）

把 `dsh-feishu-0.1.1.tgz` 拷到目标机器，然后：

```bash
cd "$DSH_HOME/profiles/$PROFILE"
pnpm add /path/to/dsh-feishu-0.1.1.tgz
```

> tarball 用 `npm pack` 生成，只含 `lib/`、`skill/`、`scripts/`、安装指南、能力目录、README、LICENSE、bundle patch —— 不含测试与文档全集。

### 方式 C：源码 `link:`（要改代码才用）

```bash
git clone https://github.com/ZhangYunfang/dsh-feishu.git ~/src/dsh-feishu
cd "$DSH_HOME/profiles/$PROFILE"
pnpm add link:$HOME/src/dsh-feishu
```

⚠️ **方式 C 有两个额外坑**（方式 A/B 不会遇到）：
1. 设置页会报「配置文件不可写：the profile patch file could not be located」——因为插件从模块路径向上找不到 profile。修法见 §3.4。
2. 改了代码**必须重启 dsh-web** 才生效（插件在进程启动时加载）。

### 把插件加进 bundle 栈（A/B 方式各一次即可）

```bash
dsh plugin add github:ZhangYunfang/dsh-feishu    # 或 tarball 路径
```

它会把 `dsh-feishu` 追加到 profile 的 `dsh.profile.bundles`，并自动合并包里的 `cordis.patch.yml`（插入 `id: feishu` 那一行）。

> **不要同时用 bundle 和手写 insert**：两者产生同一个 loader id，loader 会拒绝重复。设置页会识别 bundle 并改成写 config 覆盖，不再插第二行。

---

## 2. 飞书应用配置（最容易卡住的一步）

### 2.1 建应用拿三项信息

1. 打开 <https://open.feishu.cn/app> → 创建企业自建应用
2. 记下 **App ID**、**App Secret**（`开发配置 → 凭证与基础信息`）

### 2.2 注册重定向 URL（必须逐字匹配）

`安全设置 → 重定向 URL` 里加一条：

```text
http://127.0.0.1:3080/api/feishu/oauth/callback
```

端口换成你自己的 `dsh web` 端口；**必须是完整路径**，`?`/`#` 后缀不生效。不在列表里会报 `{code:2000, redirect_uri unmatch}`。

> 如果你本机开着系统代理且绕过表写的是 `127.*`，浏览器打不开 `127.0.0.1`（Chrome 不认这种通配）。此时把重定向写成 `http://localhost:3080/api/feishu/oauth/callback` 并在 §3.3 里显式配置 `oauthRedirectUri`。

### 2.3 开通权限（15 项，缺一项对应功能就废）

`开发配置 → 权限管理` 搜索并开通：

```text
offline_access                  ← 续期前提，缺了约 2 小时就要重新授权
bitable:app                     多维表格
base:table:read                 LiteQuery 聚合（feishu_query）
base:dashboard:read             仪表盘读
base:dashboard:create           建仪表盘 / 图表块
base:dashboard:update           改块
base:dashboard:delete           删块
docx:document                   云文档
docx:document.block:convert     Markdown 转块（append_markdown）
drive:drive                     云空间读写
sheets:spreadsheet              电子表格
wiki:wiki                       知识库
im:message                      发消息
im:resource                     传图 / 传文件
contact:user.base:readonly      读本人 profile
```

要点：
- 仪表盘是**四个独立 scope**（read/create/update/delete），只开 read 会全线 `99991679`；
- **勾完必须「创建版本并发布」**，不发布等于没开通。这是最常见的坑；
- 报错 `99991679` 时，`detail` 里会明写 `required one of these privileges under the user identity: [xxx]` —— 照抄那个名字去开就行，不用猜。

---

## 3. 配置

### 3.1 appId（必填）

编辑 `$DSH_HOME/profiles/$PROFILE/cordis.patch.yml`，加/改这一条（**顶层条目，不要塞进 insert 列表**）：

```yaml
- id: feishu
  config:
    appId: 'cli_你的AppID'
```

也可以在设置页「飞书 / Feishu」里填（那里不允许填 `patchFilePath`，字段是故意只读的）。

### 3.2 App Secret（三选一，推荐第一种）

**① 凭据库（推荐）**：写进 `$DSH_HOME/.credentials.yaml`（权限 0600）：

```yaml
version: 1
refs:
  FEISHU_APP_SECRET: '你的AppSecret'
```

插件按 **凭据库 → 同名环境变量 `FEISHU_APP_SECRET` → config.appSecret** 顺序取。放凭据库的好处：不进 shell 历史、不进 supervisor 配置（后者通常 644）。

**② 环境变量**：`FEISHU_APP_SECRET=... dsh web`（或用 supervisor 的 `environment=`）

**③ config.appSecret**：设置页可写。**注意**：早期版本有 bug 会在这里踩到（见 §6 表格最后一行），0.1.1 已修，但仍建议用 ①。

### 3.3 可选配置

```yaml
- id: feishu
  config:
    appId: 'cli_...'
    oauthRedirectUri: 'http://localhost:3080/api/feishu/oauth/callback'  # 浏览器受代理影响时用
    defaultFolderToken: 'fld...'   # 不填 folderToken 时文档默认落这里
    # oauthScopes: [...]           # 不要写！写了会覆盖默认 15 项，容易漏掉 offline_access
```

### 3.4 只给 `link:` 安装用：指定 patch 文件位置

```yaml
- id: feishu
  config:
    appId: 'cli_...'
    patchFilePath: '/absolute/path/to/.dsh/profiles/web/cordis.patch.yml'
```

不写这个，设置页保存会失败并提示找不到 profile patch 文件。

---

## 4. 重启并授权

```bash
# 重启托管 dsh-web 的方式随你的部署而定，例如：
supervisorctl restart dsh-web      # 用 supervisor 托管
# 或直接重跑：pnpm dsh web
```

浏览器打开 DSH → 在对话里让 agent 调用 `feishu_auth`：

```text
feishu_auth action=authorize_url   → 拿到链接，点开授权
feishu_auth action=status          → 看结果
```

授权页面会申请 15 项权限；同意后浏览器回跳 `127.0.0.1:3080/...`，插件自动存下凭证。

> 如果回跳页打不开或报 `state mismatch`：0.1.0 及更早版本工具生成的链接不带 state 登记，请升级到 **0.1.1**。兜底方案是把地址栏里的 `code=xxx` 复制给学生，用 `feishu_auth action=complete code=xxx` 直接兑换。

---

## 5. 验收（三条，全过才算装好）

```text
feishu_auth action=status
```

期望：

| 字段 | 期望值 | 说明 |
|---|---|---|
| `tenantTokenOk` | `true` | 应用凭证可用 |
| `user.authorized` | `true` | 有用户授权 |
| `user.refreshable` | **`true`** | 能自动续期 |
| `user.scope` | 含 `offline_access` | 续期前提 |
| `user.refreshExpiresInDays` | 有数字 | 续期凭证剩余天数 |
| `warnings` | **空** | 有告警按提示处理 |

再跑一次续期（真轮换，连跑两次更稳）：

```text
feishu_auth action=refresh    → 期望 refreshable 仍为 true
feishu_auth action=refresh    → 再跑一次，仍为 true
```

> ⚠️ `refreshable: true` 只是「记录里有 refresh token」的存在性检查——token 被撤销后它照样是 true。**要证实能续期只能真跑 refresh。**

最后抽查一个真实调用：

```text
feishu_drive action=list_files pageSize=5 identity=user
```

源码级自检（可选，需要 git clone 而不是 tarball）：

```bash
npm test              # 108 条离线用例，不联网
npm run test:live:list   # 看 62 条真接口用例（零请求）
npm run test:live        # 真接口全量，约 2 分钟，自动清理产物
```

---

## 6. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具全报 `99991679` | 应用权限没开或**没发版**；或用户 grant 是旧的（开权限前授权的） | 后台开权限 → 创建版本发布 → **重新授权** |
| `refreshable: false` / 约 2 小时就要重授权 | 缺 `offline_access`，或授权时没带它 | 开 `offline_access` 并发版，重新授权（插件默认链接已含它） |
| `redirect_uri unmatch`（code 2000） | 重定向 URL 没逐字匹配 | 按 §2.2 逐字加；端口/路径都要对 |
| 回跳页 `ERR_TOO_MANY_REDIRECTS` | 本地鉴权插件（如 `dsh-web-startup-auth`）的 cookie 用了 `SameSite=Strict` | 改 `Lax`（补丁在 `node_modules`，插件更新会覆盖）；或用 `action=complete` 走 code 兑换 |
| 回跳 `state mismatch` | 版本 < 0.1.1 时工具生成的链接未登记 state | 升级到 0.1.1；或改用面板入口 / `action=complete` |
| 设置页报「配置文件不可写」 | `link:` 安装，插件找不到 profile patch | 按 §3.4 配 `patchFilePath` |
| 改了代码没生效 | 插件在进程启动时加载 | 重启 dsh-web |
| 装了但任何插件都装不上，报错指向无关的包 | profile `package.json` 里有失效的 `file:` 依赖 | 读 profile 找所有 `file:`，逐个确认目标文件存在 |
| `append_markdown` 报 `1770001 invalid param` | 版本 < 0.1.1 时含表格的 Markdown 无法追加 | 升级到 0.1.1 |

---

## 7. 升级 / 卸载

```bash
# 升级（git 通道）
cd "$DSH_HOME/profiles/$PROFILE" && pnpm add github:ZhangYunfang/dsh-feishu
# 升级（tarball 通道）：pnpm add /path/to/dsh-feishu-新版本.tgz
# 之后重启 dsh-web

# 卸载
cd "$DSH_HOME/profiles/$PROFILE" && pnpm remove dsh-feishu
# 再从 cordis.patch.yml / dsh.profile.bundles 里删掉对应条目
```

升级后重新看一次 `feishu_auth status`：插件可能有新的推荐 scope（例如仪表盘写权限是 0.1.1 才补齐的），需要重新授权才能吃到。

---

## 8. 已知限制（不是装错）

| 限制 | 说明 |
|---|---|
| 没有群组 / 通讯录 / 日历 / 审批 / 事件回调用法 | 插件未封装，只能用 `feishu_api` 直调开放平台 |
| `feishu_wiki` 不能删节点 | 插件与开放平台都没有删除节点接口；建了清不掉 |
| `feishu_message webhook` | 需要你在群内自建自定义机器人并拿到 webhook URL |
| 飞书 365 天硬上限 | 授权满 365 天必须重新授权；`refreshExpiresInDays` 就是倒计时 |
| 一个 `$DSH_HOME` 只跑一个 DSH | 双实例会互踩会话与插件目录 |

功能与权限的完整对照见 [`feishu-capabilities.md`](./feishu-capabilities.md)；改了什么、怎么验的见 [`../CHANGELOG.md`](../CHANGELOG.md)。
