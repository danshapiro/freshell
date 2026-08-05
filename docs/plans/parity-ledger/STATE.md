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

## Phase status
- [x] AGENTS.md port fix (committed 47f5c68f5)
- [ ] Baseline: npm test + cargo test running in bg (PID 2698087, logs /tmp/parity/logs/baseline-*.log)
- [ ] Phase 0 audit: 16 Kimi auditors → /tmp/parity/audit/*.yaml → docs/plans/parity-ledger/audit/
- [ ] Triage → waves
- [ ] Wave 1: perf logging (user-prioritized) + P0 gaps
- [ ] Final gates + write-up (WRITEUP.md)

## Scratch layout
- /tmp/parity/sections/  — checklist split by section
- /tmp/parity/audit/     — auditor YAML outputs + status
- /tmp/parity/workers/   — implementation worker dirs
- /tmp/parity/logs/      — baseline + monitor logs
