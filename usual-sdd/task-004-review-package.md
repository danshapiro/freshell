# Task 4 Independent Review Package

Read the execution brief:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-004-brief.md`

Read the complete Task 4 plan section and unchanged `## User Request` block in:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Implementation commit:
- `0041c964b0803c707e78c1c5ab7d8aac6cdb179c`
- parent: `8844e431cb8eebdcf0a85c92efcbc0718fc48107`

Reports:
- `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-004-report.md`
- `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-004-completion-report.md`

Review the actual diff and tests. Verify:
- one owned Rust browser constructor, explicit external targets remain non-owned, shared fixture support is correctly rehomed, and browser TestServer/GATE-01 executable paths are gone while the frozen JSON remains;
- one Rust-backed `chromium` application project, CI browser projects and continuity selection obey the exact exclusion/registration contract, no legacy project/MATRIX/e2eServerKind/TestServer residue remains in the closed sets, and selection-nonvacuity floors/provenance checks are substantive;
- global setup/teardown/perf/Electron seams and `/api/server-info` provenance identify Rust;
- `mcp-qa-smoke-rust` local-only classification/positive selector is preserved;
- the oracle focused test is run through its owning config (port config intentionally excludes oracle/**), and the focused Rust Chromium receipt/race is evaluated honestly rather than hidden or skipped.

Constraints:
- Read-only; no implementation edits/commits; no server/port 3001 contact/restart/health-check.
- Give separate requirements-compliance and code-quality verdicts.
- List only concrete findings with severity (Blocker/Major/Minor/Nit), one file/line, evidence, impact, remediation. If no findings, say so.
- Write review to:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-004-review.md`
