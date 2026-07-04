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

## Equivalence is differential, not absolute

freshell orchestrates nondeterministic LLM harnesses over live APIs. NEVER
assert byte-identical LLM output. Assert equivalence at four tiers (see
`port/oracle/DESIGN.md`): T0 protocol conformance, T1 deterministic differential
(PTY bytes, parser outputs, HTTP), T2 live behavioral-invariant differential
(same real task, cheapest model, invariants hold equally), T3 e2e/visual. "Done"
= original and port both pass all four on the same inputs.

## Architecture is frozen once set

- **Rust-first, single Cargo workspace.** Tauri core + `freshell-server` binary.
  `portable-pty` replaces node-pty; `axum` + `tokio-tungstenite` cover HTTP/WS.
- Preserve the **headless/daemon/phone-reachable** server mode: the server is a
  standalone binary the Tauri shell spawns/embeds.
- **Go is an escape hatch per-component, not a default.** Every extra toolchain
  multiplies autonomous failure surface. Reach for Go only on a concrete Rust
  library gap, and record the justification in the ADR.
- **The frontend (React/TS SPA) is retained unchanged** in Tauri's webview. The
  only rewrite is `electron/preload.ts` IPC → Tauri commands.
- **`shared/ws-protocol.ts` is the immutable contract.** Extract to a
  language-neutral schema; generate Rust types from it. Both sides and the
  oracle share that single source of truth. Changing the wire contract is
  out of scope for an "identical" port.

## No human in the loop

- Run recipes NON-STAGED / auto-approve. Never emit a `wait.human` gate.
- Antagonist / adversarial-review agents substitute for human review.
- self-driving owns crash recovery, heartbeat, and token budget.
- On unrecoverable ambiguity, STOP and write a blocker to `STATE.yaml` rather
  than guess — a wrong autonomous guess is more expensive than a pause.

## Engineering discipline (inherits root AGENTS.md)

- Red-Green-Refactor TDD for every non-trivial change. Never skip the refactor.
- Structural limits: ≤10K LOC per crate/module, ≤1K lines per file.
- Server uses NodeNext/ESM on the TS side; relative imports need `.js`.
- **Process safety (CRITICAL):** never broad-kill; the self-hosted freshell
  server must never be restarted without the user's explicit "APPROVED".
  Building is fine; deploying (stop+start) is not.
- Everything lands via PR; do NOT open a PR without explicit user approval.

## QA: cheapest model per harness

Live T2 QA drives each real harness with its cheapest model to stay fast/cheap:
Kimi k2.7 (OpenCode, already wired), Claude Haiku (Claude Code), GPT mini/nano
(Codex), Gemini Flash-Lite. Use pinned-output probes ("reply with exactly X")
for deterministic assertions out of nondeterministic models.

## Single-host coverage caveat

This host is WSL2 Linux. WSL/PowerShell/firewall/native mac+Windows packaging
paths CANNOT be live-QA'd here; they get golden-fixture coverage only. Do not
claim tri-platform parity from a single host.
