# Skill Conductor

一个**宿主无关**的 SKILL.md 发现、推荐、人工选择、激活与可选受信任执行组件。核心是 Node.js ESM SDK 与 CLI；MCP stdio 是适配层，OpenCode 只是一个可选的语义选择器适配器，不是运行前提。

当前 v0.1.1 默认采用 **ask（人工选择）**，显式开启 **auto** 后自主选择和调用，并保留推荐理由、执行状态和独立校验记录。

English quickstart: [`README.en.md`](README.en.md). 开发期真实 OpenCode 集成结果（非 benchmark）见 [`docs/live-integration.md`](docs/live-integration.md)。

普通用户安装与 **4 个领域、40 个真实 skill、64 个任务**的推荐测试、4 例真实执行及已知失败，见 [`docs/onboarding-test-report.md`](docs/onboarding-test-report.md)。

可选的真实技能测试复现步骤见 [`docs/reproduce-live-tests.md`](docs/reproduce-live-tests.md)，本次临时技能清理与原环境哈希复核摘要见 [`docs/environment-restoration.json`](docs/environment-restoration.json)。

## 为什么默认 ask

用户的需求是：发现可用 skill 时先让用户知道，多个候选时给出推荐和理由，并允许用户选择单个、多个或跳过；也可以显式允许完全自主。

因此：

- `policy.mode` 默认 `ask`。
- 在 `ask` 模式下，`route` / `run` 只做发现、排序、推荐并持久化 `awaiting_choice`，**不加载正文、不执行脚本、不调用宿主执行器**。若选择器明确拒选/没有可用技能，状态为终态 `no_match`（保留候选与 abstainReason），**不会制造一个空的审批问题**。
- 选择必须由真正的所有者动作完成：CLI `choose`、TTY 交互菜单，或受信任的 SDK 宿主回调。
- MCP **不暴露审批或改模式工具**。模型给的是推荐，不能自我批准。
- `--mode auto` 或受信任配置 `policy.mode: "auto"` 是一次显式自主授权；空输入、超时、模型输出都不会被当成批准。

状态分开记录，避免把“选了”当成“执行了”或“验证成功”：

```
routed -> awaiting_choice -> decided -> activated -> executed
                                                  |-> partial (some steps handed off/blocked)
                                                  \-> independentlyVerified
```

若某个步骤的依赖没有实际执行（失败、超时、仅 handoff 或被阻塞），依赖步骤会记录为 `blocked`，即使 `stopOnError: false` 也不会继续执行它；互不相关的分支仍可继续。实际执行与待宿主 handoff 混合时，总体状态是 `partial`，不会被包装成 `completed` / `executed`。

## 安装与首次运行

需要 Node.js >= 20.11（已在 Node 24.22.3 / npm 11.19.1 上验证）。**npm registry 上的裸包名 `skill-conductor` 目前不可用（E404）**；请使用公开 GitHub 仓库的 HTTPS tarball，不要依赖 `npm install skill-conductor`。

一次性运行（无需全局安装，产物写在当前目录）：

```powershell
npx --yes --package=https://github.com/ok888laity/skill-conductor/archive/refs/heads/main.tar.gz skill-conductor demo
```

全局安装后初始化并运行：

```powershell
npm install --global https://github.com/ok888laity/skill-conductor/archive/refs/heads/main.tar.gz
skill-conductor init --demo
skill-conductor demo
```

`init` 默认在**当前目录**创建 `.skill-conductor/config.json` 和空的 `./skills` 根，`policy` 保持 `ask`，且 `execution.enabled=false`（不信任任何脚本）。`init --root PATH` 使用已有技能根；已有配置或文件**不会被覆盖**。`init --demo` 把仓库自带的四个第一方演示技能与合成 CSV 复制到 `.skill-conductor/demo/`，只信任 `demo:csv-inspector` 与 `demo:markdown-report` 两个脚本，仍然保持 `ask`；`demo` 命令本身才是显式 auto。

安装后的命令会从当前目录向上查找 `.skill-conductor/config.json`，再查找 `skill-conductor.config.json`；显式 `--config PATH` 始终优先。未初始化时 `demo` 仍可直接运行，但所有运行记录与产物写当前目录的 `.skill-conductor/runs/`，不会写安装包目录。显式 `--config` 则保留该配置里的 `execution.runDir`。

`demo` 是**显式 auto** 的集成示例：它读取 `销售 数据.csv`（文件名含中文和空格），按依赖顺序运行两个受信任脚本，写出 `runs/artifacts/<runid>/csv-summary.json` 与 `report.md`，再由宿主 verifier 独立核对：

- CSV 行数：6
- 数量合计：40
- 金额合计：6260

这些数字来自本地实际运行，不是模型宣称。

## 快速开始（Windows 源码树）

仓库自带 PowerShell/CMD 启动器 `skill-conductor.cmd`：

```powershell
# 如果 node 不在 PATH，可显式指定（本机开发运行时示例）
$env:SKILL_CONDUCTOR_NODE = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

.\skill-conductor.cmd init --demo
.\skill-conductor.cmd demo
```

不使用 `.cmd` 时直接运行：

```powershell
node bin\skill-conductor.mjs init --demo
node bin\skill-conductor.mjs demo
```

## CLI

```text
skill-conductor.cmd help
skill-conductor.cmd init [--root PATH | --demo]
skill-conductor.cmd list [--config PATH]
skill-conductor.cmd route TASK [--config PATH] [--material FILE ...] [--phase X]
skill-conductor.cmd run TASK [--config PATH] [--material FILE ...] [--phase X]
skill-conductor.cmd choose RUN_ID [--config PATH] (--skills ID,ID | --skip) [--activate-only]
skill-conductor.cmd show RUN_ID [--config PATH]
skill-conductor.cmd runs [--config PATH]
skill-conductor.cmd interactive [--config PATH]
skill-conductor.cmd mcp [--config PATH]
skill-conductor.cmd demo [--config PATH]
```

- `init`：安全脚手架。默认只创建本地配置与技能根，不覆盖已有文件，也不启用执行；`--demo` 仅复制并信任仓库自带演示技能；`--root` 使用已有技能根。
- `route`：只路由/激活上下文；在 ask 下返回 pending；不会执行脚本。
- `run`：ask 下同样先返回 pending；所有者 `choose` 后才按持久化意图执行。
- `choose`：新进程读取持久化 run，校验 pending 状态、plan token、技能/脚本/配置 hash；`--skip` 记录跳过；`--activate-only` 只激活。
- `interactive`：简体中文 TTY 菜单，显示推荐、理由、候选编号与阻塞项；可输入 `a` 接受推荐、`1` 或 `1,3` 选编号、`s` 跳过、`q` 退出。新建任务时会明确询问 `ask`（默认，先确认）或 `auto`（本次自主），也可用 `--mode auto` 预先指定；恢复已有 pending 时保留其原模式和意图。**空输入会重新询问，绝不等于批准。** 非 TTY 会报错，脚本请用 `route` + `choose`。
- 机器输出为 stdout 上的 JSON；提示和错误走 stderr。交互菜单的提示也走 stderr，因此最后结果仍是可解析 JSON。

`--mode auto` 只对当前命令显式生效；默认配置文件仍可保持 ask。

## SDK

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, prepareTask, chooseRun, verifyRun } from './src/index.mjs';

const config = await loadConfig('examples/config.demo.json');

// 1) 路由并持久化 pending；ask 下不会加载正文或执行
const { run, pendingChoice } = await prepareTask({
  config,
  task: '分析这份 CSV 并生成报告',
  files: ['data/销售 数据.csv'],
  phase: 'reporting',
});

// 2) 把 pendingChoice.candidates / recommendation 展示给用户
// 3) 用户真正选择后，由受信任宿主代码记录决定并恢复
const executed = await chooseRun({
  config,
  runId: run.runId,
  skills: ['demo:csv-inspector', 'demo:markdown-report'],
  decisionToken: run.planHash, // 防止陈旧 UI 决定
});

// 4) 独立验证必须是真正的复核，而不是“执行成功就 verified: true”。
// 这里重新读取输入 CSV，独立计算行数，再与脚本产出的摘要对照。
let verification = null;
if (executed.states.executed) {
  const summary = JSON.parse(
    await fs.readFile(path.join(executed.execution.artifactDir, 'csv-summary.json'), 'utf8'),
  );
  const csv = await fs.readFile('data/销售 数据.csv', 'utf8');
  const expectedRows = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).length - 1;
  verification = await verifyRun({
    config,
    runId: executed.runId,
    verified: summary.rowCount === expectedRows,
    details: {
      check: 'independently recomputed CSV row count',
      reportedRows: summary.rowCount,
      expectedRows,
    },
  });
}
```

- 自定义 selector：`prepareTask({ selector: async ({ task, phase, materials, candidates }) => ({ selected: [...] }) })`。返回值仍经过严格校验：只能使用候选集中真实存在的 ID，置信度、步骤和数量都有界；模型给出的路径、命令、正文不会被采纳。
- 宿主执行器：`prepareTask` / `chooseRun` / `resumeRun` 可传 `executor`。没有受信任脚本时，激活正文和资源交给宿主；`handoff` 不等于执行成功。
- 每一步重新路由：见 `examples/sdk-before-each-step.mjs`。新的 `phase` / `observations` 会生成新的 run；会话自己的选择由调用方保存，不会因为重路由被静默改写。
- 自定义 selector + 宿主执行器：见 `examples/custom-selector-host-executor.mjs`。

## 选择器模式

配置 `selector.mode`：

| 模式 | 说明 | 是否语义 |
| --- | --- | --- |
| `lexical` | 默认离线 BM25 风格元数据匹配，支持中文 bigram、正/负 trigger。 | **否，明确标记 lexical** |
| `http` | OpenAI chat-completions 兼容端点，`baseURL` + `model` + key 环境变量；响应流上限 4 MiB，已知 key 在成功内容和错误体里脱敏。 | 取决于端点；本仓库不宣称准确率 |
| `opencode` | 可选 OpenCode CLI 适配器。长 prompt 通过临时 `--file` 附件传递，短消息触发；尊重 `standalone` / `archived`。 | 取决于所选模型 |
| SDK callback | 宿主注入 `selector` 函数，核心不依赖 OpenCode。 | 取决于宿主 |

小目录（默认 <= 40）会把**全部**候选元数据交给语义选择器，即使词法分数为 0，避免中文查询被英文词法预筛隐藏。大目录先用有界词法预筛，再交给语义选择器。

可直接参考三份配置：`examples/config.demo.json` 是无需模型的本地演示；`examples/config.http.example.json` 可接本地或托管的兼容 HTTP 模型（填写 `model`、`baseURL`，按需设置密钥环境变量）；`examples/config.opencode.example.json` 是可选 OpenCode 适配器，使用前设置 `SKILL_CONDUCTOR_OPENCODE_CLI`。核心 SDK 的 `selector` 回调可以直接使用你自己的 agent/model。

控制器曾用精确的 `opencode-go/deepseek-v4.1-flash`（low variant）做一次真实集成探测：48 个本机已有 skill 全部进入候选，中文“Excel/公式/图表”改写命中了现有 spreadsheets skill，并停留在 `awaiting_choice`。这是一次集成示例，不是准确率或 benchmark 证据。开发者未在本会话重复运行实时模型。

## 发现与材料

- 递归扫描配置 roots 下的 `SKILL.md`；兼容现有格式。支持 `conductor.json` sidecar：`triggers`、`avoidTriggers`、`tags`、`requiredCapabilities`、`dependencies`、`conflicts`、`resources`、`executable`、`whenToUse`。
- 支持 YAML frontmatter 子集：普通/引号标量、`|`/`>` 块文本、列表、注释、BOM、CRLF，以及常见的可选 `metadata` 映射。超出支持范围的结构会给出警告或错误，保留可核实的字段。
- 稳定 ID 基于 namespace + 相对路径；重名会标记 ambiguity 并要求精确 ID。符号链接有 visited 防护；解析到 root 外的真实路径不会继承 root 信任。
- `SKILL.md` / `conductor.json` / 入口脚本内容都纳入 hash；决定和恢复时会重新校验，防止“等待选择期间文件被改”。
- 材料仅限显式文件：`.txt`、`.md`、`.markdown`、`.json`、`.jsonl`、`.csv`、`.tsv`、`.html`、`.htm`；有单文件/总量/数量/截断限制，带 SHA-256 与来源。URL 不自动抓取；不支持的二进制只给元数据，不伪造提取内容。材料内容是 **DATA**，不能变成指令或授权。

## 受信任执行

只有同时满足以下条件才运行脚本：

1. `execution.enabled` 为 true；
2. 技能 ID 在 `execution.trustedSkillIds`；
3. 若有 `execution.allowlist`，技能 ID 也在其中；
4. sidecar 声明 `executable.runtime: "node"` 和相对入口；
5. 入口经 realpath 校验仍在 skill 目录内（防路径穿越/junction 逃逸）。

执行使用 `spawn(process.execPath, [script], { shell: false })`，不解析 markdown 或模型返回的 shell。stdin 只传结构化 JSON；stdout/stderr 有字节上限；超时会终止**实际进程树**并记录 `timeout`；非零退出记录 `failed`。产物在 run 目录内清点大小与 hash。

这**不是**操作系统沙箱。受信任脚本仍以当前用户权限运行。没有可执行入口的 skill 只交给宿主执行器，状态是 `activated` / `handoff`，不是成功。

## 持久决定与原子性

`runs\<runId>.json` 保存候选、推荐、材料引用、hash、模式、意图、状态与产物；`runs\<runId>.events.jsonl` 记录事件。

- 写入使用同目录临时文件 + rename。
- 跨进程文件锁防止并发写；`resumeClaim` 确保同一决定不会被两个进程执行两次。
- pending 计划有 `planHash`；决定时可传 `decisionToken`，拒绝陈旧 UI。
- 决定时重新校验技能正文、sidecar 和执行脚本 hash；配置指纹包含 roots、能力、执行开关、trusted ID、allowlist、超时/输出策略、MCP 执行许可等，prepare 后改动会要求重新 prepare。
- 未知/伪造 ID、重复决定、跳过与执行的冲突都会被显式拒绝。
- 只写配置的 run 目录，不修改用户全局配置、既有 skill 或其他会话。

## MCP stdio

```powershell
node bin\skill-conductor.mjs mcp --config examples\config.demo.json
```

最小 JSON-RPC 2.0 换行分隔协议：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`。stdout 只输出协议消息。

工具：

- `list_skills`
- `prepare_skills`（不接收 mode；mode 只来自受信任配置）
- `get_run`
- `activate_run`（已批准才加载；否则原样返回 awaiting_choice）
- `read_resource`（仅激活 run 中声明的资源）

没有 `approve` / `decide` / `set_mode` 工具。审批来自所有者 CLI 或受信任宿主 UI/回调，下一次 MCP 调用读取状态。`prepare_skills` 的自主执行还要求 `mcp.allowExecution` 与 `execution.enabled` 同时为 true；否则即使配置是 auto，也只路由/激活。通用聊天集成应把 pending 候选和理由展示给用户，例如读取 result 中的 `candidates` 与 `recommendation` 并生成问题。

这是有文档边界的最小适配器，不是完整 MCP SDK 或安全边界声明。

## 测试与离线 eval

实际可运行命令（Node v24.22.1 已验证）：

```powershell
node --test tests\foundation.test.mjs tests\runtime.test.mjs tests\mcp-cli.test.mjs tests\process-cleanup.test.mjs tests\http-selector.test.mjs
node evals\run-eval.mjs
```

`package.json` 的 `test` 脚本使用同一组显式文件；如果环境里有 npm，也可以运行 `npm test`。本机 Windows / Node 24.22.1 已验证 30 项项目测试全部通过。GitHub Actions 配置了 Windows/Linux 与 Node 20/22/24；云端矩阵的实际结果以仓库运行记录为准。

`evals\run-eval.mjs` 是 **synthetic-lexical-fixtures** 的离线开发检查，覆盖中英文、无匹配与 avoid trigger，只验证词法排序，不代表语义准确率或实时模型质量。

## 已知限制

- 不安装、不下载、不自动执行第三方 skill。
- 语义选择质量取决于宿主/模型；本仓库不提供准确率 benchmark。
- `http` / `opencode` 适配器的错误与格式处理有界且显式，但实时模型行为仍需集成方验证。
- 没有自动学习、反馈改写 skill、Web UI 或完整 MCP SDK。
- 执行不是沙箱；脚本必须由所有者显式信任。
- 不负责跨机器同步、发布或全局配置迁移。

## License 与来源

MIT。设计借鉴与边界见 [ATTRIBUTION.md](ATTRIBUTION.md)，完整来源审查见 `research/upstream-review.json`。本实现是工程组合，不声称学术独创，也不把测试通过包装成生产准确率。
