# dsh-feishu 0.1.2

> **已发布**：<https://github.com/ZhangYunfang/dsh-feishu/releases/tag/v0.1.2> · 附件 `dsh-feishu-0.1.2.tgz`（128920 字节 / 37 个文件，sha256 `38d9da0afcd221ca08288e46d3c8e7422f92e25cc19d583d03e39de8227d03e8`，下载后校验一致）

> 本文件既是发布说明的源，也直接用作 GitHub Release 正文（正文里的链接已写成绝对 URL，点得开）。
> 上游：`2048lr/dsh-feishu`（0.1.0）· 本分支：`ZhangYunfang/dsh-feishu`（0.1.2）
> 验证宿主：DeepSeek Harness `0.1.2-alpha.2`，macOS + Node 24

## 一句话

修掉「设置页保存过一次配置后，再也存不进去」的锁死缺陷：`link:` 安装的插件现在自己就能找到 profile 的 `cordis.patch.yml`，并且写配置时不会再把自己需要的 `patchFilePath` 覆盖掉。

## 安装

```bash
# 1) 直接装 GitHub（仓库 public，钉本版 tag）
dsh plugin add github:ZhangYunfang/dsh-feishu#v0.1.2

# 2) 或装本地 tarball（离线/内网分发）
dsh plugin add /path/to/dsh-feishu-0.1.2.tgz
```

其余步骤（飞书后台 15 项权限 + 重定向 URL + 发版、DSH 侧配置、三条验收）与 0.1.1 完全相同，见
[`install-for-others.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/install-for-others.md)。

## 这一版相对 0.1.1 修了什么

| 类别 | 内容 |
|---|---|
| 🔴 锁死 | **设置页报「配置文件不可写：the profile patch file could not be located」且重启无效**。两层根因：①写入口 `locateBlock()` 只认标记区和 `name: dsh-feishu`，认不出只有 `id: feishu` 的手写条目 → 保存时追加第二条同 id 条目，而加载器**后一条整块替换前一条的 `config`**，把 `patchFilePath` 一起吃掉（该字段不许浏览器写，无法自愈）；②读入口把 Cordis 的 `ctx.baseUrl`（是 `<profile>` **目录**）当文件 `dirname()`，候选表里只剩 `profiles/cordis.patch.yml` 之类祖先，永远没有 `<profile>/cordis.patch.yml` |
| 🔧 自愈 | 现在每次写配置都会把 `patchFilePath` 补成当前文件路径；块形式跟随被替换的块（手写 override 不会被改写成 `insert:` 造成二次定义 id） |
| 🐛 定位 | 新增 `locateIdOnlyBlock()`：按 `id: feishu` 兜底查找（`insert:` 列表跳过，改写会丢同级条目）；`anchorDirectory()` 遇到已存在目录时原样使用 |
| 🧪 测试 | 新增 3 条回归（baseUrl 指目录 / id-only 条目 / 不留两条同 id） |
| 📄 文档 | 排障主文档新增「缺陷 9」与「§六 风险 6」全过程，`feishu-issue-fix-log.md` 新增 ISSUE-14，能力目录与用户指南的版本号同步 |

## 需要你做的（升级者）

1. **重启 dsh-web**（`supervisorctl restart dsh-web` 或你惯用的方式）—— 本版改的是 `lib/`，插件在进程启动时加载，不重启跑的还是旧逻辑。
2. **不需要重新授权**：本版没有新增 scope，也不动令牌。
3. 如果你之前已经被这个缺陷锁死（保存一律报错）：重启即可恢复——新代码能从 `ctx.baseUrl` 直接定位 `<profile>/cordis.patch.yml`，不再依赖 `patchFilePath`。之后点一次保存会把 `patchFilePath` 写回 managed 块；若你的 profile 里仍留着两条同 id 条目，可以手工删掉那条手写的（保留带 `# >>> dsh-feishu` 标记的那条）。

## 验证数据（0.1.2 实测，2026-10-28）

```text
npm test                                  → 112 passed, 0 failed（0.1.1 为 108，本版新增 3 条 + 1 条既有断言）
resolvePatchFile({}, {baseUrl:'<profile>'}) → <profile>/cordis.patch.yml   ← 模拟「配置里没有 patchFilePath」的全新安装
GET /api/feishu/config                    → patch.file 非 null · entryFound true · readable true · error null
feishu_auth refresh ×2（同一进程连跑）     → 两次 refreshable: true，scope 16 项含 offline_access，refreshExpiresInDays 7
```

## 已知限制

- `feishu_message webhook` 仍需要用户自建的自定义机器人 URL，插件无法代办。
- 未发布到 npm：`dsh-feishu` 这个包名属上游，走 npm 需改自有 scope。
- 设置页保存依赖 profile 的 `cordis.patch.yml`；若你的 profile 用了非标准布局（不在 `<DSH_HOME>/profiles/<name>/`），请显式配置 `patchFilePath`（该字段只能写在 yaml 里，故意不让浏览器改）。

## 文档

- 安装给别人：[`install-for-others.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/install-for-others.md)
- 飞书后台配置：[`feishu-console-setup.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-console-setup.md)
- 用户指南：[`user-guide.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/user-guide.md)
- 排障全记录（含本版缺陷的复现与证据）：[`dsh-feishu-安装与排障全记录.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/dsh-feishu-安装与排障全记录.md)
- 问题编号：[`feishu-issue-fix-log.md`](https://github.com/ZhangYunfang/dsh-feishu/blob/main/docs/feishu-issue-fix-log.md)（ISSUE-14 即本版修复）

## Checksums

```text
dsh-feishu-0.1.2.tgz  128920 B · 37 个文件
sha256  38d9da0afcd221ca08288e46d3c8e7422f92e25cc19d583d03e39de8227d03e8
核对：shasum -a 256 dsh-feishu-0.1.2.tgz 一致；tar -tzf … | wc -l → 37；包内无 App Secret（只有 App ID 与占位符）
```
