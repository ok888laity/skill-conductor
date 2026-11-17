# 通用宿主 / MCP 集成说明

## OpenCode 2.x 本地连接示例

在要接入的项目 `opencode.json` 中配置，替换示例中的绝对路径：

```json
{
  "mcp": {
    "servers": {
      "conductor": {
        "type": "local",
        "command": ["node", "/absolute/path/skill-conductor/bin/skill-conductor.mjs", "mcp", "--config", "/absolute/path/skill-conductor/examples/config.demo.json"],
        "codemode": false,
        "protocol": "legacy"
      }
    }
  }
}
```

V2 的服务器位于 `mcp.servers`。本次在 OpenCode 2.2.7 中实测了此结构，模型实际调用了 `conductor_prepare_skills`，获得 `ask / awaiting_choice` 的结果且未激活或执行技能。其他 MCP 客户端按各自的 stdio 进程配置连接同一 CLI。

## 自适应事件接口

宿主应在每次步骤前调用 `prepareTask`，显式提供任务身份和宿主确认的事件：

```js
const { run, pendingChoice, trigger } = await prepareTask({
  config,
  task,
  taskId: 'stable-task-id',
  sessionId: 'host-session',
  event: 'routine_continuation', // 或 new_task / phase_change / material_family_change / requirements_change / repeated_failure / delivery / manual_request
  phase,
  files,
  activity: {
    needsSkill: false,
    materialFamilies: ['markdown'],
    requirementsKey: 'requirements-v1',
    errorFingerprint: 'same-error-key',
    errorCount: 2,
  },
  selector,
});
```

- `activity` 是宿主显式信号，不是对 agent 全部活动的自动观测。没有 `taskId` 时保留旧的一次性行为。
- `trigger.action` 为 `trigger`/`suppress`/`reuse`/`pending`/`disabled`；每次都带 `reasonCode`、`explanation`、预算和计数。
- `status:"reused"` 只表示复用已激活上下文：`executedForThisEvent:false`、`execution.status:"not_executed"`，不会重新执行脚本。新输入需要宿主自己完成实际工作。
- `status:"suppressed"` 不是 `no_match`；预算耗尽、未达失败阈值、当前 phase 被跳过都会显式解释。
- 相同 pending 指纹重复请求返回同一 `runId`，不要重复向用户展示成新问题。
- 由所有者 CLI 修改 `assistance.enabled`/profile；MCP 不接受设置变更。

## 聊天界面如何呈现选择

`prepare_skills` 返回的 JSON 包含：

- `status: "awaiting_choice"`（有可用推荐时）；若选择器拒选/无匹配则为终态 `status: "no_match"` 且没有 `pendingChoice`，不要把空推荐展示成审批问题
- `candidates[]`：精确 ID、名称、描述、理由、分数/置信度、是否推荐、阻塞项
- `recommendation.selected[]`：推荐 ID、理由、置信度，可能包含必需依赖
- `options`：single / multiple / skip
- `runId`、`planHash`

宿主应把推荐和候选**展示给用户**，例如：

> 找到 2 个相关 skill：`demo:csv-inspector`（推荐）和 `demo:markdown-report`。要使用哪个？可以多选，也可以跳过。若不确定，可先查看理由。

MCP 没有审批工具。用户回答后，由所有者 CLI 执行：

```powershell
node bin\skill-conductor.mjs choose <runId> --config <PATH> --skills ID,ID
# 或
node bin\skill-conductor.mjs choose <runId> --config <PATH> --skip
```

下一次 `activate_run` / `get_run` 会读取持久化决定。受信任宿主 UI 也可以调用 SDK `chooseRun` 并传入自己的所有者身份；模型输出不能调用这条路径。

MCP 进程在每次 `tools/call` 时重新读取 `--config` 指向的受信任配置。所有者用 CLI 关闭 `assistance.enabled` 后，运行中的 MCP 下一次请求就会返回 `disabled`；配置损坏时请求显式失败，不会继续使用启动时的旧信任副本。MCP 没有设置、审批或切换 auto 的工具。

## 自主模式

只有受信任配置 `policy.mode: "auto"` 或 CLI/SDK 显式 auto 才自主。MCP 即使配置为 auto，还要 `mcp.allowExecution` 和 `execution.enabled` 同时为 true 才允许脚本执行；否则只路由/激活。不要通过模型对话切换模式。

## 宿主执行器

没有受信任脚本时，`executor` 回调接收：

```js
{
  runId, task, phase,
  skill: { id, name, body, baseDir },
  context,
  step, artifactDir
}
```

返回 `{ ok: true, output, artifacts }` 只算执行证据，不会自动写 `independentlyVerified`。独立验证必须另外调用 `verifyRun`，并保留实际检查内容。

## 验证边界

- `activated`：正文/资源已加载。
- `executed`：受信任脚本或宿主回调实际运行完成。
- `independentlyVerified`：宿主 verifier 独立核对输出（例如与输入 CSV 重新计算数字）。
- 只有 `verified: true` 才设置独立验证；执行成功、模型自评、MCP 返回都不能替代。

## 安全边界

- 只读显式材料文件；URL 不自动抓取；二进制只给元数据。
- 只运行 sidecar 声明且配置明确信任的 Node 脚本；`shell: false`；超时杀进程树；输出与产物有界。
- 这不是 OS 沙箱，脚本仍以当前用户权限运行。
- 不修改用户全局 skill 或配置。
