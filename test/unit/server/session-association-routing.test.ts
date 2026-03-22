import { describe, expect, it } from 'vitest'
import type { CodingCliSession, ProjectGroup } from '../../../server/coding-cli/types'
import { splitAssociationProjectsForUpdate } from '../../../server/session-association-routing'

function createProject(sessions: CodingCliSession[]): ProjectGroup {
  return {
    projectPath: '/repo/project',
    sessions,
  }
}

describe('splitAssociationProjectsForUpdate', () => {
  it('keeps Claude sessions on the compatibility update path while reserving Codex for exact provenance binding', () => {
    const projects = [createProject([
      {
        provider: 'claude',
        sessionId: 'claude-session-1',
        projectPath: '/repo/project',
        lastActivityAt: 1_000,
        cwd: '/repo/project',
      },
      {
        provider: 'codex',
        sessionId: 'codex-session-1',
        projectPath: '/repo/project',
        lastActivityAt: 1_000,
        cwd: '/repo/project',
      },
      {
        provider: 'opencode',
        sessionId: 'opencode-session-1',
        projectPath: '/repo/project',
        lastActivityAt: 1_000,
        cwd: '/repo/project',
      },
    ])]

    const { codexProjects, compatibilityProjects } = splitAssociationProjectsForUpdate(projects)

    expect(codexProjects[0]?.sessions.map((session) => session.provider)).toEqual(['codex'])
    expect(compatibilityProjects[0]?.sessions.map((session) => session.provider)).toEqual(['claude', 'opencode'])
  })
})
