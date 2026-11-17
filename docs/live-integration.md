# Live integration results (development testing)

This is **development/integration testing**, not an accuracy benchmark or held-out evaluation.
Model: `opencode-go/deepseek-v4.1-flash#low`. OpenCode sessions counted: 31.

## Routing

21 cases through the project OpenCode selector adapter: 21 passed, 3 abstained, 0 failed.
Offline no-match gate replay of recorded empty selections: 4/4 passed, zero model calls.

| Case | Category | Selected | Outcome |
| --- | --- | --- | --- |
| r01 | pdf-read | anthropic:pdf | matched |
| r02 | pdf-read-en | anthropic:pdf | matched |
| r03 | docx-read | anthropic:docx | matched |
| r04 | docx-near-neighbor | anthropic:docx | matched |
| r05 | doc-coauthor-zh | anthropic:doc-coauthoring | matched |
| r06 | doc-coauthor-en | anthropic:doc-coauthoring | matched |
| r07 | xlsx-read | anthropic:xlsx | matched |
| r08 | xlsx-near-csv | anthropic:xlsx | matched |
| r09 | csv-report | demo:csv-inspector, demo:markdown-report | matched |
| r10 | report-en | demo:csv-inspector, demo:markdown-report | matched |
| r11 | frontend-design | anthropic:frontend-design | matched |
| r12 | web-design-near | vercel:web-design-guidelines | matched |
| r13 | debug-zh | superpowers:systematic-debugging | matched |
| r14 | tdd-en | superpowers:test-driven-development | matched |
| r15 | verification-en | superpowers:verification-before-completion | matched |
| r16 | explicit-vendor | vercel:web-design-guidelines | matched |
| r17 | multi-skill | superpowers:test-driven-development, superpowers:verification-before-completion | matched |
| r18 | no-skill-weather | (none) | abstained |
| r19 | short-ack | (none) | abstained |
| r20 | material-injection | (none) | pending-consent-preserved |
| r21 | missing-capability | (none) | abstained-missing-capability |

## Downstream executions

6 cases through the project SDK executor and real isolated OpenCode build sessions: 6 independently verified, 0 failed, 7 sessions.

| Case | Category | Sessions | Checks | Post-verifier state |
| --- | --- | --- | --- | --- |
| d01-pdf | pdf-read | 1 | 4/4 | verified |
| d02-docx | docx-read | 1 | 4/4 | verified |
| d03-xlsx | xlsx-read-subset | 1 | 6/6 | verified |
| d04-debug | systematic-debugging | 1 | 6/6 | verified |
| d05-tdd | tdd-and-verification | 2 | 6/6 | verified |
| d06-web | web-design-review | 1 | 4/4 | verified |

## Method notes

- 21 OpenCode-selector cases through the project selector adapter; small-catalog roster; ask mode; no activation from route-only cases.
- 6 downstream cases through the project SDK host executor; isolated OpenCode build sessions with native local skills arrays; executor prompt requires the built-in skill tool; independent verifier reads actual artifacts and saved raw tool events.
- At least one downstream case prepared in ask mode, showed pending and zero executor calls, then a trusted harness choice resumed it.
- Counts are OpenCode run/session invocations, not underlying provider turns. Repeated/internal provider turns inside one agent session are not counted separately.

## Preserved findings

- First-pass offline verifier treated PowerShell-wrapped tests as exit 0 because the wrapper process exited 0; saved raw events showed the real RED then GREEN. Revalidated offline with effective EXITCODE parsing and no new model call.
- One budget-accounting defect double-counted four downstream cases; the ledger now marks those rows as non-invocation markers instead of deleting history.
- An early blocked-capability classifier passed for the wrong reason; the corrected classification uses the recorded abstainReason naming the missing capability.
- The original 21-row run predates the ask no_match gate: empty selections were recorded as awaiting_choice. An offline replay of the same four empty selections verifies the fixed gate with zero model calls.

## Limitations

- Small synthetic integration set; not production accuracy evidence.
- No claim that the selector always chooses the intended skill.
- Execution is not an OS sandbox.
- Third-party skill packages are test inputs only and are not vendored in this repository.
- Windows was the actual live-test platform in this run; CI is configured for offline tests on Windows and Linux; the cloud matrix has not run at this publication-preparation stage.

