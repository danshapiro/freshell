import type { ProjectGroup } from './coding-cli/types.js'

const COMPATIBILITY_UPDATE_PROVIDERS = new Set(['claude', 'opencode'])

export function splitAssociationProjectsForUpdate(projects: ProjectGroup[]): {
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
      sessions: project.sessions.filter((session) => COMPATIBILITY_UPDATE_PROVIDERS.has(session.provider)),
    })),
  }
}
