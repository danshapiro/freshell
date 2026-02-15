// test/unit/server/updater/executor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeUpdate, type UpdateProgress, type ExecAsyncFn } from '../../../../server/updater/executor.js'

/**
 * Helper: creates a mock exec that resolves for all commands by default,
 * with optional per-command overrides via a map of command substring → behavior.
 */
function createMockExec(overrides: Record<string, 'reject' | Error | string> = {}): ExecAsyncFn {
  return vi.fn().mockImplementation((cmd: string) => {
    for (const [substr, behavior] of Object.entries(overrides)) {
      if (cmd.includes(substr)) {
        if (behavior === 'reject') {
          return Promise.reject(new Error(`${substr} failed`))
        }
        if (behavior instanceof Error) {
          return Promise.reject(behavior)
        }
        if (typeof behavior === 'string') {
          return Promise.reject(new Error(behavior))
        }
      }
    }
    // Default: resolve with mock SHA for rev-parse, empty for others
    if (cmd.includes('rev-parse')) {
      return Promise.resolve({ stdout: 'abc1234snapshot\n', stderr: '' })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  })
}

describe('executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeUpdate', () => {
    it('runs git pull, npm install, and npm run build in sequence', async () => {
      const mockExec = createMockExec()
      const progress: UpdateProgress[] = []
      await executeUpdate((p) => progress.push(p), mockExec)

      expect(progress).toContainEqual({ step: 'git-pull', status: 'running' })
      expect(progress).toContainEqual({ step: 'git-pull', status: 'complete' })
      expect(progress).toContainEqual({ step: 'npm-install', status: 'running' })
      expect(progress).toContainEqual({ step: 'npm-install', status: 'complete' })
      expect(progress).toContainEqual({ step: 'build', status: 'running' })
      expect(progress).toContainEqual({ step: 'build', status: 'complete' })
    })

    it('executes commands with correct project root cwd', async () => {
      const mockExec = createMockExec()
      const testProjectRoot = '/test/project/root'

      await executeUpdate(() => {}, mockExec, { projectRoot: testProjectRoot })

      // rev-parse + 3 update steps = 4 calls
      expect(mockExec).toHaveBeenCalledTimes(4)
      expect(mockExec).toHaveBeenCalledWith('git rev-parse HEAD', { cwd: testProjectRoot })
      expect(mockExec).toHaveBeenCalledWith('git pull', { cwd: testProjectRoot })
      expect(mockExec).toHaveBeenCalledWith('npm ci', { cwd: testProjectRoot })
      expect(mockExec).toHaveBeenCalledWith('npm run build', { cwd: testProjectRoot })
    })

    it('reports error and stops if git pull fails', async () => {
      const mockExec = createMockExec({ 'git pull': 'reject' })
      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('git pull failed')
      expect(progress).toContainEqual({ step: 'git-pull', status: 'error', error: expect.any(String) })
      // rev-parse + git pull = 2 calls (no npm install or build)
      expect(mockExec).toHaveBeenCalledTimes(2)
    })

    it('reports error and stops if npm ci fails', async () => {
      const mockExec = createMockExec({ 'npm ci': 'reject' })
      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('npm ci failed')
      expect(progress).toContainEqual({ step: 'npm-install', status: 'error', error: expect.any(String) })
    })

    it('reports error and stops if build fails', async () => {
      const mockExec = createMockExec({ 'npm run build': 'reject' })
      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('npm run build failed')
      expect(progress).toContainEqual({ step: 'build', status: 'error', error: expect.any(String) })
    })

    it('returns success: true when all commands succeed', async () => {
      const mockExec = createMockExec()
      const result = await executeUpdate(() => {}, mockExec)

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('handles non-Error thrown values', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        return Promise.reject('string error')
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toBe('string error')
    })

    it('includes stderr in error message when available', async () => {
      const errorWithStderr = new Error('Command failed') as Error & { stderr?: string }
      errorWithStderr.stderr = 'ENOENT: npm not found'
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        return Promise.reject(errorWithStderr)
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Command failed')
      expect(result.error).toContain('ENOENT: npm not found')
    })
  })

  describe('snapshot', () => {
    it('captures HEAD SHA via git rev-parse before update steps', async () => {
      const mockExec = createMockExec()
      await executeUpdate(() => {}, mockExec, { projectRoot: '/test' })

      // First call should be rev-parse
      expect(mockExec).toHaveBeenNthCalledWith(1, 'git rev-parse HEAD', { cwd: '/test' })
    })

    it('includes snapshotSha in successful result', async () => {
      const mockExec = createMockExec()
      const result = await executeUpdate(() => {}, mockExec)

      expect(result.snapshotSha).toBe('abc1234snapshot')
    })

    it('continues without snapshot if rev-parse fails', async () => {
      const mockExec = createMockExec({ 'rev-parse': 'reject' })
      const result = await executeUpdate(() => {}, mockExec)

      // Should still succeed — snapshot failure is non-fatal
      expect(result.success).toBe(true)
      expect(result.snapshotSha).toBeUndefined()
    })
  })

  describe('GPG tag verification', () => {
    it('runs verify-tag when targetTag is provided and verification succeeds', async () => {
      const mockExec = createMockExec()
      const progress: UpdateProgress[] = []

      await executeUpdate((p) => progress.push(p), mockExec, {
        targetTag: 'v0.5.0',
        projectRoot: '/test'
      })

      expect(mockExec).toHaveBeenCalledWith('git fetch origin tag v0.5.0', { cwd: '/test' })
      expect(mockExec).toHaveBeenCalledWith('git verify-tag v0.5.0', { cwd: '/test' })
      expect(progress).toContainEqual({ step: 'verify-tag', status: 'running' })
      expect(progress).toContainEqual({ step: 'verify-tag', status: 'complete' })
    })

    it('skips verification when no targetTag provided', async () => {
      const mockExec = createMockExec()
      const progress: UpdateProgress[] = []

      await executeUpdate((p) => progress.push(p), mockExec)

      expect(progress).not.toContainEqual(expect.objectContaining({ step: 'verify-tag' }))
    })

    it('aborts update when verification fails in strict mode', async () => {
      const mockExec = createMockExec({ 'verify-tag': 'reject' })
      const progress: UpdateProgress[] = []

      const result = await executeUpdate((p) => progress.push(p), mockExec, {
        targetTag: 'v0.5.0',
        requireGpgVerification: true
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('verify-tag failed')
      expect(progress).toContainEqual({ step: 'verify-tag', status: 'error', error: expect.any(String) })
      // Should not have called git pull
      const calls = (mockExec as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
      expect(calls).not.toContain('git pull')
    })

    it('continues with warning when verification fails in permissive mode', async () => {
      const mockExec = createMockExec({ 'verify-tag': 'reject' })
      const progress: UpdateProgress[] = []

      const result = await executeUpdate((p) => progress.push(p), mockExec, {
        targetTag: 'v0.5.0',
        requireGpgVerification: false
      })

      expect(result.success).toBe(true)
      // verify-tag should show error (warning)
      expect(progress).toContainEqual({ step: 'verify-tag', status: 'error', error: expect.any(String) })
      // But git-pull should still have run
      expect(progress).toContainEqual({ step: 'git-pull', status: 'complete' })
    })

    it('continues when verification fails with no requireGpgVerification set', async () => {
      const mockExec = createMockExec({ 'verify-tag': 'reject' })
      const progress: UpdateProgress[] = []

      const result = await executeUpdate((p) => progress.push(p), mockExec, {
        targetTag: 'v0.5.0'
      })

      // Default is permissive — should continue
      expect(result.success).toBe(true)
      expect(progress).toContainEqual({ step: 'git-pull', status: 'complete' })
    })
  })

  describe('rollback', () => {
    it('rolls back on build failure with git reset and npm ci', async () => {
      const calls: string[] = []
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd: string) => {
        calls.push(cmd)
        if (cmd.includes('rev-parse')) return Promise.resolve({ stdout: 'snap123\n', stderr: '' })
        if (cmd === 'npm run build') return Promise.reject(new Error('Build failed'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Build failed')
      expect(result.rolledBack).toBe(true)
      expect(result.snapshotSha).toBe('snap123')

      // Verify rollback commands were executed in order
      expect(calls).toContain('git reset --hard snap123')
      const resetIdx = calls.indexOf('git reset --hard snap123')
      // The npm ci AFTER reset is the rollback restore
      const rollbackNpmCiIdx = calls.indexOf('npm ci', resetIdx)
      expect(rollbackNpmCiIdx).toBeGreaterThan(resetIdx)

      // Verify rollback progress events
      expect(progress).toContainEqual({ step: 'rollback', status: 'running' })
      expect(progress).toContainEqual({ step: 'rollback', status: 'complete' })
    })

    it('rolls back on npm-install failure', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return Promise.resolve({ stdout: 'snap456\n', stderr: '' })
        if (cmd === 'npm ci' && (vi.mocked(mockExec).mock.calls.filter((c: unknown[]) => c[0] === 'npm ci').length === 1)) {
          // First npm ci (update step) fails, second (rollback) succeeds
          return Promise.reject(new Error('npm ci failed'))
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const result = await executeUpdate(() => {}, mockExec)

      expect(result.success).toBe(false)
      expect(result.rolledBack).toBe(true)
    })

    it('does not roll back on git-pull failure', async () => {
      const mockExec = createMockExec({ 'git pull': 'reject' })
      const progress: UpdateProgress[] = []

      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      // No rollback events — code hasn't changed yet
      expect(progress).not.toContainEqual(expect.objectContaining({ step: 'rollback' }))
      expect(result.rolledBack).toBeUndefined()
    })

    it('reports rolledBack: false when rollback itself fails', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return Promise.resolve({ stdout: 'snap789\n', stderr: '' })
        if (cmd === 'npm run build') return Promise.reject(new Error('Build failed'))
        if (cmd.includes('git reset')) return Promise.reject(new Error('Reset failed'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Build failed')
      expect(result.rolledBack).toBe(false)
      expect(progress).toContainEqual({ step: 'rollback', status: 'error', error: expect.any(String) })
    })

    it('skips rollback when snapshot SHA is unavailable', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('rev-parse')) return Promise.reject(new Error('not a git repo'))
        if (cmd === 'npm run build') return Promise.reject(new Error('Build failed'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Build failed')
      // No rollback possible without snapshot
      expect(progress).not.toContainEqual(expect.objectContaining({ step: 'rollback' }))
      expect(result.rolledBack).toBeUndefined()
    })
  })
})
