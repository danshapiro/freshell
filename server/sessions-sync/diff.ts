import type { ProjectGroup, CodingCliSession } from '../coding-cli/types.js'

export type SessionsProjectsDiff = {
  upsertProjects: ProjectGroup[]
  removeProjectPaths: string[]
}

function sessionsEqual(a: CodingCliSession, b: CodingCliSession): boolean {
  return (
    (a.provider || 'claude') === (b.provider || 'claude') &&
    a.sessionId === b.sessionId &&
    a.projectPath === b.projectPath &&
    a.updatedAt === b.updatedAt &&
    a.createdAt === b.createdAt &&
    a.messageCount === b.messageCount &&
    a.title === b.title &&
    a.summary === b.summary &&
    a.cwd === b.cwd &&
    a.archived === b.archived &&
    a.sourceFile === b.sourceFile
  )
}

function projectEqual(a: ProjectGroup, b: ProjectGroup): boolean {
  if (a.projectPath !== b.projectPath) return false
  if ((a.color || '') !== (b.color || '')) return false
  if (a.sessions.length !== b.sessions.length) return false

  for (let i = 0; i < a.sessions.length; i += 1) {
    if (!sessionsEqual(a.sessions[i]!, b.sessions[i]!)) return false
  }
  return true
}

export function diffProjects(prev: ProjectGroup[], next: ProjectGroup[]): SessionsProjectsDiff {
  const prevByPath = new Map(prev.map((p) => [p.projectPath, p] as const))
  const nextByPath = new Map(next.map((p) => [p.projectPath, p] as const))

  const removeProjectPaths: string[] = []
  for (const key of prevByPath.keys()) {
    if (!nextByPath.has(key)) removeProjectPaths.push(key)
  }

  const upsertProjects: ProjectGroup[] = []
  for (const [projectPath, nextProject] of nextByPath) {
    const prevProject = prevByPath.get(projectPath)
    if (!prevProject || !projectEqual(prevProject, nextProject)) {
      upsertProjects.push(nextProject)
    }
  }

  // Deterministic order makes tests and patch application simpler.
  removeProjectPaths.sort()
  upsertProjects.sort((a, b) => a.projectPath.localeCompare(b.projectPath))

  return { upsertProjects, removeProjectPaths }
}

