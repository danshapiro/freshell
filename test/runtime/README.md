
## Phase 5 loss, chaos, and soak qualification

Phase 5 is destructive and must run only through `RuntimeHarness` and the
restricted Docker broker. Never invoke its runtime-kill or state-removal steps
directly on the host. The harness records every exact container/PID/volume it
owns and cleanup removes only those receipts.

## Landing gate versus full production Gate 5

The same cumulative body runs in two release modes:

```bash
# Landing / pre-certification gate. May PASS while exactly the deferred
# providers await live access.
npm run test:runtime -- gate landing --require-live

# Full production Gate 5. BLOCKED (exit 2) with the typed reason
# "pending_live_provider_certification" until every required provider is
# live-certified.
npm run test:runtime -- gate phase-5 --require-live
```

Beyond the phase cases, each run executes one `PC-<PROVIDER>` certification
case per provider that makes — or is queued to make — a managed claim
(`PC-SHELL`, `PC-CLAUDE`, `PC-OPENCODE`, `PC-CODEX`, `PC-AMPLIFIER`). Every
case in `summary.json` carries exactly one of:

| Status | Meaning |
|---|---|
| `PASS` | The case ran and its assertions held. |
| `DEFERRED_LIVE_PROVIDER_CERTIFICATION` | Landing mode only, and only for a provider the capability manifest lists in `certification.landingGate.deferrableProviders`. The run additionally proves the provider makes no managed durable promise anywhere. |
| `BLOCKED` | A prerequisite (receipt, live access, provider certification) is missing. Exit code 2. Never a pass. |
| `FAIL` | A genuine defect. Exit code 1. |

Deferring a provider that is not deferrable, or deferring anything at all in
production mode, fails the run. Each run writes `deferred-providers.json`
alongside `summary.json` recording exactly what was not proven.

The cumulative command is:

```bash
npm run test:runtime -- gate phase-5 --require-live
```

Before the gate, generate all candidate-bound receipts with the checked-in
specs/campaigns. Phase 5 adds:

```bash
# Real isolated OpenCode state removal and one loss notice.
FRESHELL_RUNTIME_PHASE5_LIVE=1 npm run test:e2e:local -- \
  --project=rust-chromium \
  test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts

# Pending approval, long tool, 100 web replacements, 20 supervisor restarts.
FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE=1 npm run test:e2e:local -- \
  --project=rust-chromium \
  test/e2e-browser/specs/runtime-chaos-rust.spec.ts

# Must run for at least 30 minutes and maintain at least 50 desired souls.
~/.local/bin/mise exec node@22 -- \
  node_modules/.bin/tsx scripts/testing/runtime-phase5-soak.ts
```

Deferred-provider certification campaigns must pin their low-cost launch
policy before starting. Use `haiku` plus Claude effort `low`, and
`gpt-5.6-luna` plus Codex effort `minimal`; verify the captured launch/resume
evidence contains those exact values. Codex must show
`-c model_reasoning_effort="minimal"`, not a synthesized flag or provider
default.

Amplifier qualification uses the approved
`/home/sentinelx/sentinelx-tools/amplifier-onecli` credential source model,
but never executes that wrapper or sources shell text. The web process stores
only a canonical reference to the private `~/.amplifier/keys.env`; the session
host's bounded parser resolves its allowlisted names immediately before spawn
and adds them only to the unprivileged Amplifier child. The runtime image owns
the exact `claude-haiku-4-5-20251001` / `low` settings and wrapper. Supply the
non-secret approved endpoint explicitly:

```bash
export FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE="$HOME/.amplifier/keys.env"
export FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENDPOINT='https://approved-onecli-endpoint.example/v1'
export FRESHELL_RUNTIME_AMPLIFIER_MODEL='claude-haiku-4-5-20251001'
export FRESHELL_RUNTIME_AMPLIFIER_REASONING_EFFORT='low'
```

The keys-file variable may be omitted only when the canonical approved default
exists with mode `0600` or stricter. A different keys file, a placeholder,
unknown key, malformed assignment, endpoint mismatch, expensive model/effort,
or any raw OAuth file fails closed with an actionable error. Secret bytes are
absent from launch specs, the registry, Docker environment, logs, and receipts.
Model and effort evidence comes from Amplifier's native redacted
`session:config` event, never imagined resume flags. These instructions prepare
a campaign only; all three providers remain deferred and release-disabled until
their separate certification change lands.

Receipt paths may be supplied through the `FRESHELL_RUNTIME_PHASE5_*_RECEIPT`
environment variables. The gate validates schema, exact candidate SHA, measured
counts/duration, provider/mode coverage, cleanup, and zero unsafe broker
attempts, then copies the receipt into its own evidence directory. Never reuse a
receipt from another commit or image.

Provider qualification receipts use schema v2. A v2 receipt names its exact
`receiptRunId`, candidate-bound `evidenceRun`, pinned `runtimeImage`, and the
provider version/model/reasoning-effort/native-session identity observed by the
live browser run. Its assertion, broker, and cleanup artifact references each
carry a SHA-256 digest. Certification resolves those references only inside
`.runtime-evidence/<candidate-sha>/<receipt-run-id>/`, verifies the run manifest
and build record, hashes the files again, and derives provider, cleanup, and
unsafe-attempt verdicts from those artifacts. The build artifact and receipt
also pin production versus `qualification_fixture`, exact feature sets,
selected providers, and server/supervisor binary hashes. Final gates accept
production only; a preliminary qualification-fixture receipt must be requested
explicitly and can never promote a production capability. A stale, missing,
path-escaped, or tampered artifact fails certification. Schema v1 remains a narrow migration
exception for an OpenCode-only receipt; adding any newly promoted provider
requires schema v2.

The live producer requires an explicit per-provider selection. Claude or Codex
can therefore qualify without Amplifier credentials, and Amplifier setup cannot
turn a missing provider into a blanket skip:

```bash
FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE=1 \
FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS='claude,codex' \
npm run test:runtime:campaign -- --only managed-provider-qualification
```

For an isolated receipt producer, select exactly one provider (no implicit
Amplifier prerequisite is evaluated for the other providers):

```bash
npm run test:runtime:provider-qualification -- --provider claude
npm run test:runtime:provider-qualification -- --provider codex
npm run test:runtime:provider-qualification -- --provider amplifier
```

The campaign refuses to treat a missing live flag or a Playwright skip as a
qualification pass.

### Fresh-agent live qualification

Hosted FreshClaude, Kilroy, FreshCodex, and FreshOpenCode use a separate
`fresh_agent_live` schema-v1 receipt. A producer must select exact mode names;
empty selections, aliases such as `claude`, `all`, whitespace, unknown names,
and duplicates fail before the runtime harness creates any workload:

```bash
FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE=1 \
npm run test:runtime:fresh-agent-qualification -- --mode freshcodex
```

The producer pins the low-cost profiles from `gate-manifest.json` (Claude
Haiku/low, Codex `gpt-5.6-luna`/low, and OpenCode
`opencode/big-pickle`/provider-default), provider/runtime versions, exact
native IDs, two provider-native completed assistant turns, no-tool recall,
web/session-host/provider-process failure evidence, one-writer evidence,
independent provider volumes/enclosures, and cgroup limits with swap disabled.
Claude and Kilroy additionally require a real pending approval to survive web
and host recovery and resolve exactly once.

`managed-fresh-agent-fixtures` and the session-host `fresh-agent-fixtures`
feature form a separate deterministic regression lane. Fixture selection is a
typed launch field and the provider child runs inside the managed soul; an
ordinary session-host explicitly rejects it. A fixture build can never satisfy
the live receipt validator. Run its local, provider-free supervisor/recovery
proof explicitly with `npm run test:runtime:fresh-agent-fixtures`; it exercises
all four modes, web/session-host/provider-child failure, pending-decision
recovery, enclosure/store isolation, and startup reconciliation without
writing a qualification receipt. The checked-in capability manifest keeps all
four fresh modes disabled until an authentic receipt is reviewed and the
release flags are changed deliberately.

The gate includes crash failpoints around incident commit, cleanup, export, and
notice projection. Failpoints are available only in the test supervisor built
with `runtime-test-faults`. The release-binary case passes the same environment
variables and proves they have no effect.

A valid run contains:

- all cumulative `P1-G*` through `P5-G*` assertions;
- `broker.jsonl` with no unsafe attempt;
- ownership before/after and a successful cleanup artifact;
- browser/provider/chaos/soak receipts under the final candidate SHA;
- incident exports and runtime metrics;
- migration and repair evidence;
- `summary.json` reporting PASS.

Evidence stays untracked under `.runtime-evidence/<candidate-sha>/<run-id>/`.
If a code or documentation change is committed after receipt generation, all
candidate-bound receipts and the cumulative gate must be regenerated.

### OpenCode-only staged landing

For this landing, provider-matrix receipts are required only for providers
whose manifest entries have both `managedEnabled` and
`durableRecoveryEnabled`. That set is OpenCode. Claude, Codex, and Amplifier are
explicitly deferred as `PENDING_LIVE_QUALIFICATION`; their legacy behavior
remains covered by the ordinary regression suite, but no managed durability
claim is made. When one is enabled later, the same gate automatically requires
its live provider row and all managed modes.
