import type { CodingCliSession, ProjectGroup } from './coding-cli/types.js'

const COMPATIBILITY_UPDATE_PROVIDERS = new Set(['opencode', 'kimi'])

type SplitAssociationProjectsForUpdateOptions = {
  includeClaudeSession?: (session: CodingCliSession) => boolean
}

export function splitAssociationProjectsForUpdate(
  projects: ProjectGroup[],
  options: SplitAssociationProjectsForUpdateOptions = {},
): {
  codexProjects: ProjectGroup[]
  compatibilityProjects: ProjectGroup[]
} {
  return {
    codexProjects: projects.map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.provider === 'codex'),
    })),
    compatibilityProjects: projects.map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => {
        if (COMPATIBILITY_UPDATE_PROVIDERS.has(session.provider)) return true
        if (session.provider !== 'claude') return false
        return options.includeClaudeSession?.(session) ?? false
      }),
    })),
  }
}
