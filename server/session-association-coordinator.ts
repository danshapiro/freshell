import { makeSessionKey, type CodingCliSession, type ProjectGroup } from './coding-cli/types.js'
import { modeSupportsResume, type BindSessionResult } from './terminal-registry.js'
import type { SessionBindingReason } from './terminal-stream/registry-events.js'

type TerminalAssociationCandidate = {
  terminalId: string
  createdAt: number
}

type AssociationRegistry = {
  findUnassociatedTerminals: (mode: CodingCliSession['provider'], cwd: string) => TerminalAssociationCandidate[]
  bindSession: (
    terminalId: string,
    provider: CodingCliSession['provider'],
    sessionId: string,
    reason: SessionBindingReason,
  ) => BindSessionResult
  isSessionBound: (provider: CodingCliSession['provider'], sessionId: string) => boolean
}

export type SessionAssociationResult = {
  associated: boolean
  terminalId?: string
  reason?:
    | 'provider_managed'
    | 'provider_not_supported'
    | 'missing_cwd'
    | 'subagent'
    | 'non_interactive'
}

export class SessionAssociationCoordinator {
  private watermarks = new Map<string, number>()

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
    const candidate = this.associationCandidateReason(session)
    if (candidate !== 'ok') return { associated: false, reason: candidate }
    if (this.registry.isSessionBound(session.provider, session.sessionId)) return { associated: false }
    const cwd = session.cwd!
    const unassociated = this.registry.findUnassociatedTerminals(session.provider, cwd)
    if (unassociated.length === 0) return { associated: false }

    const term = unassociated.find((candidate) => session.lastActivityAt >= candidate.createdAt - this.maxAssociationAgeMs)
    if (!term) return { associated: false }

    const bound = this.registry.bindSession(term.terminalId, session.provider, session.sessionId, 'association')
    if (!bound.ok) return { associated: false }

    return { associated: true, terminalId: term.terminalId }
  }

  private isAssociationCandidate(session: CodingCliSession): boolean {
    return this.associationCandidateReason(session) === 'ok'
  }

  private associationCandidateReason(
    session: CodingCliSession,
  ): 'ok' | NonNullable<SessionAssociationResult['reason']> {
    if (session.provider === 'codex') return 'provider_managed'
    if (!modeSupportsResume(session.provider)) return 'provider_not_supported'
    if (!session.cwd) return 'missing_cwd'
    if (session.isSubagent) return 'subagent'
    if (session.isNonInteractive) return 'non_interactive'
    return 'ok'
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
