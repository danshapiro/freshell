# freshell → Rust/Tauri port — autonomous campaign

This directory is the **plan-of-record and control surface** for an autonomous,
no-human-in-the-loop port of freshell's backend from TypeScript/Electron to
**Rust + Tauri**, retaining the React/TS frontend unchanged.

- Base commit: `98ed121c` (origin/main, verified green via `npm run test:status`)
- Worktree branch: `feat/rust-tauri-port`
- Machine state: `port/machine/STATE.yaml`

## The one idea

freshell orchestrates **nondeterministic LLM harnesses over live APIs**, so
"identical" cannot mean byte-identical. It means **contract- and
invariant-level equivalence, differentially proven old-vs-new on the same real
tasks.** The autonomous machine's *first* deliverable is therefore not the port
— it is an **equivalence oracle** built and validated against the *original*
before any Rust is written. See `port/oracle/DESIGN.md`.

## Phases

| Phase | Name | Output | Bundle(s) |
|------|------|--------|-----------|
| 0 | Oracle-first bootstrap | frozen WS contract, external-process harness, PTY golden capture, live baselines from ORIGINAL, oracle validated by mutation testing | (custom) + execution-environments |
| 1 | Understand | ground-truth behavior of the 4 risk areas | parallax-discovery |
| 2 | Architect | frozen ADR (`port/machine/architecture-spec.md`) | systems-design |
| 3 | Port | Rust workspace, module-by-module, each feature gated by contract tests + oracle diff | dev-machine |
| 4 | Self-QA | per-feature T0–T2, nightly T0–T3 incl. cheap-model matrix | self-driving |
| 5 | Converge | 100% black-box contract + differential parity + e2e/visual + live matrix | — |

## Equivalence definition (the acceptance bar)

The port is "done" only when, on the SAME inputs, it is **differentially
equivalent to the original** across all four oracle tiers (T0 protocol, T1
deterministic, T2 live-invariant, T3 e2e/visual) — with the original passing
the same suite. See `port/oracle/DESIGN.md` for tier definitions and the
cheapest-model-per-harness matrix.

## Guardrails

The autonomous machine operates under `port/AGENTS.md` (oracle-first, RGR TDD,
Rust-first, frozen WS contract, no-human config) **in addition to** the repo
root `AGENTS.md`. Repo rules and specific user instructions always win.

## Status

See `port/machine/STATE.yaml` for the live phase tracker and next actions.
