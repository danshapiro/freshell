# Task 4 Execution Brief — Collapse Browser E2E to One Owned Rust Backend

Governing plan section: `### Task 4: Collapse Browser E2E to One Owned Rust Backend` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Read that full section (Files, Interfaces, all seven steps) and the unchanged `## User Request` block before acting.

Required outcome:
- Remove `E2eServerKind`/`e2eServerKind`; browser fixtures start owned `RustServer`, while explicit external targets remain non-owned and never stopped. Move shared info/port/home/setup helpers to `server-fixture-support.ts`; delete browser `test-server.ts` only after every browser/Electron/oracle import/constructor is migrated. Keep an oracle-local Node constructor temporarily only where the plan explicitly requires it.
- Collapse Playwright application coverage to one Rust-backed `chromium` project; CI firefox/webkit inherit Rust; match-all projects use exact `continuity-smoke.spec.ts` exclusion only. Keep specialized continuity project. Remove `legacy-chromium`, `rust-chromium`, `MATRIX_SPECS`, browser-E2E Node `TestServer`, and stale executable-path/project claims.
- Delete GATE-01 executable/collator/config while retaining frozen `gate01-baseline.json`; update global setup/teardown/leak/perf/Electron seams to Rust and prove `/api/server-info` runtime/provenance identifies `freshell-server`.
- Convert every current literal `kind: 'legacy'`, `e2eServerKind`, `TestServer`/`test-server.js`, and stale `legacy-chromium|dist/server/index` subject in the plan's closed sets; no required Rust spec may disappear. Preserve local-only `mcp-qa-smoke-rust` classification/selector and positive local receipt.
- Add `selection-nonvacuity.test.ts` covering project/literal-Rust contract, exact continuity-only exclusion, floors (>=308 tests, >=86 files), zero legacy projects, cloud skip integrity, helper imports, and fake healthy non-Rust provenance failure.

Required commands:
1. RED: `npm run test:e2e:helpers`; `npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list`.
2. GREEN: same commands; list must name `[chromium]`, >=308 tests in >=86 files, no legacy/zero-test warning.
3. Impacted: exact forbidden legacy scan from plan; oracle external-handshake unit; focused Rust Chromium E2E (auth, terminal lifecycle, restart recovery, Rust baseline actions); then full `npm run test:e2e -- --project=chromium` with positive selection and Rust provenance.

Execution rules:
- Follow red-green-refactor TDD, commit on current branch, and write `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-004-report.md`.
- Do not edit progress/review files. Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not perform Task 5 protocol/oracle retirement beyond the temporary oracle constructor relocation expressly listed here.
