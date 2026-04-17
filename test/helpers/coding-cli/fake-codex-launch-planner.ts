export const DEFAULT_CODEX_REMOTE_WS_URL = 'ws://127.0.0.1:43123'

export class FakeCodexLaunchPlanner {
  planCreateCalls: any[] = []

  constructor(
    private readonly plan: {
      sessionId: string
      remote: { wsUrl: string }
    } = {
      sessionId: 'thread-new-1',
      remote: { wsUrl: DEFAULT_CODEX_REMOTE_WS_URL },
    },
  ) {}

  async planCreate(input: any) {
    this.planCreateCalls.push(input)
    return this.plan
  }
}
