# Fix fresh-agent-pane-migration Container Test Failure

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Make `fresh-agent-pane-migration.test.ts` pass in the Cloud Run container by removing its dependency on the `rg` (ripgrep) binary.

**Architecture:** The first test shells out to `rg` to verify that legacy type names no longer appear in three source files. The container doesn't install ripgrep, so `spawnSync` returns `status: null` (ENOENT) instead of `status: 1` (rg's "no matches"). Replace the `rg` call with Node.js `fs.readFileSync` + regex — same assertion, no external dependency.

**Tech Stack:** Vitest, Node.js `fs`, Node.js `path`

## Requirements

- **R1 — Outcome:** `fresh-agent-pane-migration.test.ts` passes in the Cloud Run container (all 9 tests, including the `rg`-dependent one)
- **R2 — Constraint:** The test must still assert that `AgentChatPaneContent|AgentChatPaneInput` do not appear in the three named source files
- **R3 — Constraint:** No new external dependencies in the container image

---

### Task 1: Replace rg spawnSync with fs-based file search

**Requirements served:** R1, R2, R3

**Behavior:**
- Test reads the three source files (`src/store/paneTypes.ts`, `src/lib/pane-activity.ts`, `src/store/persistControl.ts`) using `fs.readFileSync`
- Test asserts that `AgentChatPaneContent` and `AgentChatPaneInput` do not appear in any of the three files
- No `spawnSync`, no `rg` dependency

**Files:**
- Modify: `test/unit/client/fresh-agent-pane-migration.test.ts:1-22`

**Interfaces:**
- Consumes: `fs.readFileSync`, `path.resolve`
- Produces: same test name, same assertions, no external binary dependency

**Test cases:**
- The three files do NOT contain `AgentChatPaneContent` → test passes
- (Negative case is proven by the test itself failing if the pattern were reintroduced)

- [ ] **Step 1: Run the existing test to confirm it passes locally**

Run: `npm run test:vitest -- run test/unit/client/fresh-agent-pane-migration.test.ts`

Expected: PASS (all 9 tests, locally with rg installed)

- [ ] **Step 2: Replace the rg-based test with fs-based file search**

Replace `spawnSync('rg', ...)` with `fs.readFileSync` for each of the three files, then assert neither pattern appears. Keep the same test name and describe block.

- [ ] **Step 3: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/fresh-agent-pane-migration.test.ts`

Expected: PASS (all 9 tests)

- [ ] **Step 4: Run broader verification**

Run: `npm run test:client`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/unit/client/fresh-agent-pane-migration.test.ts
git commit -m "fix: replace rg dependency in fresh-agent-pane-migration test with fs read"
```

### Task 2: Verify in Cloud Run container

**Requirements served:** R1

**Behavior:**
- Rebuild the Cloud Run image (includes the updated test)
- Run the focused test in the container via Cloud Run Jobs (single shard)

**Files:**
- No new files (uses existing `scripts/vitest-cloud.sh`)

- [ ] **Step 1: Rebuild the container image**

Run: `bash scripts/vitest-cloud.sh build`

Expected: Cloud Build completes successfully

- [ ] **Step 2: Run the focused test in the container**

Run: `bash scripts/vitest-cloud.sh --cloud --shards=1 test/unit/client/fresh-agent-pane-migration.test.ts`

Expected: All 9 tests pass in the container

### Task 3: Push and land via PR

**Requirements served:** R1

- [ ] **Step 1: Push the branch**

Run: `git push -u origin the-usual/vitest-version-mismatch`

- [ ] **Step 2: Create PR targeting main**

Run: `gh pr create --title "fix: replace rg dependency in fresh-agent-pane-migration test with fs read" --body "..."`

- [ ] **Step 3: Wait for required checks**

Run: `gh pr checks --watch`

Expected: All checks pass

- [ ] **Step 4: Merge and sync**

Run: `gh pr merge --merge --delete-branch && git fetch origin main && git merge origin/main --ff-only`
