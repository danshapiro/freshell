import { describe, it, expect } from 'vitest'
import { TerminalMetadataService } from '../../../server/terminal-metadata-service'
import type { CodingCliSession } from '../../../server/coding-cli/types'

function createTerminalRecord(overrides: Partial<{
  terminalId: string
  mode: 'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'
  cwd: string | undefined
  resumeSessionId: string | undefined
}> = {}) {
  return {
    terminalId: overrides.terminalId ?? 'term-1',
    title: 'Terminal',
    description: undefined,
    mode: overrides.mode ?? 'shell',
    resumeSessionId: overrides.resumeSessionId,
    createdAt: 10,
    lastActivityAt: 20,
    status: 'running' as const,
    hasClients: true,
    cwd: overrides.cwd,
  }
}

function createService(gitState?: { branch?: string; isDirty?: boolean }) {
  let now = 1_000
  const nextNow = () => {
    now += 100
    return now
  }

  const service = new TerminalMetadataService({
    now: nextNow,
    git: {
      resolveCheckoutRoot: async () => '/workspace/repo',
      resolveRepoRoot: async () => '/workspace',
      resolveBranchAndDirty: async () => ({
        branch: gitState?.branch ?? 'main',
        isDirty: gitState?.isDirty ?? true,
      }),
    },
  })

  return { service }
}

describe('TerminalMetadataService', () => {
  it('seeds metadata from terminal records and enriches checkout/repo/branch/dirty fields', async () => {
    const { service } = createService()

    const meta = await service.seedFromTerminal(
      createTerminalRecord({
        terminalId: 'term-codex',
        mode: 'codex',
        cwd: '/workspace/repo/src',
        resumeSessionId: 'session-1',
      }),
    )

    expect(meta).toEqual({
      terminalId: 'term-codex',
      cwd: '/workspace/repo/src',
      checkoutRoot: '/workspace/repo',
      repoRoot: '/workspace',
      displaySubdir: 'repo',
      branch: 'main',
      isDirty: true,
      provider: 'codex',
      sessionId: 'session-1',
      tokenUsage: undefined,
      updatedAt: 1200,
    })
  })

  it('prefers live git branch/dirty over stale session snapshots and updates token usage', async () => {
    const { service } = createService({ branch: 'feature/live', isDirty: true })
    const seeded = await service.seedFromTerminal(
      createTerminalRecord({
        terminalId: 'term-2',
        mode: 'claude',
        cwd: '/workspace/repo/src',
      }),
    )

    const session: CodingCliSession = {
      provider: 'claude',
      sessionId: 'claude-session-2',
      projectPath: '/workspace/repo',
      updatedAt: Date.now(),
      cwd: '/workspace/repo/src',
      gitBranch: 'main',
      isDirty: false,
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 9,
        cachedTokens: 12,
        totalTokens: 41,
        contextTokens: 41,
        modelContextWindow: 200000,
        compactThresholdTokens: 190000,
        compactPercent: 0,
      },
    }

    const updated = await service.applySessionMetadata('term-2', session)

    expect(seeded?.updatedAt).toBe(1200)
    expect(updated?.updatedAt).toBeGreaterThan(seeded?.updatedAt ?? 0)
    expect(updated).toEqual({
      terminalId: 'term-2',
      cwd: '/workspace/repo/src',
      checkoutRoot: '/workspace/repo',
      repoRoot: '/workspace',
      displaySubdir: 'repo',
      branch: 'feature/live',
      isDirty: true,
      provider: 'claude',
      sessionId: 'claude-session-2',
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 9,
        cachedTokens: 12,
        totalTokens: 41,
        contextTokens: 41,
        modelContextWindow: 200000,
        compactThresholdTokens: 190000,
        compactPercent: 0,
      },
      updatedAt: 1300,
    })
  })

  it('preserves the terminal cwd when session snapshots report a stale cwd', async () => {
    const { service } = createService({ branch: 'feature/worktree', isDirty: false })
    await service.seedFromTerminal(
      createTerminalRecord({
        terminalId: 'term-2b',
        mode: 'codex',
        cwd: '/workspace/repo/.worktrees/feature-branch',
      }),
    )

    const session: CodingCliSession = {
      provider: 'codex',
      sessionId: 'codex-session-2b',
      projectPath: '/workspace/repo',
      updatedAt: Date.now(),
      cwd: '/workspace/repo',
      gitBranch: 'main',
      isDirty: true,
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 9,
        cachedTokens: 12,
        totalTokens: 41,
        contextTokens: 41,
        modelContextWindow: 200000,
        compactThresholdTokens: 190000,
        compactPercent: 0,
      },
    }

    const updated = await service.applySessionMetadata('term-2b', session)

    expect(updated?.cwd).toBe('/workspace/repo/.worktrees/feature-branch')
    expect(updated?.branch).toBe('feature/worktree')
    expect(updated?.isDirty).toBe(false)
  })

  it('uses the session cwd when it is more specific than the terminal spawn cwd (e.g. worktree)', async () => {
    const { service } = createService({ branch: 'feature/worktree', isDirty: false })
    await service.seedFromTerminal(
      createTerminalRecord({
        terminalId: 'term-2c',
        mode: 'codex',
        cwd: '/workspace/repo',
      }),
    )

    const session: CodingCliSession = {
      provider: 'codex',
      sessionId: 'codex-session-2c',
      projectPath: '/workspace/repo',
      updatedAt: Date.now(),
      cwd: '/workspace/repo/.worktrees/feature-branch',
      gitBranch: 'feature/worktree',
      isDirty: false,
    }

    const updated = await service.applySessionMetadata('term-2c', session)

    expect(updated?.cwd).toBe('/workspace/repo/.worktrees/feature-branch')
    expect(updated?.sessionId).toBe('codex-session-2c')
    expect(updated?.provider).toBe('codex')
  })

  it('returns undefined for idempotent updates and avoids duplicate change payloads', async () => {
    const { service } = createService()
    await service.seedFromTerminal(
      createTerminalRecord({
        terminalId: 'term-3',
        mode: 'shell',
        cwd: '/workspace/repo/src',
      }),
    )

    const associated = service.associateSession('term-3', 'codex', 'session-3')
    expect(associated?.sessionId).toBe('session-3')
    expect(associated?.provider).toBe('codex')

    const duplicateAssociation = service.associateSession('term-3', 'codex', 'session-3')
    expect(duplicateAssociation).toBeUndefined()

    const session: CodingCliSession = {
      provider: 'codex',
      sessionId: 'session-3',
      projectPath: '/workspace/repo',
      updatedAt: Date.now(),
      cwd: '/workspace/repo/src',
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 3,
        totalTokens: 6,
        contextTokens: 6,
        compactThresholdTokens: 24,
        compactPercent: 25,
      },
    }

    const firstApply = await service.applySessionMetadata('term-3', session)
    expect(firstApply?.tokenUsage?.compactPercent).toBe(25)

    const secondApply = await service.applySessionMetadata('term-3', session)
    expect(secondApply).toBeUndefined()
    expect(service.list()).toHaveLength(1)
  })
})
