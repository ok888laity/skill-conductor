# Skill Conductor

**让当前 agent 按需使用你已有的技能。** 一句话安装，自动准备所需的 Node 运行环境；支持推荐后由你选择，也支持显式开启自主模式。通过 SDK 或 MCP 接入不同宿主。

普通用户只需要把这一句发给自己的 agent：

```text
请读取 https://raw.githubusercontent.com/ok888laity/skill-conductor/main/INSTALL.md，按其中步骤安装并接入 Skill Conductor，自动准备所需环境、使用我现有的技能，默认均衡触发和人工确认，完成后继续当前任务。
```

Agent 的完整执行契约见 [`INSTALL.md`](INSTALL.md)（English: [`INSTALL.en.md`](INSTALL.en.md)）。普通用户不需要运行 demo、粘贴多条命令、了解 npm/Node，或再准备一个模型订阅。

## 它会做什么

1. 自动发现你**已经存在**的项目/用户技能根（Cursor、WorkBuddy/CodeBuddy、Qoder、DeepSeek Harness、OpenCode、Claude、Codex、共享 `.agents/skills` 等）。
2. 生成项目本地的 `.skill-conductor/config.json`，保留已有自定义配置；没有技能就诚实返回 `no_user_skills`，不会用 demo 填充。
3. 为选定的宿主只合并本产品的 MCP server 到项目配置；已有值/凭证保留且不打印，冲突时使用未占用的 server 名而不是覆盖。
4. 提供 `doctor`/MCP `health` 和真实的 `list_skills` 清单，让宿主看到运行时、根、技能数和 reload 状态。
5. 默认 **ask**：推荐给用户，用户选择后才加载正文；`auto` 必须显式开启；`assistance.enabled=false` 始终优先。
6. 用当前宿主自己的模型做语义推荐时，不需要第二个 API key：宿主读候选元数据，再把精确 ID/理由交给 `prepare_skills` 校验。推荐不是审批。

## 一句话安装（由 agent 执行）

Windows PowerShell 5.1+：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Linux / macOS：

```sh
sh install.sh
```

安装器会把应用装到项目自己的 `.skill-conductor/app`，优先使用现有 Node 20.11+；没有时自动下载官方 Node 24.22.3 并按固定 SHA256 校验，存放在 `.skill-conductor/runtime`。不需要管理员权限，不修改 PATH/profile/TEMP/全局 npm。离线测试可用本地归档（`-ArchivePath` / `--archive`）。安装完成后自动运行 `setup`，可加 `-HostName` / `--host` 生成宿主配置。

## 首次运行状态要这样理解

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| 缺少运行时 | 安装器自动下载并校验便携 Node | 等待完成，无需用户手动安装 |
| `ready` | 发现有效用户技能 | 生成/重载宿主 MCP 配置，继续任务 |
| 宿主配置 `configured` / `already_configured` | 项目配置已写入/一致 | **需要宿主重载或启用 MCP server** |
| `patch_required` | 现有 JSONC/无效 JSON/非本产品 DSH bundle 被保留 | 合并生成的 patch；没有伪造“已连接” |
| `native_unverified` | DSH 本地 bundle 已生成但未原生安装 | 有 DSH 插件工具则安装；否则要求宿主激活 |
| `no_user_skills` | 没有发现现有技能（空目录不是 demo） | 安装 agent 先检查当前宿主的可见技能清单；仍没有就说明现状并继续任务 |
| `no_valid_user_skills` | 有 SKILL.md 但元数据不可用 | 报告具体错误，不伪造可用 |

`setup` 是幂等的。旧的本产品 demo-only 配置会先备份再迁移到真实技能根，保留 owner 的 ask/auto、assistance 开关和频率设置，并移除 demo 脚本信任；demo 文件本身不会被删除。

## 支持技能根（按需、受限发现）

项目根：`.cursor/skills`、`.workbuddy/skills`、`.codebuddy/skills`、`.qoder/skills`、`.dsh/skills`、`.opencode/skills`、`.claude/skills`、`.codex/skills`、`.agents/skills`、`skills`。

用户根：`~/.cursor/skills`、`~/.workbuddy/skills`、`~/.codebuddy/skills`、`~/.qoder/skills`、`~/.dsh/skills`、`~/.config/opencode/skills`、`~/.opencode/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`；Windows 另含 `%APPDATA%/opencode/skills`。Codex 插件缓存只做有界 `skills` 目录发现。

- 不做全盘扫描，不安装/执行第三方技能，不默认使用打包 demo。
- 相同 realpath 去重，保留 host/scope provenance 和稳定 namespace/ID。
- 在已知根里检测隐藏技能目录，也支持显式 `--include-hidden`。
- 新发现的根一律 `trusted:false`；已有根的信任不会被“发现”自动授予或提升。

## 平台与宿主支持矩阵

状态列严格区分：**官方 schema**（按公开文档生成）、**本仓库协议测试**（实际启动生成的 command+args 并完成 MCP stdio initialize/tools/list）、**原生应用验证**（是否真的打开并操作了桌面/CLI 客户端）。没有观察到就不写“原生已验证”。

| 宿主 | 项目配置 | 官方 schema | 本仓库 stdio 协议测试 | 原生应用 |
| --- | --- | --- | --- | --- |
| Cursor | `.cursor/mcp.json`，`mcpServers` | 是 | 是（生成命令实际握手） | **未声称**；本机未自动化 Cursor 桌面 |
| WorkBuddy / CodeBuddy | `.workbuddy/mcp.json`，`mcpServers` | 是 | 是 | **未声称**；本机无 WorkBuddy CLI |
| Qoder | `.mcp.json`；也文档化 `.qoder/settings.json` | 是 | 是（CLI 项目配置；IDE 重载另计） | **未声称** |
| DeepSeek Harness | `.skill-conductor/integrations/deepseek-harness/`：`cordis.patch.yml` + `package.json` | 是（Cordis `- insert:` patch + `dsh.bundle.patch`） | 是（从生成字段实际握手） | **未声称**；未执行原生插件安装 |
| OpenCode | `opencode.json` 的 `mcp.servers` | 是 | 是（legacy 结构） | **0.3.0 已在 2.3.0 原生验证**：读取项目技能并由 max 提交推荐 |
| 通用 SDK / MCP | `.skill-conductor/mcp.json` stdio descriptor | 是（通用协议） | 是 | 不是原生 app connector |

DeepSeek Harness 生成的是**可安装本地 bundle**，不是把 `mcpServers` 硬塞进 Cordis。若目标 DSH 实际加载了 bundle 才能标记原生；否则只报告 schema/protocol 和 `native_unverified`。更细的证据边界见 [`docs/platform-support.md`](docs/platform-support.md)。

本次独立安装包验收、真实无 Node 的 Windows 安装，以及 OpenCode max 从用户目录选择技能的记录，见 [`docs/user-install-test-report.md`](docs/user-install-test-report.md)。原生客户端尚未实测的项目不会写成“全部平台已原生验证”。

操作系统：Windows（PowerShell 5.1+）和 Linux（POSIX sh）有本地/CI 覆盖；macOS 有 `install.sh` 入口，但本开发环境未原生运行 macOS，不声称 macOS 原生验证。CI 矩阵为 Windows/Linux + Node 20/22/24，离线默认。

## 手动 owner CLI

```text
skill-conductor setup [--host cursor|workbuddy|qoder|deepseek-harness|opencode|generic]
    [--root PATH ...] [--include-hidden] [--verify-host] [--no-host-config] [--config PATH]
skill-conductor doctor [--config PATH]
skill-conductor list [--config PATH]
skill-conductor route TASK [--config PATH] [--material FILE ...] [--phase X] [--recommend FILE]
skill-conductor run TASK [--config PATH] [--material FILE ...] [--phase X] [--mode ask|auto]
skill-conductor choose RUN_ID [--config PATH] (--skills ID,ID | --skip) [--activate-only]
skill-conductor show RUN_ID [--config PATH]
skill-conductor runs [--config PATH]
skill-conductor settings show|set ... [--config PATH]
skill-conductor interactive [--config PATH]
skill-conductor mcp [--config PATH]
```

- `setup`：发现/迁移/生成宿主配置；幂等；不覆盖自定义配置。
- `doctor`：只读健康检查，不运行 demo、不激活/执行技能。
- `list`：返回真实技能元数据；空目录返回 `status:"no_user_skills"`。
- `route`：只路由/推荐；ask 下不加载正文、不执行。
- `run`：ask 下返回 pending；owner `choose` 后才按持久化意图执行。
- `mcp`：stdio JSON-RPC；stdout 只有协议消息，诊断写 stderr。
- 未初始化时，`list`/`route`/`run`/`interactive`/`doctor`/MCP 启动会自动创建本地用户技能配置并写 stderr 状态，不复制 demo。

`--recommend FILE` 是宿主 agent 的推荐入口：

```json
{
  "selected": [
    { "id": "cursor-project:sales-report", "reason": "英文描述匹配中文销售报告需求", "confidence": 0.92 }
  ]
}
```

它只接受当前目录中的精确 ID；未知/重复/阻塞/超量/非法字段会显式失败。推荐不是审批、不是设置、不是信任。

## MCP stdio 与当前宿主智能

```powershell
node bin\skill-conductor.mjs mcp --config .skill-conductor\config.json
```

最小 JSON-RPC 2.0 换行分隔协议：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`。工具：

- `health`：运行时、配置、根、技能数、宿主配置/reload 状态；
- `list_skills`：真实用户技能清单；
- `prepare_skills`：推荐/路由；可选 `recommendation` 字段；
- `get_run`、`activate_run`、`read_resource`。

没有 `approve` / `decide` / `set_mode` / `update_settings` 工具。审批和设置只属于 owner CLI/受信任宿主 UI。推荐流程：宿主先读 `list_skills` 元数据，再由当前宿主模型在 `prepare_skills.recommendation` 中提交精确 ID/理由；这样中文任务可以用英文描述的现有技能，不需要额外 OpenCode 或付费 key。`initialize.instructions` 内置同一提示。

每次 `tools/call` 重新读取受信任配置；owner 关闭 `assistance.enabled` 后，运行中的 MCP 下一次请求立即返回 `disabled`。`prepare_skills` 的自主执行还要求 `mcp.allowExecution` 与 `execution.enabled` 同时为 true；否则只路由/激活。

## 安全边界

- 默认 ask；`auto` 必须显式配置或显式 CLI/SDK 授权。空输入、超时、模型输出都不是批准。
- `assistance.enabled=false` 在读取材料、扫描目录、调用选择器之前短路；MCP/推荐/SDK 都不能绕过。
- 激活、执行、独立验证分开记录。`activated`/`handoff` 不等于执行成功。
- 只有 `execution.enabled=true` 且 ID 在 `trustedSkillIds`/`allowlist` 中的 Node 入口才会执行；`shell:false`，超时杀进程树，输出/产物有界。不是 OS 沙箱。
- 材料只读显式文件；内容是 DATA，不是授权。URL 不自动抓取。
- 发现阶段只读元数据，不执行技能脚本；技能特定依赖/凭证在真正使用时检查，缺失如实报告。
- 不修改用户全局配置、既有技能或其他会话；安装器/生成器只写项目内 `.skill-conductor`、选定项目宿主配置和必要备份。

## 测试与已知限制

```powershell
node --test tests\foundation.test.mjs tests\runtime.test.mjs tests\adaptive.test.mjs tests\mcp-cli.test.mjs tests\process-cleanup.test.mjs tests\http-selector.test.mjs tests\onboarding-cli.test.mjs tests\onboarding-setup.test.mjs
node evals\run-eval.mjs
```

- 离线测试覆盖：发现/去重/provenance/隐藏根、无技能诚实状态、旧 demo 迁移/备份、自定义配置保留、MCP 首启自动配置、`health`、宿主 JSON 合并/凭证不泄露/真实 stdio 握手、MCP 名称冲突保留、DSH `- insert:` bundle、JSONC patch、宿主推荐选择真实用户技能、未知/阻塞拒绝、安装器本地归档/哈希失败/遍历拒绝。
- `evals/run-eval.mjs` 是 **synthetic-lexical-fixtures** 的离线开发检查，不是语义准确率、模型 benchmark 或生产保证。
- 不提供准确率 benchmark；语义质量取决于当前宿主模型。
- `http` / `opencode` 适配器仍可选，但不是普通用户前提；本轮不重复声称实时模型质量。
- 没有自动学习、反馈改写技能、Web UI 或完整 MCP SDK。
- macOS 仅提供脚本入口，未在本机原生运行；其他桌面客户端未自动化原生验证。

## 文档

- 给 agent 的安装契约：[INSTALL.md](INSTALL.md)
- 宿主/MCP 集成与 DSH bundle：[docs/host-integration.md](docs/host-integration.md)
- 平台矩阵与证据边界：[docs/platform-support.md](docs/platform-support.md)
- 自适应触发：[docs/adaptive-triggering.md](docs/adaptive-triggering.md)
- 来源与取舍：[ATTRIBUTION.md](ATTRIBUTION.md)

## 可选 demo 与开发者检查（不属于普通安装）

```powershell
node bin\skill-conductor.mjs demo
node bin\skill-conductor.mjs init --demo
```

demo 使用仓库自带第一方示例技能与合成 CSV，显式 auto 执行两个受信任脚本并独立复核数字；它不调用模型。`setup` 永远不会运行 demo，也不会把 demo 根加入默认用户目录。

## 来源与许可

MIT。设计借鉴、来源与取舍见 [ATTRIBUTION.md](ATTRIBUTION.md) 和 `research/upstream-review.json`。本实现是工程组合，不声称学术独创，也不把测试通过包装成生产准确率。
