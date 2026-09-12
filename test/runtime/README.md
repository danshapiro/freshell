# Durable Souls runtime tests — Stage 5a

The eight in-scope coding-agent modes remain required. Stage 5a replaces layered
report certification with direct test execution, without dropping their behavioral
checks, resource controls, recovery paths, or operational safeguards. Gemini, Kimi,
and extension/plugin support are explicitly deferred by the scope amendment below.

## Direct commands

```bash
npm run test:runtime:verify -- --list
npm run test:runtime:verify -- --suite deterministic
npm run test:runtime:verify -- --suite live
npm run test:runtime:verify -- --suite stress
npm run test:runtime:verify -- --suite all
npm run test:runtime:verify -- --only rehydrate loss-notice
npm run test:runtime -- gate phase-5 --require-live --case P5-G06
npm run test:runtime -- gate phase-5 --require-live
npm run test:runtime:provider-qualification -- --provider claude
npm run test:runtime:fresh-agent-qualification -- --mode freshcodex
```

The deterministic suite includes Docker/IPC tests and the hosted fresh-agent
fixture browser test. The live suite explicitly selects Claude, Codex, OpenCode,
Amplifier, FreshClaude, Kilroy, FreshCodex, and FreshOpenCode, plus browser
continuity, resurrection, view reconstruction, and loss notices. The stress
suite runs 100 web replacements / 20 controller replacements and the minimum
30-minute / 50-soul pressure test. All means all three suites, including actual
provider usage and long stress work.

Use the single-provider/mode commands for narrower work. The live suite names
its complete implemented matrix explicitly; ambient selection variables do not
narrow it. Dan explicitly deferred Gemini, Kimi, and extension/plugin support
from Stage 5a on September 11, 2026. They are excluded from this stage's
implementation and acceptance, not reported as passing coverage. All eight
named modes and their safety and recovery assertions remain required.

`test:runtime:campaign` is a compatibility alias for the new direct runner.
Old `gate landing` and certification-mode arguments are retired. Existing
single-provider command names remain, but do not generate promotion certificates.
The raw phase gate runs only the 50 deterministic Docker scenarios: its PASS is
not a whole-product or actual-provider result. `--case` is narrower still.

## Runner and sandbox

Stage 5a browser tests explicitly use the local Docker-backed entrypoint
`test:e2e:local` and pin `FRESHELL_E2E_BACKEND=local`. Dan selected this lane
for final qualification; it is not an ambient fallback from cloud. Nonbrowser
Docker cases remain a separate sandbox workload.

All destructive scenarios stay within RuntimeHarness and the restricted Docker
broker. Exact container/volume ownership records and cleanup are retained.
Production, other worktrees, and actual user session state are outside their
scope. Fixture and fault-injection features remain distinct from normal runtime
behavior. Fixtures never count as actual-provider coverage.

Playwright results require actual passing tests and zero failures, skips, or
retry-masked failures. Missing dependencies and failed cleanup remain visible.
There is no second program authenticating a portable report or approving release.

## Coverage mapping

The original 56 scenario IDs still describe behavior. Fifty have deterministic
cases. Six report-only consumers are replaced with direct scenario execution:

| Original case | Direct scenario |
|---|---|
| P2-G01 and P2-G04 | runtime-terminal-continuity-rust.spec.ts |
| P3-G01 | Managed-provider and fresh-agent live tests |
| P3-G10 | runtime-provider-resurrection-rust.spec.ts |
| P4-G08 | runtime-tabs-rehydrate-rust.spec.ts |
| P5-G10 | scripts/testing/runtime-phase5-soak.ts |

Mixed cases keep their deterministic assertions. Their native-provider and
browser checks run in the corresponding live/stress specs, including the
additional OpenCode isolation scenario. Provider-native history readers still
check exact session identity, completed follow-up turns, no-tool recall, actual
model/effort, and provider-specific native records. Scope-specific results do
not imply that every original all-provider requirement has been verified.

Pressure tests still require continuous measurements, actual CPU throttling,
memory/PID pressure, one writer, no false loss, terminal output progression,
bounded spools/logs, and successful cleanup. Loss/chaos checks inspect the
observations collected by that test, not imported certificates or hashed copies.

Logs and normal results are private files under .runtime-evidence/. Build,
image, and provider versions identify what ran. A documentation-only commit does
not invalidate an earlier result or require repeating the soak. Rebuild and
retest behavior that changed. Relevant actual-provider testing remains necessary
before enabling defaults; unit tests or executable presence are not substitutes.

## Provider configuration

Version and low-cost model settings remain in docker/runtime/provider-versions.json
and the original gate manifest. Preserve each provider's native effort settings
and existing credential references. Claude/Codex keep their own subscription
logins; Amplifier keeps its approved OneCLI credential-source semantics. Stage
5a does not alter login requirements, runtime authentication, secret handling,
provider-home isolation, or model-cost policy.

Explicit FRESHELL_MANAGED_PROVIDERS selects implemented terminal adapters on
both supervisor and web using ordinary production routing. Unset retains the
conservative defaults. Fresh-mode configuration is still separate. Enablement
is installation configuration, not proof that unfinished integration work is
complete. All original agent modes remain required for the full product.

## Loss diagnostics

SQLite commits the loss, exact cleanup target, and outbox before cleanup.
Secondary JSON export is independent: failed exports stay pending and retry,
without preventing cleanup or truthful notices. Database persistence/read
failures remain blocking. Cleanup success still requires the exact owned
runtime to be empty. Notifications and incident history remain durable.

Observed failure facts remain required. Unknown root-cause hypotheses,
preventive actions, and regression-case references are optional enrichment.
Old enriched incident records remain readable; generic generated postmortems
are no longer prerequisites for safe lifecycle operations.
