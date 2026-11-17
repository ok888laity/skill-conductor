# Attribution and source boundaries

Skill Conductor v0.3 is an original JavaScript implementation, but its design is deliberately informed by multiple public projects and the existing Agent Skills / SKILL.md conventions. The v0.2 adaptive gate combines the before-step hook/phase-boundary ideas cited below with bounded local task state; v0.3 adds real-user discovery, project-local bootstrap/runtime and multi-host adapters. No upstream implementation was copied. No upstream source code was copied into this repository in this session. Upstream projects are cited below at the level of design patterns, with their limits noted.

Full source-review notes and metadata are in [`research/upstream-review.json`](research/upstream-review.json). That file records 16 documented sources; not every source was code-audited, and `repositoryReview.claimsIndependentlyReproduced` is `false`.

## v0.3 host onboarding sources

The 0.3 onboarding adapters were generated from public official schemas, not cloned app code:

| Source | Used for | Boundary |
| --- | --- | --- |
| https://prod.cursor.com/help/customization/mcp | Cursor project `.cursor/mcp.json` `mcpServers` command/args shape | Project JSON schema and generated-command stdio test; Cursor desktop was not automated. |
| https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide | WorkBuddy project `.workbuddy/mcp.json` local `mcpServers` | No WorkBuddy app run; managed runtime fields not assumed. |
| https://docs.qoder.com/cli/mcp-reference and https://docs.qoder.com/extensions/skills | Qoder CLI project `.mcp.json` / documented `.qoder/settings.json`, and `.qoder/skills` roots | CLI schema/stdio only; Qoder IDE reload not claimed. |
| https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/dsh-doc/templates/mcp/package.json and `.../cordis.patch.yml` | DSH installable local bundle: `- insert:` patch and `dsh.bundle.patch` | Generated bundle and stdio handshake only; native DSH installation not performed. |
| Existing OpenCode 2.x adapter evidence in this repository | Legacy `opencode.json` `mcp.servers` shape | Prior native 2.2.7/2.3.0 observation retained; 0.3 rechecks schema/stdio, not native app. |

The v0.3 platform review notes record the reviewed URLs and schema limitations. The installer pins
official Node 24.22.3 archives and SHA256 values from Node's published `SHASUMS256.txt`; no
third-party mirror fallback is used.

## Directly relevant projects

| Project | Link | Borrowed design | Not borrowed / limitation |
| --- | --- | --- | --- |
| numman-ali/openskills | https://github.com/numman-ali/openskills | Universal SKILL.md discovery, progressive disclosure, existing directory/resource conventions. | Not a semantic selector; installing/loading instructions is not execution. |
| vercel-labs/skills | https://github.com/vercel-labs/skills | Cross-host skill ecosystem, one-off use, content hashes and traceability. | Installation/discovery is separate from in-work routing. |
| agentskills/agentskills | https://github.com/agentskills/agentskills | SKILL.md package format; separation of discovery, activation and execution. | The specification does not mandate routing or a runtime executor. |
| joshuadavidthomas/opencode-agent-skills | https://github.com/joshuadavidthomas/opencode-agent-skills | Skill injection and compaction/session concerns as product context. | OpenCode-bound; developer did not run its embedding model or v2 behavior. |
| legendtkl/agentic-skill-router | https://github.com/legendtkl/agentic-skill-router | Metadata extraction, bounded search, staged matching and layered scanning. | Mostly skill control; not a general execution-authorization model. |
| paulpas/agent-skill-router | https://github.com/paulpas/agent-skill-router | BM25-style retrieval, triggers, reranking patterns and audit logging. | Timeout/execution claims in its README were not reproduced here. |
| sowhan/skill-search | https://github.com/sowhan/skill-search | MCP-oriented skill retrieval, hash/health/drift ideas. | Its embedding/Qdrant stack and benchmark numbers are not adopted or reproduced. |
| joshrotenberg/skillet | https://github.com/joshrotenberg/skillet | MCP tools/prompts, BM25-style search, provenance and staged evidence. | Discovery does not equal execution; its graph features are not cloned. |
| intellectronica/skillz | https://github.com/intellectronica/skillz | Skill discovery plus explicit named scripts and provenance. | PoC execution/sandbox claims are not treated as a security boundary. |
| drfrog-coding/codex-skill-router | https://github.com/drfrog-coding/codex-skill-router | Positive/avoid triggers, ask-user conditions, combination hints, local scan. | Dynamic user prompting cannot guarantee quality and must not silently edit global config. |
| diet103/claude-code-infrastructure-showcase | https://github.com/diet103/claude-code-infrastructure-showcase | Before-step hooks and external skill activation as integration inspiration. | Its bash hook examples are not portable; no original code was copied. |
| obra/superpowers | https://github.com/obra/superpowers | Multi-skill workflows, phase boundaries, execution/verification separation. | Its agent workflow conventions are not a universal security model. |
| jiayuww/SkillOrchestra | https://github.com/jiayuww/SkillOrchestra | Execution traces, skill handbooks and multi-skill composition. | Research system; learning/cost claims are not reproduced. |
| oneal2000/SR-Agents | https://github.com/oneal2000/SR-Agents | Retrieval/incorporation/application split, BM25 + rerank motivation, visible evidence. | Research benchmark; this repository does not claim its results. |
| GodsBoy/jev-agent-skill-router | https://github.com/GodsBoy/jev-agent-skill-router | Client-side routing, explicit candidate selection, small synthetic fixtures. | Provider-specific and small-fixture results are not accuracy evidence. |
| Dicklesworthstone/skillranker | https://github.com/Dicklesworthstone/skillranker | Using current-session/next-step context for rerouting. | Its ranking claims were not executed or validated here. |

## Additional inspected source files

The research file also lists individual files inspected from `joshuadavidthomas/opencode-agent-skills` (`src/embeddings.ts`, `src/plugin.ts`) and related implementation details. Those informed the caution that embedding/provider integration, session state and execution are separate concerns. They are not vendored here.

## Live integration-test inputs (not vendored)

The expanded integration run used downloaded public skill packages only as
temporary test inputs. They are not copied into this repository or the npm
package, and their licenses remain with their upstream projects:

| Repository | Commit used | Skills exercised |
| --- | --- | --- |
| anthropics/skills | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` | pdf, docx, xlsx, doc-coauthoring, frontend-design, webapp-testing |
| obra/superpowers | `22f0b463e7a5e579904dd6211a520321035526f7` | systematic-debugging, test-driven-development, verification-before-completion |
| vercel-labs/skills | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` | web-design-guidelines |

Temporary `conductor.json` overlays declared test-only metadata and capabilities;
original `SKILL.md` files were not modified. Those overlays and downloaded
packages live under ignored `integration-temp/` and are not part of the public
source release. The sanitised results are in
[`docs/live-integration.md`](docs/live-integration.md); no third-party skill body
is reproduced there.

## What this project does not claim

- No claim of novelty or academic originality. This is a sourced engineering combination.
- No copied benchmark, accuracy number or production-quality claim.
- The offline eval is **synthetic lexical fixtures**, not semantic accuracy.
- The one recorded live OpenCode probe in controller evidence is an integration example, not a benchmark.
- No claim that process spawning is an OS sandbox.
- No claim that a loaded SKILL.md is a callable function or that activation equals successful execution.

## License

This repository is MIT-licensed (see [`LICENSE`](LICENSE)). Upstream projects retain their own licenses; consult each project before reusing their code or assets.
