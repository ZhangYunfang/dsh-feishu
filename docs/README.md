# 文档索引

本目录收录 `dsh-feishu` 在 **DeepSeek Harness `0.1.2-alpha.2`** 上的部署记录、排障过程与宿主契约调研。

| 文件 | 内容 |
|---|---|
| [`dsh-feishu-安装与排障全记录.md`](./dsh-feishu-安装与排障全记录.md) | **★ 主文档**：安装步骤（飞书云端 + DSH 本地 + 授权验证）、6 个坑的现象/根因/证据/解法、诊断方法论、配置清单、复发风险与恢复命令、命令速查与源码索引 |
| [`dsh-plugin-contract-0.1.2-alpha.2.md`](./dsh-plugin-contract-0.1.2-alpha.2.md) | DSH 插件包契约调研：profile/bundle 解析、patch 方言、host/client 拆分、工具注册、设置 schema、HTTP 路由、版本清单，逐条带 `path:line` |
| [`workspace-understanding/`](./workspace-understanding/) | 逆向分析产物：资源索引（`00`）、缺口与未决问题（`07`）、增量基线（`index.json`） |

## 交接包（仓库根目录）

| 文件 | 内容 |
|---|---|
| [`../HANDOVER.md`](../HANDOVER.md) | 主交接文档：接手 30 秒入口、当前实测状态、本阶段做了什么、**未做/未验证/待裁决**、下一步依赖顺序、6 个坑的现象→根因→判据、跨机器迁移清单 |
| [`../HANDOVER-MEMORY.md`](../HANDOVER-MEMORY.md) | 记忆清单：换机器时要灌进记忆库的 10 条短事实 + 灌入方法 |

断点（此刻状态）在 `.dsh/CONTINUE.md`，已被 `.gitignore` 排除 —— 属运行态，不随仓库走。

## 值得先看的三个结论

1. **本插件与 DSH 0.1.2-alpha.2 没有 API 不兼容** —— 宿主半边用真实服务挂载实测通过（10 工具 / 6 路由）。
2. **「装了但用不了」的四类原因都在插件之外**：失效的 `file:` 依赖、密钥存放位置、patch 缩进、以及第三方鉴权插件的 cookie 策略。
3. **唯一的代码级适配点**是工具返回值必须是无损 JSON —— 见下文。

## 代码改动

相对上游 `2048lr/dsh-feishu`，本项目只改了一处行为：

- `lib/tools/kit.js` — 新增 `sanitizeToJson()`，在 `defineTool` 的唯一出口对结果做深度净化（剔除 `undefined` 属性、数组空位补 `null`、`-0` → `0`、丢弃非有限数与循环引用）。

原因：DSH 工具注册表要求结果是严格无损 JSON，而插件在「已授权」状态下会把 `undefined` 拼进结果（`lib/identity.js` 的 `userState()`、`lib/tools/auth.js` 的 profile 合并），导致 `feishu_auth status` 报 `value is not lossless JSON`。详见主文档「坑 3」。

## 远程约定

```
origin    → github.com/ZhangYunfang/dsh-feishu    （本仓库，推送用）
upstream  → github.com/2048lr/dsh-feishu          （原作者，同步用）
```

同步上游：

```bash
git fetch upstream
git merge upstream/main     # 或 git rebase upstream/main
```
