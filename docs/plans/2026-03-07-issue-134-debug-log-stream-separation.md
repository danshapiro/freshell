# Issue #134 Logging Stream Separation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure default debug log files are separated between development and production and between server instances so they can no longer interleave by default.

**Architecture:** Keep the existing `pino` + `rotating-file-stream` pipeline, but make debug-stream selection deterministic and instance-aware. Resolve mode using explicit override (`FRESHELL_LOG_MODE`) first, then launch-artifact inference (`dist/server` vs source), and finally `NODE_ENV` fallback. Compose default filenames as `server-debug.{mode}.{instance}.jsonl` where instance is derived from explicit IDs, then port/env, then process ID. Keep existing `LOG_DEBUG_PATH` and `FRESHELL_LOG_DIR` override behavior.

**Tech Stack:** Node.js, TypeScript, pino, rotating-file-stream, Vitest.

---

[INITIAL_REQUEST_AND_SUBSEQUENT_CONVERSATION]

User request: "Use trycycle to implement #134 (https://github.com/danshapiro/freshell/issues/134) Dev and prod logs are interleaved in the same debug log stream — opened March 1, 2026"
Assistant response: "Getting started."
Latest review concerns:
- argv-based mode inference must handle relative script paths in package scripts (`tsx watch server/index.ts`, `node dist/server/index.js`) and non-node argv tokens (`watch`).
- unit tests must set `PORT` or `VITE_PORT` deterministically before asserting suffixes derived from instance IDs.

User decision required: **No**

Chosen path for robust separation: explicit launch mode via `FRESHELL_LOG_MODE`, source-vs-dist inference fallback, then `NODE_ENV` fallback; include explicit instance resolution in the default filename.

## Task 1: Make debug-mode and instance resolution deterministic and Windows-safe

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/trycycle-request-worktree/server/logger.ts`

**Step 1: Add explicit mode parsing and robust argv inference helpers**

Implement helper functions in `server/logger.ts`:

```ts
const DEFAULT_DEBUG_LOG_FILE = 'server-debug'
const DEFAULT_DEBUG_LOG_SUFFIX = '.jsonl'
type LogMode = 'development' | 'production'
const SOURCE_ENTRY_MATCHERS = [/(^|\/)server\/index\.ts$/i, /(^|\/)server\/index\.js$/i]
const DIST_ENTRY_MATCHERS = [/(^|\/)dist\/server\/index\.js$/i]

function normalizeLogMode(value: string | undefined): LogMode | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'development' || normalized === 'dev') return 'development'
  if (normalized === 'production' || normalized === 'prod') return 'production'
  return undefined
}

function normalizeArgPath(arg: string): string {
  return path
    .normalize(arg)
    .replace(/\\+/g, '/')
    .replace(/^\.\/+/, '')
    .toLowerCase()
}

function inferLogModeFromArgv(argv: string[] = process.argv): LogMode | undefined {
  const normalizedArgv = argv.map(normalizeArgPath)
  const hasDistEntry = normalizedArgv.some((arg) => DIST_ENTRY_MATCHERS.some((regex) => regex.test(arg)))
  if (hasDistEntry) return 'production'

  const hasSourceEntry = normalizedArgv.some((arg) => SOURCE_ENTRY_MATCHERS.some((rx) => rx.test(arg)))
  if (hasSourceEntry) return 'development'

  return undefined
}

function resolveDebugLogMode(
  envVars: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): LogMode {
  return (
    normalizeLogMode(envVars.FRESHELL_LOG_MODE) ??
    inferLogModeFromArgv(argv) ??
    (envVars.NODE_ENV === 'production' ? 'production' : 'development')
  )
}

function resolveDebugInstanceTag(envVars: NodeJS.ProcessEnv = process.env): string {
  const explicit = envVars.FRESHELL_LOG_INSTANCE_ID?.trim()
  if (explicit) return explicit

  const fallback = [
    envVars.FRESHELL_DEBUG_STREAM_INSTANCE,
    envVars.PORT,
    envVars.VITE_PORT,
    String(process.pid),
  ].find(Boolean)

  return fallback?.toString() || String(process.pid)
}
```

**Step 2: Thread mode/instance into default filename generation**

Keep override precedence for location (`LOG_DEBUG_PATH` > test/runtime skip > `FRESHELL_LOG_DIR` > home path), but replace default filename with instance-aware naming:

```ts
function resolveDebugLogFilename(envVars: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string {
  const mode = resolveDebugLogMode(envVars, argv)
  const instance = resolveDebugInstanceTag(envVars)
  return `${DEFAULT_DEBUG_LOG_FILE}.${mode}.${instance}${DEFAULT_DEBUG_LOG_SUFFIX}`
}

export function resolveDebugLogPath(
  envVars: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  argv: string[] = process.argv,
): string | null {
  const explicitPath = envVars.LOG_DEBUG_PATH?.trim()
  if (explicitPath) return path.resolve(explicitPath)
  if (isTestRuntime(envVars)) return null

  const logDirOverride = envVars.FRESHELL_LOG_DIR?.trim()
  const logDir = logDirOverride ? path.resolve(logDirOverride) : path.join(homeDir, '.freshell', 'logs')
  const filename = resolveDebugLogFilename(envVars, argv)
  return path.join(logDir, filename)
}
```

**Step 3: Emit resolved path on startup**

Within `createLogger()`, once `debugLogPath` is known, log the resolved path once to stdout using the console stream so humans can confirm active target without code inspection.

```ts
if (debugLogPath) {
  consoleLogger.info(
    {
      filePath: debugLogPath,
      debugMode: resolveDebugLogMode(),
      debugInstance: resolveDebugInstanceTag(),
    },
    'Resolved debug log path',
  )
}
```

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
npx vitest run test/unit/server/logger.test.ts
```

Expected: test set should fail until implementation is in place.

**Step 4: Commit**

```bash
git add /home/user/code/freshell/.worktrees/trycycle-request-worktree/server/logger.ts
git commit -m "feat(logging): add mode+instance-based debug log filename resolution"
```

## Task 2: Expand unit tests for mode inference, per-instance defaults, and stable filenames

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/trycycle-request-worktree/test/unit/server/logger.test.ts`

**Step 1: Update default path assertions to include mode and instance**

In `describe("debug log path resolution")`, update default expectations so `server-debug.jsonl` includes `.{mode}.{instance}`.

```ts
expect(
  resolveDebugLogPath(
    { PORT: '3001', FRESHELL_LOG_DIR: logDir, NODE_ENV: 'development' } as NodeJS.ProcessEnv,
    '/home/test',
  ),
).toBe(path.join(path.resolve(logDir), 'server-debug.development.3001.jsonl'))
expect(
  resolveDebugLogPath(
    { PORT: '3002', FRESHELL_LOG_DIR: logDir, NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    '/home/test',
  ),
).toBe(path.join(path.resolve(logDir), 'server-debug.production.3002.jsonl'))
```

**Step 2: Add mode-precedence and inference assertions**

Add tests for: `FRESHELL_LOG_MODE` precedence, explicit-mode overrides, and both inference paths.

```ts
expect(resolveDebugLogPath(
  { FRESHELL_LOG_MODE: 'development', NODE_ENV: 'production', PORT: '3001' } as NodeJS.ProcessEnv,
  '/home/test',
)).toContain('server-debug.development.')

expect(
  resolveDebugLogPath(
    { NODE_ENV: 'production', PORT: '3001' } as NodeJS.ProcessEnv,
    '/home/test',
    ['node', 'C:/repo/dist/server/index.js'],
  ),
).toContain('server-debug.production.')

expect(
  resolveDebugLogPath(
    { NODE_ENV: 'production', PORT: '3001' } as NodeJS.ProcessEnv,
    '/home/test',
    ['node', 'node_modules/.bin/tsx', 'watch', 'server/index.ts'],
  ),
).toContain('server-debug.development.')

expect(
  resolveDebugLogPath(
    { NODE_ENV: 'production', PORT: '3002' } as NodeJS.ProcessEnv,
    '/home/test',
    ['node', 'dist/server/index.js'],
  ),
).toContain('server-debug.production.')
```

In every assertion that depends on the inferred instance suffix, set `PORT` or `VITE_PORT` up front so the expected suffix is deterministic across runs.

**Step 3: Add per-instance filename tests**

Add tests to ensure explicit overrides and fallback tags are distinct:

```ts
const alpha = resolveDebugLogPath({ FRESHELL_LOG_INSTANCE_ID: 'alpha', PORT: '3001' } as NodeJS.ProcessEnv, '/home/test')
const beta = resolveDebugLogPath({ FRESHELL_LOG_INSTANCE_ID: 'beta', PORT: '3001' } as NodeJS.ProcessEnv, '/home/test')
const explicitInstance = resolveDebugLogPath({ FRESHELL_DEBUG_STREAM_INSTANCE: 'ci-run-1', PORT: '3001' } as NodeJS.ProcessEnv, '/home/test')
expect(alpha).toContain('server-debug.development.alpha.jsonl')
expect(beta).toContain('server-debug.development.beta.jsonl')
expect(explicitInstance).toContain('server-debug.development.ci-run-1.jsonl')
expect(alpha).not.toBe(beta)
expect(resolveDebugLogPath({ PORT: '3001' } as NodeJS.ProcessEnv, '/home/test')).toContain('server-debug.development.3001.jsonl')
expect(resolveDebugLogPath({ PORT: '3002' } as NodeJS.ProcessEnv, '/home/test')).toContain('server-debug.development.3002.jsonl')
expect(resolveDebugLogPath({ VITE_PORT: '3101' } as NodeJS.ProcessEnv, '/home/test')).toContain('server-debug.development.3101.jsonl')
```

This confirms the non-instance env fallback keeps concurrent instances from sharing the same file by default.

**Step 4: Add startup visibility assertions (non-invasive)**

Add one direct assertion proving the startup-resolved path includes both mode and instance:

```ts
expect(
  resolveDebugLogPath(
    { NODE_ENV: 'production', FRESHELL_DEBUG_STREAM_INSTANCE: 'abc', PORT: '3001' } as NodeJS.ProcessEnv,
    '/tmp',
    ['node', '/workspace/dist/server/index.js'],
  ),
).toContain('server-debug.production.abc.jsonl')
```

Run:

```bash
npx vitest run /home/user/code/freshell/.worktrees/trycycle-request-worktree/test/unit/server/logger.test.ts
```

Expected: all new mode/inference/instance tests pass.

**Step 5: Commit**

```bash
git add /home/user/code/freshell/.worktrees/trycycle-request-worktree/test/unit/server/logger.test.ts
git commit -m "test(logging): cover debug mode inference and instance filename suffixes"
```

## Task 3: Add docs update for naming and override controls

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/trycycle-request-worktree/docs/index.html`

Because this changes observable logging behavior, add a short developer-facing note in the mock settings/help area to document defaults and precedence:

- Default file: `server-debug.{mode}.{instance}.jsonl`
- Fallback instance candidates: `FRESHELL_LOG_INSTANCE_ID` (preferred), `FRESHELL_DEBUG_STREAM_INSTANCE`, `PORT`, `VITE_PORT`, `process.pid`
- Override precedence: `LOG_DEBUG_PATH` > `FRESHELL_LOG_DIR` > generated mode/instance path
- Mention `FRESHELL_LOG_MODE` values (`development|production`) for deterministic launches

If adding this to `docs/index.html` is undesirable for UI mock scope, include equivalent docs notes in `docs/plans/<date>-issue-134...` and proceed with that route.

**Step 1: Commit**

```bash
git add /home/user/code/freshell/.worktrees/trycycle-request-worktree/docs/index.html
git commit -m "docs(logging): document debug stream naming and env override precedence"
```

## Task 4: Verify both source and compiled launch paths without stale dist usage

**Files:**
- Execute commands in `/home/user/code/freshell/.worktrees/trycycle-request-worktree` (no commits for runtime verification files)

### Step 1: Build fresh server output

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
rm -rf dist/server
npm run build:server >/tmp/issue-134-build.log 2>&1
```

### Step 2: Run source launch with inference and distinct instance IDs

```bash
export LOG_DIR=/tmp/freshell-logs-issue-134
rm -rf "$LOG_DIR" && mkdir -p "$LOG_DIR"

# source run must infer development even with NODE_ENV=production (no FRESHELL_LOG_MODE)
FRESHELL_LOG_DIR="$LOG_DIR" NODE_ENV=production PORT=3401 LOG_DEBUG_PATH="" tsx watch server/index.ts > /tmp/freshell-dev-src.log 2>&1 &
echo $! > /tmp/freshell-dev-src.pid
```

### Step 3: Run dist server launch path (compiled) and npm start path

```bash
# dist inference path (should infer production from dist/server/index.js)
FRESHELL_LOG_DIR="$LOG_DIR" NODE_ENV=production PORT=3402 LOG_DEBUG_PATH="" node dist/server/index.js > /tmp/freshell-prod-dist.log 2>&1 &
echo $! > /tmp/freshell-prod-dist.pid

# explicit wrapper path (verifies npm run start still uses compiled launch path)
FRESHELL_LOG_MODE=production FRESHELL_LOG_INSTANCE_ID=issue-134-start FRESHELL_LOG_DIR="$LOG_DIR" PORT=3403 LOG_DEBUG_PATH="" npm run start > /tmp/freshell-start.log 2>&1 &
echo $! > /tmp/freshell-start.pid
```

### Step 4: Confirm resolved filenames and startup visibility

```bash
sleep 3
cat /tmp/freshell-dev-src.log | grep -E "Resolved debug log path"
sed -n '1,120p' /tmp/freshell-prod-dist.log
sed -n '1,120p' /tmp/freshell-start.log
ls -1 "$LOG_DIR" | sort
```

Expected:
- startup logs for each process include `Resolved debug log path` with concrete per-instance paths
- generated filenames include all of: `server-debug.development.<...>.jsonl`, `server-debug.production.<...>.jsonl`, `server-debug.production.issue-134-start.jsonl`
- no stale-path reuse between processes

Stop test processes:

```bash
kill "$(cat /tmp/freshell-dev-src.pid)" "$(cat /tmp/freshell-prod-dist.pid)" "$(cat /tmp/freshell-start.pid)" && rm -f /tmp/freshell-*.pid
```

**Step 5: Run full suite**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-request-worktree
npm test
```

Expected: all tests pass with log path behavior verified.

**Step 6: Commit**

```bash
# if all tasks completed and docs change included
git add /home/user/code/freshell/.worktrees/trycycle-request-worktree/docs/plans/2026-03-07-issue-134-debug-log-stream-separation.md
git commit -m "plan(issue-134): add instance-aware debug log resolution and dist/source smoke checks"
```

---

## Verification Checklist

- Debug filename defaults now include both mode and instance (`server-debug.{mode}.{instance}.jsonl`).
- `FRESHELL_LOG_MODE` wins over inference and `NODE_ENV`.
- Source and dist launch inference are separately covered.
- Per-instance defaults avoid cross-instance interleaving even under matching `mode`.
- Startup logs print the resolved debug file path.
- `LOG_DEBUG_PATH` and `FRESHELL_LOG_DIR` behavior remains unchanged.
- `npm test` passes after implementation.
