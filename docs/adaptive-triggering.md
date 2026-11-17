# 自适应触发（v0.2.0）

v0.2 增加了一个**宿主无关、先便宜后昂贵**的触发门：先根据宿主显式提供的任务/事件/文件名做本地判断，只有判断“值得”时才读取材料、扫描技能目录并调用选择器。它不会为了决定是否路由而额外调用一次模型。

本文描述真实实现与默认值。它不是准确率 benchmark。

## 1. 总开关与审批策略相互独立

```json
{
  "assistance": {
    "enabled": true,
    "profile": "balanced"
  },
  "policy": { "mode": "ask" }
}
```

- `assistance.enabled=false` 是所有者总开关。`prepareTask` 会在**读取材料、扫描目录、调用选择器/执行器之前**短路，返回 `status: "disabled"` 和 `reasonCode: "disabled_total_switch"`，而不是 `no_match`。
- 关闭后，`chooseRun`、`resumeRun`、MCP `activate_run`/`read_resource` 都会拒绝新的激活或执行；已存在的 pending 审批也不能绕过关闭。`get_run`/`runs`/`show` 仍可读历史。
- 关闭不会撤回已经交付给宿主的上下文，也不会回滚已经完成的操作。
- `policy.mode` 的 `ask`/`auto` 仍只决定“谁批准、是否允许受信任脚本执行”。修改触发频率不会自动切换 ask/auto。

旧配置没有 `assistance` 时按 `enabled=true, profile=balanced` 迁移；这是安全的兼容默认值，不表示用户做过额外授权。

## 2. 频率配置

| profile | 新任务自动判断 | 模糊文本 | 阶段/材料族/需求变化 | 失败重试 | 交付复查 | 每任务预算 |
|---|---|---|---|---|---|---|
| `manual` | 否 | 否 | 否 | 否 | 否 | 手动请求不受预算限制 |
| `conservative` | 仅明确专门能力/文件或 `needsSkill` | 否 | 材料族/需求变化；阶段变化默认否 | 阈值 2 | 否 | 4 |
| `balanced`（默认） | 是，含谨慎歧义回退 | 是 | 是 | 阈值 2 | 否 | 12 |
| `proactive` | 是 | 是 | 是 | 阈值 2 | 默认是（可关） | 24 |
| `custom` | 由 `assistance.triggers` 决定 | 由配置决定 | 由配置决定 | 可配阈值 | 可配 | 可配 |

`init` 只写入 `enabled` 和 `profile`，不会把 balanced 的默认 triggers/budget 固化成“所有者覆盖”，因此之后切换 profile 会真正应用该 preset。只有用户在 `custom`/高级设置中显式写入的值才作为覆盖保留。显式 triggers 会覆盖 profile 默认值，例如：

```json
{
  "assistance": {
    "profile": "balanced",
    "triggers": { "failureThreshold": 3 }
  }
}
```

所有者 CLI（唯一支持的配置写入方式）：

```powershell
node bin\skill-conductor.mjs settings show --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.enabled false --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.profile conservative --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.triggers.failureThreshold 2 --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.budget.maxAutomaticChecksPerTask 8 --config .skill-conductor\config.json
```

`settings set` 只接受已知键；先完整校验候选配置，再原子写入，失败不会部分覆盖。其他用户配置键和 `policy.mode` 保持不变。MCP 没有设置、审批或切换 auto 的工具。

## 3. 事件接口

SDK：

```js
const { run, pendingChoice, trigger } = await prepareTask({
  config,
  task: '继续整理材料并生成摘要',
  taskId: 'task-2026-001',        // 显式任务身份；用于隔离状态
  sessionId: 'host-session-7',    // 可选宿主会话
  event: 'routine_continuation',  // 见下表
  phase: 'summarize',
  files: ['./notes.md'],
  activity: {
    needsSkill: false,
    materialFamilies: ['markdown'],
    requirementsKey: 'summary-v1',
    // errorFingerprint: 'build-tsc-2345',
    // errorCount: 2,
    // manualRequest: false,
  },
  selector,
});
```

支持的 `event`：

| event | 含义 |
|---|---|
| `new_task` | 新的显式任务；重置该 taskId 的预算、跳过、no-match 与失败状态 |
| `routine_continuation` | 同阶段常规步骤 |
| `phase_change` | 宿主确认的实质阶段/能力变化 |
| `material_family_change` | 新的材料族，例如 CSV -> Markdown/PDF |
| `requirements_change` | 需求实质变化，配合 `activity.requirementsKey` |
| `repeated_failure` | 同一失败的重复信号，配合 `errorFingerprint` |
| `delivery` | 交付前复查；默认关闭 |
| `manual_request` | 用户明确请求重新检查；绕过频率/预算，但不绕过总开关、信任和审批 |

`activity` 是**宿主信号**，不是对全部 agent 行为的观测。没有提供 `taskId` 时保留 v0.1 的一次性行为（总开关和 manual profile 除外）；这是兼容边界。没有显式 phase 时，不会把普通措辞变化、文件 mtime 或任意 observation 猜成阶段变化。

## 4. 判定与抑制原因（结构化）

每次调用返回 `trigger`：

```json
{
  "schema": "skill-conductor/trigger/v0.1",
  "action": "trigger",
  "event": "new_task",
  "reasonCode": "new_task_specialized",
  "explanation": "A new task explicitly needs file processing or a specialized capability.",
  "profile": "balanced",
  "automatic": true,
  "counters": { "gateChecks": 1, "selectorCalls": 1, "cacheReuse": 0, "ownerPrompts": 1, "executions": 0 },
  "budget": { "used": 1, "limit": 12, "exhausted": false }
}
```

主要 `reasonCode`：

- 触发：`new_task_specialized`、`new_task_needs_skill`、`new_task_ambiguous_cautious`、`phase_changed`、`material_family_changed`、`requirements_changed`、`repeated_failure_threshold_reached`、`delivery_recheck`、`manual_request`、缓存失效类 `cache_invalidated_*`。
- 抑制：`new_task_smalltalk_skip`、`new_task_simple_skip`、`phase_change_disabled`、`delivery_recheck_disabled`、`repeated_failure_threshold`、`repeated_failure_deduped`、`no_match_suppressed`、`owner_skipped_phase`、`budget_exhausted`、`manual_profile_passive`。
- 复用/其他：`routine_reuse`、`pending_unchanged`、`pending_completed_reuse`、`disabled_total_switch`。

“抑制”不是 `no_match`。预算耗尽、未达失败阈值、用户已跳过等都不会伪造“没有可用技能”。

## 5. 去重、缓存与执行边界

- 状态按 **workspace + 显式 `sessionId` + `taskId`** 隔离；同一 `taskId` 的新 session 不能继承审批、pending、no-match、跳过、上下文或预算，也不会把“同一任务”当成隐式批准。文件名使用 SHA-256 task key，identifier 有长度和字符校验；会话数量、失败指纹和已执行 run 列表都有上限。
- 相同任务、阶段和输入指纹的 pending 请求直接返回同一 `runId`，不新建 run、不重复提示、不再次调用选择器。`ownerPrompts` 只统计首次产生的 pending。
- 同阶段 routine continuation 若有已激活决策，返回 `status: "reused"`、`sourceRunId`、`reused: true`、现有 `context`，且 `executedForThisEvent: false`、`execution.status: "not_executed"`。**没有重新执行脚本**。
- 同格式新输入可以复用技能选择，但不会把旧计算结果当作新结果；宿主必须对当前输入做实际工作。需要强制重新检查时发送 `event: "manual_request"`。
- 复用前会验证配置/信任指纹、目录签名、已选 SKILL.md/sidecar/脚本 hash。技能、脚本、信任或目录变化会让缓存失效并重新判断；真正激活时原有 stale decision/hash/信任检查仍然执行。
- 用户跳过只抑制**当前 phase**；新材料族、需求变化、新阶段或显式手动请求可以重新检查。

## 6. 预算、失败与交付默认值

- 每任务自动昂贵检查预算默认 12（`proactive` 24，`conservative` 4）。`0` 表示不限制。只有真正进入发现/选择才消耗；pending 去重和缓存复用不消耗。手动请求不消耗且可越过耗尽状态。
- 重复失败默认阈值 2，可在 1–20 调整。同一 `errorFingerprint` 触发一次后，在材料/需求/阶段发生实质变化前不再重复触发。
- 交付复查默认关闭（balanced/conservative/manual）。`proactive` 默认开启。`deliveryRecheck` 是主要配置键；`delivery` 保留为兼容别名。
- 计数是轻量事实（gate checks、actual selector calls、cache reuse、owner prompts、executions），没有延迟或准确率声明。

## 7. 兼容性与限制

- 旧的一次性 `prepareTask` 消费者不传 `taskId` 时仍按旧行为工作；因此不会自动获得去重和预算，只受总开关/manual profile 影响。
- 触发门只做确定性词法/文件名启发式，**不是语义模型**，也不声称置信度已校准。中文和英文都走同样的谨慎回退；不依赖英文词边界。
- 省略 `taskId` 时无法可靠区分“同一任务”和“新任务”，不会假装有持久任务状态。
- MCP 会在每次 `tools/call` 时重新读取受信任配置，所以所有者 CLI 关闭 assistance 后，运行中的 MCP 进程下一次请求即生效；配置损坏时请求失败而不是回退到旧配置。`prepare_skills` 先校验 `additionalProperties:false`：顶层的 `mode`、`assistance` 等设置字段会返回显式 `isError`，不会伪装成成功的 `disabled` 结果，也不参与 OFF 短路。
- MCP 只携带任务事件数据；不能修改设置、审批或切换 auto。
- 本功能不实现跨任务审批复用；每次 ask 决策仍只覆盖当前 run。用户没有确认过“问题 2/3”的更宽重新确认或错误时机策略，因此这里只提供上述可配置默认值。
