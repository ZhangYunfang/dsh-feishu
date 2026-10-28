# dsh-feishu 0.1.3

> **已发布**：<https://github.com/ZhangYunfang/dsh-feishu/releases/tag/v0.1.3> · 附件 `dsh-feishu-0.1.3.tgz`（130521 字节 / 37 个文件，sha256 `3e13d2e1bfb5deec688288e8863c04fca3653a7c51417271eb90bd549b362880`，下载后校验一致）

> 本文件既是发布说明的源，也直接用作 GitHub Release 正文。
> 上游：`2048lr/dsh-feishu`（0.1.0）· 本分支：`ZhangYunfang/dsh-feishu`（0.1.3）
> 验证宿主：DeepSeek Harness `0.1.2-alpha.2`，macOS + Node 24

## 一句话

让"授权出问题"不再看起来像成功：**回跳被挡时告诉你改用 code 兑换，授权拿到手但没有 `offline_access` 时当场告诉你它两小时后会失效** —— 而不是等你两小时后发现所有工具一起崩。

## 安装

```bash
# 1) 直接装 GitHub（仓库 public，钉本版 tag）
dsh plugin add github:ZhangYunfang/dsh-feishu#v0.1.3

# 2) 或装本地 tarball（离线/内网分发）
dsh plugin add /path/to/dsh-feishu-0.1.3.tgz
```

飞书后台（15 项权限 + 重定向 URL + **必须创建版本发布**）与 DSH 侧配置同 0.1.2，见
[`install-for-others.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/install-for-others.md)。

## 这一版相对 0.1.2 改了什么

功能逻辑与 0.1.2 相同，改的全是**授权环节的可解释性**（来源：2026-10-28 的一次真实事故，ISSUE-15）：

| 位置 | 改动 | 为什么 |
|---|---|---|
| `feishu_auth authorize_url` 的 `nextStep` | 明确写出「浏览器回不到本机时，改用 `action: "complete"` 传 code」 | 本机 `dsh-web-startup-auth` 的浏览器 cookie 曾是 `SameSite=Strict`，从飞书跨站回跳必然死循环；旧文案却承诺"浏览器会自动落地" |
| `feishu_auth complete` | 兑换后若 grant 不含 `offline_access`，`summary` 直说"到期即失效"，`warnings` 给出后台检查项 | 缺 `offline_access` 的授权**看起来是成功**，约 2 小时后才崩；旧实现只回 `refreshable: false` |
| OAuth 回调成功页 | 同上，无 `offline_access` 时标题变为「connected, but it will not renew itself」并转琥珀色 | 浏览器落地页是用户唯一会看的那一眼 |

## 需要你做的（升级者）

1. **重启 dsh-web** —— 本版改了 `lib/`，插件在进程启动时加载。
2. **不需要重新授权**：本版没动 scope、没动令牌。
3. 如果你正被 `ERR_TOO_MANY_REDIRECTS` 卡住：那不是本插件能修的 —— 是宿主插件 `dsh-web-startup-auth` 的浏览器 cookie 用了 `SameSite=Strict`（0.1.9 只改了会话 cookie，浏览器 cookie 仍是 Strict）。处置步骤、两条判据与"重启会清空 state 表、必须先重启再生成链接"的顺序陷阱，见
   [`dsh-feishu-安装与排障全记录.md` §六 风险 1](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/dsh-feishu-安装与排障全记录.md)。应急通道：把回跳 URL 里的 `code` 交给 agent，用 `action: "complete"` 兑换。

## 验证数据（0.1.3 实测，2026-10-28）

```text
node test/run-tests.mjs   → 113 passed, 0 failed（0.1.2 为 112，本版新增 1 条用例 + 1 条断言）
feishu_auth status        → refreshable: true · scope 16 项含 offline_access · refreshExpiresInDays: 7
feishu_auth refresh ×2    → 两次均成功，refreshable 始终 true，expiresAt 逐次前进
浏览器 OAuth 回跳          → 落地页 "Feishu is connected / Authorized as Hunter Zhang"
```

⚠️ 「缺 `offline_access` 时的告警文案」由**离线用例**覆盖（构造不含 refresh_token 的兑换响应），本版发布时没有再造一次真实的无 `offline_access` 授权。

## 已知限制

- 未发布到 npm（`dsh-feishu` 包名属上游）。
- `SameSite` 补丁无法随本插件分发：它在宿主插件的 `node_modules` 里，升级/重装 `dsh-web-startup-auth` 后需按风险 1 重打。
- `offline_access` 丢失的应用侧根因未确认（授权链接一直带着该 scope，重授权后才恢复）。

## 文档

- 安装给别人：[`install-for-others.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/install-for-others.md)
- 飞书后台配置：[`feishu-console-setup.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-console-setup.md)
- 用户指南：[`user-guide.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/user-guide.md)
- 排障全记录（风险 1 = 授权回跳）：[`dsh-feishu-安装与排障全记录.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/dsh-feishu-安装与排障全记录.md)
- 问题编号：[`feishu-issue-fix-log.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-issue-fix-log.md)（ISSUE-15 即本版来源）

## Checksums

```text
dsh-feishu-0.1.3.tgz  130521 B · 37 个文件
sha256  3e13d2e1bfb5deec688288e8863c04fca3653a7c51417271eb90bd549b362880
核对：shasum -a 256 … 一致；tar -tzf … | wc -l → 37；包内无 App Secret（只有 App ID 与占位符）
```
