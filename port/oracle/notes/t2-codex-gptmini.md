# T2 live slice — freshcodex + cheap-GPT (codex-spark)

> **CORRECTION (antagonist adjudication, DEV-0003 = REJECTED).** This note's
> "DEV-CODEX-EFFORT" claim — that codex rejects `none`/`minimal` effort and that
> this caused the run-1 stall — was REFUTED: freshell's own
> `CodexReasoningEffortSchema` (`server/coding-cli/codex-app-server/protocol.ts:26`)
> deems `none`/`minimal` VALID and the real-codex contract fixture advertises
> `minimal` as supported, and a rejected param would surface a JSON-RPC error, not
> a silent hang. The stall's true cause is unproven. `effort='low'` remains valid
> test hygiene (cheapest VALID effort), so the codex T2 slice is GREEN and NOT
> blocked. See `port/oracle/DEVIATIONS.md` DEV-0003 (status: rejected) — the
> authoritative record. The claim below is retained only for history.

Original-side T2 behavioral-invariant capture for the **codex** runtime, mirroring the
opencode/Kimi and claude/Haiku slices. Boots the ORIGINAL freshell server isolated +
credential-seeded, drives ONE cheap GPT turn through the real `freshAgent.*` WS surface,
grades the provider-agnostic T2 invariants, and persists
`port/oracle/baselines/t2/codex-gptmini.json`.

- Harness: `port/oracle/harness/t2-live-codex.ts` (`runCodexGptMiniT2`)
- Gated test: `test/integration/port/oracle/t2-codex-gptmini.test.ts`
- Grader: `port/oracle/harness/invariants.ts` (`assertT2Invariants`, codex id-shape + codex
  branch of the completion-signal invariant)
- Unit cases: `test/unit/port/oracle/t2-invariants.test.ts` (`goodCodexObservation`)

Result (codex-cli 0.142.5, model `gpt-5.3-codex-spark`, effort `low`): **9/9 fatal
invariants PASS**, 1 non-fatal expected-absent (`wire.session-materialized`).
`liveModelCalls=1` per run.

## How freshcodex drives a turn (file:line)

1. WS `freshAgent.create` (`sessionType:'freshcodex'`, `provider:'codex'`) →
   `server/ws-handler.ts:3291` → `manager.create` → codex adapter
   `create()` (`server/fresh-agent/adapters/codex/adapter.ts:819`) →
   `runtime.startThread()` (`server/coding-cli/codex-app-server/runtime.ts:971`) spawns the
   real `codex app-server` child (JSON-RPC 2.0 over WS, `runtime.ts:1246`) and starts a
   thread. `create()` returns `{ sessionId: started.threadId }` — the codex **thread id**
   verbatim — surfaced as `freshAgent.created.sessionId` (`ws-handler.ts:3381`).
2. WS `freshAgent.send` → codex adapter `send()` (`adapter.ts:955`) →
   `runtime.startTurn()` — **the single live model call**. Returns `submittedTurnId`.

## PRIMARY completion edge — STATUS-GUARDED (the key codex fact)

`server/fresh-agent/adapters/codex/adapter.ts:911-928` (subscribe → `onTurnCompleted`):

```
const params = event.params as { status?; turn?: { status? } } | undefined
const status = params?.turn?.status ?? params?.status
if (status !== 'completed') return          // interrupt/failure NEVER chimes
listener({ type: 'sdk.turn.complete', sessionId, at })
```

`sdk.turn.complete` → `freshAgent.turn.complete` at
`server/fresh-agent/sdk-events.ts:71`. The codex `turn/completed` notification ALSO fires
on interrupt/failure (`CodexTurnStatusSchema = completed|interrupted|failed|inProgress`,
`server/coding-cli/codex-app-server/protocol.ts:104`; the "read `params.turn?.status ??
params.status`" contract is documented at `protocol.ts:398-413`). So the edge is
**status-guarded server-side** — observing `freshAgent.turn.complete` on the wire IS a
positive completion signal. The persisted rollout reply corroborates it.

Codex is graded on `provider.emits-completion-signal` (like claude/kilroy), NOT opencode's
`provider.emits-idle-signal`. NOTE: codex does **not** stream assistant text over the
subscription (adapter `subscribe()` wires only status snapshots + the turn-complete edge —
no `sdk.assistant`), so the reply text comes from the persisted rollout, not the wire.

## Session-id shape — corrected (placeholder == durable UUID)

`create` returns the codex thread id verbatim, and it is **stable from create** — there is
NO placeholder→durable materialization (unlike opencode `freshopencode-…→ses_…`). Observed
id: `019f30f4-263a-7300-af75-1df3e5af4d69` — a **UUIDv7** (codex-cli 0.142.x; the rollout
filename embeds the same id). Therefore:

- `PROVIDER_ID_SHAPES.codex.placeholder` was the aspirational `^freshcodex-` (never
  validated live); **corrected to the UUID shape** (== durable) in `invariants.ts`.
- NO `freshAgent.session.materialized` event fires for codex — `wire.session-materialized`
  is expected-absent (non-fatal), consistent with the claude slice.

## Cred seeding + isolation (CODEX_HOME)

`codex` resolves `CODEX_HOME` as `process.env.CODEX_HOME || $HOME/.codex`
(`server/coding-cli/providers/codex.ts:26`). The app-server child inherits
`{...process.env}` (`runtime.ts:1255`) and neither the server nor the runtime sets
CODEX_HOME (parent env verified unset). TestServer isolated mode sets `HOME=<isoHOME>`, so
the app-server authenticates from + writes ALL rollout/session data under
`<isoHOME>/.codex` — never the user's real `~/.codex`.

- Seed (READ-ONLY copies): `~/.codex/auth.json` + `~/.codex/config.toml` →
  `<isoHOME>/.codex/{auth.json,config.toml}`.
- PRE-CREATE `<isoHOME>/.codex/sessions/` so the rollout root EXISTS at boot (a real user
  always has it; harness ENV parity, analogous to claude's `~/.claude/projects` /
  DEV-0002). No isolated-home crash was observed with this in place.
- Rollout transcript: `<isoHOME>/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl`.
  Line shape `{ type, timestamp, payload }`; assistant text appears as
  `event_msg`/`agent_message` (`payload.message`) and `response_item`/`message`
  (role=assistant, `payload.content[].text`).

The gated test asserts the user's real `~/.codex/{auth.json,config.toml}` mtimes are
unchanged (READ-only) and that `:3001` / the live server pid survive.

## Cheapest model — reachability finding

Real codex catalog (`~/.codex/models_cache.json`, and live `model/list` on a chatgpt/pro
account): `gpt-5.5` (default), `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`.

freshell's freshcodex allowlist (`shared/fresh-agent-models.ts:30`) is
`{gpt-5.5, gpt-5.4-flash, gpt-5.3-codex-spark}`, and `normalizeFreshcodexModel`
(`:101`) **clamps any other model to the default `gpt-5.5`**. Consequences:

- `gpt-5.4-mini` (the literal "mini", present in the codex catalog) is **UNREACHABLE**
  through freshell — silently rewritten to `gpt-5.5`.
- `gpt-5.4-flash` (in freshell's allowlist) is **absent** from the real codex catalog.
- **`gpt-5.3-codex-spark`** is the only non-flagship model in BOTH → the cheapest GPT model
  actually reachable through freshell's freshcodex surface. This slice uses it.

The Rust port must reproduce this clamp (or the oracle diff will flag a model-selection
divergence).

## ⚠ Candidate finding — DEV-CODEX-EFFORT (effort-vocabulary mismatch → silent stall)

**Symptom (live run #1):** with `effort='minimal'`, the turn was accepted
(`freshAgent.send.accepted`, `turnAccepted=true`) but the inference **silently STALLED** —
no `freshAgent.turn.complete`, no assistant output, no rollout reply — until the 180s
budget elapsed.

**Root cause (probed live, non-inference `model/list`):** the real codex app-server
advertises reasoning efforts **only** `{low, medium, high, xhigh}` for every model
(incl. codex-spark). But freshell's freshcodex options declare
`thinkingEfforts: ['none','minimal','low','medium','high','max']`
(`shared/fresh-agent-models.ts:34-48`), mapping `max→xhigh` but passing `'none'`/`'minimal'`
through verbatim (`toCodexReasoningEffort`, `adapter.ts:127`). Those two values are NOT
accepted by the codex models, and a turn dispatched with them stalls the inference.

**This is a candidate pristine-source defect** (freshell offers efforts the codex models
reject → a real freshcodex user selecting "minimal"/"none" would hang). It is **NOT
patched** (source is frozen). It did **not block** this slice: the harness pins effort to
`'low'` — the cheapest VALID codex effort — which drives a clean turn (turnMs≈1.8s). Flagged
here for antagonist adjudication; the Rust port should either fix the effort vocabulary or
constrain freshcodex efforts to `{low,medium,high,xhigh}` (with a `max→xhigh` alias).

## Codex lifecycle facts the Rust-port QA must reproduce

1. `create` returns the codex app-server thread id (UUID) verbatim; it is the durable id —
   no placeholder→durable materialization; no `freshAgent.session.materialized`.
2. Completion = discrete `freshAgent.turn.complete`, emitted ONLY when the codex
   `turn/completed` carries `turn.status ?? status === 'completed'` (status-guarded).
3. Assistant text is NOT streamed over the subscription — it lands in the persisted rollout
   `.jsonl` under `<CODEX_HOME>/sessions/…`.
4. CODEX_HOME follows `$HOME/.codex` unless overridden; all session state is isolated there.
5. Model clamp to `{gpt-5.5, gpt-5.4-flash, gpt-5.3-codex-spark}` (fallback gpt-5.5).
6. Effort vocabulary vs. the codex app-server: see DEV-CODEX-EFFORT above.
