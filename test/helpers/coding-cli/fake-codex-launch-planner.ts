export const DEFAULT_CODEX_REMOTE_WS_URL = 'ws://127.0.0.1:43123'

export class FakeCodexTerminalSidecar {
  attachedTerminalId?: string
  durableSessionHandlers = new Set<(sessionId: string) => void>()
  fatalHandlers = new Set<(error: Error) => void>()
  shutdownCalls = 0

  attachTerminal(input: {
    terminalId: string
    onDurableSession: (sessionId: string) => void
    onFatal: (error: Error) => void
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

  emitFatal(message = 'fake codex sidecar failed') {
    const error = new Error(message)
    for (const handler of this.fatalHandlers) {
      handler(error)
    }
  }
}

export class FakeCodexLaunchPlanner {
  planCreateCalls: any[] = []
  readonly sidecar: FakeCodexTerminalSidecar

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

  async planCreate(input: any) {
    this.planCreateCalls.push(input)
    return {
      ...this.plan,
      sidecar: this.sidecar,
    }
  }
}
