import { makeSessionKey, type CodingCliSession, type ProjectGroup } from './coding-cli/types.js'
import { modeSupportsResume, type BindSessionResult } from './terminal-registry.js'
import type { SessionBindingReason } from './terminal-stream/registry-events.js'

type TerminalAssociationCandidate = {
  terminalId: string
  createdAt: number
  pendingResumeName?: string
}

type AssociationRegistry = {
  findUnassociatedTerminals: (mode: CodingCliSession['provider'], cwd: string) => TerminalAssociationCandidate[]
  bindSession: (
    terminalId: string,
    provider: CodingCliSession['provider'],
    sessionId: string,
    reason: SessionBindingReason,
  ) => BindSessionResult
  isSessionBound: (provider: CodingCliSession['provider'], sessionId: string, cwd?: string) => boolean
}

export type SessionAssociationResult = {
  associated: boolean
  terminalId?: string
}

export class SessionAssociationCoordinator {
  private watermarks = new Map<string, number>()
  private compatibilityProviders = new Set(['claude', 'opencode', 'kimi'])

  constructor(
    private readonly registry: AssociationRegistry,
    private readonly maxAssociationAgeMs: number,
  ) {}

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

  noteSession(session: CodingCliSession): boolean {
    if (!this.isAssociationCandidate(session)) return false
    return this.trackIfAdvanced(session)
  }

  associateSingleSession(session: CodingCliSession): SessionAssociationResult {
    if (!this.isAssociationCandidate(session)) return { associated: false }
    if (this.registry.isSessionBound(session.provider, session.sessionId, session.cwd)) return { associated: false }
    const cwd = session.cwd!
    const unassociated = this.registry.findUnassociatedTerminals(session.provider, cwd)
    const eligible = session.provider === 'claude'
      ? unassociated.filter((candidate) => typeof candidate.pendingResumeName === 'string' && candidate.pendingResumeName.trim().length > 0)
      : unassociated
    if (eligible.length === 0) return { associated: false }

    const term = eligible.find((candidate) => session.lastActivityAt >= candidate.createdAt - this.maxAssociationAgeMs)
    if (!term) return { associated: false }

    const bound = this.registry.bindSession(term.terminalId, session.provider, session.sessionId, 'association')
    if (!bound.ok) return { associated: false }

    return { associated: true, terminalId: term.terminalId }
  }

  private isAssociationCandidate(session: CodingCliSession): boolean {
    if (!this.compatibilityProviders.has(session.provider)) return false
    if (!modeSupportsResume(session.provider)) return false
    if (!session.cwd) return false
    if (session.isSubagent) return false
    if (session.isNonInteractive) return false
    if (session.provider === 'claude') {
      return this.registry.findUnassociatedTerminals(session.provider, session.cwd)
        .some((candidate) => typeof candidate.pendingResumeName === 'string' && candidate.pendingResumeName.trim().length > 0)
    }
    return true
  }

  private trackIfAdvanced(session: CodingCliSession): boolean {
    const key = makeSessionKey(session.provider, session.sessionId, session.cwd)
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
