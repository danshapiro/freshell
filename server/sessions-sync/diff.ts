import type { ProjectGroup, CodingCliSession } from '../coding-cli/types.js'

export type SessionsProjectsDiff = {
  upsertProjects: ProjectGroup[]
  removeProjectPaths: string[]
}

function sessionsEqual(a: CodingCliSession, b: CodingCliSession): boolean {
  // Compare all own enumerable fields, so new session fields can't be silently ignored.
  if ((a.provider || 'claude') !== (b.provider || 'claude')) return false

  for (const key in a) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) continue
    if (key === 'provider') continue
    if ((a as any)[key] !== (b as any)[key]) return false
  }

  for (const key in b) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue
    if (key === 'provider') continue
    if ((a as any)[key] !== (b as any)[key]) return false
  }

  return true
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
