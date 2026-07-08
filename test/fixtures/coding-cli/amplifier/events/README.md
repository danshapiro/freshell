# Amplifier `events.jsonl` fixtures (Phase 0 captures)

Converted from the Phase 0 live captures against `amplifier 2026.07.06-7ec5dcd`
(core 1.6.0), per `docs/plans/2026-07-08-amplifier-session-durability-plan.md`
(§2, §9 Phase 1, Appendix B). Source trees: `~/.amplifier/projects/-tmp-amp-p0-{a..f}/sessions/*/events.jsonl`.

## Scrubbing

Large raw payloads (LLM request/response bodies, agent-config blobs, tool
inputs/outputs, prompt text) were removed from `data`. Preserved verbatim:
event names, record order, `session_id`, `schema` objects, `ts`, `lvl`,
`redaction`, and `data.parent_id`. For `session:config` records the
`data.raw.project_dir` / `working_dir` / `project_slug` keys are preserved
(the locator's cwd-confirm inputs, plan §5 step 4). Scrubbed records carry
`"scrubbed": "[payload removed for fixture]"` where payload keys were removed.

## Fixtures

| File | Source | Shape |
|---|---|---|
| `normal-turn.jsonl` | `-tmp-amp-p0-b` lines 1–20 | Normal single no-tool turn: `session:start` → `session:config` → `prompt:submit` → execution → `prompt:complete` → `session:end` (E2). |
| `tool-turn-out-of-order-end.jsonl` | `-tmp-amp-p0-c` lines 1–31 | Tool turn: `tool:pre`/`tool:post` with a second `provider:request` iteration inside one execution; post-complete background-naming `llm:request` + `provider:retry`×3; **out-of-order** `session:end` (its `ts` predates the retries that appear before it) (E3). |
| `kill9-orphan.jsonl` | `-tmp-amp-p0-e` lines 1–11 | `kill -9` before first `prompt:complete`: file ends at `tool:pre`, no `session:end`, no `metadata.json` ever (E6). |
| `resume-append.jsonl` | `-tmp-amp-p0-b` lines 21–48 | Resume append pass: `session:resume` → `session:config` → full turn → post-complete `llm:request` + `provider:retry`×4 → out-of-order `session:end` → a second `cleanup:finally_*`/`session:end` group (E7/E3). Appends to the same file as `normal-turn.jsonl`. |
| `steering-injection.jsonl` | `-tmp-amp-p0-d` session `5f91a6ca…` lines 1–30 | Mid-turn typing queued as steering: `orchestrator:steering_injected` inside a single `prompt:submit`/`prompt:complete` pair (E5). |
| `continue-attach-orphan-end.jsonl` | `-tmp-amp-p0-b` lines 46–48 | `continue`-attach-then-quit pass: orphan `session:end` with **no** `session:start`/`session:resume` in the pass (E7). |
| `pty-hangup-completes.jsonl` | **synthesized** (modeled on `normal-turn.jsonl`) | PTY hangup, E7 **first clause**: amplifier finishes the turn (`prompt:submit` → execution → `prompt:complete`) and then writes `session:end` promptly. Session id and record shapes follow the real-capture format. |

All required shapes except `pty-hangup-completes.jsonl` existed in the real
captures. That fixture was synthesized from the `normal-turn.jsonl` record
format (adversarial-review finding O) because the raw E7 hangup capture was
not converted during Phase 1. Synthetic records used by tests
(schema-mismatch, `session:fork`, subagent `parent_id` starts) are constructed
inline in the test files from the real record format.
