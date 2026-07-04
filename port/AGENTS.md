# AGENTS.md — guardrails for the autonomous port machine

These rules bind every agent/session in the Rust/Tauri port campaign. They are
**in addition to** the repo root `AGENTS.md`. The root rules and any specific
user instruction always win on conflict.

## Prime directive: oracle before port

No Rust that implements freshell behavior may be written until the equivalence
oracle (`port/oracle/DESIGN.md`) exists, is validated by mutation testing
against the ORIGINAL, and the ORIGINAL passes it. The oracle is the judge that
replaces the human. If the oracle cannot detect a divergence, that divergence
is by definition invisible to the whole campaign — so the oracle's completeness
is the campaign's hard ceiling.

## Equivalence is differential — with an adjudicated deviation ledger

freshell orchestrates nondeterministic LLM harnesses over live APIs. NEVER
assert byte-identical LLM output. Assert equivalence at four tiers (see
`port/oracle/DESIGN.md`): T0 protocol conformance, T1 deterministic differential
(PTY bytes, parser outputs, HTTP), T2 live behavioral-invariant differential
(same real task, cheapest model, invariants hold equally), T3 e2e/visual.

**Fix bugs; do not replicate them (user directive).** The port must be *behavior-
equivalent to the original EXCEPT where the original is objectively defective.*
Every old-vs-new divergence the oracle detects must resolve to exactly one of:

1. **Port defect** → fix the port (the default assumption — never grade your own
   output as correct just because it diverges).
2. **Deliberate bug-fix** → allowed ONLY when logged in `port/oracle/DEVIATIONS.md`
   with an *objective* defect criterion (see below) AND a new positive test that
   pins the corrected behavior. The oracle then treats that specific diff as
   expected.

An **objective defect** is one an independent reviewer can confirm without taste:
it crashes/errors/panics, leaks resources, violates the WS protocol schema,
contradicts documented behavior (AGENTS.md/docs/lab-notes), corrupts data, or
breaks an invariant the code itself asserts. "I think mine is nicer" is NOT a
defect — that is scope creep and is forbidden. The **antagonist reviewer**, not
the implementer, adjudicates each ledger entry. Bug-fixes are made in the PORT;
record the original's buggy behavior in the ledger for traceability.

## Architecture is frozen once set

- **Rust-first, single Cargo workspace.** Tauri core + `freshell-server` binary.
  `portable-pty` replaces node-pty; `axum` + `tokio-tungstenite` cover HTTP/WS.
- **No Go.** Dropped by user directive.
- **JS/Node is permitted ONLY as a spawned sidecar when it is a massive net
  savings** — i.e. a dependency with no Rust equivalent or near-equivalent
  (e.g. a vendor SDK that exists only in JS). Default is pure Rust; any JS
  sidecar must be justified in the ADR with the specific missing-crate reason,
  isolated behind a process boundary, and covered by the oracle like any other
  component. Convenience is not justification.
- Preserve the **headless/daemon/phone-reachable** server mode: the server is a
  standalone binary the Tauri shell spawns/embeds.
- **The frontend (React/TS SPA) is retained unchanged** in Tauri's webview. The
  only rewrite is `electron/preload.ts` IPC → Tauri commands.
- **`shared/ws-protocol.ts` is the immutable contract.** Extract to a
  language-neutral schema; generate Rust types from it. Both sides and the
  oracle share that single source of truth. Changing the wire contract is
  out of scope for an "identical" port.

## No human in the loop

- Run recipes NON-STAGED / auto-approve. Never emit a `wait.human` gate.
- Antagonist / adversarial-review agents substitute for human review AND
  adjudicate the deviation ledger.
- self-driving owns crash recovery, heartbeat, and token budget.
- **No spend cap (user directive)** — still prefer cheapest-capable models and
  bounded parallelism; no reason to be wasteful.
- On unrecoverable ambiguity, STOP and write a blocker to `STATE.yaml` rather
  than guess — a wrong autonomous guess is more expensive than a pause.

## Engineering discipline (inherits root AGENTS.md)

- Red-Green-Refactor TDD for every non-trivial change. Never skip the refactor.
- Structural limits: ≤10K LOC per crate/module, ≤1K lines per file.
- Server uses NodeNext/ESM on the TS side; relative imports need `.js`.
- **Process safety (CRITICAL):** never broad-kill. **The user's live freshell is
  pid 1262455 on :3001 (plus its child ports) — NEVER touch it, never bind :3001.
  My own server binds a unique high port (see STATE.yaml).** Live-QA spawns its
  OWN codex/opencode on unique ports and only cleans up processes it spawned
  (reuse the existing ownership-safe cleanup); the user's live codex/opencode
  sessions are off-limits. Because I run my own server and validate via browser
  testing, I never need the "APPROVED" restart gate.
- **Delivery: push `feat/rust-tauri-port` to origin periodically** (safety against
  worktree loss). **Do NOT open a PR (user directive: no PR).** Leave the pushed
  branch for review.

## QA: cheapest model per harness

Live T2 QA drives each real harness with its cheapest model to stay fast/cheap.
Gemini is OUT of scope (user directive):

- OpenCode → Kimi k2.7 (already wired)
- Claude Code → Claude Haiku
- Codex → GPT mini/nano

Use pinned-output probes ("reply with exactly X") for deterministic assertions
out of nondeterministic models. Credentials for claude/codex/opencode are
present on the host.

## Platform coverage on this host

WSL2 Linux host with **Windows interop live**: `powershell.exe` (Windows
PowerShell 5.1) and `cmd.exe` are reachable. Therefore the Windows-integration
paths (WSL↔Windows path conversion, `netsh` firewall, WSL port-forward, elevated
PowerShell) CAN be at least partially live-verified — do so; do your best.
**macOS** packaging/integration remains golden-fixture only (no mac host). Do
not claim macOS parity from live runs; label mac coverage as spec/fixture.
