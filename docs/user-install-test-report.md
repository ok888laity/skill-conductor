# 用户技能安装与多宿主接入验收

版本0.3.0，2026-11-17。用户安装流程改为自动准备产品运行环境、发现用户已有技能、生成当前宿主接入、后台健康检查；官方 demo 仅作为显式开发示例保留。

独立安装包验收 **15/15通过**。测试在模拟用户目录和中文/空格项目路径中预先放入10个相近技能，检查的是用户目录中的实际SKILL.md文件，不是产品打包的演示技能。

覆盖：首次无配置运行、用户和项目技能目录、幂等安装、OFF和自定义配置保留、旧demo配置迁移与备份、空技能目录、宿主JSON配置保留、同名服务器避让、JSONC不破坏、当前宿主模型提供推荐、虚构ID和权限覆盖拒绝。

## 实际无Node安装

在Windows PowerShell5.1中从不含node/npm的子进程PATH启动，安装器实际从nodejs.org下载并按固定SHA256校验Node24.22.3，将node.exe放入项目内；随后安装本地候选归档，发现用户技能，配置均衡+ask并完成接入检查。未运行演示、未修改全局PATH/profile/npm。Windows在线分支只需要官方node.exe，不解压产品不需要的npm目录，避免长路径问题。

另有 **4/4** 反例检查通过：错误运行时校验值、归档路径穿越、归档符号链接、项目状态目录重解析点逃逸，均拒绝且保留外部数据。

## 宿主验证边界

| 宿主 | 官方格式 | 实际官方SDK stdio | 原生客户端 |
|---|---|---|---|
| Cursor | .cursor/mcp.json | 已通过 | 未在原生应用加载实测 |
| WorkBuddy | .workbuddy/mcp.json | 已通过 | 未在原生应用加载实测 |
| Qoder | .mcp.json (CLI project scope) | 已通过 | 未在原生应用加载实测 |
| DeepSeek Harness | Local bundle: cordis.patch.yml insert operation + package.json dsh.bundle.patch | 已通过 | 未在原生应用加载实测 |
| OpenCode | opencode.json mcp.servers legacy stdio | 已通过 | OpenCode2.3.0实际调用通过 |
| Generic MCP/SDK | Project stdio descriptor / callback | 已通过 | 不适用 |

stdio测试使用官方@modelcontextprotocol/sdk1.32.2，实际启动生成的command+args，初始化、获取工具、读取对应用户技能目录。DeepSeek Harness的本地bundle使用官方Cordis `- insert:` 和 `dsh.bundle.patch` 结构；生成和握手不等于已经在DSH应用中安装启用。

## 当前模型推荐用户技能

真实OpenCode max会话读取了项目原有的10个相近测试技能。对中文“只把PDF表格提取为CSV，不做OCR、不合并页面”，选择了 `agents-project:pdf-tables`，通过host-supplied推荐入口保存为 `awaiting_choice`，未激活、未执行技能。当前宿主可用自己的模型提供推荐，不需要再配置OpenCode或另一份模型API key。

早期会话曾同时提交selected和abstainReason，被校验器拒绝后修正成功，原始错误和重试记录保留。工具描述和启动指令随后明确了互斥规则；最终候选版的原生会话只使用一次清单调用和一次有效推荐，没有发生重试。本例是集成验证，不是独立准确率benchmark。

## 仍需明确的范围

- 产品只自动准备自身Node运行时，具体技能的额外工具、库和账户在选用时由宿主按需处理，不在安装时批量安装全部技能依赖。
- 当前自动发现本地SKILL.md目录；原生应用的虚拟/远端技能目录可能需要其registry适配。
- 现有JSONC或原生客户端的加载/授权由安装agent按生成patch和平台机制完成，不伪造“已连接”。
- 安装步骤见[INSTALL.md](../INSTALL.md)，完整机器可读结果见[user-install-test-results.json](user-install-test-results.json)。
