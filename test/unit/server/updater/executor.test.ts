// test/unit/server/updater/executor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeUpdate, type UpdateProgress, type ExecAsyncFn } from '../../../../server/updater/executor.js'

describe('executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeUpdate', () => {
    it('runs git pull, npm install, and npm run build in sequence', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

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
      const mockExec: ExecAsyncFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
      const testProjectRoot = '/test/project/root'

      await executeUpdate(() => {}, mockExec, { projectRoot: testProjectRoot })

      expect(mockExec).toHaveBeenCalledTimes(3)
      expect(mockExec).toHaveBeenNthCalledWith(1, 'git pull', { cwd: testProjectRoot })
      expect(mockExec).toHaveBeenNthCalledWith(2, 'npm ci', { cwd: testProjectRoot })
      expect(mockExec).toHaveBeenNthCalledWith(3, 'npm run build', { cwd: testProjectRoot })
    })

    it('reports error and stops if git pull fails', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes('git pull')) {
          return Promise.reject(new Error('Git pull failed'))
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Git pull failed')
      expect(progress).toContainEqual({ step: 'git-pull', status: 'error', error: expect.any(String) })
      // Should not continue to npm install
      expect(mockExec).toHaveBeenCalledTimes(1)
    })

    it('reports error and stops if npm ci fails', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes('npm ci')) {
          return Promise.reject(new Error('npm ci failed'))
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('npm ci failed')
      expect(progress).toContainEqual({ step: 'npm-install', status: 'error', error: expect.any(String) })
      // Should have run git pull but not build
      expect(mockExec).toHaveBeenCalledTimes(2)
    })

    it('reports error and stops if build fails', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes('npm run build')) {
          return Promise.reject(new Error('Build failed'))
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Build failed')
      expect(progress).toContainEqual({ step: 'build', status: 'error', error: expect.any(String) })
    })

    it('returns success: true when all commands succeed', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

      const result = await executeUpdate(() => {}, mockExec)

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('handles non-Error thrown values', async () => {
      const mockExec: ExecAsyncFn = vi.fn().mockRejectedValue('string error')

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toBe('string error')
    })

    it('includes stderr in error message when available', async () => {
      const errorWithStderr = new Error('Command failed') as Error & { stderr?: string }
      errorWithStderr.stderr = 'ENOENT: npm not found'
      const mockExec: ExecAsyncFn = vi.fn().mockRejectedValue(errorWithStderr)

      const progress: UpdateProgress[] = []
      const result = await executeUpdate((p) => progress.push(p), mockExec)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Command failed')
      expect(result.error).toContain('ENOENT: npm not found')
    })
  })
})
