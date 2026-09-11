# Stage 5a — feature-preserving runtime simplification

## Goal and scope

Implement the September 11 reconsideration: the complete Durable Souls product,
with fewer independent rules and failure dependencies. This is an amendment to
Stage 5 of the five-phase execution plan, not an OpenCode-only release or a new
runtime architecture. Baseline: `7d5dff9dff7c060ec6138550402cb20a713336bd`, in the
existing `durable-souls-release-candidate` worktree. `origin/main` remains
`2e05dd9e2f8a4dce393689d228e21ad123c474a5` at planning time.

All coding agents remain required: Claude terminal, FreshClaude, Kilroy, Codex
terminal, FreshCodex, OpenCode terminal, FreshOpenCode, Amplifier, and managed
hosting/capability treatment for enabled Gemini/Kimi/plugin modes. No adapter,
provider operation, creation doorway, resource control, recovery path, view
behavior, or ordinary legacy behavior is removed. Existing disabled defaults
are not silently promoted; missing integration work/testing remains outstanding
for the full product, never reclassified as out of scope.

Keep exact ownership, isolation/authentication, controller fencing, one writer,
stop-wins revisions, independent session hosts, protected command/permission
journals, native identity, safe checkpoints, blocked-versus-lost distinctions,
bounded retries, output epochs, admission reservations, effective limits,
durable view intent, durable incidents, and idempotent notices.

## Validated assumptions and resulting boundaries

1. **Confirmed:** `recovery.rs` commits loss to SQLite, then synchronously exports
   the secondary incident file before cleanup (old lines 988–1025). Export failure
   returns an error (1478–1499). Pending cleanup on startup has the same dependency.
   Change this dependency; keep authoritative database failure fatal.
2. **Confirmed:** `loss_report.rs::validate_analysis` requires a preventive action,
   missing invariant, and regression case. `recovery.rs` fills these with generic
   hypotheses and `P5-G02`. They are commentary, not safety facts. Make enrichment
   optional without relaxing recovery-path completeness or ownership checks.
3. **Confirmed:** the campaign catalogs/hashes receipts, validates gate summaries,
   and binds every run to a clean Git SHA. Browser tests already assert real
   identity, native turns, recovery, limits, and cleanup. Replace report attestation
   and release approval with direct execution/results; keep those assertions,
   pinned build/provider metadata, real-versus-fixture distinction, and exact test
   resource ownership. No skipped/empty real-provider run becomes a pass.
4. **Confirmed:** runtime capabilities contain release certification status and a
   separate compile-time qualification path. Replace that release vocabulary with
   supported operations and ordinary explicit installation enablement. Live tests
   use normal production routing; crash/fixture features remain separate.
5. **Confirmed:** the capability JSON and Rust table duplicate provider information.
   Consolidate this where practical. Public lifecycle states and view projections
   have different compatibility/consumer obligations: do not combine this work with
   a schema rewrite or sweeping Redux refactor. Those larger candidates are not
   justified merely by their size.
6. **Confirmed:** the inherited combined regression baseline fails on five
   `node:sqlite` client-environment suite loads and one remaining arrow-constructor
   xterm mock. Unit and server subsets had passed. Repair test ownership and the
   mock, not product behavior; retain the tests in their proper runner.
7. **Environment:** E2E is configured `cloud`; Vitest is unset (local default).
   Do not silently switch browser execution to local. Docker-backed tests must
   use a suitable explicit runner; report the unsupported configured lane rather
   than counting excluded specs as coverage. No production restart or PR is
   authorized by this stage.

## Implementation sequence

### 5a.1 — ordinary regression test ownership

Reproduce the inherited failures, move Node-only suites to their correct Node
runner without losing coverage, update the final constructor mock, and add
registration checks. Keep the standard coordinated check as the broad baseline.

### 5a.2 — independent diagnostic export

Add failing tests with real temporary SQLite and a fake exact-owned backend:
secondary export failure cannot prevent loss cleanup or startup reconciliation;
the incident/notice remain durable, export stays pending, recovery after repair
exports it, and one failing export does not suppress unrelated exports. Keep
failure to commit or read authoritative cleanup state fatal. Export retries are
bounded best-effort work outside the cleanup decision, not a second durable gate.

### 5a.3 — optional incident enrichment

Add tests accepting an incident without root-cause commentary while still
rejecting unreadable/unknown/incomplete recovery paths and foreign targets.
Preserve old incident deserialization. Stop generating generic hypotheses and
hardcoded regression-case claims. Keep observed facts and reason codes.

### 5a.4 — direct runtime verification

Replace the layered campaign/approval workflow with simple scenario execution
and normal results. Separate deterministic runtime scenarios, real-provider and
browser scenarios, and long stress/soak work. Preserve the complete provider/mode
matrix and original meaningful assertions; do not turn a fixture into a provider
pass. Keep actionable logs, versions/build identification, and owned cleanup.
Remove clean-SHA/document-only invalidation and redundant attestation from this
workflow. Preserve substantive native-history, limits, isolation, cleanup, and
secret-redaction checks. Remove obsolete machinery only after callers migrate.

### 5a.5 — capabilities versus enablement

Remove runtime certification state and the special pending-provider build path.
Use ordinary explicit enablement for installed adapters, retaining current safe
defaults and explicit unsupported-provider errors. Centralize declarations where
it removes actual duplication. Do not pretend this enables every mode by default
or completes outstanding all-provider behavioral validation.

### 5a.6 — verify and hand off

Run focused red/green tests, format/type/contract checks, relevant Rust tests,
and the combined regression suite. Update current development/test documentation
and annotate the original plan where Stage 5a supersedes report/formality rules.
Record actual results and any remaining blockers in this document. Commit the
stage in the existing feature worktree, keep other worktrees untouched, and do
not deploy or create a PR.

## Acceptance

The same product behavior remains expressible and supported. Durable loss state
and exact cleanup are sufficient to proceed without a second report write.
Report commentary cannot veto safe lifecycle operations. Normal production
routing is what live tests exercise. The development test workflow reports what
actually ran without a separate certificate/approval protocol. Existing failures
and missing external execution are reported honestly, not hidden by new flags.

## Execution results

Implementation is present. The following additional assumptions were checked
while implementing, rather than treating the plan as infallible:

- The canonical provider manifest becomes a production Rust build input after
  consolidation. Both upload ignore policies excluded it and the cloud Rust
  build stage did not copy it. A narrow exception and explicit COPY fix this;
  regression tests still exclude private runtime material and unrelated docs.
- Some old runtime scenarios start focused unit subtests. Their inherited
  coordinator-active marker prevented the nested invocation, even though the
  outer scenario already held the lease. A shared, single-file-only helper now
  uses the repo-owned focused runner with a child-local marker reset. The parent
  lease remains held and its environment is unchanged; broad selectors fail.
- The new browser typecheck found a prior resurrection-test bug: its output wait
  returns void, so calling .includes on that value failed after the scenario.
  The positive output wait remains the assertion; its successful result is no
  longer treated as a string. Native message IDs are narrowed before selection.
- The combined suite reached its Electron stage for the first time on this
  candidate and exposed two additional Vitest 5 constructor mocks. Only test
  doubles changed; the 14 affected tests now pass with unchanged assertions.

Delivered behavior: secondary export no longer blocks authoritative cleanup;
incident enrichment is optional and old records still deserialize; runtime
capabilities come from one declaration; explicit provider selection uses normal
production binaries; fixture/fault-injection separation remains; direct test
execution replaces certificate catalogs/importers and separate release modes.

The original 56 scenario descriptions remain. Fifty deterministic cases remain
in the raw Docker runner. Six report-only cases now execute their actual
browser/provider/soak scenario directly. Mixed cases retain their deterministic
checks and their live checks in the corresponding specs. Native-history,
resource, approval, isolation, and cleanup assertions were moved rather than
removed. Current provider/fresh-mode defaults are unchanged; the full product
still requires all original agents and all applicable recovery/operation paths.

Validation so far: 129 Rust tests pass (runtime protocol 19, provider/runtime 38,
supervisor 72); lint has zero errors and 11 existing warnings; contract generation
has no drift; TypeScript runtime/browser checks and the managed Rust server build
pass. Direct result-check tests pass, as do the build-context and runner tests.
The exact-owned Docker P5-G06 export/cleanup scenario passes with successful
cleanup and no unsafe attempts. The first full check passed client, server, and
port suites, then failed only on the subsequently fixed Electron mocks.

Final combined regression and P5-G07/P5-G08 reruns are recorded below when they
complete. The configured cloud browser backend reports BLOCKED because it
cannot host this Docker runtime. No browser fallback, actual-provider PASS,
30-minute stress PASS, full-product readiness, PR, or deployment is claimed by
these Stage 5a changes. Live provider/fresh-mode coverage remains necessary for
the full original product before changing its conservative defaults.
