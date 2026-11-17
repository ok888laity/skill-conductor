# Platform support and evidence boundaries

This project generates host-specific project configuration from the official schemas cited below.
The table separates three evidence levels:

- **Schema**: the file/key/field shape is based on official documentation.
- **Protocol**: this repository actually launched the generated command and completed MCP stdio
  `initialize` + `tools/list` in automated fixtures.
- **Native**: the desktop/CLI host application itself was opened, reloaded and observed. This is
  claimed only where it was actually performed.

| Host | Generated project path | Shape | Schema | Protocol | Native |
| --- | --- | --- | --- | --- | --- |
| Cursor | `.cursor/mcp.json` | `mcpServers.<name>.command/args/env/cwd` | Official | Yes (generated command handshake) | Not claimed |
| WorkBuddy / CodeBuddy | `.workbuddy/mcp.json` | `mcpServers.<name>.command/args/env` | Official | Yes | Not claimed |
| Qoder | `.mcp.json` (documented alternative `.qoder/settings.json`) | `mcpServers.<name>.command/args/env/cwd` | Official | Yes (CLI project config) | Not claimed |
| DeepSeek Harness | `.skill-conductor/integrations/deepseek-harness/cordis.patch.yml` + `package.json` | Cordis `- insert:` patch with `@deepseek-ai/dsh-mcp-client` fields; `dsh.bundle.patch` | Official template | Yes (generated fields handshake) | Not claimed; native bundle install not executed |
| OpenCode | `opencode.json` | `mcp.servers.<name>` local command array, `codemode:false`, `protocol:"legacy"` | Official | Yes | 0.2.x native-tested on 2.2.7/2.3.0; not re-claimed this round |
| Generic MCP / SDK | `.skill-conductor/mcp.json` | stdio `command` + `args` descriptor | Generic protocol | Yes | Not a native app connector |

## Name collisions

The generator never overwrites an unrelated `conductor` server. If the name is already used by a
different command/args signature, it allocates a stable unused name (`conductor-skill-conductor`,
`conductor-2`, ...), preserves the unrelated entry, and reports `serverName` plus
`preservedExistingConductor`. `inspectHostIntegrations` and `verifyHostIntegration` locate the
owned entry by its `skill-conductor.mjs` + `mcp` command signature rather than assuming a name.

## JSONC / unsupported configs

If the existing host file is JSONC or cannot be parsed, it is preserved byte-for-byte. A machine-readable
patch is written under `.skill-conductor/patches/` and the result is `patch_required` with an explicit
next action. The host is not reported as connected.

## DeepSeek Harness bundle

The generated `cordis.patch.yml` is a patch operation document:

```yaml
- insert:
    - id: mcp-skill-conductor
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: skill-conductor
        transport: stdio
        command: '<absolute node>'
        args:
          - '<absolute cli>'
          - 'mcp'
          - '--config'
          - '<absolute conductor config>'
        failOnStartupError: true
```

The sibling `package.json` contains `name`, `version`, `private`, `type`, `files` and
`dsh.bundle.patch: "./cordis.patch.yml"`. The bundle is written under the project state directory;
no unrelated workspace package.json is touched. The result stays `native_unverified` until the
target DSH actually installs/loads it.

## Operating systems

| OS | Installer | Local evidence | CI |
| --- | --- | --- | --- |
| Windows | `install.ps1` (PowerShell 5.1+) | Local tests with existing Node and fixture archives; portable Node hash failure/traversal rejection exercised | Windows Node 20/22/24 |
| Linux | `install.sh` (POSIX sh) | CI executed the installer entrypoint with a fixture archive | Ubuntu Node 20/22/24 |
| macOS | `install.sh` | Script provided; not natively run in this development environment | Not run natively |

The installer checks archive entries before extraction (absolute paths, `..`, symlinks/hardlinks),
verifies extracted trees, rejects project-state reparse/symlink escape, and validates every final
move/delete target. Portable Node is downloaded only from `https://nodejs.org/dist/v24.22.3/` and
verified against pinned SHA256 values. No third-party mirror fallback is used.
