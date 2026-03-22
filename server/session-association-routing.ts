import type { ProjectGroup } from './coding-cli/types.js'

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
      sessions: project.sessions.filter((session) => session.provider !== 'codex'),
    })),
  }
}
