# Session-list performance work: pause and resume handoff

**Prepared:** 2026-08-15  
**Audience:** program/product manager and the engineer or agent who resumes the work  
**Status:** paused before product implementation  
**Original work item:** [Kata `freshell#0gdd`](#original-kata-freshell0gdd)  
**Authoritative implementation plan:** [2026-08-13-session-directory-lazy-page-prep.md](./2026-08-13-session-directory-lazy-page-prep.md)

Resume kata: freshell#k68e

## Executive summary

The product goal is to make Freshell's session list use much less processor time without removing, hiding, or weakening access to any session history.

Today, a request for about 50 visible sessions prepares information for roughly 28,000 sessions first. The intended change keeps the complete catalog and still searches and orders it correctly, but performs the expensive final preparation only for the page returned to the browser.

The product change has **not started**. No product source or product test has been changed. The saved branch contains only the earlier implementation plan, plus this handoff as the one new uncommitted documentation file.

Work paused because the normal shared cloud test runner could not reliably prove that simultaneous test runs were isolated and that the exact saved code was tested. A large one-off helper was built for this branch. It found important problems and produced historical test evidence, but it became more complicated than the feature and was superseded by a user-approved prerequisite: fix the shared project test runner once, merge that fix to `main`, and then resume this feature using the normal project commands.

**Do not patch, rerun, or accept results from the one-off helper.** Preserve it and its records only as historical evidence.

The prerequisite cloud-runner work must also satisfy the newer, stricter product requirement: every Linux-compatible test group available locally must be covered in the cloud by default. There may be no cloud-only skip list or quietly omitted files. Windows- and Mac-native checks stay local on machines running those operating systems. Private-data and paid-provider checks may remain separate, but they must be named explicitly and must never be silently counted as covered.

## Plain-language status

### Finished

- The processor problem was investigated and the main session-list waste was identified.
- The product promise was defined: all history, search, ordering, page behavior, counts, fields, cursors, revision values, and visible behavior stay the same.
- A detailed seven-step implementation plan was written and reviewed repeatedly.
- Historical baseline checks were run against the old plan-only code.
- The branch and its historical evidence are preserved.
- The user approved replacing the shared cloud runner in place and approved eventually landing this feature through a pull request.

### Not finished

- No new behavior tests have been added to `session_directory.rs`.
- No session-list implementation code has been changed.
- None of the seven feature-plan tasks has been accepted as complete.
- The branch has no pull request.
- The shared cloud runner prerequisite has not yet been merged to `main`.
- The prior cloud baseline cannot be reused because it skipped 20 tests and because its custom evidence format was rejected by the mandatory review.

## 1. Goal and non-negotiable product promise

The endpoint behind the session sidebar currently performs whole-catalog work before returning a small page. The current route prepares all rows, applies saved user changes and metadata, combines running terminal state, sorts, filters, searches, and only then returns the requested limit. The investigated production scale was roughly 28,000 sessions, while a normal request asks for about 50.

The goal is:

> Keep the complete session catalog and all existing behavior, while limiting expensive full-row preparation and response construction to the rows actually returned.

The change must preserve all of the following:

- every stored session remains available;
- old sessions remain searchable and openable;
- searches still consider the complete eligible catalog;
- returned rows and their order remain identical for the same captured inputs;
- pagination boundaries remain identical;
- no row is lost because it was just outside a page before a title, deletion, running-state, or metadata change was applied;
- all existing response fields and field-omission rules remain identical;
- cursor values and cursor continuation behavior remain identical;
- revision values remain identical across pages for fixed inputs;
- partial-search behavior and reasons remain identical;
- no totals or counts are added, removed, or changed;
- exact response bytes remain unchanged where the plan captures them literally;
- no history is deleted, hidden, truncated, or made less searchable as a performance shortcut.

The authoritative plan states this contract at `docs/plans/2026-08-13-session-directory-lazy-page-prep.md:7-13` and records the current policy facts at `docs/plans/2026-08-13-session-directory-lazy-page-prep.md:256-289`.

## 2. Why the work is paused

### The immediate reason

The saved `the-usual` workflow is at its stop guard. Its mandatory Task 1 review rejected the one-off cloud evidence format for two reasons:

1. `cloud-baseline-accepted.json` was required to name the branch, but the prescribed writer omitted it.
2. The linked acceptance was required to copy every cleanup field, but the custom helper omitted `cleanupError` from that acceptance record.

The active recipe result records this exact blocker. Directly resuming the recipe now would enter `execute-halt-guard` and fail; it would not begin product implementation.

### The larger reason

The custom helper was a diagnostic tool, not a good permanent design. It accumulated its own:

- image and job identity rules;
- result formats and acceptance records;
- cleanup records;
- script fingerprint checks;
- retry history;
- separate baseline receipt;
- branch-specific instructions.

It successfully exposed weaknesses in the shared cloud runner, but continuing to patch it would create a second testing system that future work could accidentally choose instead of the project-supported one.

The user therefore chose this order:

1. replace the unsafe shared cloud behavior in place;
2. merge that reusable change to `main`;
3. resume this feature using only the normal shared runner;
4. never patch or resume the branch-specific helper.

### Superseded one-off workflow

The following items are obsolete as an execution path:

- `pinned-vitest-cloud-v1.sh`;
- `pinned-cloud-runs.jsonl`;
- `cloud-baseline-accepted.json`;
- the separate custom `accept` operation;
- the plan's custom adapter fingerprint checks;
- the plan's custom attempt, acceptance, and baseline linkage checks.

They remain evidence only. Do not edit them to make the old run acceptable, do not append a new run, and do not use their prior success as authorization to skip a fresh baseline.

## 3. User-approved cloud-testing success criteria

The shared runner prerequisite is a product requirement, not merely a cleanup of this branch.

### One set of tests, two places to run it

- The project keeps one definition for each test.
- Linux-compatible tests can run in the cloud or locally.
- Cloud execution copies the ability to run the tests; it does not move or fork the test definitions.
- A test must not have one expected behavior locally and another in the cloud.

### Default placement

- Heavy Linux-compatible test work runs in the cloud by default.
- Focused tests remain available locally for edit-and-debug cycles.
- The complete Linux-compatible suite remains available locally for cloud outages and deliberate local confirmation.
- A failed or unavailable cloud run must stop clearly. It must **not** silently start a heavy local run.

### Parallel use

Multiple agents must be able to start complete cloud runs at the same time.

Each run must have:

- the exact saved code it is testing;
- its own immutable image identity;
- its own temporary cloud job;
- its own exact execution result;
- cleanup limited to its own temporary resources.

One run must not replace, select, update, accept, or delete another run's image, job, or result. The local coordinator must not serialize otherwise independent cloud runs across worktrees.

### Platform boundary

- Linux-compatible tests run in the Linux cloud by default.
- Windows-native checks run locally on a Windows machine.
- Mac-native checks run locally on a Mac.
- Freshell will not create custom Windows or Mac cloud machines for this work.
- Platform-specific checks are separate named lanes; they are not silently counted as Linux-cloud coverage.

### No skipped cloud coverage

For every Linux-compatible test group available in cloud:

- the cloud and local test-file inventories must match;
- there may be no cloud-only skip list;
- there may be no omitted test files;
- no compatible test may be skipped merely because it is running in cloud;
- a skip or exclusion must be explicitly classified as Windows-native, Mac-native, private-data, or paid-provider work;
- separate lanes must be reported by name and must never be counted as passed by the main cloud result.

The historical result of 20 skipped tests does **not** satisfy this criterion.

## 4. Exact saved state

This section records the read-only snapshot taken before this handoff file was created.

### Recipe state

| Item | Exact value |
|---|---|
| Recipe session | `5cece3d2222f4b0d-20260813-203431_recipe` |
| Recipe | `the-usual` version `3.8.0` |
| Current step index | `9` |
| Current step | `execute-halt-guard` |
| Last completed step | `execute-collect`, index `8` |
| Accepted feature tasks | `0/7` |
| Final review verdict | `n/a` |
| Safe direct resume now | **No**; it would enter the halt guard |

Completed recipe stages are exactly:

1. `workspace-setup`
2. `write-plan`
3. `write-plan-collect`
4. `load-bearing`
5. `load-bearing-collect`
6. `fresheyes-plan`
7. `execute-plan`
8. `execute-collect`

The workflow's active result says that Task 1's focused Rust, browser, cloud, and Electron commands completed, but the mandatory review rejected the evidence schema. It therefore accepted no task and stopped before Task 2.

### Git and GitHub state

| Item | Exact value |
|---|---|
| Worktree | `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep` |
| Branch | `the-usual/session-directory-lazy-page-prep` |
| Local HEAD | `f2c3807c34164162c5d1703663fc7c93f59230da` |
| Remote branch HEAD | `f2c3807c34164162c5d1703663fc7c93f59230da` |
| Frozen base | `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` |
| Live `origin/main` at snapshot | `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` |
| Merge base | `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` |
| Difference from `origin/main` | 11 commits ahead, 0 behind |
| Configured upstream | none |
| Pull request from this branch | none; read-only GitHub query returned `[]` |
| Committed branch delta | one added file: `docs/plans/2026-08-13-session-directory-lazy-page-prep.md` |
| Product source changes | none |
| Product test changes | none |

Before this handoff was created, the target worktree was clean. After this handoff is written, the expected and only worktree change is:

```text
?? docs/plans/2026-08-15-session-directory-lazy-page-prep-handoff.md
```

The committed branch still contains only the original plan. No product code or tests have been implemented.

### Authority when records disagree

The current Task 1 report begins with `DONE`, because its executor finished all commands. The later mandatory review rejected the evidence format. The recipe state, active execution result, and progress ledger therefore record `0/7` and blocked.

For resumption, use this rule:

> The recipe's later mandatory-review result is authoritative. The Task 1 report is historical command evidence, not accepted workflow progress.

## 5. Historical test evidence — useful, but not reusable

The latest Task 1 command report records the following baseline against plan-only HEAD `f2c3807c...`:

| Check | Historical result |
|---|---:|
| Focused Rust session-directory tests | 68 passed, 0 failed, 0 ignored |
| Rust-backed browser session-directory matrix | 7 passed, 0 failed |
| Cloud tasks | 4 succeeded, 0 failed |
| Cloud test aggregate | 9,952 passed, 20 skipped, 0 failed |
| Local Electron unit tests | 350 passed, 0 failed |

Source: `/home/dan/code/freshell/.git/worktrees/session-directory-lazy-page-prep/sdd/task-1-report.md:86-203`.

These results are **historical only** for four independent reasons:

1. The mandatory Task 1 review rejected the custom evidence schema afterward.
2. The shared runner prerequisite will change the test machinery and must be tested on a newer `main`.
3. The feature branch must be updated to that newer `main`, producing a different baseline code version.
4. The 20 skipped cloud tests violate the newly approved no-skipped-cloud-coverage criterion unless each is moved into an explicitly named non-Linux/private/paid lane. The old report did not establish that.

Do not reuse the old cloud image, job, execution, attempt, acceptance, baseline receipt, browser result, Electron result, or Rust result as the new Task 1 baseline.

## 6. Active files and exact fingerprints

These fingerprints describe the active saved state. They are for identification and audit, not an invitation to edit evidence files.

| Artifact | Absolute path | SHA-256 |
|---|---|---|
| Recipe state | `/home/dan/.amplifier/projects/{project}/recipe-sessions/home-dan-code-freshell/recipe-sessions/5cece3d2222f4b0d-20260813-203431_recipe/state.json` | `bb20cf95bd1ae58e39695658756d3114e7952bf694dd4d8086b1b9618354cdb6` |
| Authoritative plan | `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/plans/2026-08-13-session-directory-lazy-page-prep.md` | `5aa2f0a96e58027967557ee8854ebdbde283823e331718b5f145821c99bfb6b1` |
| Obsolete one-off adapter | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pinned-vitest-cloud-v1.sh` | `ef22952c8ef53ebdabae899159730d3d1745d9197382d77a2975647b2036d2ed` |
| Historical cloud record log | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pinned-cloud-runs.jsonl` | `d0fc29bc3fe5717c498204142020ea169fc9d75466ad0d40438257aa2c658d28` |
| Historical baseline receipt | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/cloud-baseline-accepted.json` | `c9e2d780ce38540fefe6a76191c738e9fe9a2c102c4b6b40915bde40c10bbf04` |
| Active execute result | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/execute-result.json` | `1062799b88c61812762e90b35571ba3c9fcfb380092a6c8429ba62555905b915` |
| Active pending output | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pending-output.json` | `1062799b88c61812762e90b35571ba3c9fcfb380092a6c8429ba62555905b915` |
| Current Task 1 report | `/home/dan/code/freshell/.git/worktrees/session-directory-lazy-page-prep/sdd/task-1-report.md` | `261a23d7c79cf9368e81c85cc3eb394080a39d6c36c88bfb2f00cacc363393c1` |
| Progress ledger | `/home/dan/code/freshell/.git/worktrees/session-directory-lazy-page-prep/sdd/progress.md` | `95e6d9a14eafcdd73d2bfa7d3e0348c4ec4006a57f4c428a226d93fe5d9edee6` |

### Historical review receipts

| Review | Absolute path | SHA-256 |
|---|---|---|
| Amendment 4 | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-4-independent-review.md` | `7d0ae4c92ad9c261428b30f92579d4b40bbad1a69e747217d32c6af8197c69f3` |
| Amendment 5 | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-5-independent-review.md` | `b72f6dce47e1c5a15b072b54184273850eba7275d6355f82c455a2cac5d9d2c1` |
| Amendment 6 | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-6-independent-review.md` | `cd68aafadbf3a0f00eb069b5fd75884d37800f7d4447e3effb99c4e06a316d91` |
| Amendment 7 | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-7-independent-review.md` | `ee245ee551e7d7a661c870a676d87a49164bd661ea398eaf266fe0e62b4f6e4d` |
| Amendment 8 | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-8-independent-review.md` | `d0a3353fe3692b9ae18c46855851acd327323fc0810eda0a8a170bb3e4ef3252` |
| Load-bearing ledger | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/load-bearing-ledger.md` | `62779ce935e65c9034aad4a22b0413a15b585b6a24c4ca1110d14982114c54da` |
| Plan self-review history | `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/writing-plans-self-review.md` | `938877d111925efbbbb3f4365e7669aa52c425184707de3f7d8275104c65c146` |

Fingerprints will naturally stop matching if an authorized archival process appends an audit entry. The rule is not “force the hash to stay forever”; the rule is “never rewrite old evidence to make a failed or rejected result look accepted.”

## 7. Prerequisite exit gate before this feature may resume

Do not resume the feature merely because a cloud-runner pull request exists. Resume only after the shared runner is merged to `main` and the following facts have objective evidence.

### A. Exact code is tested

- A cloud run packages a committed code version, not dirty working files.
- The image has an immutable identity tied to that committed version.
- The temporary job runs that exact image.
- The result identifies the exact job and exact execution.
- There is no mutable `latest` selection and no “most recent execution” fallback.

**Objective check:** run from a clean branch, record the branch commit, cloud image identity, job name, and execution name, and prove all four refer to that same commit.

### B. Simultaneous runs are isolated

- Two agents can start full cloud runs from two worktrees at the same time.
- They receive different image/run identities and different temporary jobs.
- Neither run waits on a local global lock intended only for local heavy tests.
- Neither run changes, accepts, or deletes the other's resources.

**Objective check:** launch two overlapping runs against two distinct saved commits, require both to finish, and verify each result and cleanup belongs only to its own commit.

### C. Cleanup is reliable

- A successful run deletes its own temporary job.
- A failed run attempts to delete its own temporary job.
- Cleanup failure is reported as failure, not success.
- No shared or foreign job is updated or deleted.

**Objective check:** exercise success, test failure, interrupted execution, and cleanup failure with no-cost fakes; then verify one real successful run leaves no temporary job.

### D. Linux cloud coverage matches local coverage

- The local and cloud inventories for every Linux-compatible group are identical.
- There is no cloud-only skip file or exclusion list.
- Every omitted lane is explicitly named and classified.
- A summary must not say “full suite passed” while compatible files were omitted.

**Objective check:** generate machine-readable local and cloud inventories and require set equality for Linux-compatible test files and named test cases. Require zero unexplained cloud-only skips. The historical `9,952 passed / 20 skipped` result is not sufficient.

### E. Local execution remains available

- One test can run locally.
- One file can run locally.
- One test group can run locally.
- The complete Linux-compatible suite can run locally by explicit request.

**Objective check:** run one focused local test and one explicit complete local run using the merged project's documented commands.

### F. Cloud failure never silently starts heavy local work

**Objective check:** make the cloud backend unavailable in a controlled test. The command must exit clearly and print the explicit local alternative. It must not start the full local suite automatically.

### G. Windows and Mac boundaries are explicit

- Windows-native checks are documented as local-on-Windows.
- Mac-native checks are documented as local-on-Mac.
- These checks are not reported as covered by the Linux cloud run.
- Private-data and paid-provider checks are also named separately.

Only after A through G pass and the change is merged to `main` is the prerequisite complete.

## 8. Supported resume procedure

Follow this order. Do not skip directly to implementation.

### Step 1 — archive the active stop

Ask `foundation:session-analyst` to archive the active `execute-result.json` and `pending-output.json`, preserve the current Task 1 report and progress ledger, and produce an auditable receipt.

Do not manually edit `state.json`. Do not delete the active result files yourself. Do not mark Task 1 complete.

### Step 2 — update the feature branch from the new `main`

After the shared runner is merged:

1. update local `main` from `origin/main` by fast-forward only;
2. fetch the exact new `origin/main`;
3. record historical feature head `f2c3807c34164162c5d1703663fc7c93f59230da` in the archival receipt and amended plan;
4. integrate the new `origin/main` into `the-usual/session-directory-lazy-page-prep` with a non-destructive Git operation that keeps the historical head reachable;
5. do not discard the eleven plan commits;
6. do not force-push over the historical remote branch;
7. resolve only real conflicts, with special attention to the shared runner's commands and test configuration.

A normal merge of the new `origin/main` into the feature branch is the simplest way to preserve `f2c3807c...` as an ancestor. If `git-ops` selects another method, it must still preserve an auditable reference to that historical head.

### Step 3 — refresh the worktree tools

From the target worktree, reinstall JavaScript dependencies from the merged lockfile using the repository-supported clean install. The prior supported command was:

```bash
env -u NODE_ENV \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npm ci --include=dev --no-audit --no-fund
```

Then rebuild only what the updated Task 1 requires. Do not assume the old `node_modules`, Rust release binary, browser output, or cloud image is current after merging `main`.

### Step 4 — amend the authoritative plan

Before resuming the recipe, update `docs/plans/2026-08-13-session-directory-lazy-page-prep.md` so it uses the normal merged runner.

Remove **all** active execution dependencies on:

- `pinned-vitest-cloud-v1.sh`;
- `FRESHELL_VITEST_CLOUD_SCRIPT`;
- `FRESHELL_PINNED_CLOUD_*` variables;
- `pinned-cloud-runs.jsonl`;
- the separate adapter `accept` command;
- custom attempt and acceptance records;
- `cloud-baseline-accepted.json`;
- adapter fingerprints;
- Amendment 4–8 receipts as runtime authorization;
- old custom image/job/execution parsing instructions;
- any requirement to append or reconcile the obsolete ledger.

Replace those instructions with the normal shared commands and receipts introduced by the merged prerequisite. Preserve the product tasks and behavior rules unless the new `main` changed the relevant code and an evidence-based plan review requires an adjustment.

Also update Task 1 and Task 7 so:

- the full Linux-compatible cloud run has no skipped compatible coverage;
- focused and complete local alternatives remain documented;
- cloud failure does not trigger local work automatically;
- the new baseline is run against the updated exact branch commit;
- no old result can satisfy the new gate.

### Step 5 — independently review and commit the amended plan

- Run a fresh plan review against the updated `main` and actual shared runner.
- Resolve every blocking finding.
- Commit the amended plan and this handoff with normal attribution.
- Keep product source unchanged until the review passes.
- Record the new plan commit and review receipt.

### Step 6 — perform an auditable recipe rewind

Ask `foundation:session-analyst` to:

- create an exact backup of current recipe state;
- archive the current blocked result and pending output;
- remove `execute-plan` and `execute-collect` from active completed state;
- remove the stale active `execute_result` from recipe context;
- set `current_step_index` to `7` (`execute-plan`);
- preserve `0/7` feature-task progress;
- preserve all prior repair and blocked-history records;
- produce a repair receipt and validate the recipe state.

Do not manually change recipe JSON. Do not resume until the analyst reports the state is safe.

### Step 7 — restart Task 1 from its first check

Run every updated Task 1 check fresh against the new committed plan-only branch state.

Do not resume at Electron, cloud acceptance, or receipt validation. Do not reuse:

- 68 focused Rust passes;
- 7 browser passes;
- 9,952 cloud passes;
- 20 cloud skips;
- 350 Electron passes;
- the old cloud image;
- the old job or execution;
- the old custom attempt or acceptance;
- the old baseline receipt.

Task 2 may start only after the new Task 1 is accepted by its mandatory review.

## 9. Product implementation guardrails

### Plain-language glossary

- **Lightweight selected row:** enough information to decide whether a session belongs on the page and where it belongs, without constructing every response field.
- **Full materialization:** building the complete session row returned to the browser, including all overlays and running-state fields.
- **Lookahead row:** one extra eligible row used only to know whether another page exists.
- **Cursor:** the opaque value the browser sends to request the next page.
- **Revision:** the route's full-catalog recency value; it is not merely the newest visible row.
- **Partial result:** a search response that stopped because of its existing scan budget or an input/output error.

### Keep one policy

There must be exactly one production implementation for:

- applying saved title, summary, archive, and deletion changes;
- combining running terminal identity;
- deciding visibility;
- ordering sessions;
- comparing a row with a cursor;
- selecting rows;
- searching;
- building full response rows;
- serializing the response.

Do not keep old and new implementations side by side. Do not create a test-only copy of the old rules. Tests must use fixed expected answers through the real authenticated route, not calculate expected answers with copied production logic.

### Preserve deep-search stopping behavior

For user-message and full-text search, the current loop stops after finding `limit + 1` matches. The exact check order remains:

1. stop if the lookahead match already exists;
2. check the scan budget;
3. check for a source path;
4. check whether the provider is supported;
5. increment the scan count;
6. read and search the file.

Do not inspect a later candidate after the lookahead exists. Doing so can reveal a later file error or budget stop and change `partial` or `partialReason`.

### Preserve overlays and live-session behavior

Tests must cover at least:

- a deleted newest row and backfill from the next eligible row;
- title and summary changes;
- archived rows;
- a running indexed session;
- a running terminal with no known session ID;
- a known live session that is not yet indexed;
- a deleted indexed session reappearing as a live session;
- providerless live identity affecting revision but not adding a row;
- duplicate identities where the first supplied identity currently wins;
- subagent, non-interactive, empty, whitespace-only, and running-empty visibility;
- all-hidden pages;
- exact provider names and field omissions.

### Preserve ordering, pages, cursors, and revision

- Sort by descending activity, then descending full `provider:sessionId` key.
- Use the same relation for sorting and strict cursor continuation.
- Preserve behavior for equal timestamps and stable duplicate keys.
- Preserve page boundaries at 0, 1, `limit`, and `limit + 1` rows.
- Derive the next cursor from the last returned row, never the lookahead row.
- Preserve the full-catalog revision, including hidden and providerless identity contributions.
- Preserve the ignored request `revision` parameter.
- Preserve exact malformed-cursor errors and accepted extra cursor fields.

### Preserve search behavior

- Title search checks title, summary, then first user message.
- Title search does not search project-path or working-directory leaves.
- User-message search ignores assistant-only hits.
- Full-text search can match assistant messages.
- Search stays case-insensitive.
- Snippet length and contents remain exact.
- Budget and input/output partial reasons retain their current precedence.

The detailed literal fixtures and expected values remain in `docs/plans/2026-08-13-session-directory-lazy-page-prep.md:291-470`.

## 10. Test-first implementation and acceptance

### Characterize behavior before changing it

Tasks 2 and 3 must first add fixed, real-route tests for current behavior. They must call the authenticated Axum route, collect the complete response, and compare literal expected values and bytes.

The tests must pass against the unchanged implementation before production policy work begins. A test that computes its expected order, cursor, visibility, search result, or response through the same rules as production is not an independent test.

### Prove the current waste with a failing structural test

Do not use elapsed time as the pass/fail test. Machine load, compilation, and cloud scheduling make timer tests unreliable.

Use test-only counters to prove how much work the request performs:

- peak lightweight selections;
- search annotations created;
- indexed rows fully materialized;
- synthesized rows fully materialized;
- rows serialized.

Against the deliberately pre-bound checkpoint, record a real failing test showing unnecessary preparation. The original plan's `limit=1`, 52-row sentinels are the expected RED evidence:

- no query: 52 selected and 52 materialized;
- title search: 52 selected, 52 annotations, and 52 materialized;
- deep searches: 2 selected and annotated, but both materialized even though only 1 is returned.

### Implement the minimum bound and prove GREEN

For an effective page limit `L`:

- retain at most `L + 1` lightweight selected rows;
- retain at most `L + 1` search annotations;
- fully materialize at most `L` rows;
- serialize at most `L` rows;
- preserve all route output and page behavior.

Run the identical structural command after the implementation and require it to pass. Cover every accepted limit from 1 through 50, page boundaries, all-hidden input, all four query modes, indexed rows, and synthesized live rows.

### Same tests locally and in cloud

- Local and cloud execution must use the same test definitions.
- No Linux-compatible file may be removed or skipped only in cloud.
- Focused local runs are encouraged during development.
- The final complete Linux-compatible run is cloud by default.
- An explicit complete local run remains available and should be used when needed, not started silently.

### Measure operational effect after landing

Structural tests prove the amount of work is bounded; they do not prove the real processor improvement.

After landing, measure before and after on the same representative large catalog:

- processor time attributable to session-directory requests;
- request work for a 50-row page;
- steady server processor use with the same clients connected;
- whether the remaining background sweeps or client request loop dominate after this slice.

Report measured results. Do not claim this first slice fixes the entire chronic processor baseline if the measurements show other causes remain.

A live production-server restart or server-side deployment still requires the user's explicit word **`APPROVED`**. The code may be built and tested on scratch ports without that approval.

## 11. Risks and traps

### Critical warnings

1. **Do not execute the current plan as written.** Its Task 1 and Task 7 still depend on the superseded custom helper.
2. **Do not directly resume the recipe at index 9.** It will replay the halt guard, not start implementation.
3. **Do not edit recipe state by hand.** Use an auditable session-analyst rewind with backups and receipts.
4. **Do not repair the old JSONL or baseline receipt.** Their contradiction is historical evidence.
5. **Do not accept the Task 1 report's `DONE` label.** The later mandatory review is authoritative and says blocked, `0/7`.
6. **Do not reuse the old cloud result.** It contains 20 skips and predates the shared runner.
7. **Do not page before applying rules that can change membership or order.** A row just outside the raw page can belong inside the effective page.
8. **Do not optimize search by searching only the returned page.** All eligible history remains searchable.
9. **Do not scan beyond deep-search lookahead.** That changes partial-result behavior.
10. **Do not duplicate production rules in tests.** A copied mistake can make both implementation and test agree incorrectly.
11. **Do not add a cache, total count, new public paging interface, or wire change.** They are outside this slice.
12. **Do not use elapsed time as the correctness gate.** Use structural work counters, then measure real performance separately.
13. **Do not let cloud failure trigger a heavy local fallback.** Fail clearly and offer the explicit local command.
14. **Do not allow cloud-only skips or omitted Linux-compatible files.** Separate platform/private/paid lanes must be named.
15. **Do not use broad process-kill commands.** Scratch servers must have recorded, verified PIDs.
16. **Do not restart the live server without `APPROVED`.**

### Branch-update trap

The branch is based on old `main`. The shared runner prerequisite will change `main`. Updating the feature branch may change test scripts, package locks, and plan commands. Revalidate every command after integration; do not assume line numbers or old runner behavior remain current.

### Build-warmth trap

A historical browser run initially timed out because a three-minute Rust release build occurred inside a one-minute fixture setup. Later runs prebuilt the binary. After updating `main`, treat caches and binaries as stale and use the current repository-supported setup. Do not hide this by increasing an unrelated browser timeout.

### Scope trap

Kata `0gdd` covers the wider chronic processor baseline. This session-list page-bound change is one high-confidence slice. Other identified causes include periodic full-catalog sweeps and a client/server refresh loop. Landing this slice does not automatically close the wider investigation.

## 12. Immutable history and “do not touch” guidance

The following paths are audit history. Read them as needed; do not rewrite or delete them.

### Recipe repair history

```text
/home/dan/.amplifier/projects/{project}/recipe-sessions/home-dan-code-freshell/recipe-sessions/5cece3d2222f4b0d-20260813-203431_recipe/repairs/
```

This directory contains exact before/after states and repair receipts from prior authorized rewinds. Preserve every generation.

### Blocked-run history

```text
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/blocked-history/
```

Preserve every archived stop, report, screenshot, coordinator record, and manifest.

### Active stop to archive, not overwrite

```text
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/execute-result.json
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pending-output.json
/home/dan/code/freshell/.git/worktrees/session-directory-lazy-page-prep/sdd/task-1-report.md
/home/dan/code/freshell/.git/worktrees/session-directory-lazy-page-prep/sdd/progress.md
```

Have `foundation:session-analyst` archive the active result files before rewind. Preserve the current Task 1 report and progress ledger as historical evidence even though their `DONE`/blocked sequence requires explanation.

### Superseded custom cloud evidence

```text
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pinned-vitest-cloud-v1.sh
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pinned-cloud-runs.jsonl
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/cloud-baseline-accepted.json
```

Do not patch the script, append a retry, add missing fields, accept an old attempt, or delete a row.

### Plan-review history

```text
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-4-independent-review.md
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-5-independent-review.md
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-6-independent-review.md
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-7-independent-review.md
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/reports/amendment-8-independent-review.md
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/load-bearing-ledger.md
/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/writing-plans-self-review.md
```

These explain why the plan evolved. They are not runtime prerequisites after the shared runner replaces the custom workflow.

## 13. Git and delivery rules

- Continue in the dedicated worktree:
  `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep`.
- Continue on branch:
  `the-usual/session-directory-lazy-page-prep`.
- Do not implement on local `main`.
- First land the shared cloud-runner prerequisite separately on `main`.
- Fast-forward local `main` to the merged remote `main`.
- Update the feature branch safely from that merged `main` while preserving historical head `f2c3807c...`.
- Keep the feature's source changes focused. The current product plan expects only
  `crates/freshell-server/src/session_directory.rs` to change; revalidate that scope after integrating new `main`.
- Push the feature branch normally; do not force over historical evidence.
- The user has already explicitly approved eventual pull-request creation for this feature.
- Open the feature pull request only after `the-usual` finishes and all required checks pass.
- Target `main`.
- Wait for required checks, merge according to repository policy, then fast-forward local `main` from `origin/main`.
- Clean up the feature worktree and branches only after merge and after confirming no live process uses the worktree.
- Do not deploy or restart the live Rust server on port 3001 without the user's explicit word `APPROVED`.
- Update kata records with real pull-request and merged-commit evidence. Do not close the broader `0gdd` task unless its wider processor-baseline acceptance is actually satisfied.

## 14. Resume checklist

Copy this checklist into the resume task and check each item with real evidence.

```markdown
### Shared-runner prerequisite

- [ ] The shared cloud-runner change is merged to `main`.
- [ ] Heavy Linux-compatible tests run in cloud by default.
- [ ] Cloud and local use one test definition per suite.
- [ ] Two simultaneous runs from different worktrees/commits pass without interference.
- [ ] Each run uses exact committed code, an immutable image, a unique temporary job, and its exact result.
- [ ] Success, failure, interruption, and cleanup behavior are tested.
- [ ] No Linux-compatible test file or case is skipped or omitted only in cloud.
- [ ] Windows-native and Mac-native checks are explicitly local on matching machines.
- [ ] Private-data and paid-provider lanes are explicitly named and not counted as covered.
- [ ] Focused local testing works.
- [ ] An explicit complete local suite works.
- [ ] Cloud failure exits clearly and does not silently start a heavy local run.

### Preserve and update the feature branch

- [ ] Record historical HEAD `f2c3807c34164162c5d1703663fc7c93f59230da`.
- [ ] Ask `foundation:session-analyst` to archive the active stop with a receipt.
- [ ] Fast-forward local `main` to the merged `origin/main`.
- [ ] Integrate the new `origin/main` into `the-usual/session-directory-lazy-page-prep` without losing the historical head.
- [ ] Reinstall dependencies from the merged lockfile.
- [ ] Treat old build outputs as stale and rebuild only what the updated plan requires.

### Replace the obsolete plan workflow

- [ ] Remove every active plan dependency on the one-off adapter.
- [ ] Remove every active plan dependency on the custom JSONL, accept step, and baseline receipt.
- [ ] Replace Task 1 and Task 7 with the normal merged shared-runner commands.
- [ ] Require complete Linux-compatible cloud coverage with no cloud-only skips.
- [ ] Preserve explicit focused and complete local alternatives.
- [ ] Preserve every product-behavior guardrail.
- [ ] Independently review the complete amended plan.
- [ ] Resolve all blocking findings.
- [ ] Commit the reviewed plan and handoff before product source work.

### Rewind and restart `the-usual`

- [ ] Ask `foundation:session-analyst` for an auditable rewind to `execute-plan`, index 7.
- [ ] Preserve `0/7` accepted feature-task progress.
- [ ] Verify active stale result files are archived, not deleted without a receipt.
- [ ] Validate the repaired recipe state.
- [ ] Restart Task 1 from its first check.
- [ ] Reuse none of the old Rust/browser/cloud/Electron results.
- [ ] Begin Task 2 only after the new Task 1 passes mandatory review.

### Implement and land

- [ ] Add literal real-route behavior tests before policy changes.
- [ ] Keep exactly one production policy and no copied expected-value policy.
- [ ] Record genuine structural RED for unnecessary preparation.
- [ ] Implement at most `limit + 1` lightweight selections and at most `limit` full materializations.
- [ ] Preserve deep-search lookahead order and partial-result behavior.
- [ ] Pass identical-command GREEN and all limits/boundaries/edge cases.
- [ ] Pass focused checks and the complete no-skipped-coverage cloud suite.
- [ ] Complete independent code review.
- [ ] Push the branch and open the already-approved pull request to `main`.
- [ ] Wait for required checks and merge.
- [ ] Fast-forward local `main` and clean up safely.
- [ ] Measure and report before/after request work and server processor use.
- [ ] Do not restart or deploy the live server without `APPROVED`.
- [ ] Update the resume kata and original kata with real PR/merge/measurement evidence.
```

## 15. Definition of done

The session-list performance work is done only when all of the following are true.

### Testing foundation

- The shared runner prerequisite is merged on `main`.
- Complete Linux-compatible cloud runs are safe for simultaneous agents.
- Cloud runs test exact committed code with isolated resources and reliable cleanup.
- No Linux-compatible cloud coverage is skipped or omitted.
- Focused and complete local execution remain available.
- Cloud failure never silently triggers a heavy local run.
- Windows- and Mac-native checks remain explicit local lanes on matching systems.

### Product behavior

- All session history remains stored, searchable, pageable, and openable.
- Returned rows, order, page boundaries, cursor behavior, revision, partial fields, counts, response fields, omissions, and captured bytes remain unchanged.
- Overrides, deletion, archive, live identity, synthesized sessions, duplicates, visibility flags, searches, and edge cases are covered by literal real-route expectations.
- There is exactly one production policy, selector, materializer, and serializer.

### Work bound

For page limit `L` across every accepted limit 1–50 and all query modes:

- no more than `L + 1` lightweight selected rows are retained;
- no more than `L + 1` annotations are retained;
- no more than `L` rows are fully materialized;
- no more than `L` rows are serialized;
- deep search never inspects beyond its existing lookahead stop;
- the same structural command proves RED before and GREEN after the implementation.

### Verification and delivery

- Focused tests pass.
- Full Linux-compatible cloud coverage passes with no unexplained skips.
- Explicit local fallback commands are verified.
- Required formatting, compilation, lint, sandbox, browser, and review gates pass.
- The feature pull request is merged to `main`.
- Local `main` is fast-forwarded to the merged state.
- The worktree and branches are cleaned up safely.
- Before/after processor and request-work measurements are recorded.
- No live server restart or deployment occurs without `APPROVED`.
- The resume kata is updated with the handoff, PR, merge, and measurement evidence.
- Kata `0gdd` is updated honestly; it remains open if other chronic processor causes remain.

## Original kata: `freshell#0gdd`

**Tracker UID:** `01KZRW1HFB77ZQZJ6F1PJB0GDD`  
**Short ID:** `0gdd`  
**Status at handoff:** open  
**Title:** `Investigate freshell-server chronic ~50%-of-a-core CPU baseline (session-directory polling suspect)`

Open the original work item from the repository with:

```bash
kata show freshell#0gdd
```

The original item reports a steady 43–56% use of one processor core and identifies the two-second session-directory refresh as a prime suspect. This page-bounded preparation change addresses one verified source of repeated work. It does not by itself dispose of the wider background-sweep and refresh-loop findings.