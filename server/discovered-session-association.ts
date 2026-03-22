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
  rebindSession: (
    terminalId: string,
    provider: CodingCliSession['provider'],
    sessionId: string,
    reason: SessionBindingReason,
  ) => BindSessionResult
  getSessionOwner: (
    provider: CodingCliSession['provider'],
    sessionId: string,
  ) => string | undefined
}

export type DiscoveredSessionAssociationResult = {
  associated: boolean
  terminalId?: string
}

type SessionWatermark = {
  lastActivityAt: number
  launchOriginKey?: string
}

export class DiscoveredSessionAssociation {
  private watermarks = new Map<string, SessionWatermark>()

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

    const terminalId = session.launchOrigin?.terminalId
    if (!terminalId) return { associated: false }

    const terminal = this.registry.get(terminalId)
    if (!terminal || terminal.mode !== session.provider || terminal.status !== 'running') {
      return { associated: false }
    }

    const owner = this.registry.getSessionOwner(session.provider, session.sessionId)
    if (owner === terminalId && terminal.resumeSessionId === session.sessionId) {
      return { associated: false }
    }
    if (terminal.resumeSessionId && terminal.resumeSessionId !== session.sessionId) {
      return { associated: false }
    }

    const bound = this.registry.rebindSession(terminalId, session.provider, session.sessionId, 'association')
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
    const nextLastActivityAt = this.normalizeLastActivityAt(session.lastActivityAt)
    const nextLaunchOriginKey = this.getLaunchOriginKey(session)
    const prev = this.watermarks.get(key)
    const launchOriginAdvanced = !!nextLaunchOriginKey && nextLaunchOriginKey !== prev?.launchOriginKey
    if (prev !== undefined && nextLastActivityAt <= prev.lastActivityAt && !launchOriginAdvanced) {
      return false
    }
    this.watermarks.set(key, {
      lastActivityAt: Math.max(prev?.lastActivityAt ?? 0, nextLastActivityAt),
      launchOriginKey: nextLaunchOriginKey ?? prev?.launchOriginKey,
    })
    return true
  }

  private getLaunchOriginKey(session: CodingCliSession): string | undefined {
    const terminalId = session.launchOrigin?.terminalId?.trim()
    if (!terminalId) return undefined
    const tabId = session.launchOrigin?.tabId?.trim() ?? ''
    const paneId = session.launchOrigin?.paneId?.trim() ?? ''
    return `${terminalId}:${tabId}:${paneId}`
  }

  private normalizeLastActivityAt(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.floor(value)
  }
}
