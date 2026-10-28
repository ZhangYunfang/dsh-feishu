# 安装到另一台机器 / 给其他人用

> 目标：让**没有这台机器任何上下文**的人，从零把 `dsh-feishu` 装进自己的 DeepSeek Harness 并跑通。
> 装完怎么用见 [`user-guide.md`](./user-guide.md)；能做什么、每项要什么权限见 [`feishu-capabilities.md`](./feishu-capabilities.md)。
> 版本 **0.1.2** · 实测宿主 DeepSeek Harness `0.1.2-alpha.2` · Node ≥ 20 · macOS / Linux 实测，Windows 路径差异见 §0.3

---

## 0. 先做三项自查

### 0.1 找到你的 `$DSH_HOME` 和 profile 名

```bash
echo "${DSH_HOME:-$HOME/.dsh}"        # 默认 ~/.dsh
ls "$HOME/.dsh/profiles"              # 常见只有 web；也可能有 desktop 等
```

Windows（PowerShell）：

```powershell
echo $env:DSH_HOME                    # 空则用默认
Get-ChildItem "$env:USERPROFILE\.dsh\profiles"
```

后面的命令里 `$DSH_HOME` = 上面那个目录，`$PROFILE` = profile 名（通常 `web`）。

### 0.2 确认 `dsh` CLI 有没有 `plugin` 子命令

```bash
dsh plugin --help 2>&1 | head -5
```

- **有输出** → 走 §1 方式 A/B（一条命令装好并激活）
- **报 unknown command** → 走 §1 方式 C（手动两步）

### 0.3 平台差异

| 平台 | shell | profile 路径 |
|---|---|---|
| macOS / Linux | bash / zsh | `$HOME/.dsh/profiles/web` |
| Windows | PowerShell | `$env:USERPROFILE\.dsh\profiles\web` |

包里的 `scripts/install.ps1`（`npm run install:profile`）是 Windows 专用辅助脚本，手动装不需要它。

---

## 1. 装包

先说明 DSH 的装配机制，否则容易装好却"没生效"：

> profile 的 `package.json` 里 `dependencies` 决定"装了什么"，`dsh.profile.bundles` 决定"哪些作为插件层被加载"。
> `dsh plugin --profile <名> add <spec>` 会**两步都做**：初始化 profile → 在 profile 目录跑 `pnpm add` →
> 再按**已安装状态** reconcile `dsh.profile.bundles`：凡声明了 `dsh.bundle.patch` 的依赖会被自动追加进 bundle 栈。
> `dsh-feishu` 声明了该字段，所以自动激活；一个纯库只会得到一行 warn。

### 方式 A：从 GitHub 安装（最简单，仓库 public）

```bash
dsh plugin --profile "$PROFILE" add github:ZhangYunfang/dsh-feishu
```

要钉版本：

```bash
dsh plugin --profile "$PROFILE" add github:ZhangYunfang/dsh-feishu#v0.1.2
```

### 方式 B：从 GitHub Release 的 tarball 安装（内网/离线）

先下载（也可以在浏览器里点，或直接转发文件）：

```bash
curl -L -o dsh-feishu-0.1.2.tgz \
  https://github.com/ZhangYunfang/dsh-feishu/releases/download/v0.1.2/dsh-feishu-0.1.2.tgz
shasum -a 256 dsh-feishu-0.1.2.tgz     # 应与发布页记录一致
```

再装：

```bash
dsh plugin --profile "$PROFILE" add /绝对路径/dsh-feishu-0.1.2.tgz
```

> tarball 只含 `lib/`、`skill/`、`scripts/`、安装指南、用户指南、能力目录、README、LICENSE、bundle patch —— 不含测试与文档全集。

### 方式 C：没有 `dsh plugin` 子命令时，手动两步

```bash
# 第 1 步：装依赖（三选一 spec）
cd "$DSH_HOME/profiles/$PROFILE"
pnpm add github:ZhangYunfang/dsh-feishu          # 或 tarball 路径，或 link:~/src/dsh-feishu

# 第 2 步：把包名加进 bundle 栈
$EDITOR package.json
```

```jsonc
{
  "dependencies": { "dsh-feishu": "github:ZhangYunfang/dsh-feishu" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",       // ← 原有内容一律保留
        "@deepseek-ai/dsh-web-app",
        "dsh-feishu"                    // ← 新增这一个（末尾）
      ]
    }
  }
}
```

> 手动方式同样会自动合并包里的 `cordis.patch.yml`（插入 `id: feishu` 那行），**不要再手写第二条 insert**——
> 两条会产生同一个 loader id，loader 会拒绝重复。设置页识别到 bundle 后会改为写 config 覆盖。

### 方式 D：源码 `link:`（要改代码才用）

```bash
git clone https://github.com/ZhangYunfang/dsh-feishu.git ~/src/dsh-feishu
dsh plugin --profile "$PROFILE" add link:$HOME/src/dsh-feishu
```

⚠️ `link:` 安装的两个额外坑（A/B/C 方式不会遇到）：
1. 设置页报「配置文件不可写：the profile patch file could not be located」→ 见 §3.4 配 `patchFilePath`；
2. 改了代码**必须重启 dsh-web** 才生效（插件在进程启动时加载）。

### 装完自检（不管用哪种方式）

```bash
cd "$DSH_HOME/profiles/$PROFILE"
ls -l node_modules/dsh-feishu/package.json           # 存在即可（link: 会是软链）
node -e "console.log(require('./node_modules/dsh-feishu/package.json').version)"
python3 -c "import json;print(json.load(open('package.json'))['dsh']['profile']['bundles'][-3:])"
```

期望：版本 `0.1.2`，bundle 列表末尾出现 `dsh-feishu`。

---

## 2. 飞书应用配置（最容易卡住）

> 这一步的**完整版**（含每一步的界面位置、每个权限的用途与缺失症状、错误码对照、检查清单）在
> [`feishu-console-setup.md`](./feishu-console-setup.md)。本节只给最短路径。

### 2.1 建应用，拿 App ID / App Secret

1. 打开 <https://open.feishu.cn/app> → 创建企业自建应用
2. `开发配置 → 凭证与基础信息` 里取 **App ID**、**App Secret**

### 2.2 注册重定向 URL（必须逐字匹配）

`安全设置 → 重定向 URL` 加一条（端口换成你自己的 `dsh web` 端口）：

```text
http://127.0.0.1:3080/api/feishu/oauth/callback
```

- 必须**逐字匹配**（协议、端口、完整路径），否则报 `{code:2000, redirect_uri unmatch}`
- `?`/`#` 后缀不生效
- 本机开着系统代理且绕过表写的是 `127.*` 时，浏览器打不开 `127.0.0.1`（Chrome 不认这种通配）→ 改用 `http://localhost:3080/api/feishu/oauth/callback`，并在 §3.3 显式配 `oauthRedirectUri`

### 2.3 开通权限（15 项，缺一项对应能力就废）

`开发配置 → 权限管理` 搜索并开通：

```text
offline_access                   ← 续期前提，缺了约 2 小时就要重新授权
bitable:app                      多维表格
base:table:read                  LiteQuery 聚合（feishu_query）
base:dashboard:read              仪表盘读
base:dashboard:create            建仪表盘 / 图表块
base:dashboard:update            改块
base:dashboard:delete            删块
docx:document                    云文档
docx:document.block:convert      Markdown 转块（append_markdown）
drive:drive                      云空间读写
sheets:spreadsheet               电子表格
wiki:wiki                        知识库
im:message                       发消息
im:resource                      传图 / 传文件
contact:user.base:readonly       读本人 profile
```

三条铁律：

1. 仪表盘是**四个独立 scope**（read / create / update / delete），只开 read 会全线 `99991679`；
2. **勾完必须「创建版本并发布」**，不发布等于没开通——这是最常见的坑；
3. 报 `99991679` 时，返回的 `detail` 里会写 `required one of these privileges under the user identity: [xxx]`，**照那个名字开**，不用猜。

---

## 3. 配置

### 3.1 appId（必填）

编辑 `$DSH_HOME/profiles/$PROFILE/cordis.patch.yml`，**顶层**加/改（不要塞进 insert 列表）：

```yaml
- id: feishu
  config:
    appId: 'cli_你的AppID'
```

也可以在 DSH 设置页「飞书 / Feishu」里填。

### 3.2 App Secret（三选一，推荐 ①）

**① 凭据库（推荐）**：写进 `$DSH_HOME/.credentials.yaml`（0600）：

```yaml
version: 1
refs:
  FEISHU_APP_SECRET: '你的AppSecret'
```

插件按 **凭据库 → 同名环境变量 `FEISHU_APP_SECRET` → config.appSecret** 顺序取。放凭据库不进 shell 历史、不进 supervisor 配置（后者通常 644）。

**② 环境变量**：`FEISHU_APP_SECRET=... dsh web`
**③ config.appSecret**：设置页可写（不如 ① 安全）。

### 3.3 可选配置

```yaml
- id: feishu
  config:
    appId: 'cli_...'
    oauthRedirectUri: 'http://localhost:3080/api/feishu/oauth/callback'  # 浏览器受代理影响时
    defaultFolderToken: 'fld...'   # 不指定 folderToken 时的默认落点
    # oauthScopes: [...]           # ⚠️ 不要写！会覆盖默认 15 项，容易漏掉 offline_access
```

### 3.4 仅 `link:` 安装需要：告诉插件 patch 文件在哪

```yaml
- id: feishu
  config:
    appId: 'cli_...'
    patchFilePath: '/绝对路径/.dsh/profiles/web/cordis.patch.yml'
```

不写这个，设置页保存会失败（插件从模块路径向上找不到 profile）。此字段**不允许从浏览器写**，只能手改。

---

## 4. 重启并授权

```bash
# 重启方式随你的部署而定
supervisorctl restart dsh-web        # 用 supervisor 托管
# 或直接重跑：pnpm dsh web
```

浏览器打开 DSH，在对话里：

```text
feishu_auth action=authorize_url   → 拿到链接，点开同意
feishu_auth action=status          → 看结果
```

回跳页应显示 **Feishu is connected / Authorized as <你的名字>**。

> 若回跳页报 `state mismatch`：说明是 0.1.0 或更早版本（工具生成的链接不登记 state），升级到 **0.1.1**。
> 兜底：把地址栏里的 `code=xxx` 复制出来，用 `feishu_auth action=complete code=xxx` 直接兑换，完全绕开回调。

---

## 5. 验收（三条，全过才算装好）

```text
feishu_auth action=status
```

| 字段 | 期望 | 说明 |
|---|---|---|
| `tenantTokenOk` | `true` | 应用凭证可用 |
| `user.authorized` | `true` | 有用户授权 |
| `user.refreshable` | **`true`** | 能自动续期 |
| `user.scope` | 含 `offline_access` | 续期前提 |
| `user.refreshExpiresInDays` | 有数字 | 续期凭证剩余天数 |
| `warnings` | **空** | 有告警按提示处理 |

再真验证一次续期（`refreshable` 只是"记录里有 token"，不代表有效）：

```text
feishu_auth action=refresh     → 期望 refreshable 仍 true
feishu_auth action=refresh     → 再跑一次，仍 true
```

最后抽查一个真实调用：

```text
feishu_drive action=list_files pageSize=5 identity=user
```

源码级自检（需要 clone 而不是 tarball）：

```bash
cd 你的 clone 目录
npm test                 # 108 条离线用例，不联网
npm run test:live:list   # 看 62 条真接口用例（零请求）
npm run test:live        # 真接口全量，约 2 分钟，自动清理
```

---

## 6. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具全报 `99991679` | 权限没开 / 开了**没发版** / 用户 grant 是旧的 | 后台开权限 → 创建版本发布 → **重新授权** |
| `refreshable: false`，约 2 小时就要重授权 | 缺 `offline_access` 或授权时没带 | 开通 + 发版 + 重新授权（默认链接已含它） |
| 装完但插件没加载（对话里没有 `feishu_*` 工具） | `dsh.profile.bundles` 里没有 `dsh-feishu` | 用 `dsh plugin --profile … add …` 重装，或手改 bundles（§1 方式 C） |
| 装完启动报 loader 重复 id | bundle 与手写 insert 同时存在 | 删掉手写的那条 `- id: feishu` |
| `redirect_uri unmatch`（code 2000） | 重定向 URL 没逐字匹配 | 按 §2.2 逐字加，端口/路径都要对 |
| 回跳 `ERR_TOO_MANY_REDIRECTS` | 本地鉴权插件（如 `dsh-web-startup-auth`）的 cookie 用了 `SameSite=Strict` | 改成 `Lax`（补丁在 `node_modules`，插件更新会覆盖）；或用 `action=complete` |
| 回跳 `state mismatch` | 版本 < 0.1.1 | 升级到 0.1.1；或改用面板入口 / `action=complete` |
| 设置页报「配置文件不可写」 | `link:` 安装，插件找不到 profile patch | 按 §3.4 配 `patchFilePath` |
| 改了代码没生效 | 插件在进程启动时加载 | 重启 dsh-web |
| 任何插件都装不上，报错指向无关的包 | profile 里有失效的 `file:` 依赖 | 读 profile `package.json` 找所有 `file:`，逐个确认目标文件存在 |
| `append_markdown` 报 `1770001 invalid param` | 版本 < 0.1.1 时含表格的 Markdown 无法追加 | 升级到 0.1.1 |

---

## 7. 升级 / 卸载

```bash
# 升级（沿你安装时的通道）
dsh plugin --profile "$PROFILE" add github:ZhangYunfang/dsh-feishu
dsh plugin --profile "$PROFILE" add /绝对路径/dsh-feishu-新版本.tgz
# 之后重启 dsh-web

# 卸载
dsh plugin --profile "$PROFILE" remove dsh-feishu
```

`remove` 后 `dsh.profile.bundles` 里那条也会被 reconcile 掉（手工安装的请自行删除）。
升级后重看 `feishu_auth status`：插件可能新增推荐 scope（如仪表盘写权限是 0.1.1 才补齐的），需要重新授权才吃到。

---

## 8. 已知限制（不是装错）

| 限制 | 说明 |
|---|---|
| 无群组 / 通讯录 / 日历 / 审批 / 事件回调封装 | 只能用 `feishu_api` 直调开放平台 |
| `feishu_wiki` 不能删节点 | 插件与开放平台都没有该接口；建了删不掉 |
| `feishu_message webhook` | 需要你在群内自建自定义机器人拿 URL |
| 飞书 365 天硬上限 | 授权满 365 天必须重新授权；`refreshExpiresInDays` 即倒计时 |
| 一个 `$DSH_HOME` 只跑一个 DSH 实例 | 双实例互踩会话与插件目录 |

---

## 9. 下一步

装好之后看 [`user-guide.md`](./user-guide.md)：怎么用中文提需求、每类任务的提示词配方、结果怎么读、安全边界。
