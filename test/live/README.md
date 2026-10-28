# 真接口测试（`test/live`）

`npm test` 用 mock 证明「代码与自己一致」；这里用**真飞书开放平台**证明「飞书也这么认为」。
两件事都要做：只跑 mock 会漏掉真实契约（本轮就是这样发现了 4 个缺陷）。

## 怎么跑

```bash
cd dsh-feishu

npm run test:live:list     # 只列 61 条用例，不发任何请求（安全检查首选）
npm run test:live          # 全量跑 + 自动清理，约 2 分钟
node test/live/feishu-live.mjs --only=drive   # 单个家族
node test/live/feishu-live.mjs --keep         # 保留产物（排查用）
```

`--only=` 接受家族名：`auth` `api` `drive` `doc` `sheet` `bitable` `query`
`dashboard` `wiki` `message`，也接受用例 id 前缀（如 `--only=MSG`）。

## 前置条件

| 需要什么 | 从哪里来 |
|---|---|
| 飞书 App ID | `~/.dsh/profiles/web/cordis.patch.yml` 的 `appId`（可用 `FEISHU_APP_ID` 覆盖） |
| App Secret | 凭据库 `~/.dsh/.credentials.yaml` 的 `refs.FEISHU_APP_SECRET`（只读） |
| 用户授权（user grant） | 同上，`records.dsh-feishu/user-token`（只读） |
| 回调地址 | 默认 `http://127.0.0.1:3080/api/feishu/oauth/callback`，可用 `FEISHU_TEST_REDIRECT` 覆盖 |

跑之前先在 DSH 里确认 `feishu_auth status` → `tenantTokenOk: true`、
`user.authorized: true`。

## 安全护栏（写在代码里，不靠自觉）

1. **凭据库只读**：`credentials.mjs` 实现的是 host 的 credentials 契约，但所有写操作都被拒绝并计数。
   原因很硬——`refresh_token` **一次性**，一次写坏就永久失去该授权。运行结束会比较
   `expiresAt` 并打印 `grant rotated during the run: false`，这一行必须是 `false`。
2. **不碰破坏性动作**：`feishu_auth logout`（销毁唯一凭据）与 `complete`（需一次性 code）永远不自动跑。
3. **产物可回收**：所有对象以 `DSH-TEST-<时间戳>` 命名，结束时倒序删除；消息用**发送方身份**撤回
   （发用 `identity:'app'`，撤也用 `app`，否则飞书答 `Not allowed to recall messages sent by others`）。
4. **不外发**：消息只发给授权用户**本人**的 `open_id`，不发群、不发他人。
5. **不静默跳过**：无法安全执行或没有清理手段的用例标 `skipped` 并在证据列写明原因（如 wiki 节点无删除 API）。

## 判定口径

| 状态 | 含义 | 谁该处理 |
|---|---|---|
| `pass` | 真接口返回且断言成立（含清理） | —— |
| `fail` | 代码或契约缺陷 | 开发者（本轮 0 条） |
| `blocked` | 飞书以权限/能力拒绝，**改代码修不了** | 通常是：应用后台开权限 → 发版 → 重新授权 |
| `skipped` | 刻意不跑（破坏性/缺前置/无清理手段） | 见证据列 |

退出码：`0` 仅在 `fail=0`；有 `blocked` 仍返回 `0`（它们不是代码问题），但会在汇总里显式列出。

## 结果

- `test/live/last-run.json`：机读报告（`counts` / 每条用例的 `evidence` / `cleanup` / `artifacts` / `grantRotated`）。
  已被 `.gitignore` 排除——它是单次运行的证据，随时可再生成。
- `docs/feishu-test-report.md`：人读报告（用例矩阵、阻塞总账、复现命令）。
- `docs/feishu-issue-fix-log.md`：本轮抓到并修掉的问题。

## 文件

| 文件 | 作用 |
|---|---|
| `feishu-live.mjs` | 61 条用例 + 运行器 + 清理 + 报告 |
| `credentials.mjs` | 只读凭据适配器（拒绝一切写，并记录拒绝次数） |
| `last-run.json` | 上一次运行的结果（gitignored） |

## 新增用例的写法

用例是 `cases(t)` 返回的数组，每条形如：

```js
{
  id: 'DOC-09', p: 'P1', area: 'doc', gate: ['DOC-01'],
  desc: '一句话说清验证什么',
  async run() {
    const r = assertOk(await t.call('feishu_doc', { action: '...' }), 'label');
    return '一行证据';           // 抛异常 = fail
  },
}
```

约定：`gate` 写它真正依赖的用例 id；创建的对象 **必须** `C.cleanup.push(...)`；
缺权限导致的拒绝用 `asScopeBlocker(error, t, 'scope:name')` 转成 `blocked`，
而不是让它变成 `fail` 误导后来者。
