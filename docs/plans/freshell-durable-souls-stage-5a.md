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
  The existing provider-version inventory was also missing from that build
  stage; both embedded JSON inputs are now copied. An offline cargo check of
  an isolated snapshot containing only the cloud Rust stage inputs passes.
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

## Final validation results

Implementation is committed on `feat/durable-souls-release-candidate`.
The main implementation commit is `00508bbc916dbc9302b85753abc690d7edd98275`;
the cloud-input follow-up changes build inputs and their regression tests only.
Logs below are relative to `.runtime-evidence/stage-5a/` in this worktree.

| Check | Actual result | Log |
|---|---|---|
| Combined `npm run check` | PASS: 12,204 passed; 30 opt-in tests skipped. Client 6,072; server 5,645; port 45; Electron 442. | `full-check-final.log` |
| Protocol, agent-runtime, supervisor Rust tests | PASS: 129 tests (19 + 38 + 72). | `rust-final.log` |
| Managed server check, including all features | PASS. | `rust-check.log`, `rust-all-features.log` |
| Client production build | PASS; existing large-chunk warning remains. | `client-build.log` |
| Runtime and affected browser TypeScript checks | PASS. | `runtime-typecheck.log` |
| ESLint | PASS: zero errors; 11 existing warnings. | `lint.log` |
| Contract generation | PASS; no generated-contract drift. | `contracts.log` |
| Direct provider/fresh-agent result and policy checks | PASS: 66 tests at the first combined focused run; later runner additions are also covered by the full check. | `direct-results-green.log` |
| Loss/chaos/soak observation checks | PASS: 35 tests. | `stress-results-green.log` |
| Build-context regression checks after final input fix | PASS: 36 tests. | `inventory-context-green.log` |
| Isolated cloud-stage Rust input snapshot, offline cargo check | PASS; this checks source-input completeness, not a full cloud image deployment. | `cloud-inputs-check.log` |
| Actual Docker P5-G06: export and cleanup failures | PASS; cleanup successful; zero unsafe attempts. | `docker-p5-g06.log` |
| Actual Docker P5-G07: crashes at loss/cleanup/notice boundaries | PASS; cleanup successful; zero unsafe attempts. | `docker-p5-g07-final.log` |
| Actual Docker P5-G08: private durable observations without invented postmortem | PASS; cleanup successful; zero unsafe attempts. | `docker-p5-g08-final.log` |
| Configured cloud browser attempt (`--only rehydrate`) | BLOCKED, exit 2: this Cloud Run backend cannot host the Docker runtime. No local fallback or skipped coverage counted as a pass. | `browser-backend.log` |

The initial failures and their fixes remain in the adjacent `*-red.log` and
first-run logs. The combined regression first exposed the inherited Electron
constructor mocks; the Docker crash matrix exposed the nested focused-runner
marker issue. Both were fixed and rerun successfully, rather than omitted.

## Remaining full-product work, not deleted scope

Stage 5a is implemented. It does not claim a new full all-provider live campaign,
a new 30-minute stress run, or execution of all 50 Docker scenarios in this task.
The relevant actual Docker loss scenarios and the ordinary regression suite
passed. Actual-provider/fresh-mode browser verification still needs an approved
Docker-capable runner; conservative defaults were not silently promoted.
Gemini/Kimi/plugin implementation gaps remain gaps in the original product,
not exclusions introduced by simplification. Complete the original provider
and operation coverage before calling the full feature deployed.

No PR or deployment was performed. The live self-hosted server was not restarted.
Other worktrees were not modified. Public lifecycle states, resource management,
view intent, credentials/authentication, durable notices, and provider operations
were deliberately left intact. There was no sweeping schema or Redux rewrite.
