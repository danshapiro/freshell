export const DEFAULT_CODEX_REMOTE_WS_URL = 'ws://127.0.0.1:43123'

export class FakeCodexTerminalSidecar {
  attachedTerminalId?: string
  durableSessionHandlers = new Set<(sessionId: string) => void>()
  fatalHandlers = new Set<(error: Error, source?: 'sidecar_fatal' | 'app_server_exit' | 'app_server_client_disconnect') => void>()
  shutdownCalls = 0

  attachTerminal(input: {
    terminalId: string
    onDurableSession: (sessionId: string) => void
    onThreadLifecycle?: (event: unknown) => void
    onFatal: (error: Error, source?: 'sidecar_fatal' | 'app_server_exit' | 'app_server_client_disconnect') => void
  }) {
    this.attachedTerminalId = input.terminalId
    this.durableSessionHandlers.add(input.onDurableSession)
    this.fatalHandlers.add(input.onFatal)
  }

  async shutdown() {
    this.shutdownCalls += 1
  }

  emitDurableSession(sessionId: string) {
    for (const handler of this.durableSessionHandlers) {
      handler(sessionId)
    }
  }

  emitFatal(
    message = 'fake codex sidecar failed',
    source: 'sidecar_fatal' | 'app_server_exit' | 'app_server_client_disconnect' = 'sidecar_fatal',
  ) {
    const error = new Error(message)
    for (const handler of this.fatalHandlers) {
      handler(error, source)
    }
  }
}

export class FakeCodexLaunchPlanner {
  planCreateCalls: any[] = []
  readonly sidecar: FakeCodexTerminalSidecar
  private failuresRemaining = 0

  constructor(
    private readonly plan: {
      sessionId?: string
      remote: { wsUrl: string }
      sidecar?: FakeCodexTerminalSidecar
    } = {
      remote: { wsUrl: DEFAULT_CODEX_REMOTE_WS_URL },
    },
  ) {
    this.sidecar = this.plan.sidecar ?? new FakeCodexTerminalSidecar()
  }

  failNext(count: number) {
    this.failuresRemaining = count
  }

  async planCreate(input: any) {
    this.planCreateCalls.push(input)
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('fake Codex launch failed')
    }
    return {
      ...this.plan,
      sidecar: this.sidecar,
    }
  }
}
