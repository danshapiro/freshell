export const DEFAULT_CODEX_REMOTE_WS_URL = 'ws://127.0.0.1:43123'

export class FakeCodexLaunchSidecar {
  adoptCalls: Array<{ terminalId: string; generation: number }> = []
  shutdownCalls = 0
  shutdownError: Error | null = null
  shutdownStarted = false
  private lifecycleLossHandlers = new Set<(event: unknown) => void>()

  async adopt(input: { terminalId: string; generation: number }) {
    this.adoptCalls.push(input)
  }

  async shutdown() {
    if (this.shutdownStarted) return
    this.shutdownStarted = true
    this.shutdownCalls += 1
    if (this.shutdownError) throw this.shutdownError
  }

  onLifecycleLoss(handler: (event: unknown) => void) {
    this.lifecycleLossHandlers.add(handler)
    return () => this.lifecycleLossHandlers.delete(handler)
  }

  emitLifecycleLoss(event: unknown) {
    for (const handler of this.lifecycleLossHandlers) {
      handler(event)
    }
  }
}

export class FakeCodexLaunchPlanner {
  planCreateCalls: any[] = []
  sidecar = new FakeCodexLaunchSidecar()
  private failuresRemaining = 0

  constructor(
    private readonly plan: {
      sessionId: string
      remote: { wsUrl: string }
      sidecar?: FakeCodexLaunchSidecar
    } = {
      sessionId: 'thread-new-1',
      remote: { wsUrl: DEFAULT_CODEX_REMOTE_WS_URL },
    },
  ) {}

  failNext(count: number) {
    this.failuresRemaining = Math.max(0, count)
  }

  async planCreate(input: any) {
    this.planCreateCalls.push(input)
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('fake Codex launch failed')
    }
    return {
      ...this.plan,
      sidecar: this.plan.sidecar ?? this.sidecar,
    }
  }
}
