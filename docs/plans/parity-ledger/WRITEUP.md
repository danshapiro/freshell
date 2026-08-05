# Overnight Parallel-Agent Campaign — What I Learned (fable, 2026-08-05, 00:15–09:00)

**The headline:** 31 parity checklist items landed on a single review-ready branch
(`parity-campaign-20260805`), each verified by targeted cargo/vitest runs on the integration
branch, using ~35 opencode sessions running `ms-runpod/moonshotai/Kimi-K3` as the workforce —
plus a complete evidence-cited re-audit of all 235 checklist items that corrects a badly stale
ledger (only 7 boxes were checked; reality is 31 DONE / 118 PARTIAL / 58 MISSING / 23 UNCLEAR /
5 HOST-LIMITED). One item honestly closed as already-done (SYNC-06), and one dropped after three
zero-output sessions (SESSION-21). Even the item cut at the first deadline (AUTO-05) was
salvaged by a fresh session pointed at its dirty worktree in a bonus round after gates went green.

**What worked — the winning process shape.** The most effective topology was *write-only
workers + central serial verification*: each worker gets its own git worktree and a spec
(checklist item text + audit findings + pacing rules), writes code and tests WITHOUT running
cargo, and commits with explicit pathspecs; the orchestrator cherry-picks each branch onto the
integration branch and runs targeted tests there against a shared warm CARGO_TARGET_DIR. This
kept 28GB of build cache shared, made verification serial (no build storms), and made every
failure attributable to exactly one item. First-pass success was only ~30%, but recovery loops
raised the effective land rate to ~90%: feed the exact panic output back into the same session
(`opencode run -c`) for one fix round; if a session times out twice, start a FRESH session
pointed at the dirty worktree — fresh sessions decisively finish what resumed sessions endlessly
re-explore. The audit phase (18 read-only auditors in parallel, one per checklist section)
was the single highest-value step: it turned a fiction (7/233) into an implementable backlog of
133 S/M items and its evidence quality survived spot-checks.

**What failed — and the guardrails that emerged.** Kimi-K3 is thorough to a fault: 17 of 18
auditors blew a 25-minute timeout with zero output because they wrote results only at the end
(fix: incremental output + resume-and-dump recovers everything); M-sized items routinely needed
45–60+ minutes; and DIAG-04 (the perf logger you asked for early) consumed four sessions before
I implemented it myself from the sessions' excellent module docs — the cap-retries-then-escalate
rule is now explicit. Environment-sensitive tests are a blind spot (AUTO-10's real-shell test
failed three identical rounds until told to seed state deterministically). Perf-wise the box
survived but had two scares: load 148/32-cores when a 4-item verify chain overlapped ~10 live
agents (rule: ONE verify chain at a time), and a reminder that the Amplifier bash tool kills
process groups on timeout — long jobs must use run_in_background. Repo-side learnings: the live
Rust server runs on port 3001 not 3002 (AGENTS.md fixed), `X-Auth-Token` is the only accepted
auth header, and main's server suite has one pre-existing failure (`api-edge-cases` __proto__
test) that predates this campaign.

**What I'd do next time.** Bake the pacing contract into the FIRST prompt (hard budget, commit
early, WIP commits allowed); split anything M-sized into S-slices before dispatch; run the
audit wave with incremental output from the start; and keep the fix-loop/fresh-session ladder —
it's cheap and it converts almost every "failed" worker into a landed feature. The full running
log is in `LEARNINGS.md`, per-item results in `CAMPAIGN-RESULTS.md`, and the re-audit in
`audit/*.yaml`, all committed on this branch.
