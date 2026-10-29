# 手动测试：审批拒绝附言 / PTC 超时原因回传

这个文件给 agent 读：里面写好了**要执行的命令**和**期望的模型侧结果**。命令会删除一个
**会话之前就存在**的临时目录——auto-review 把它判为中风险并拒绝，从而弹出审批卡。

> 为什么必须“会话外创建”：auto-review 只把「本会话创建对象的精确清理」算低风险；
> 删除会话外就存在的对象属于 `irreversible deletion of pre-existing objects`（medium，
> 需要当前人类明确授权），所以 reviewer 会拒绝，审批卡才会出现。

## 0. 前置（在普通 PowerShell 窗口执行，不要用 agent）

```powershell
$dir = Join-Path $env:TEMP 'dsh-approval-manual-test'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -LiteralPath (Join-Path $dir 'keep.txt') -Value 'pre-existing object for the approval test'
Get-ChildItem $dir | Select-Object FullName
```

前置条件：`dsh-reject-message` fork 已安装（本地 link 或 fork git 地址）、`dsh web` 已重启、
页面已刷新；插件行启用。

---

## 测试 A：原生模式的「拒绝 + 预填审查原因」

**会话**：standard 预设（native 工具）的会话，审批策略 Auto（`ask`）。

**在会话里粘贴：**

```text
读取 <仓库>/plugins/dsh-reject-message/manual-tests/approval-and-timeout.md 的「测试 A」，
按里面的命令执行。我会拒绝这次审批，不会放行。
```

**agent 应执行（native pwsh 工具）：**

```powershell
if (Test-Path -LiteralPath (Join-Path $env:TEMP 'dsh-approval-manual-test')) {
  Remove-Item -LiteralPath (Join-Path $env:TEMP 'dsh-approval-manual-test') -Recurse -Force
  'removed'
} else { 'absent' }
```

**期望**：

1. 弹出原生审批卡（Auto review 拒绝，显示 reviewer 原因）。
2. 点「拒绝」→ 同款拒绝窗口；**描述框应已预填 reviewer 原因**（可改/可清）。
3. 直接「确认拒绝」后，模型侧工具结果应出现：

```text
Error: the user rejected tool "pwsh"

The user rejected this privileged request for tool "pwsh" with this description:
<预填的 reviewer 原因>
```

4. 如果描述框是空的（没有预填），说明插件客户端半没有生效：重启 `dsh web` + 刷新页面。

---

## 测试 B：PTC 模式的审批超时（abandoned approval）

**会话**：ptc 预设的会话（PTC 模式下模型只能调用 `run_code`），审批策略 Auto（`ask`）。

**在会话里粘贴：**

```text
读取 <仓库>/plugins/dsh-reject-message/manual-tests/approval-and-timeout.md 的「测试 B」并执行：
用 run_code 且 timeoutMs=15000，里面调用 tools.pwsh 删除那个临时目录。我会拒绝这次审批、不会放行，
请在审批卡上什么都不要点，等 run_code 自己超时。
```

**agent 应执行（PTC `run_code`，注意 `timeoutMs`）：**

```ts
const result = await tools.pwsh({
  command: `if (Test-Path -LiteralPath (Join-Path $env:TEMP 'dsh-approval-manual-test')) { Remove-Item -LiteralPath (Join-Path $env:TEMP 'dsh-approval-manual-test') -Recurse -Force; 'removed' } else { 'absent' }`,
  description: 'Delete the pre-existing approval test directory',
})
return result
```

调用参数：`run_code({ code: <上面代码>, description: '...', timeoutMs: 15000 })`。

**期望**：

1. `run_code` 内的 `tools.pwsh` 被 reviewer 拒绝 → 弹出审批卡。
2. **不要点**审批卡。约 15 秒后 `run_code` 预算耗尽，程序被中止。
3. 模型侧 run_code 结果应出现（顺序可能有差异）：

```text
Error: code run failed (timeout): execution deadline reached (15000ms)

Approval requests abandoned before a decision (cancelled or timed out):
- "pwsh": <reviewer 原因>
```

4. 另外应有一条 `dsh-reject-message` 的 `additionalContext`（user 角色的 notice），内容类似
   `The approval for tool "pwsh" was abandoned before a decision (cancelled or timed out). …`，
   这是 PTC 桥接把内层 notice 转发到外层的结果。
5. 如果只有 `execution deadline reached` 而没有 `Approval requests abandoned…`，说明 Host 半
   还是旧代码（需要重启 `dsh web`）；或者审批原因没被捕获（确认这条 ask 确实来自 auto-review）。

---

## 清理（测试完在普通 PowerShell 窗口执行）

```powershell
Remove-Item -LiteralPath (Join-Path $env:TEMP 'dsh-approval-manual-test') -Recurse -Force -ErrorAction SilentlyContinue
```

若审批卡仍挂着：可以直接点「拒绝」收尾（不会执行删除）；或停止当前回合。

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 命令直接执行了，没弹审批卡 | reviewer 允许了。确认目标目录是**会话外**创建的；确认提示里包含「我会拒绝这次审批」；必要时换一个明确未被授权的目标（例如用户主目录下的测试文件）。 |
| 审批卡还是原生两按钮、拒绝后没有描述框 | 插件客户端半未生效：重启 `dsh web` + 刷新页面。 |
| 描述框没有预填原因 | 审批原因不是 `Auto review denied tool "…": …` 形式（例如沙箱提权），预填只对 auto-review 的 ask 生效。 |
| PTC 测试没超时 | `run_code` 的 `timeoutMs` 没传或超过上限；默认 300000ms。 |
| `Approval requests abandoned…` 里没有工具名 | Host 半是旧构建：`cd plugins/dsh-reject-message && pnpm run check` 后重启 `dsh web`。 |
