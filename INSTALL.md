# Skill Conductor 安装与接入契约（给 agent，不是给用户的手册）

用户只需要说一句：

> 请读取 https://raw.githubusercontent.com/ok888laity/skill-conductor/main/INSTALL.md，按其中步骤安装并接入 Skill Conductor，自动准备所需环境、使用我现有的技能，默认均衡触发和人工确认，完成后继续当前任务。

你（宿主 agent）负责按下面的契约完成安装、发现、接入和一次真实握手。用户不需要知道 Node、npm、配置字段或演示 CSV。产品只要求 Node；不需要 Python、OpenCode 或第二个模型订阅。

## 1. 从没有项目文件的状态开始

先确认用户当前任务的工作目录和你所在的宿主。不要把产品仓库当成用户的工作目录，也不要让用户去猜宿主名或 Node 路径。尚未下载产品时，先把对应安装脚本下载到当前项目自己的 `.skill-conductor/bootstrap/`，再执行；整个流程由 agent 完成。

Windows：

```powershell
$projectPath = (Get-Location).Path
$bootstrapDir = Join-Path $projectPath '.skill-conductor/bootstrap'
New-Item -ItemType Directory -Path $bootstrapDir -Force | Out-Null
$installerPath = Join-Path $bootstrapDir 'install.ps1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/ok888laity/skill-conductor/main/install.ps1' -OutFile $installerPath
powershell -NoProfile -ExecutionPolicy Bypass -File $installerPath -ProjectPath $projectPath -HostName cursor -VerifyHost
```

把 `cursor` 换成你实际所在的 `workbuddy`、`qoder`、`deepseek-harness`、`opencode` 或 `generic`。创建目录前，若已存在的 `.skill-conductor` 是指向项目外的符号链接/重解析点，应停止并说明具体路径，不跟随它写入。

Linux / macOS：

```sh
project_path="$PWD"
bootstrap_dir="$project_path/.skill-conductor/bootstrap"
mkdir -p "$bootstrap_dir"
curl -fsSL 'https://raw.githubusercontent.com/ok888laity/skill-conductor/main/install.sh' -o "$bootstrap_dir/install.sh"
sh "$bootstrap_dir/install.sh" --project "$project_path" --host cursor --verify-host
```

同样使用真实宿主名；只有 `wget` 时用它下载同一官方 URL。不要改用户系统的默认目录或运行时配置。安装器会自动下载应用，优先复用可用 Node，缺少时自动安装项目内的便携运行时。

## 已有源码时的入口

在用户项目根目录运行对应入口（不要改 PATH、profile、TEMP、全局 npm 或用户 home 配置）：

Windows PowerShell 5.1+：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Linux / macOS：

```sh
sh install.sh
```

离线或受控测试可以用本地源码归档，不访问 GitHub：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ArchivePath .\skill-conductor.zip
```

```sh
sh install.sh --archive ./skill-conductor.tar.gz
```

安装器会：

- 把应用放在项目自己的 `.skill-conductor/app`；
- 在 `.skill-conductor/runtime` 选择已有 Node 20.11+，否则自动下载官方便携 Node 24.22.3 并按固定 SHA256 校验；
- 不申请管理员权限，不写 PATH/profile/TEMP/全局 npm；
- 校验归档条目和最终移动/删除目标，拒绝绝对路径、`..`、符号链接/重解析点逃逸；
- 保留已有配置，安装后自动运行 `setup`（可用 `-NoSetup`/`--no-setup` 只安装）。

安装器 stdout 末尾给出 `appPath`、`nodePath`、`nodeVersion`、`configPath`、`setupRan` 和 `nextAction`。若 `setupRan=false`，用给出的 Node 运行：

```text
<nodePath> <appPath>/bin/skill-conductor.mjs setup
```

## 2. 让 setup 发现用户现有技能

```text
<nodePath> <appPath>/bin/skill-conductor.mjs setup --host <cursor|workbuddy|qoder|deepseek-harness|opencode|generic>
```

- 不带 `--host` 时只创建/更新用户技能配置，不生成宿主配置。
- `--root PATH` 可重复，用于额外明确指定的技能根。
- `--include-hidden` 仅在确有隐藏根需要时使用；发现器也会在已知根里检测隐藏技能目录。
- `setup` 是幂等的。已有自定义配置不会被静默覆盖；旧的本产品 demo-only scaffold 会先备份再迁移，并移除 demo 脚本信任。
- 发现器只检查已知项目/用户目录，不扫全盘，不安装、不执行第三方技能。
- 所有新发现根默认 `trusted:false`，执行仍关闭。发现不等于信任。

### setup 状态如何转述

| `status` / `setupStatus` | 含义 | agent 动作 |
| --- | --- | --- |
| `ready` | 有有效用户技能 | 继续宿主接入和任务 |
| `no_user_skills` | 没有发现用户技能（空目录不等于 demo） | 先查询当前宿主可见的已启用技能清单，自动补充可确认的本地根；仍没有则简短说明并继续原任务，不要求用户跑 demo |
| `no_valid_user_skills` | 有 SKILL.md 但元数据不可用 | 报告具体文件/错误，不要伪造可用 |
| `existing_custom_config_preserved` | 已有自定义配置被保留 | 复用可用配置；确需补根时先备份，只合并已确认的技能目录，不改 owner 的开关或确认策略 |
| `existing_custom_config_invalid` | 自定义配置无效且未修改 | 先备份并尝试修复可明确判断的产品配置错误；只有无法确定用户意图时才提出一个简短问题 |
| `migrated_demo_scaffold` | 旧 demo-only 配置已备份迁移 | 说明 demo 文件仍在但不再参与路由/信任 |

## 3. 宿主配置状态

`setup --host X` 只合并本项目配置中的本产品 server，不写 home/global 宿主文件，不打印已有凭证。

| 状态 | 含义 | agent 动作 |
| --- | --- | --- |
| `configured` / `already_configured` | 项目宿主配置已写入/已一致 | 让用户重载或启用该宿主的 MCP server；不要声称应用已原生验证 |
| `patch_required` | 现有 JSONC/无效 JSON/非本产品 DSH bundle 被保留 | 把生成的 patch 交给用户/agent 合并，明确下一步 |
| `native_unverified` | DSH 本地 bundle 已生成，但未安装到 DSH | 如有 DSH 插件工具可安装；否则要求宿主激活；保持 nativeVerified=false |
| `verification: "schema-only"` | 结构/命令已验证 | 仍需宿主 reload |
| `verification.status: "protocol_verified"` | 实际启动了生成的命令并完成 MCP initialize/tools/list | 仍不等于原生应用验证 |

需要真实 stdio 握手时加 `--verify-host`，或用宿主自己的 MCP SDK 启动生成配置里的 `command`+`args`。

DeepSeek Harness 生成的是本地 bundle：

```text
.skill-conductor/integrations/deepseek-harness/cordis.patch.yml
.skill-conductor/integrations/deepseek-harness/package.json
```

`cordis.patch.yml` 是 `- insert:` patch 操作文档；`package.json` 带 `dsh.bundle.patch`。它不是通用的 `mcpServers` JSON，也不要修改无关工作区的 package.json。原生安装/重载未执行时必须报告 `native_unverified`。

## 4. 健康检查与真实清单

```text
<nodePath> <appPath>/bin/skill-conductor.mjs doctor
```

或 MCP 工具 `health` / `list_skills`。输出包含：

- Node 版本/路径、平台；
- 配置路径、策略 ask/auto、assistance 总开关；
- 根目录、技能数、有效/无效数；
- 宿主配置存在/已配置/reload 状态；
- `no_user_skills` 时明确 nextAction；
- 不运行 demo，不激活技能，不执行脚本。

首次 MCP 启动若没有配置，会在当前项目创建本地配置，诊断写 stderr；stdout 仍只发 JSON-RPC 协议消息。

## 5. 用当前宿主模型做语义推荐（不需要额外 key）

推荐分两步，推荐不是审批：

1. 调用 `list_skills` 或 `health`，读取真实候选的 `id`、`name`、`description`、`tags`、`triggers`、`blocked` 等元数据。
2. 由当前宿主模型选择后，调用：

```json
{
  "name": "prepare_skills",
  "arguments": {
    "task": "用户的中文任务",
    "recommendation": {
      "selected": [
        { "id": "cursor-project:sales-report", "reason": "英文描述与中文销售报告需求匹配", "confidence": 0.9 }
      ]
    }
  }
}
```

- 只能使用目录中的精确 ID；未知、重复、阻塞、超量或非法 confidence 会被显式拒绝。
- 推荐只改变 pending 中的推荐内容，不改变 ask/auto 策略、settings 或 trust。
- 用户仍需在 ask 模式下通过 `choose`、所有者 UI 或受信任 SDK 回调决定。
- 中文任务可以选择英文描述的现有技能；不需要再配置 OpenCode 或付费 API key。
- `assistance.enabled=false` 始终优先，推荐也不能绕过。

MCP `initialize` 的 `instructions` 也会提示上述流程。

## 6. 完成并返回用户任务

- 若 `ready` 且宿主已重载：调用 `prepare_skills`，把 `status:"awaiting_choice"`、候选、理由、阻塞项展示给用户。
- `no_match`：说明原因（`no_user_skills` 或选择器拒选），不要展示空的审批问题。
- `awaiting_choice`：等待用户/所有者决定；agent 不能自我批准。决定可由：

```text
<nodePath> <appPath>/bin/skill-conductor.mjs choose <runId> --skills ID,ID --config <configPath>
<nodePath> <appPath>/bin/skill-conductor.mjs choose <runId> --skip --config <configPath>
```

- 激活后再回到用户原任务。`handoff`/`activated` 不等于脚本执行成功，也不等于独立验证。
- 只有显式受信任的 Node 脚本才会执行；发现不会授予信任。没有执行入口的技能交给宿主执行器。
- 技能特定依赖/凭证在真正使用该技能时检查；缺失就如实报告，可由宿主 agent 在限定范围内修复，不能伪造为已安装。

## 7. 禁止事项

- 不把 demo、示例 CSV 或演示脚本作为首次使用步骤。
- 不安装未审查的第三方技能，不执行发现阶段遇到的脚本。
- 不读取或打印凭证，不把现有配置值回显到日志。
- 不修改用户全局宿主配置；只写项目内路径。
- 不声称 Cursor/WorkBuddy/Qoder/DeepSeek Harness 原生应用已运行；只报告实际观察到的 schema 或 stdio 握手。
- 不把 `no_user_skills` 改写成“已准备好”；也不要用假技能填充空目录。

## 8. 支持的技能根（按需发现）

项目根：`.cursor/skills`、`.workbuddy/skills`、`.codebuddy/skills`、`.qoder/skills`、`.dsh/skills`、`.opencode/skills`、`.claude/skills`、`.codex/skills`、`.agents/skills`、`skills`。

用户根：`~/.cursor/skills`、`~/.workbuddy/skills`、`~/.codebuddy/skills`、`~/.qoder/skills`、`~/.dsh/skills`、`~/.config/opencode/skills`、`~/.opencode/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`；Windows 另含 `%APPDATA%/opencode/skills`。Codex 插件缓存只做有界 `skills` 目录发现。Node 下载只来自 nodejs.org 的固定版本和已发布 SHA256。

发现结果按 host/scope 保留 provenance 和稳定 namespace；相同 realpath 去重；已存在根信任不会被新发现自动授予。

## 9. 可选开发者演示

`node bin/skill-conductor.mjs demo` / `init --demo` 仅是仓库示例/开发检查，不属于普通用户安装流程，也不会由 `setup` 运行。
