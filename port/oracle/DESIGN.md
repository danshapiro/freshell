# Equivalence Oracle — design

The oracle is the automated judge that replaces the human. It decides, on
identical inputs, whether the Rust/Tauri port is equivalent to the original
TS/Electron freshell. It is built and validated in Phase 0 **against the
original** before any port code exists.

## Why differential, not absolute

freshell's core job is driving nondeterministic LLM harnesses over live APIs.
Byte-identical output is impossible. So the oracle runs the SAME input against
BOTH implementations and compares at the level where equivalence is actually
defined: the wire contract, deterministic byte streams, and behavioral
invariants.

## Four tiers

| Tier | Asserts | Determinism | Reuse (exists in repo) | Build (Phase 0 gap) |
|------|---------|-------------|------------------------|---------------------|
| **T0 Protocol conformance** | same `WS_PROTOCOL_VERSION`; message types/shapes/ordering/state-machine on identical inputs | deterministic | `test/helpers/visible-first/protocol-harness.ts` (inbound+outbound transcript capture); `test/server/ws-handshake-snapshot.test.ts` | id/timestamp **normalization** + persisted golden store |
| **T1 Deterministic differential** | PTY **byte streams** for fixed shell commands; `.jsonl`/`opencode.db` **parser outputs** for fixed fixtures; HTTP API responses | deterministic | `test/fixtures/sessions/*.jsonl`; supertest API tests; `fake-app-server.mjs` | **PTY byte-stream golden capture** (biggest gap — node-pty is mocked everywhere today) |
| **T2 Live behavioral-invariant differential** | same real task vs both impls, each driving the real harness with the cheapest model; invariants hold equally (session created, id *shape*, transcript persisted+parseable, rename semantics, ownership/cleanup) | nondeterministic content, deterministic invariants | `test/helpers/coding-cli/real-session-contract-harness.ts` (real binaries, cred seeding, ownership-safe cleanup, Kimi path) | cheapest-model matrix + old-vs-new **invariant differ** |
| **T3 E2E / UI parity** | full user flows + 7 visual baselines against the new backend | mostly deterministic | `test/e2e-browser/**` Playwright specs (frontend unchanged) | point specs at the port's server URL |

## Cheapest-model-per-harness matrix (T2)

| Harness | Cheapest model | Status |
|---------|----------------|--------|
| OpenCode | Kimi k2.7 (`umans-ai-coding-plan/umans-kimi-k2.7`) | already wired in `opencode-serve-real-provider-smoke.test.ts` |
| Claude Code | Claude Haiku | to wire |
| Codex | GPT mini/nano | to wire |
| Gemini | Gemini Flash-Lite | to wire |

Determinism trick (already used in repo): pin exact outputs — prompt "Reply with
exactly: <token>" then assert equality. Reuse it for every live probe.

## The external-process requirement

Today WS/server tests construct the server **in-process** (`new WsHandler(...)`).
The oracle must connect to an **externally spawned** server over `ws://`/`http://`
so a Go/Rust binary can be diffed. The client side already speaks raw `ws`; only
server construction changes. Deliverable: a harness variant that boots either
(a) the original Node server or (b) the Rust `freshell-server`, and drives both
through the identical client transcript.

## Normalization layer

WS/HTTP payloads carry nondeterministic fields (nanoid ids, timestamps, temp
paths, ports, `ses_`/rollout ids). Before diffing, canonicalize them (stable
placeholders). Enumerate every nondeterministic boundary field first; that list
sizes the layer. Injectable clock/id seams already exist partially
(`turn-complete-clock.ts`, nanoid mocking) — extend rather than invent.

## Oracle validation (this is what makes it "impeccable")

An oracle is only trustworthy if it can DETECT divergence. Validate by
**mutation testing against the original**: deliberately break the original (drop
a WS field, corrupt a parser, flip rename semantics, perturb a PTY byte) and
assert the oracle fails. An oracle proven to catch injected divergences is the
strongest guarantee available for a nondeterministic system under test.

## Known prerequisite defects (must fix before trusting the oracle)

- `test:real:coding-cli-contracts` set the WRONG env var
  (`FRESHELL_REAL_PROVIDER_CONTRACTS` vs the `_RUN_` the tests read), so the
  "proven" live contracts may never have run green. FIXED on this branch with a
  regression test (`test/unit/server/real-provider-contract-script.test.ts`).
- CI runs NONE of the suites (only typecheck + electron build). The campaign
  must stand up its own runner; do not rely on CI as an equivalence gate.
