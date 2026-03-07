# Issue #134 Logging Stream Separation — Test Plan

Date: 2026-03-07  
Source: `/home/user/code/freshell/.worktrees/trycycle-request-worktree/docs/plans/2026-03-07-issue-134-debug-log-stream-separation.md`

## Strategy changes requiring user approval
No approval required. The implementation plan is internally consistent with the existing unit/integration strategy, but two test assumptions are corrected:

1. Use `FRESHELL_LOG_DIR` (not `LOG_DIR`) when driving default debug path tests.
2. Runtime smoke tests should set `AUTH_TOKEN` explicitly to avoid bootstrap `.env` mutations and inter-test side effects in the worktree.

## Harness requirements
Build a small logger separation harness in `test/integration/server/logger.separation.harness.ts` before scenario tests:

- `startServerProcess(args, env, cwd)`: spawn `tsx` or `node` child process with deterministic env values and return `{ process, stderrLogPath }`.
- `waitForResolvedPath(process, timeoutMs)`: parse process stdout/stderr for `Resolved debug log path`.
- `stopProcess(process)`: graceful shutdown (`SIGINT`) then hard kill after timeout.
- `listCandidateFiles(logDir, mode, instance)`: return matching `server-debug.{mode}.{instance}*.jsonl` files.

This harness is used by scenario tests to validate non-overlap between concurrent server instances.

## Test plan

1. Name: `Source vs dist launches choose different default filenames`

Type: scenario  
Harness: `test/integration/server/logger.separation.harness.ts` (new)  
Preconditions: dist build is available; two free ports selected; temp directory created as `FRESHELL_LOG_DIR`.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
rm -rf dist/server
npm run build:server
LOG_DIR=$(mktemp -d)

AUTH_TOKEN="integration-token-1x16chars" \
FRESHELL_LOG_DIR="$LOG_DIR" \
NODE_ENV=production \
PORT=3411 \
VITE_PORT=4173 \
tsx watch server/index.ts >"$LOG_DIR/dev-source.log" 2>&1 &
DEV_PID=$!

AUTH_TOKEN="integration-token-2x16chars" \
FRESHELL_LOG_DIR="$LOG_DIR" \
NODE_ENV=production \
PORT=3412 \
node dist/server/index.js >"$LOG_DIR/prod-dist.log" 2>&1 &
DIST_PID=$!

sleep 4
grep -E "Resolved debug log path" "$LOG_DIR/dev-source.log"
grep -E "Resolved debug log path" "$LOG_DIR/prod-dist.log"
kill -INT "$DEV_PID" "$DIST_PID" || true
```

Expected outcome:
`dev-source.log` must include `server-debug.development.3411.jsonl`.
`prod-dist.log` must include `server-debug.production.3412.jsonl`.
`ls "$LOG_DIR"/server-debug*.jsonl` must show two distinct filenames.

Interactions: logger module, startup sequence (`validateStartupSecurity`, `createLogger`), rotating-file-stream path creation.

2. Name: `Concurrent default launches with same mode do not reuse a single file`

Type: scenario  
Harness: `test/integration/server/logger.separation.harness.ts` (new)  
Preconditions: temp `FRESHELL_LOG_DIR`; `FRESHELL_LOG_MODE` unset; two different `PORT` values.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
rm -rf /tmp/freshell-issue134-parallel && mkdir -p /tmp/freshell-issue134-parallel
AUTH_TOKEN="integration-token-3x16chars" \
FRESHELL_LOG_DIR=/tmp/freshell-issue134-parallel \
PORT=3413 \
NODE_ENV=development \
tsx watch server/index.ts > /tmp/freshell-issue134-1.log 2>&1 &
PID_A=$!

AUTH_TOKEN="integration-token-4x16chars" \
FRESHELL_LOG_DIR=/tmp/freshell-issue134-parallel \
PORT=3414 \
NODE_ENV=development \
tsx watch server/index.ts > /tmp/freshell-issue134-2.log 2>&1 &
PID_B=$!

sleep 4
grep -E "Resolved debug log path" /tmp/freshell-issue134-1.log
grep -E "Resolved debug log path" /tmp/freshell-issue134-2.log
kill -INT "$PID_A" "$PID_B" || true
```

Expected outcome:
Both processes must report `server-debug.development.<PORT>.jsonl`.
The reported suffixes must differ (`3413` vs `3414`) and files must not be identical.

Interactions: resolve-by-port fallback and `resolveDebugLogPath` default instance resolution path.

3. Name: `Explicit instance ID and legacy explicit stream vars are respected`

Type: scenario  
Harness: `test/integration/server/logger.separation.harness.ts` (new) + logger unit-level path parser  
Preconditions: temp log dir and two processes with explicit instance IDs.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
AUTH_TOKEN="integration-token-5x16chars" \
FRESHELL_LOG_DIR=/tmp/freshell-issue134-explicit \
FRESHELL_LOG_INSTANCE_ID=alpha \
PORT=3415 \
NODE_ENV=production \
tsx watch server/index.ts > /tmp/freshell-issue134-alpha.log 2>&1 &
PID_ALPHA=$!

AUTH_TOKEN="integration-token-6x16chars" \
FRESHELL_LOG_DIR=/tmp/freshell-issue134-explicit \
FRESHELL_DEBUG_STREAM_INSTANCE=beta \
PORT=3416 \
NODE_ENV=production \
node dist/server/index.js > /tmp/freshell-issue134-beta.log 2>&1 &
PID_BETA=$!

sleep 4
grep -E "server-debug\\.production\\.(alpha|beta)\\.jsonl" /tmp/freshell-issue134-*.log
kill -INT "$PID_ALPHA" "$PID_BETA" || true
```

Expected outcome:
Startup lines must include `server-debug.production.alpha.jsonl` and `server-debug.production.beta.jsonl` respectively.
This verifies precedence of explicit instance settings.

Interactions: env override precedence path in logger and startup path logger message emission.

4. Name: `Mode precedence and argv inference is deterministic in unit tests`

Type: unit  
Harness: `npx vitest run test/unit/server/logger.test.ts`  
Preconditions: test command can import uninitialized logger module with injectable `argv`.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
npx vitest run test/unit/server/logger.test.ts
```

Expected outcome:
- `FRESHELL_LOG_MODE=development` beats `NODE_ENV=production`.
- `NODE_ENV=production` + argv containing `dist/server/index.js` resolves production.
- `NODE_ENV=production` + argv containing `tsx watch server/index.ts` and non-node token `watch` resolves development.
- Invalid `FRESHELL_LOG_MODE` values fall back to argv/env inference.

Source of truth: new logger helpers in implementation plan step 1 + `resolveDebugLogPath` behavior.

Interactions: `resolveDebugLogPath` + `resolveDebugLogFilename` decision path.

5. Name: `Instance fallback defaults remain stable and deterministic`

Type: unit  
Harness: `npx vitest run test/unit/server/logger.test.ts`  
Preconditions: explicit `PORT`, `VITE_PORT`, `FRESHELL_DEBUG_STREAM_INSTANCE`, `FRESHELL_LOG_INSTANCE_ID`, with non-test env.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
npx vitest run test/unit/server/logger.test.ts
```

Expected outcome:
- `FRESHELL_LOG_INSTANCE_ID` overrides all other fallback tags.
- `FRESHELL_DEBUG_STREAM_INSTANCE` is used before port fallback.
- absent explicit IDs, `PORT` and then `VITE_PORT` are used.
- same port+mode yields same expected suffix for replayable assertions.

Interactions: default instance fallback logic and `resolveDebugLogPath` output naming.

6. Name: `Startup logs include resolved debug destination`

Type: scenario  
Harness: `test/integration/server/logger.separation.harness.ts` or unit via custom destination stream  
Preconditions: one runtime start with known mode/instance and `FRESHELL_LOG_MODE` set.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
AUTH_TOKEN="integration-token-7x16chars" \
FRESHELL_LOG_MODE=production \
FRESHELL_LOG_INSTANCE_ID=ci-run-1 \
FRESHELL_LOG_DIR=/tmp/freshell-issue134-startup \
PORT=3416 \
tsx watch server/index.ts > /tmp/freshell-issue134-startup.log 2>&1 &
PID=$!
sleep 3
grep -E "Resolved debug log path" /tmp/freshell-issue134-startup.log
kill -INT "$PID" || true
```

Expected outcome:
Startup log line contains:
`filePath` ending in `server-debug.production.ci-run-1.jsonl`,
`debugMode: "production"`,
`debugInstance: "ci-run-1"`.

Interactions: logger startup path resolver and console stream emission at boot.

7. Name: `Windows-style and Unix-style argv entries match correctly`

Type: unit  
Harness: `npx vitest run test/unit/server/logger.test.ts`  
Preconditions: logger unit tests allow explicit argv injection.  
Actions:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
npx vitest run test/unit/server/logger.test.ts
```

Expected outcome:
`inferLogModeFromArgv` normalizes both `server/index.ts` and `C:\\repo\\dist\\server\\index.js` forms.

Interactions: helper normalization and matching logic in `logger.ts`.

## Coverage summary
- Covered action space: startup path resolution, launch-mode inference, explicit override precedence (`FRESHELL_LOG_MODE`, `FRESHELL_LOG_INSTANCE_ID`, `FRESHELL_DEBUG_STREAM_INSTANCE`, `PORT`, `VITE_PORT`), filename generation, startup message visibility, and source vs dist launch behavior.
- Excluded by this plan:
  - Deep `pino` internals and rotating-file-stream rotation policy edge cases (still covered in existing `createDebugFileStream` test).
  - Browser UI logging surfaces; logger behavior is validated at service boundary before surfacing anywhere.
- Risk of exclusions: if rotation behavior fails but pathing is correct, this plan still misses max-files/size regressions; that risk is captured by existing `debug log file stream` unit test.

Run order recommendation:
1. Add unit assertions (`test/unit/server/logger.test.ts`) and run `npx vitest run test/unit/server/logger.test.ts`.
2. Add scenario harness and integration tests under `test/integration/server`.
3. Run `npx vitest run test/integration/server/logger.separation.test.ts`.
4. Run full suite `npm test`.
