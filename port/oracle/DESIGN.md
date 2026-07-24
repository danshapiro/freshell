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

## Divergence adjudication (bug-fix posture — user directive)

The user directed: **fix bugs as found; do not replicate bug-for-bug.** So
differential equivalence is the *default* expectation, not an absolute one.
Every diff the oracle detects MUST resolve to exactly one of three verdicts:

- **PORT_DEFECT** — the port is wrong. Fix the port. This is the default; the
  machine may never rule its own divergence "correct" without an objective basis.
- **DELIBERATE_FIX** — the ORIGINAL is objectively defective and the port
  corrects it. Allowed only with a `port/oracle/DEVIATIONS.md` entry (objective
  defect criterion + a new positive test pinning the fixed behavior),
  adjudicated by the **antagonist reviewer**, not the implementer. The oracle
  then whitelists that specific diff via the entry's fingerprint.
- **EQUIVALENT** — no material diff (after normalization).

Objective-defect bar (any one): panics/crashes/errors, resource leak, violates
the WS schema, contradicts documented behavior, corrupts data, or breaks an
invariant the code itself asserts. Aesthetic preference is NOT a defect. The
differ consults the ledger: a diff matching a ledger fingerprint is expected;
any *unexplained* diff is always a failure.

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

(Gemini is OUT of scope per user directive — not ported, not QA'd.)

Determinism trick (already used in repo): pin exact outputs — prompt "Reply with
exactly: <token>" then assert equality. Reuse it for every live probe.

## The external-process requirement

Today WS/server tests construct the server **in-process** (`new WsHandler(...)`).
The oracle must connect to an **externally spawned** server over `ws://`/`http://`
so the Rust binary can be diffed. The client side already speaks raw `ws`; only
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
