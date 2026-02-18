import { makeSessionKey, type CodingCliProviderName, type SessionCompositeKey } from './coding-cli/types.js'

export type BindInput = {
  provider: CodingCliProviderName
  sessionId: string
  terminalId: string
}

export type BindResult =
  | { ok: true; key: SessionCompositeKey }
  | { ok: false; reason: 'session_already_owned'; owner: string }
  | { ok: false; reason: 'terminal_already_bound'; existing: SessionCompositeKey }

export type UnbindResult =
  | { ok: true; key: SessionCompositeKey }
  | { ok: false; reason: 'not_bound' }

export class SessionBindingAuthority {
  private bySession = new Map<SessionCompositeKey, string>()
  private byTerminal = new Map<string, SessionCompositeKey>()

  bind(input: BindInput): BindResult {
    const key = makeSessionKey(input.provider, input.sessionId)
    const owner = this.bySession.get(key)
    if (owner && owner !== input.terminalId) {
      return { ok: false, reason: 'session_already_owned', owner }
    }

    const existing = this.byTerminal.get(input.terminalId)
    if (existing && existing !== key) {
      return { ok: false, reason: 'terminal_already_bound', existing }
    }

    this.bySession.set(key, input.terminalId)
    this.byTerminal.set(input.terminalId, key)
    return { ok: true, key }
  }

  ownerForSession(provider: CodingCliProviderName, sessionId: string): string | undefined {
    return this.bySession.get(makeSessionKey(provider, sessionId))
  }

  sessionForTerminal(terminalId: string): SessionCompositeKey | undefined {
    return this.byTerminal.get(terminalId)
  }

  unbindTerminal(terminalId: string): UnbindResult {
    const key = this.byTerminal.get(terminalId)
    if (!key) return { ok: false, reason: 'not_bound' }

    this.byTerminal.delete(terminalId)
    if (this.bySession.get(key) === terminalId) {
      this.bySession.delete(key)
    }
    return { ok: true, key }
  }

  clearSessionOwner(provider: CodingCliProviderName, sessionId: string): void {
    const key = makeSessionKey(provider, sessionId)
    const ownerTerminalId = this.bySession.get(key)
    if (!ownerTerminalId) return
    this.bySession.delete(key)
    if (this.byTerminal.get(ownerTerminalId) === key) {
      this.byTerminal.delete(ownerTerminalId)
    }
  }
}
