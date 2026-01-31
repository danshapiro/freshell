// test/unit/server/updater/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the dependency modules before importing the orchestrator
vi.mock('../../../../server/updater/version-checker.js', () => ({
  checkForUpdate: vi.fn()
}))

vi.mock('../../../../server/updater/prompt.js', () => ({
  promptForUpdate: vi.fn()
}))

vi.mock('../../../../server/updater/executor.js', () => ({
  executeUpdate: vi.fn()
}))

// Import after mocking
import { runUpdateCheck, type UpdateAction, type UpdateCheckResult } from '../../../../server/updater/index.js'
import { checkForUpdate } from '../../../../server/updater/version-checker.js'
import { promptForUpdate } from '../../../../server/updater/prompt.js'
import { executeUpdate } from '../../../../server/updater/executor.js'

describe('update orchestrator', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    stdoutWriteSpy.mockRestore()
  })

  describe('runUpdateCheck', () => {
    describe('when version check fails', () => {
      it('returns action: check-failed with error message', async () => {
        vi.mocked(checkForUpdate).mockResolvedValue({
          updateAvailable: false,
          currentVersion: '0.1.0',
          latestVersion: null,
          releaseUrl: null,
          error: 'Network error'
        })

        const result = await runUpdateCheck('0.1.0')

        expect(result.action).toBe('check-failed')
        expect(result.error).toBe('Network error')
        expect(promptForUpdate).not.toHaveBeenCalled()
        expect(executeUpdate).not.toHaveBeenCalled()
      })
    })

    describe('when no update is available', () => {
      it('returns action: none and does not prompt user', async () => {
        vi.mocked(checkForUpdate).mockResolvedValue({
          updateAvailable: false,
          currentVersion: '0.1.0',
          latestVersion: '0.1.0',
          releaseUrl: 'https://github.com/test/releases/v0.1.0',
          error: null
        })

        const result = await runUpdateCheck('0.1.0')

        expect(result.action).toBe('none')
        expect(result.error).toBeUndefined()
        expect(result.newVersion).toBeUndefined()
        expect(promptForUpdate).not.toHaveBeenCalled()
        expect(executeUpdate).not.toHaveBeenCalled()
      })
    })

    describe('when update is available', () => {
      beforeEach(() => {
        vi.mocked(checkForUpdate).mockResolvedValue({
          updateAvailable: true,
          currentVersion: '0.1.0',
          latestVersion: '0.2.0',
          releaseUrl: 'https://github.com/test/releases/v0.2.0',
          error: null
        })
      })

      it('prompts user with current and latest versions', async () => {
        vi.mocked(promptForUpdate).mockResolvedValue(false)

        await runUpdateCheck('0.1.0')

        expect(promptForUpdate).toHaveBeenCalledWith('0.1.0', '0.2.0')
      })

      describe('and user declines', () => {
        it('returns action: skipped and does not execute update', async () => {
          vi.mocked(promptForUpdate).mockResolvedValue(false)

          const result = await runUpdateCheck('0.1.0')

          expect(result.action).toBe('skipped')
          expect(executeUpdate).not.toHaveBeenCalled()
        })

        it('logs skip message', async () => {
          vi.mocked(promptForUpdate).mockResolvedValue(false)

          await runUpdateCheck('0.1.0')

          expect(consoleLogSpy).toHaveBeenCalledWith('Skipping update.\n')
        })
      })

      describe('and user accepts', () => {
        beforeEach(() => {
          vi.mocked(promptForUpdate).mockResolvedValue(true)
        })

        it('executes update with progress callback', async () => {
          vi.mocked(executeUpdate).mockResolvedValue({ success: true })

          await runUpdateCheck('0.1.0')

          expect(executeUpdate).toHaveBeenCalledTimes(1)
          expect(executeUpdate).toHaveBeenCalledWith(expect.any(Function))
        })

        it('returns action: updated with newVersion on success', async () => {
          vi.mocked(executeUpdate).mockResolvedValue({ success: true })

          const result = await runUpdateCheck('0.1.0')

          expect(result.action).toBe('updated')
          expect(result.newVersion).toBe('0.2.0')
          expect(result.error).toBeUndefined()
        })

        it('logs update complete message on success', async () => {
          vi.mocked(executeUpdate).mockResolvedValue({ success: true })

          await runUpdateCheck('0.1.0')

          expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining('Update complete!')
          )
        })

        it('returns action: error with error message on failure', async () => {
          vi.mocked(executeUpdate).mockResolvedValue({
            success: false,
            error: 'git pull failed'
          })

          const result = await runUpdateCheck('0.1.0')

          expect(result.action).toBe('error')
          expect(result.error).toBe('git pull failed')
          expect(result.newVersion).toBeUndefined()
        })

        it('logs update failed message on failure', async () => {
          vi.mocked(executeUpdate).mockResolvedValue({
            success: false,
            error: 'npm ci failed'
          })

          await runUpdateCheck('0.1.0')

          expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringContaining('Update failed!')
          )
        })
      })
    })

    describe('edge cases', () => {
      it('handles latestVersion being null when updateAvailable is false', async () => {
        vi.mocked(checkForUpdate).mockResolvedValue({
          updateAvailable: false,
          currentVersion: '0.1.0',
          latestVersion: null,
          releaseUrl: null,
          error: null
        })

        const result = await runUpdateCheck('0.1.0')

        expect(result.action).toBe('none')
        expect(promptForUpdate).not.toHaveBeenCalled()
      })
    })
  })

  describe('progress printing', () => {
    beforeEach(() => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        updateAvailable: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/test/releases/v0.2.0',
        error: null
      })
      vi.mocked(promptForUpdate).mockResolvedValue(true)
    })

    it('prints running status for git-pull step', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'git-pull', status: 'running' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pulling latest changes')
      )
    })

    it('prints complete status for git-pull step', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'git-pull', status: 'complete' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pulling latest changes')
      )
    })

    it('prints running status for npm-install step', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'npm-install', status: 'running' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('Installing dependencies')
      )
    })

    it('prints complete status for npm-install step', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'npm-install', status: 'complete' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Installing dependencies')
      )
    })

    it('prints running status for build step', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'build', status: 'running' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('Building application')
      )
    })

    it('prints complete status for build step', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'build', status: 'complete' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Building application')
      )
    })

    it('prints error status with error message', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        onProgress({ step: 'git-pull', status: 'error', error: 'Permission denied' })
        return { success: false, error: 'Permission denied' }
      })

      await runUpdateCheck('0.1.0')

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      )
    })

    it('handles unknown step names gracefully', async () => {
      vi.mocked(executeUpdate).mockImplementation(async (onProgress) => {
        // TypeScript won't allow this but runtime could have unknown steps
        onProgress({ step: 'unknown-step' as never, status: 'running' })
        return { success: true }
      })

      await runUpdateCheck('0.1.0')

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown-step')
      )
    })
  })

  describe('UpdateAction type', () => {
    it('includes all expected action values', () => {
      // This test validates the type exports correctly by checking assignment
      const actions: UpdateAction[] = ['none', 'updated', 'skipped', 'error', 'check-failed']
      expect(actions).toHaveLength(5)
    })
  })

  describe('UpdateCheckResult interface', () => {
    it('supports all required fields', () => {
      // Validates the interface structure
      const result: UpdateCheckResult = {
        action: 'updated',
        newVersion: '1.0.0'
      }
      expect(result.action).toBe('updated')
      expect(result.newVersion).toBe('1.0.0')
    })

    it('supports optional error field', () => {
      const result: UpdateCheckResult = {
        action: 'error',
        error: 'Some error'
      }
      expect(result.error).toBe('Some error')
    })
  })
})
