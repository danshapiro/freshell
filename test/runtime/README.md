
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
unsafe-attempt verdicts from those artifacts. A stale, missing, path-escaped, or
tampered artifact fails certification. Schema v1 remains a narrow migration
exception for an OpenCode-only receipt; adding any newly promoted provider
requires schema v2.

The combined live producer is explicit opt-in and is excluded from the default
landing campaign until the checked-in capability flags are promoted:

```bash
FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE=1 \
FRESHELL_RUNTIME_AMPLIFIER_MODEL='<exact-live-model>' \
FRESHELL_RUNTIME_AMPLIFIER_REASONING_EFFORT='<exact-live-effort>' \
npm run test:runtime:campaign -- --only managed-provider-qualification
```

The campaign refuses to treat a missing live flag or a Playwright skip as a
qualification pass.

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
