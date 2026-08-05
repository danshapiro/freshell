# Parity Campaign — Orchestrator State

**Deadline:** 2026-08-05 09:00 (user returns; expects learnings write-up + single review-ready branch)
**Integration branch:** `parity-campaign-20260805` at `.worktrees/parity-campaign`
**Checklist:** `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` (235 IDs, 7 checked pre-campaign)

## Goals (equal priority)
1. Develop a great process for massively parallel agents (opencode + ms-runpod/moonshotai/Kimi-K3).
2. Land as many missing parity features as possible, merged into the single branch above.

## Hard constraints
- NEVER restart the live server (port 3001). No PRs. No pushes to main. No destructive suites outside sandbox.
- Commits use explicit pathspecs. Perf watched continuously (don't crash the 32-core/49Gi box).
- Baseline suite must be green before merging implementation work.

## Phase status (final, 07:05)
- [x] AGENTS.md port fix (47f5c68f5)
- [x] Baseline: cargo workspace GREEN; npm suite green except pre-existing api-edge-cases __proto__ failure
- [x] Phase 0 audit: 18 auditors, 235 items re-verdicted (audit/*.yaml)
- [x] Implementation waves: 28 items landed (see CAMPAIGN-RESULTS.md)
- [x] DIAG-04 perf logging landed (user priority)
- [ ] Final gates: cargo --workspace + npm test running (logs /tmp/parity/logs/gate-*.log)
- [x] WRITEUP.md + LEARNINGS.md + CAMPAIGN-RESULTS.md written

## Scratch layout
- /tmp/parity/sections/  — checklist split by section
- /tmp/parity/audit/     — auditor YAML outputs + status
- /tmp/parity/workers/   — implementation worker dirs
- /tmp/parity/logs/      — baseline + monitor logs
