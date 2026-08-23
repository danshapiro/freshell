# Deep-Dive Triage — Group: infra / tooling

Base: origin/main = 3d739ca4a (2026-08-23). Read-only triage; no worktrees modified.

---

## 1. cloud-run-jobs

```yaml
worktree: cloud-run-jobs
branch: the-usual/cloud-run-jobs
date: 2026-08-09
ahead: 10
behind: 732
verdict: in-main
confidence: high
land-effort: none
```

### Evidence

Branch commits (10): Cloud Run Jobs e2e backend — Dockerfile, entrypoint, `scripts/e2e-cloud.sh`, `playwright.cloud.config.ts`, shell test suites, plan doc. All 13 footprint files **exist on origin/main today**. Of the 10 that differ vs main, every difference is main being *newer*, not the branch holding residue:

- The work landed via PR #628 (`ab8d6ed46 feat: Google Cloud Run Jobs as default Playwright e2e backend (#628)`) plus a long iteration chain on main that the branch predates entirely:
  - `ec14300e8` / `597c5aa99` — **vitest-cloud lane** (`scripts/vitest-cloud.sh`, `test:cloud` npm scripts): main's `docker/cloud-run/entrypoint.sh` has a whole `TEST_MODE=vitest` arm with `VITEST_ARGS_JSON` jq parsing; the branch entrypoint is the older e2e-only version (space-split `PLAYWRIGHT_ARGS`, no vitest arm).
  - PR #678 (`006174fb0 feat(cloud): wire gcloud-robot identity ladder into e2e/vitest cloud wrappers`): branch's `scripts/e2e-cloud.sh` still defaults `GCP_ACCOUNT=dan@danshapiro.com` hardcoded; main sources `scripts/lib/gcp-identity.sh`, adds `--account=` precedence and the gcloud-robot ladder (this is exactly the recent conversion the triage prompt flagged).
  - `ade55e095` / `8c7bce61a` — commit-addressed image tags + dirty-tree rebuild fail-closed; branch still runs mutable `:latest`.
  - `c37fa118a` — per-run job names + fail-closed on partial results; absent in branch.
  - `docker/cloud-run/Dockerfile`: main has `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` and the non-root `USER node` hardened runtime (for permission-propagation tests); branch doesn't.
  - `test/e2e-browser/playwright.cloud.config.ts`: main deliberately **removed** `freshopencode-model-picker.spec.ts` from `CLOUD_SKIP_SPECS` (`4dc87404c`); branch still skips it. Main's `playwright.config.ts` MATRIX_SPECS is far larger (df1 campaign specs).
  - `.dockerignore` / `docs/plans/2026-08-09-cloud-run-jobs.md`: main's versions are refined iterations (selective re-includes for tests; corrected default-backend claim via `c1a19b48a`).
- `git log origin/main --oneline -- scripts/e2e-cloud.sh` shows 12+ commits of post-branch evolution.

### Recommendation

Fully landed and heavily superseded. Nothing in the branch's deltas is ahead of main on any of the 10 differing files — every diff line is main-side improvement. Delete the worktree/branch at the user's convenience.

---

## 2. playwright-azure-cloud

```yaml
worktree: playwright-azure-cloud
branch: feat/playwright-azure-cloud
date: 2026-08-08
ahead: 1
behind: 735
verdict: throw-away-useless
confidence: high
land-effort: none
```

### Evidence

Single commit `a0155ec31` ("feat(e2e): Azure Playwright cloud testing with local/remote switch", 2026-08-08): adds `test/e2e-browser/playwright.service.config.ts` (49 lines — wraps base config with `@azure/playwright`/`DefaultAzureCredential` behind `PLAYWRIGHT_CLOUD=1`), `.env.example` Azure section, and npm scripts `test:e2e:service` / `test:e2e:cloud` / `test:e2e:cloud:parallel`. Commit message says it was verified live (auth.spec.ts 6 tests passed against Azure cloud), so it was a real working spike.

- Main contains **zero** Azure Playwright support: the only `azure` grep hits on origin/main are unrelated amplifier tests (`test/integration/real/amplifier-launch-smoke.test.ts`, `amplifier-stub-adoption-contract.test.ts`). No `playwright.service.config.ts`, no `@azure/*` deps.
- Main chose the competing approach one day later: GCP Cloud Run Jobs (this worktree-group's item #1, landed as PR #628, 2026-08-09/11), now with vitest-cloud, gcloud-robot identity, and commit-addressed images. The branch's npm script names **collide** with main's: branch's `test:e2e:cloud` runs Playwright against Azure; main's `test:e2e:cloud` runs `scripts/e2e-cloud.sh run --cloud`.
- The branch's base `@playwright/test ^1.52.0` and dependency set are 735 commits stale (package-lock alone is +707 lines against a long-evolved lockfile).

### Recommendation

An abandoned alternative-backend spike. The project standardized on GCP Cloud Run; landing this would introduce a second, unmaintained cloud e2e backend with colliding script names. Useless as residue — the 49-line config could be rewritten in minutes if Azure is ever wanted again.

---

## 3. release-v0.7.6-rc.1

```yaml
worktree: release-v0.7.6-rc.1
branch: release/v0.7.6-rc.1
date: 2026-08-17
ahead: 1
behind: 192
verdict: throw-away-useless
confidence: high
land-effort: none
```

### Evidence

Single commit `1db15fba6` ("chore: mark 0.7.6 release candidate", 2026-08-17), 4 files / 12 insertions: pure version-string surgery — README badge + "clone --branch v0.7.6-rc.1" quick-start, `docs/index.html` version strings, `package.json`/`package-lock.json` `0.7.5 → 0.7.6-rc.1`.

- **The 0.7.6 release never happened**: `git tag --list 'v*'` stops at `v0.7.5`; `gh release list` shows latest releases `v0.7.5 Release Candidate` (2026-07-06) and `v0.7.0` (Latest); origin/main's `package.json` is still `"version": "0.7.5"`; no CHANGELOG file exists on main; no main commits reference 0.7.6 (only an unrelated revert `f8029f1b9` matches "0.7.6" grep by hash coincidence — actually no: grep hit was for a generic "release" search; `git log --grep="0.7.6"` on main returns only noise).
- The branch is 192 commits behind — the would-be RC content is far from what a 0.7.6 cut today would contain.

### Recommendation

A release-prep marker for a release that was never cut. If/when 0.7.6 ships, the release-freshell skill re-does this prep fresh from the then-current main; this 6-day-old string-bump commit has no salvage value. Throw away.

---

## 4. slash-command-catalogs

```yaml
worktree: slash-command-catalogs
branch: the-usual/slash-command-catalogs
date: 2026-08-19
ahead: 13
behind: 99
verdict: ready-landing
confidence: high
land-effort: small
```

### Evidence

13 commits (plan + 6 feature/fix/test commits + executed marker), 25 files, +2237/−88 vs merge-base. Feature: dynamic **provider-advertised slash-command catalogs** in fresh-agent composer `/` menus — generic slot on the fresh-agent snapshot (`commands?: readonly FreshAgentSessionCommand[]`, optional = graceful absence for the Rust port), Claude/kilroy probe of SDK `supportedCommands()` + `commands_changed` REPLACE relay with terminal-command subtraction (`server/sdk-bridge.ts`, +93), freshopencode catalog from sidecar `GET /command?directory=` + dispatch lane routing typed `/name args` to `POST /session/:id/command` (`server/fresh-agent/adapters/opencode/`, +320 across adapter/catalog/serve-manager), grouped composer menu with insert-verbatim-never-autosend session rows (`FreshAgentComposer.tsx`, +165).

- **Main does not have this feature.** Main's `shared/fresh-agent-slash-commands.ts` is the *static* table only (new/compact/fork/model, from `4e1adcc6b`); no `commands` snapshot slot, no probe/relay, no opencode catalog (`git grep` on origin/main for `slashCommand|session-command|commands_changed` finds only the static-table consumer in `FreshAgentView.tsx`).
- **Mergeability verified read-only**: `git merge-tree --write-tree origin/main the-usual/slash-command-catalogs` exits 0 with an empty conflict list — cleanly landable onto today's main despite 99 commits of drift. Only 5 of 25 touched files moved on main at all, and only modestly (FreshAgentView.tsx 36, FreshAgentView.test.tsx 61, opencode-serve-adapter.test.ts 60, model-picker spec 45, serve-manager test 21).
- **Completeness**: plan doc `docs/plans/2026-08-19-slash-command-catalogs.md` carries an "Executed 2026-08-19 … run converged" marker (commit `2ca852dd2`); full TDD trail — new unit tests (`fresh-agent-slash-commands.test.ts` +62, `opencode-commands-catalog.test.ts` +129, `opencode-serve-adapter.test.ts` +309, `sdk-bridge.test.ts` +355, composer +251, contract +38) **plus e2e coverage** in `test/e2e-browser/specs/freshopencode-model-picker.spec.ts` (+134, "slash-command menu coverage + smoke receipts", commit `526453eb7`) — and that spec is cloud-legal on main (deliberately removed from `CLOUD_SKIP_SPECS` by `4dc87404c`), so the e2e story fits current policy.
- **Focused tests pass at branch HEAD** (node_modules present): `fresh-agent-slash-commands` 7/7, `fresh-agent-contract` 9/9 (default config), `opencode-commands-catalog` 13/13 (server config), `FreshAgentComposer.test.tsx` 23/23 — including the new "grouped slash menu (provider session commands)" insert-not-send case.
- Last fix commits show real edge-hardening: `07186b9c0` (command-turn timeout must not kill the shared sidecar; lazy catalog-capture retry), `85b471812` (composer help line reflects row kind).

### Recommendation

This is a finished, tested, documented feature branch that merges conflict-free into current main, with e2e coverage on a cloud-legal spec. Recommend landing: push as-is (or fast-forward-merge onto a fresh branch from origin/main), run the coordinated full suite + the model-picker e2e spec on the configured backend, then PR per repo policy. Only open question for the user is product-facing: dynamic catalogs change the fresh-agent composer menu, so a quick smoke of the menu UX on freshclaude/freshopencode before merge is a cheap sanity check.
