# 宿主 / MCP 集成说明

普通用户的安装契约见 [`INSTALL.md`](../INSTALL.md)。本页给集成开发者：如何生成项目宿主配置、真实证据边界、推荐接口和 DeepSeek Harness bundle。

## 一条命令生成宿主配置

```text
<node> <app>/bin/skill-conductor.mjs setup --host cursor|workbuddy|qoder|deepseek-harness|opencode|generic
```

`setup` 会先发现/迁移用户技能配置，然后只合并本产品 server 到**项目**配置。已有值、凭证、其他 server 保留且不打印；不写 home/global 宿主文件。加 `--verify-host` 会真正启动生成的 command+args 并完成 MCP `initialize`/`tools/list`，这只是协议证据，不是原生应用验证。

完整矩阵和证据分级见 [`platform-support.md`](platform-support.md)。

## 各宿主生成结构

### Cursor

`.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "conductor": {
      "command": "<absolute node>",
      "args": ["<app>/bin/skill-conductor.mjs", "mcp", "--config", "<config>"]
    }
  }
}
```

官方 schema：`mcpServers.<name>.command/args/env/cwd`。本仓库实际启动生成命令并完成握手；未自动化 Cursor 桌面。

### WorkBuddy / CodeBuddy

`.workbuddy/mcp.json`，结构同上，顶层 `mcpServers`。未使用 WorkBuddy 的托管运行时字段；本机未运行 WorkBuddy 应用。

### Qoder

`.mcp.json`，顶层 `mcpServers`。Qoder CLI 项目配置有官方文档；`.qoder/settings.json` 是文档化替代位置。IDE 原生加载/重载仍由宿主负责，不声称与本仓库相同。

### OpenCode

`opencode.json`：

```json
{
  "mcp": {
    "servers": {
      "conductor": {
        "type": "local",
        "command": ["<node>", "<app>/bin/skill-conductor.mjs", "mcp", "--config", "<config>"],
        "codemode": false,
        "protocol": "legacy"
      }
    }
  }
}
```

OpenCode 2.2.7/2.3.0 的 legacy 结构在 0.2.x 原生验证过；0.3.0 重新做 schema/stdio，不重复声称本轮原生验证。

### DeepSeek Harness

生成项目内本地 bundle：

```text
.skill-conductor/integrations/deepseek-harness/cordis.patch.yml
.skill-conductor/integrations/deepseek-harness/package.json
```

`cordis.patch.yml` 是 Cordis patch 操作文档：

```yaml
- insert:
    - id: mcp-skill-conductor
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: skill-conductor
        transport: stdio
        command: '<absolute node>'
        args: ['<absolute cli>', mcp, --config, '<absolute config>']
        failOnStartupError: true
```

`package.json` 带 `private:true`、`type:"module"`、`files:["cordis.patch.yml"]` 和 `dsh.bundle.patch:"./cordis.patch.yml"`。这不是通用 `mcpServers` JSON，也不修改无关工作区 package.json。生成状态为 `native_unverified`：只有目标 DSH 真的安装/加载 bundle 后才能标记原生。

### Generic / SDK

`.skill-conductor/mcp.json` 是通用 stdio descriptor，不是原生 app connector。SDK 可直接 `startMcpServer` 或用自己的 MCP SDK 启动同一 command+args。

## 名称冲突与 JSONC

- 如果已有**其他人的** `mcpServers.conductor`，不会覆盖；生成器分配稳定的未占用名字（如 `conductor-skill-conductor`），保留原 entry，并在结果中返回 `serverName` 和 `preservedExistingConductor`。`inspect`/`verify` 按 `skill-conductor.mjs` + `mcp` 签名找到实际拥有的 entry。
- 现有配置是 JSONC/无效 JSON 时，原文件保持不变；在 `.skill-conductor/patches/` 生成 patch，状态 `patch_required`，并说明合并后的重载动作。不会伪造 connected。

## 当前宿主模型推荐（不需要额外 key）

1. 宿主调用 `list_skills` 或 `health`，读取真实候选元数据。
2. 当前宿主模型选择后，调用 `prepare_skills`：

```json
{
  "task": "用户任务",
  "recommendation": {
    "selected": [
      { "id": "cursor-project:sales-report", "reason": "英文描述与中文需求匹配", "confidence": 0.92 }
    ]
  }
}
```

3. 结果仍是 `awaiting_choice`（ask 模式）；宿主展示候选、理由和阻塞项。用户通过 `choose`、所有者 UI 或受信任 SDK 回调决定。
4. 未知、重复、阻塞、超量、非法字段会被显式拒绝；推荐不会改变 ask/auto、settings 或 trust。
5. MCP `initialize.instructions` 内置同一流程提示。

CLI 对应入口是 `--recommend FILE`。`http`/`opencode` 选择器仍是可选旧客户端能力；普通用户不需要第二个模型订阅。

## 聊天界面如何呈现选择

`prepare_skills` 返回：

- `status: "awaiting_choice"`（有可用推荐）；`no_match` 时没有 pendingChoice，不要展示空审批；
- `candidates[]`：精确 ID、名称、描述、理由、分数/置信度、是否推荐、阻塞项；
- `recommendation.selected[]`：推荐 ID、理由、置信度，可能包含必需依赖；
- `options`：single / multiple / skip；
- `runId`、`planHash`、`selector.label`（`host-supplied` 表示推荐来自宿主，不是本产品语义模型）；
- 空目录时 `status:"no_match"`、`catalogStatus:"no_user_skills"`。

MCP 没有审批工具。用户回答后由所有者执行：

```text
<node> <app>/bin/skill-conductor.mjs choose <runId> --config <config> --skills ID,ID
<node> <app>/bin/skill-conductor.mjs choose <runId> --config <config> --skip
```

## 健康检查

```text
<node> <app>/bin/skill-conductor.mjs doctor
```

或 MCP `health`。输出运行时、配置、roots、技能计数、policy/assistance 和宿主配置/reload 状态；不运行 demo、不激活、不执行脚本。首次 MCP 启动无配置时会创建本地配置，诊断只写 stderr。

## 安全边界

- 只读显式材料文件；URL 不自动抓取；二进制只给元数据。
- 只运行 sidecar 声明且配置明确信任的 Node 脚本；`shell:false`；超时杀进程树；输出与产物有界。
- 这不是 OS 沙箱，脚本仍以当前用户权限运行。
- 发现、安装、激活、执行、验证是不同状态；不把 schema/handshake 当成原生应用验证。
- 不修改用户全局 skill 或配置。
