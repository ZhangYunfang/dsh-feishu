# dsh-feishu 0.1.1

> **已发布**：<https://github.com/ZhangYunfang/dsh-feishu/releases/tag/v0.1.1> · 附件 `dsh-feishu-0.1.1.tgz`（120559 字节 / 36 个文件，sha256 `22fd1026…52cf5d2b`，下载后校验一致）

> 本文件既是发布说明的源，也直接用作 GitHub Release 正文（正文里的链接已写成绝对 URL，点得开）。
> 上游：`2048lr/dsh-feishu`（0.1.0）· 本分支：`ZhangYunfang/dsh-feishu`（0.1.1）
> 验证宿主：DeepSeek Harness `0.1.2-alpha.2`，macOS + Node 24

## 一句话

让 DSH 的 agent 直接在你的飞书云空间里干活：**10 个工具 / 61 个 action**，覆盖多维表格、云文档、电子表格、知识库、仪表盘、聚合查询、云空间与消息；用户 OAuth 授权**能自我续期**，不必每两小时重授权一次。

## 安装

```bash
# 1) 直接装 GitHub（仓库 public）
dsh plugin add github:ZhangYunfang/dsh-feishu

# 2) 或装本地 tarball（离线/内网分发）
cd "$DSH_HOME/profiles/web" && pnpm add /path/to/dsh-feishu-0.1.1.tgz
dsh plugin add /path/to/dsh-feishu-0.1.1.tgz
```

**必须做的一步**：飞书后台开通 15 项权限并**创建版本发布**，再注册重定向 URL `http://127.0.0.1:3080/api/feishu/oauth/callback`。
逐条步骤（含常见故障对照）见 [`install-for-others.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/install-for-others.md)。

## 这一版相对上游 0.1.0 修了什么

| 类别 | 内容 |
|---|---|
| 🔴 致命 | **续期丢 refresh token**（约 2 小时就要重授权）：旧代码按「密钥放在哪」决定要不要沿用旧 token，把密钥放凭据库（推荐做法）反而必踩；同时补齐协议侧的 `offline_access` 语义与 6 条可执行错误提示 |
| 🐛 功能 | `append_markdown` **含表格必失败**（`table.property` 透传了 `column_width`/`merge_info`，建表接口不接受） |
| 🐛 功能 | `feishu_drive` **建得出文件夹却删不掉/移不动**（`docType` 枚举漏了 `folder`） |
| 🐛 功能 | `import_file` 成功后**不返回 ticket / 文档 token**，导致无法追查、无法单独清理 |
| 🐛 功能 | `create_field` 传 `fields[]` 却报「needs a name」 |
| 🐛 功能 | `feishu_drive download` 走错通道、根目录建夹缺 token、混类型 `get_meta` 全 970005、`import_file` 缺 `extra`（0.1.0-local.2 修） |
| 🔑 权限 | 推荐 scope 补齐 `base:table:read` / `base:dashboard:create` / `update` / `delete` / `docx:document.block:convert`（缺一个对应能力就整块不可用） |
| 🔐 授权流 | 工具生成的授权链接被自己的回调判 `state mismatch`（只有面板入口登记 state） |
| 🩺 可用性 | 工具失败时只显示一句 `invalid_grant`，`errors.js` 里写的可执行提示从未出现（宿主只渲染 `error.message`）；现已折入 message |
| 🧪 可测性 | 新增 **62 条真接口测试**（`test/live/`）与 108 条离线用例；只读凭据护栏、产物自动清理、`blocked`（权限）与 `fail`（代码）分开记 |

## 需要你做的（升级者）

1. **重启 dsh-web**（插件在进程启动时加载，不重启跑的还是旧逻辑）；
2. **重新授权一次**（用户 scope 在授权那刻固化，新开的权限不会自动扩）；
3. 后台补开本版新增的仪表盘写权限（`base:dashboard:create/update/delete`）。

## 验证数据（0.1.1 实测）

```text
npm test            → 108 passed, 0 failed
npm run test:live   → 57 通过 / 0 失败 / 1 阻塞 / 4 跳过（62 用例）
feishu_auth status  → refreshable: true · scope 16 项含 offline_access · refreshExpiresInDays: 7
feishu_auth refresh → 连跑两次均成功，refreshable 始终 true
```

唯一阻塞：`feishu_message webhook` 需要一个用户自建的自定义机器人 URL。

## 已知限制

- 无群组 / 通讯录 / 日历 / 审批 / 事件回调封装（可用 `feishu_api` 直调开放平台）；
- `feishu_wiki` 不能删除节点（插件与开放平台都没有该接口）；
- 飞书 **365 天**硬上限：授权满 365 天须重授权（`refreshExpiresInDays` 即倒计时）；
- 同一 `$DSH_HOME` 不要跑两个 DSH 实例。

## 文档

| 文档 | 内容 |
|---|---|
| [`install-for-others.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/install-for-others.md) | 装到另一台机器 / 给别人用：三通道安装、飞书应用配置、配置项、验收、故障对照 |
| [`feishu-capabilities.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-capabilities.md) | 能力目录：10 工具 / 63 单元的作用、所需权限、实测覆盖度、明确不支持项 |
| [`feishu-test-report.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-test-report.md) | 测试报告：62 条用例矩阵与结果、复现命令、安全护栏 |
| [`feishu-issue-fix-log.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-issue-fix-log.md) | ISSUE-01…12：现象 → 根因 → 修复 → 回归 → 遗留 |
| [`../CHANGELOG.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/CHANGELOG.md) | 三轮变更全记录（含提交号） |

## Checksums

```text
dsh-feishu-0.1.1.tgz  120559 B  36 个文件（含用户指南与安装指南）
sha256  22fd1026ffbba3ebfa3e53ec148ca1b02ed3483ec51a97c4b38397a552cf5d2b
```
