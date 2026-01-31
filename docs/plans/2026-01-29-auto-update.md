# Auto-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** On launch, check GitHub for new releases and offer "There's a new Freshell waiting for you!" prompt with yes/no upgrade.

**Architecture:** Server startup checks GitHub releases API, compares to local version via semver. If update available, prompt user in terminal (before server starts) with readline. If yes, run git pull + npm install + npm run build, then continue startup. Store last-check timestamp to avoid hammering GitHub.

**Tech Stack:** Node.js (built-in https/readline), semver for version comparison, GitHub Releases API, git CLI for updates.

---

## Task 0: Tag Current Production Build

**Files:**
- None (git operations only)

**Step 1: Verify clean state and tag**

Run:
```bash
cd /d/Users/Dan/GoogleDrivePersonal/code/freshell
git tag -a v0.1.0 -m "Initial release baseline"
```

**Step 2: Push tag to origin**

Run:
```bash
git push origin v0.1.0
```

**Step 3: Create GitHub Release (manual or via gh CLI)**

Run:
```bash
gh release create v0.1.0 --title "v0.1.0 - Initial Release" --notes "Initial tagged release to establish baseline for auto-update system."
```

**Step 4: Verify release exists**

Run:
```bash
gh release view v0.1.0
```

---

## Task 1: Create Version Checker Module

**Files:**
- Create: `server/updater/version-checker.ts`
- Create: `server/updater/types.ts`
- Test: `test/unit/server/updater/version-checker.test.ts`

**Step 1: Write the types file**

```typescript
// server/updater/types.ts
export interface GitHubRelease {
  tag_name: string
  html_url: string
  published_at: string
  body: string
}

export interface UpdateCheckResult {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  error: string | null
}
```

**Step 2: Write the failing test**

```typescript
// test/unit/server/updater/version-checker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkForUpdate, parseVersion, isNewerVersion } from '../../../server/updater/version-checker'

describe('version-checker', () => {
  describe('parseVersion', () => {
    it('strips v prefix from version string', () => {
      expect(parseVersion('v1.2.3')).toBe('1.2.3')
    })

    it('returns version unchanged if no prefix', () => {
      expect(parseVersion('1.2.3')).toBe('1.2.3')
    })
  })

  describe('isNewerVersion', () => {
    it('returns true when remote is newer major', () => {
      expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true)
    })

    it('returns true when remote is newer minor', () => {
      expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true)
    })

    it('returns true when remote is newer patch', () => {
      expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
    })

    it('returns false when versions are equal', () => {
      expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    })

    it('returns false when local is newer', () => {
      expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false)
    })
  })

  describe('checkForUpdate', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns updateAvailable: true when remote version is newer', async () => {
      const mockRelease = {
        tag_name: 'v1.1.0',
        html_url: 'https://github.com/danshapiro/freshell/releases/tag/v1.1.0',
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRelease)
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(true)
      expect(result.currentVersion).toBe('0.1.0')
      expect(result.latestVersion).toBe('1.1.0')
      expect(result.releaseUrl).toBe('https://github.com/danshapiro/freshell/releases/tag/v1.1.0')
      expect(result.error).toBeNull()
    })

    it('returns updateAvailable: false when versions match', async () => {
      const mockRelease = {
        tag_name: 'v0.1.0',
        html_url: 'https://github.com/danshapiro/freshell/releases/tag/v0.1.0',
        published_at: '2026-01-29T00:00:00Z',
        body: 'Release notes'
      }

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRelease)
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.latestVersion).toBe('0.1.0')
    })

    it('returns error when fetch fails', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 404
      } as Response)

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toContain('404')
    })

    it('returns error when network fails', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'))

      const result = await checkForUpdate('0.1.0')

      expect(result.updateAvailable).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })
})
```

**Step 3: Run test to verify it fails**

Run: `npm test -- test/unit/server/updater/version-checker.test.ts`
Expected: FAIL with "Cannot find module"

**Step 4: Write minimal implementation**

```typescript
// server/updater/version-checker.ts
import type { GitHubRelease, UpdateCheckResult } from './types.js'

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/danshapiro/freshell/releases/latest'

export function parseVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}

export function isNewerVersion(current: string, remote: string): boolean {
  const currentParts = current.split('.').map(Number)
  const remoteParts = remote.split('.').map(Number)

  for (let i = 0; i < 3; i++) {
    const c = currentParts[i] || 0
    const r = remoteParts[i] || 0
    if (r > c) return true
    if (r < c) return false
  }

  return false
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Freshell-Updater'
      }
    })

    if (!response.ok) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        releaseUrl: null,
        error: `GitHub API returned ${response.status}`
      }
    }

    const release: GitHubRelease = await response.json()
    const latestVersion = parseVersion(release.tag_name)

    return {
      updateAvailable: isNewerVersion(currentVersion, latestVersion),
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      error: null
    }
  } catch (err: any) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
      error: err?.message || String(err)
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm test -- test/unit/server/updater/version-checker.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add server/updater/types.ts server/updater/version-checker.ts test/unit/server/updater/version-checker.test.ts
git commit -m "$(cat <<'EOF'
feat(updater): add version checker module

Checks GitHub releases API for latest version and compares using semver.
Returns structured result with update availability and release URL.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create Update Executor Module

**Files:**
- Create: `server/updater/executor.ts`
- Test: `test/unit/server/updater/executor.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/updater/executor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeUpdate, type UpdateProgress } from '../../../server/updater/executor'
import { exec } from 'child_process'

vi.mock('child_process', () => ({
  exec: vi.fn()
}))

describe('executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeUpdate', () => {
    it('runs git pull, npm install, and npm run build in sequence', async () => {
      const mockExec = vi.mocked(exec)
      mockExec.mockImplementation((cmd, opts, callback) => {
        if (typeof opts === 'function') {
          opts(null, '', '')
        } else if (callback) {
          callback(null, '', '')
        }
        return {} as any
      })

      const progress: UpdateProgress[] = []
      await executeUpdate((p) => progress.push(p))

      expect(progress).toContainEqual({ step: 'git-pull', status: 'running' })
      expect(progress).toContainEqual({ step: 'git-pull', status: 'complete' })
      expect(progress).toContainEqual({ step: 'npm-install', status: 'running' })
      expect(progress).toContainEqual({ step: 'npm-install', status: 'complete' })
      expect(progress).toContainEqual({ step: 'build', status: 'running' })
      expect(progress).toContainEqual({ step: 'build', status: 'complete' })
    })

    it('reports error and stops if git pull fails', async () => {
      const mockExec = vi.mocked(exec)
      mockExec.mockImplementation((cmd, opts, callback) => {
        const cb = typeof opts === 'function' ? opts : callback
        if (cmd.includes('git pull')) {
          cb?.(new Error('Git pull failed'), '', 'error output')
        } else {
          cb?.(null, '', '')
        }
        return {} as any
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p))

      expect(result.success).toBe(false)
      expect(result.error).toContain('Git pull failed')
      expect(progress).toContainEqual({ step: 'git-pull', status: 'error', error: expect.any(String) })
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/server/updater/executor.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// server/updater/executor.ts
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'

const execAsync = promisify(exec)

export type UpdateStep = 'git-pull' | 'npm-install' | 'build'
export type UpdateStatus = 'running' | 'complete' | 'error'

export interface UpdateProgress {
  step: UpdateStep
  status: UpdateStatus
  error?: string
}

export interface UpdateResult {
  success: boolean
  error?: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')

export async function executeUpdate(
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateResult> {
  const steps: { step: UpdateStep; command: string }[] = [
    { step: 'git-pull', command: 'git pull' },
    { step: 'npm-install', command: 'npm install' },
    { step: 'build', command: 'npm run build' }
  ]

  for (const { step, command } of steps) {
    onProgress({ step, status: 'running' })

    try {
      await execAsync(command, { cwd: projectRoot })
      onProgress({ step, status: 'complete' })
    } catch (err: any) {
      const errorMsg = err?.message || String(err)
      onProgress({ step, status: 'error', error: errorMsg })
      return { success: false, error: errorMsg }
    }
  }

  return { success: true }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- test/unit/server/updater/executor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/updater/executor.ts test/unit/server/updater/executor.test.ts
git commit -m "$(cat <<'EOF'
feat(updater): add update executor module

Runs git pull, npm install, and npm run build in sequence.
Reports progress via callback and handles errors gracefully.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create Interactive Prompt Module

**Files:**
- Create: `server/updater/prompt.ts`
- Test: `test/unit/server/updater/prompt.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/updater/prompt.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promptForUpdate, formatUpdateBanner } from '../../../server/updater/prompt'
import * as readline from 'readline'

vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn()
  }))
}))

describe('prompt', () => {
  describe('formatUpdateBanner', () => {
    it('formats banner with version info', () => {
      const banner = formatUpdateBanner('0.1.0', '0.2.0')
      expect(banner).toContain('new Freshell')
      expect(banner).toContain('0.1.0')
      expect(banner).toContain('0.2.0')
    })
  })

  describe('promptForUpdate', () => {
    it('returns true when user enters empty (default yes)', async () => {
      const mockRl = {
        question: vi.fn((q, cb) => cb('')),
        close: vi.fn()
      }
      vi.mocked(readline.createInterface).mockReturnValue(mockRl as any)

      const result = await promptForUpdate('0.1.0', '0.2.0')
      expect(result).toBe(true)
      expect(mockRl.close).toHaveBeenCalled()
    })

    it('returns true when user enters Y', async () => {
      const mockRl = {
        question: vi.fn((q, cb) => cb('Y')),
        close: vi.fn()
      }
      vi.mocked(readline.createInterface).mockReturnValue(mockRl as any)

      const result = await promptForUpdate('0.1.0', '0.2.0')
      expect(result).toBe(true)
    })

    it('returns true when user enters y', async () => {
      const mockRl = {
        question: vi.fn((q, cb) => cb('y')),
        close: vi.fn()
      }
      vi.mocked(readline.createInterface).mockReturnValue(mockRl as any)

      const result = await promptForUpdate('0.1.0', '0.2.0')
      expect(result).toBe(true)
    })

    it('returns false when user enters n', async () => {
      const mockRl = {
        question: vi.fn((q, cb) => cb('n')),
        close: vi.fn()
      }
      vi.mocked(readline.createInterface).mockReturnValue(mockRl as any)

      const result = await promptForUpdate('0.1.0', '0.2.0')
      expect(result).toBe(false)
    })

    it('returns false when user enters N', async () => {
      const mockRl = {
        question: vi.fn((q, cb) => cb('N')),
        close: vi.fn()
      }
      vi.mocked(readline.createInterface).mockReturnValue(mockRl as any)

      const result = await promptForUpdate('0.1.0', '0.2.0')
      expect(result).toBe(false)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/server/updater/prompt.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// server/updater/prompt.ts
import * as readline from 'readline'

const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

export function formatUpdateBanner(currentVersion: string, latestVersion: string): string {
  const lines = [
    '',
    `${CYAN}╭─────────────────────────────────────────────╮${RESET}`,
    `${CYAN}│${RESET}                                             ${CYAN}│${RESET}`,
    `${CYAN}│${RESET}  ${GREEN}${BOLD}There's a new Freshell waiting for you!${RESET}   ${CYAN}│${RESET}`,
    `${CYAN}│${RESET}                                             ${CYAN}│${RESET}`,
    `${CYAN}│${RESET}    ${currentVersion} → ${YELLOW}${latestVersion}${RESET}                            ${CYAN}│${RESET}`,
    `${CYAN}│${RESET}                                             ${CYAN}│${RESET}`,
    `${CYAN}╰─────────────────────────────────────────────╯${RESET}`,
    ''
  ]
  return lines.join('\n')
}

export async function promptForUpdate(
  currentVersion: string,
  latestVersion: string
): Promise<boolean> {
  const banner = formatUpdateBanner(currentVersion, latestVersion)
  console.log(banner)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    rl.question(`Upgrade now? [${GREEN}Y${RESET}/n] `, (answer) => {
      rl.close()
      const normalized = answer.trim().toLowerCase()
      // Default to yes (empty input = yes)
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes')
    })
  })
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- test/unit/server/updater/prompt.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/updater/prompt.ts test/unit/server/updater/prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(updater): add interactive update prompt

Displays colorful banner with version info and prompts user
for update confirmation. Default is yes (empty input = yes).

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create Update Orchestrator

**Files:**
- Create: `server/updater/index.ts`
- Test: `test/unit/server/updater/index.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/updater/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runUpdateCheck } from '../../../server/updater/index'
import * as versionChecker from '../../../server/updater/version-checker'
import * as prompt from '../../../server/updater/prompt'
import * as executor from '../../../server/updater/executor'

vi.mock('../../../server/updater/version-checker')
vi.mock('../../../server/updater/prompt')
vi.mock('../../../server/updater/executor')

describe('updater orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('runUpdateCheck', () => {
    it('does nothing when no update available', async () => {
      vi.mocked(versionChecker.checkForUpdate).mockResolvedValue({
        updateAvailable: false,
        currentVersion: '0.1.0',
        latestVersion: '0.1.0',
        releaseUrl: null,
        error: null
      })

      const result = await runUpdateCheck('0.1.0')

      expect(result.action).toBe('none')
      expect(prompt.promptForUpdate).not.toHaveBeenCalled()
    })

    it('prompts user and updates when update available and user accepts', async () => {
      vi.mocked(versionChecker.checkForUpdate).mockResolvedValue({
        updateAvailable: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/danshapiro/freshell/releases/tag/v0.2.0',
        error: null
      })
      vi.mocked(prompt.promptForUpdate).mockResolvedValue(true)
      vi.mocked(executor.executeUpdate).mockResolvedValue({ success: true })

      const result = await runUpdateCheck('0.1.0')

      expect(result.action).toBe('updated')
      expect(prompt.promptForUpdate).toHaveBeenCalledWith('0.1.0', '0.2.0')
      expect(executor.executeUpdate).toHaveBeenCalled()
    })

    it('skips update when user declines', async () => {
      vi.mocked(versionChecker.checkForUpdate).mockResolvedValue({
        updateAvailable: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/danshapiro/freshell/releases/tag/v0.2.0',
        error: null
      })
      vi.mocked(prompt.promptForUpdate).mockResolvedValue(false)

      const result = await runUpdateCheck('0.1.0')

      expect(result.action).toBe('skipped')
      expect(executor.executeUpdate).not.toHaveBeenCalled()
    })

    it('reports error when update fails', async () => {
      vi.mocked(versionChecker.checkForUpdate).mockResolvedValue({
        updateAvailable: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/danshapiro/freshell/releases/tag/v0.2.0',
        error: null
      })
      vi.mocked(prompt.promptForUpdate).mockResolvedValue(true)
      vi.mocked(executor.executeUpdate).mockResolvedValue({ success: false, error: 'Build failed' })

      const result = await runUpdateCheck('0.1.0')

      expect(result.action).toBe('error')
      expect(result.error).toBe('Build failed')
    })

    it('handles version check errors gracefully', async () => {
      vi.mocked(versionChecker.checkForUpdate).mockResolvedValue({
        updateAvailable: false,
        currentVersion: '0.1.0',
        latestVersion: null,
        releaseUrl: null,
        error: 'Network error'
      })

      const result = await runUpdateCheck('0.1.0')

      expect(result.action).toBe('check-failed')
      expect(result.error).toBe('Network error')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/server/updater/index.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// server/updater/index.ts
import { checkForUpdate } from './version-checker.js'
import { promptForUpdate } from './prompt.js'
import { executeUpdate, type UpdateProgress } from './executor.js'

export type UpdateAction = 'none' | 'updated' | 'skipped' | 'error' | 'check-failed'

export interface UpdateCheckResult {
  action: UpdateAction
  error?: string
  newVersion?: string
}

const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function printProgress(progress: UpdateProgress): void {
  const labels: Record<string, string> = {
    'git-pull': 'Pulling latest changes',
    'npm-install': 'Installing dependencies',
    'build': 'Building application'
  }

  const label = labels[progress.step] || progress.step

  if (progress.status === 'running') {
    process.stdout.write(`  ${SPINNER_CHARS[0]} ${label}...\r`)
  } else if (progress.status === 'complete') {
    console.log(`  ✓ ${label}`)
  } else if (progress.status === 'error') {
    console.log(`  ✗ ${label}: ${progress.error}`)
  }
}

export async function runUpdateCheck(currentVersion: string): Promise<UpdateCheckResult> {
  const checkResult = await checkForUpdate(currentVersion)

  if (checkResult.error) {
    return { action: 'check-failed', error: checkResult.error }
  }

  if (!checkResult.updateAvailable || !checkResult.latestVersion) {
    return { action: 'none' }
  }

  const shouldUpdate = await promptForUpdate(currentVersion, checkResult.latestVersion)

  if (!shouldUpdate) {
    console.log('Skipping update.\n')
    return { action: 'skipped' }
  }

  console.log('\nUpdating Freshell...\n')

  const updateResult = await executeUpdate(printProgress)

  if (!updateResult.success) {
    console.log('\n\x1b[31mUpdate failed!\x1b[0m Please try updating manually.\n')
    return { action: 'error', error: updateResult.error }
  }

  console.log('\n\x1b[32mUpdate complete!\x1b[0m Restarting...\n')
  return { action: 'updated', newVersion: checkResult.latestVersion }
}

export { checkForUpdate } from './version-checker.js'
export { executeUpdate } from './executor.js'
export type { UpdateProgress } from './executor.js'
```

**Step 4: Run test to verify it passes**

Run: `npm test -- test/unit/server/updater/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/updater/index.ts test/unit/server/updater/index.test.ts
git commit -m "$(cat <<'EOF'
feat(updater): add update orchestrator

Coordinates version check, user prompt, and update execution.
Provides progress feedback during update process.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Integrate Updater into Server Startup

**Files:**
- Modify: `server/index.ts`
- Modify: `package.json` (to expose version)
- Test: Integration test via manual verification

**Step 1: Read package.json version at startup**

Add to top of `server/index.ts` (after bootstrap import):

```typescript
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const packageJson = require('../package.json')
const APP_VERSION: string = packageJson.version
```

**Step 2: Import and call updater before server starts**

Add import near top of `server/index.ts`:

```typescript
import { runUpdateCheck } from './updater/index.js'
```

Add update check in main startup (before `app.listen`):

```typescript
// Check for updates before starting server
const updateResult = await runUpdateCheck(APP_VERSION)

if (updateResult.action === 'updated') {
  // Re-exec the process to run the new version
  console.log('Restarting with new version...')
  process.exit(0) // Exit and let process manager restart
}
```

**Step 3: Add --skip-update-check flag for CI/testing**

Add near the top of `server/index.ts`:

```typescript
const SKIP_UPDATE_CHECK = process.argv.includes('--skip-update-check') ||
                          process.env.SKIP_UPDATE_CHECK === 'true'
```

Wrap update check:

```typescript
if (!SKIP_UPDATE_CHECK) {
  const updateResult = await runUpdateCheck(APP_VERSION)
  // ... rest of update logic
}
```

**Step 4: Test manually**

Run: `npm run dev:server -- --skip-update-check`
Expected: Server starts without update check

Run: `npm run dev:server`
Expected: Server checks for updates, shows prompt if update available

**Step 5: Commit**

```bash
git add server/index.ts
git commit -m "$(cat <<'EOF'
feat: integrate auto-update into server startup

Checks for updates on server start unless --skip-update-check flag
or SKIP_UPDATE_CHECK env var is set. If update is applied, exits
so process manager can restart with new version.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add Version to API Endpoints

**Files:**
- Modify: `server/index.ts` (add version to health/debug endpoints)
- Test: `test/server/api.test.ts` (add version assertions)

**Step 1: Update health endpoint**

Modify the `/api/health` handler to include version:

```typescript
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: APP_VERSION })
})
```

**Step 2: Update debug endpoint**

Add version to the debug response object.

**Step 3: Write the test**

```typescript
// In test/server/api.test.ts
describe('GET /api/health', () => {
  it('returns version in response', async () => {
    const res = await request(app).get('/api/health')
    expect(res.body).toHaveProperty('version')
    expect(typeof res.body.version).toBe('string')
  })
})
```

**Step 4: Run tests**

Run: `npm run test:server -- test/server/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/index.ts test/server/api.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add version to health and debug endpoints

Exposes current application version in API responses.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add Restart Logic for Process Managers

**Files:**
- Modify: `package.json` (add restart-aware start script)
- Create: `scripts/start-with-update.sh` (optional wrapper)

**Step 1: Consider restart strategies**

For users running via `npm start`:
- Exit with code 0 after update → user re-runs `npm start`

For users with process managers (systemd, pm2):
- Exit with code 0 → process manager restarts automatically

**Step 2: Add documentation**

Update README with update behavior documentation.

**Step 3: Commit**

```bash
git add package.json README.md
git commit -m "$(cat <<'EOF'
docs: document auto-update behavior

Explains how auto-update works and restart behavior for
different deployment scenarios.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: E2E Test for Update Flow

**Files:**
- Create: `test/e2e/update-flow.test.ts`

**Step 1: Write E2E test with mocked GitHub API**

```typescript
// test/e2e/update-flow.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'

describe('update flow e2e', () => {
  it('shows update prompt when new version available (mocked)', async () => {
    // This is a pseudo-test demonstrating the flow
    // Real e2e would need GitHub API mocking via msw or similar

    // Start server with test environment
    // Assert update banner appears
    // Send 'n' to decline
    // Assert server continues to start
  })
})
```

**Step 2: Commit**

```bash
git add test/e2e/update-flow.test.ts
git commit -m "$(cat <<'EOF'
test: add e2e test skeleton for update flow

Placeholder for full e2e testing with mocked GitHub API.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final Integration and Version Bump

**Files:**
- Modify: `package.json` (bump to 0.2.0 for first auto-update release)

**Step 1: Bump version**

Change version in `package.json` from `0.1.0` to `0.2.0`

**Step 2: Commit and tag**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore: bump version to 0.2.0

First release with auto-update capability.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
git tag -a v0.2.0 -m "v0.2.0 - Auto-update support"
```

**Step 3: Push and create release**

```bash
git push origin feature/auto-update
git push origin v0.2.0
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 0 | Tag current production build | git only |
| 1 | Version checker module | `server/updater/version-checker.ts`, `types.ts` |
| 2 | Update executor module | `server/updater/executor.ts` |
| 3 | Interactive prompt module | `server/updater/prompt.ts` |
| 4 | Update orchestrator | `server/updater/index.ts` |
| 5 | Server startup integration | `server/index.ts` |
| 6 | Version in API endpoints | `server/index.ts`, tests |
| 7 | Restart documentation | `README.md` |
| 8 | E2E test skeleton | `test/e2e/update-flow.test.ts` |
| 9 | Version bump and release | `package.json`, git tags |
