# RCA: OpenCode Ambiguous Session Ownership Warnings

**Date:** 2026-05-09  
**App:** Freshell v0.7.0 (production)  
**Component:** `opencode-activity-tracker`  
**Severity:** WARN (but functionally correctness-affecting — suppresses durable session adoption)

## Problem

Repeated WARN log entries:

```
OpenCode endpoint reported ambiguous session ownership; suppressing durable adoption.
```

Each warning lists multiple `sessionIds` returned by the OpenCode endpoint for a given `terminalId`. Six root cause analysis agents across two adversarial rounds investigated.

## Root Cause (Two-Part)

### 1. Trigger: Multi-Session Architecture Mismatch (90% confidence)

OpenCode v1.14.44 creates **multiple concurrently `busy` sessions per process** when launched without the `--session` flag. Freshell's ownership reducer (`server/coding-cli/opencode-ownership-reducer.ts`) assumes exclusive session ownership (one terminal = one session). When fresh terminals launch OpenCode without `--session`, the endpoint returns 2–8 concurrent busy sessions, which the reducer interprets as competing ownership claims. This triggers the `ambiguous` state and the warning.

**Code trace:**
- `server/terminal-registry.ts:252-259` — only sets `resumeArgs` when `resumeSessionId` is truthy
- `server/coding-cli/providers/opencode.ts:137-138` — maps `resumeSessionId` → `['--session', sessionId]`
- Fresh terminals have no `resumeSessionId` → no `--session` flag → OpenCode treats all sessions as candidates

**Differential evidence:**
- Processes WITH `--session`: report 0–1 busy sessions (works correctly)
- Processes WITHOUT `--session`: report 2–8 busy sessions (triggers ambiguity)
- All ambiguous sessions verified as `type: "busy"` via live endpoint query (not `retry`)

### 2. Amplifier: Stale Session Accumulation Bug (85–95% confidence)

`reduceSnapshot` at `server/coding-cli/opencode-ownership-reducer.ts:281` computes blocked sessions as:

```ts
uniqueSorted([...state.blockedSessionIds, ...busySessionIds])
```

This is a pure UNION — it never prunes sessions that have completed. Stale session IDs from prior SSE stream intervals are permanently trapped. The state can never self-resolve from `ambiguous`. Zero of 21 affected terminals have ever recovered.

### Falsified Hypothesis

The initial theory that `retry`-status sessions were being conflated with `busy` in `sortedBusySessionIds` (line 92–97: `status.type !== 'idle'`) was **falsified by live system evidence**. A query of all production endpoints found zero `retry` sessions — all multi-busy sessions are `type: "busy"`. Changing the filter to `=== 'busy'` would be a no-op for the observed warnings. The schema defines `retry` as a valid type, but OpenCode v1.14.44 never emits it.

## Recommendation

**Three concrete changes** — prefer fixing at the source (constrain OpenCode to single-session) over downstream mitigation:

1. **`server/terminal-registry.ts:252-259`** — When `mode === 'opencode'` and `resumeSessionId` is undefined, generate a session ID (e.g. via `nanoid()`) and pass it as `resumeArgs`. This constrains OpenCode to single-session mode.

2. **`server/coding-cli/opencode-activity-wiring.ts:61-68`** — Pass the generated session ID to `trackTerminal` so the reducer receives a `knownSessionId` hint, enabling `quiet → knownBusy` instead of `quiet → ambiguous`.

3. **`server/coding-cli/opencode-ownership-reducer.ts:281`** — Replace the UNION with `busySessionIds` (recompute from snapshot). The snapshot is authoritative for current state.

**Prerequisite verification:** Confirm `opencode serve --session <id>` constrains to single-session behavior.

**Rollback mitigation:** Revert commits `29dc693c` and `c1f76b1f` to return to v0.6.0 `extractBusySessionId()` behavior (no ambiguity detection, no warnings).

## RCA Process Meta-Analysis

### What worked

The adversarial multi-agent approach surfaced insights a single analyst would have missed. The most important finding — that OpenCode reports 4 concurrently `busy` sessions — came from the Outsider agent querying the live production system, breaking through a false consensus that two other agents had converged on with 85% confidence. Without the adversarial structure, the likely outcome would have been changing a filter to `=== 'busy'` — a no-op fix.

### What was the evidence gap

The single largest evidence gap across both runs was **no runtime evidence in Run 1**. All six agents in the first run performed static code analysis only. The 10–18% confidence gap was entirely attributable to missing live system data. Run 2's agents corrected this by querying production endpoints.

### Key process finding

Evidence diversity drives output diversity more than perspective framing does. Agents working from the same evidence (code + logs) converged even with different perspectives. Agents with different evidence (live system probes) diverged productively.

### Process improvements identified

1. Assign different evidence-gathering domains, not just different thinking styles
2. Require live-system verification for production-observable issues
3. Add falsification as an explicit round between evidence gathering and synthesis
4. Require agents to enumerate unverified assumptions with separate confidence ratings
5. Prevent redundant evidence gathering in Round 2 via task assignment
6. "Assumption Auditor" perspective — agent whose sole job is listing and verifying assumptions
