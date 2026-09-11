# Durable Souls production-readiness record

**Date:** September 9, 2026.  
**Branch:** `feat/durable-souls-phase-2`.  
**Release decision:** **BLOCKED — do not ship the five-phase contract as complete.**

The ordinary regression suite is green after the fixes below. That is not a substitute for the live, candidate-bound cumulative runtime gate. No provider certification flags, required gate IDs, or release acceptance criteria were relaxed.

## Implemented and committed

| Commit | Change |
|---|---|
| `37c5c0ada4a04d77409d87e20a3762e531d9a524` | Exact native resume consumes the verified, already-owned provider store instead of repeating first-boot bootstrap. Replacement specifications drop first-boot source mounts. Activation diagnostics identify the failed stage and link the prior/replacement incarnations and recovery attempt through the existing redacted lifecycle logger. |
| `de4a282efa648e58d7f7438526752bf18dae8874` | Release qualification rejects missing/duplicate cases, unauthorized deferrals, contradictory provider scope, malformed safety counts, and ambiguous CLI options. Required artifacts must be nonempty, readable, structurally valid JSON/JSONL where applicable, and contain no symbolic links. A dirty candidate is blocked before workload creation, and candidate identity is checked again at completion. |

The four-file recovery patch was reviewed and integrated from the completed `durable-souls-recovery-fix` worktree without modifying that source worktree. Its new exact-resume worker regression was reproduced failing before the behavior fix and passing afterward in the restricted test sandbox.

The separate certification-receipt and provider-plumbing worktrees have not been integrated or qualified by these commits. The pre-existing edit to `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts` was preserved and was not included in either commit.

## Verified results

Evidence from the working-tree regression run is retained under:

```text
.runtime-evidence/5bfa0486de1fcf5cbeedbe05de78c435236743cf/readiness-hardening/
```

This directory is named for the checkout's base SHA at the start of the audit. It is **not** a clean-candidate production qualification receipt for either new commit.

| Verification | Result | Evidence |
|---|---|---|
| New release-policy regressions, before fix | 25 failed, 4 passed, demonstrating the acceptance defects | `red.log` |
| Focused release-policy, artifact-integrity, and existing receipt tests | 84 passed | `integrity-green.log` |
| Client, server, and runtime TypeScript checks | Passed | `typecheck.log` |
| Full `npm run check`, corrected environment | Exit 0: **11,896 passed, 27 optional tests skipped** | `check-node22.log`, `check-node22.exit` |
| Client portion | 5,893 passed, 8 skipped | `check-node22.log` |
| Server portion | 5,526 passed, 19 skipped | `check-node22.log` |
| Port-contract portion | 45 passed | `check-node22.log` |
| Electron portion | 432 passed | `check-node22.log` |
| Lint | Exit 0, no errors; 11 warnings in unchanged client files | `lint.log` |
| Rust formatting and compilation of changed crates, including test code | Passed | `rustfmt.log`, `rust-check.log` |
| Exact-resume real worker regression | Failed before fix; passed after fix in `--runtime-suite` | `recovery-red.log`, `recovery-focused-green.log` |
| Focused supervisor activation, redaction, and verified-empty/one-writer regressions | 3 passed in the network-isolated sandbox | `recovery-supervisor-focused-green.log` |
| Release-mode supervisor and session-host builds | Passed with Rust 1.96; binary digests retained | `release-runtime-build.log`, `release-runtime-binary-sha256.txt` |
| Ambiguous `--mode` CLI smoke | Exit 1 before workload creation, as required | `cli-ambiguous-mode.log` |
| Dirty-candidate production CLI smoke | Exit 2 with typed `BLOCKED`, no workloads created | `cli-dirty-candidate.log` |

The first full regression attempt failed with 68 server-test failures while using system Node 18 and the shared `/tmp` directory. Its log records missing `node:sqlite`, temporary-directory permission errors, and `ENOSPC`. Those results were not dismissed or hidden: the relevant 166-test diagnostic subset passed under Node 22 and the profile's home-backed temporary directory, followed by the successful full rerun. No assertions or test selection were weakened to obtain that result.

A broader multi-crate sandbox test invocation was blocked by a tool safety check and is **not** counted as passed. The focused supervisor run initially encountered an uncached dependency in the intentionally network-disabled sandbox. Cache preparation used a separate compile-only sandbox step; the actual focused tests then ran with `--runtime-suite` and `--offline`. The existing sandbox image uses Rust 1.98.1; production-target compilation was separately checked with Rust 1.96. The live release-binary runtime campaign is still required.

Final application build verification also passed (`npm run build`), including the production client bundle and compiled Node server. The additional replacement-source regression passed in the restricted sandbox. These final checks are retained under:

```text
.runtime-evidence/de4a282efa648e58d7f7438526752bf18dae8874/readiness-hardening-final/
```

Relevant files are `app-build.log` and `replacement-source-regression.log`. An explicit ESLint probe of the six changed runtime TypeScript/test files reported that the repository supplies no matching lint configuration for them; `changed-typescript-lint.log` preserves that result. Those files were typechecked and tested, but the ignored lint probe is not counted as additional lint coverage. The normal `npm run lint` result above covers its configured `src` scope.

## Outstanding ship gates

### 1. Complete and qualify the declared provider/mode scope

`docs/development/runtime-provider-capabilities.json` still records Claude, Codex, and Amplifier as `pending_live_provider_certification`, with managed enablement and durability claims disabled. Shell and OpenCode are the staged managed terminal scope. Fresh-agent modes remain disabled in that scope.

This is a staged landing policy, not completion of the execution plan's all-enabled-launch-modes contract. Review and finish the provider/mode implementation and generate real native-session qualification evidence before promoting those rows. Do not remove required providers, disable inconvenient modes, reinterpret a landing deferral as certification, or fabricate a receipt to make the production gate pass.

### 2. Resolve the browser qualification lane without silently changing backends

The profile configures `FRESHELL_E2E_BACKEND=cloud`. `test/e2e-browser/playwright.cloud.config.ts` excludes the OpenCode qualification, tab rehydration, lost-soul notice, and chaos specs because that Cloud Run image has no Docker socket for the restricted runtime broker.

`AGENTS.md` requires affected browser specs to pass on the configured backend and forbids substituting a local run without explicit approval. A skipped spec or zero-test match is not coverage. Provide a suitable approved Docker-capable qualification runner/topology, or obtain the explicit local-lane exception. No cloud-to-local browser fallback was performed in this audit.

### 3. Obtain a clean, final-candidate cumulative production PASS

Review and resolve the preserved browser-test edit and all remaining implementation work. Freeze the final commit, then generate fresh receipts tied to that exact SHA, pinned provider versions, runtime image, and built binaries. Do not reuse the dirty-tree audit receipts above as production evidence.

The final campaign must demonstrate all 56 phase cases, the complete required provider certification set, exact native recovery, one-writer/verified-empty ordering, no ambiguous tool replay, browser restoration and loss notices, the 100-web/20-controller chaos run, and the at-least-30-minute/50-soul pressure soak. It must retain the declared evidence and verify cleanup with zero unsafe broker attempts.

The production command must finish with a real `PASS` and exit 0:

```bash
npm run test:runtime -- gate phase-5 --require-live
```

A landing-campaign success that explicitly expects production `BLOCKED` is not this approval.

The audit's smoke invocation wrote a **preflight-only** blocked summary at:

```text
.runtime-evidence/5bfa0486de1fcf5cbeedbe05de78c435236743cf/04a5618b-b9d6-4420-b74a-4f3b04a1017e/summary.json
```

It records `blockedReason: uncommitted_or_changed_candidate`, zero executed phase cases, and no required workload cleanup. It proves the new refusal boundary, not runtime behavior.

## Reproducing ordinary checks on this host

Use the configured home-backed temporary directory and pin the npm entrypoint to Node 22 explicitly so nested commands cannot start under system Node 18:

```bash
export PATH="$HOME/.local/share/mise/installs/node/22/bin:$HOME/.local/bin:$PATH"
export TMPDIR="$HOME/tmp"
NODE22="$HOME/.local/share/mise/installs/node/22/bin/node"
NPM22="$HOME/.local/share/mise/installs/node/22/lib/node_modules/npm/bin/npm-cli.js"
FRESHELL_TEST_SUMMARY='Durable Souls final-candidate regression check' \
  "$NODE22" "$NPM22" run check
```

Keep destructive tests in the approved sandbox or restricted runtime harness. Do not run broad destructive Rust suites against the host, modify foreign worktrees, or clean up processes/containers by name or label searches.

No PR was opened, no feature branch was pushed, and the live port-3001 server was not restarted or redeployed. Production restart still requires the explicit approval specified in `AGENTS.md`.
