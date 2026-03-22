import { makeSessionKey, type CodingCliSession, type ProjectGroup } from './coding-cli/types.js'
import type { BindSessionResult } from './terminal-registry.js'
import type { SessionBindingReason } from './terminal-stream/registry-events.js'

type TerminalAssociationCandidate = {
  terminalId: string
  mode: string
  status: 'running' | 'exited'
  resumeSessionId?: string
}

type AssociationRegistry = {
  get: (terminalId: string) => TerminalAssociationCandidate | null | undefined
  bindSession: (
    terminalId: string,
    provider: CodingCliSession['provider'],
    sessionId: string,
    reason: SessionBindingReason,
  ) => BindSessionResult
  isSessionBound: (provider: CodingCliSession['provider'], sessionId: string) => boolean
}

export type DiscoveredSessionAssociationResult = {
  associated: boolean
  terminalId?: string
}

export class DiscoveredSessionAssociation {
  private watermarks = new Map<string, number>()

  constructor(private readonly registry: AssociationRegistry) {}

  collectNewOrAdvanced(projects: ProjectGroup[]): CodingCliSession[] {
    const candidates: CodingCliSession[] = []
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!this.isAssociationCandidate(session)) continue
        if (!this.trackIfAdvanced(session)) continue
        candidates.push(session)
      }
    }
    return candidates
  }

  associateSingleSession(session: CodingCliSession): DiscoveredSessionAssociationResult {
    if (!this.isAssociationCandidate(session)) return { associated: false }
    if (this.registry.isSessionBound(session.provider, session.sessionId)) return { associated: false }

    const terminalId = session.launchOrigin?.terminalId
    if (!terminalId) return { associated: false }

    const terminal = this.registry.get(terminalId)
    if (!terminal || terminal.mode !== session.provider || terminal.status !== 'running') {
      return { associated: false }
    }
    if (terminal.resumeSessionId && terminal.resumeSessionId !== session.sessionId) {
      return { associated: false }
    }

    const bound = this.registry.bindSession(terminalId, session.provider, session.sessionId, 'association')
    if (!bound.ok) return { associated: false }
    return { associated: true, terminalId }
  }

  private isAssociationCandidate(session: CodingCliSession): boolean {
    if (session.provider !== 'codex') return false
    if (session.isSubagent) return false
    if (session.isNonInteractive) return false
    return true
  }

  private trackIfAdvanced(session: CodingCliSession): boolean {
    const key = makeSessionKey(session.provider, session.sessionId)
    const next = this.normalizeLastActivityAt(session.lastActivityAt)
    const prev = this.watermarks.get(key)
    if (prev !== undefined && next <= prev) return false
    this.watermarks.set(key, next)
    return true
  }

  private normalizeLastActivityAt(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.floor(value)
  }
}
