import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { CodingCliSession, CodingCliSessionManager, type SpawnFn } from '../../../../server/coding-cli/session-manager'
import type { CodingCliProvider } from '../../../../server/coding-cli/provider'
import { claudeProvider } from '../../../../server/coding-cli/providers/claude'

// Mock logger to suppress output
vi.mock('../../../../server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Helper to create a mock process
function createMockProcess() {
  const mockProcess = new EventEmitter() as any
  mockProcess.stdout = new EventEmitter()
  mockProcess.stderr = new EventEmitter()
  mockProcess.stdin = { write: vi.fn(), end: vi.fn() }
  mockProcess.kill = vi.fn()
  mockProcess.pid = 12345
  return mockProcess
}

describe('CodingCliSession (Claude provider)', () => {
  let mockProcess: any
  let mockSpawn: ReturnType<typeof vi.fn>
  let idCounter: number

  beforeEach(() => {
    mockProcess = createMockProcess()
    mockSpawn = vi.fn().mockReturnValue(mockProcess)
    idCounter = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function createSession(overrides = {}) {
    return new CodingCliSession({
      provider: claudeProvider,
      prompt: 'test',
      _spawn: mockSpawn as SpawnFn,
      _nanoid: () => 'test-id-' + ++idCounter,
      ...overrides,
    })
  }

  it('spawns provider command with correct arguments', () => {
    createSession({
      prompt: 'hello',
      cwd: '/test',
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', 'hello', '--output-format', 'stream-json'],
      expect.objectContaining({
        cwd: '/test',
      })
    )
  })

  it('emits normalized events from stdout', async () => {
    const session = createSession()
    const events: any[] = []
    session.on('event', (e) => events.push(e))

    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      session_id: 'abc',
      uuid: '123',
    })

    mockProcess.stdout.emit('data', Buffer.from(line + '\n'))

    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('message.assistant')
    expect(events[0].message?.role).toBe('assistant')
  })

  it('tracks provider session id from session.start events', async () => {
    const session = createSession()

    const initLine = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'session-123',
      cwd: '/test',
      model: 'claude-test',
      tools: [],
      claude_code_version: '1.0.0',
      uuid: 'uuid-1',
    })

    mockProcess.stdout.emit('data', Buffer.from(initLine + '\n'))

    await new Promise((r) => setTimeout(r, 10))
    expect(session.providerSessionId).toBe('session-123')
  })

  it('emits stderr output', async () => {
    const session = createSession()
    const errors: string[] = []
    session.on('stderr', (e) => errors.push(e))

    mockProcess.stderr.emit('data', Buffer.from('error message'))

    await new Promise((r) => setTimeout(r, 10))
    expect(errors).toContain('error message')
  })

  it('emits exit on process close', async () => {
    const session = createSession()
    let exitCode: number | null = null
    session.on('exit', (code) => {
      exitCode = code
    })

    mockProcess.emit('close', 0)

    await new Promise((r) => setTimeout(r, 10))
    expect(exitCode).toBe(0)
  })

  it('emits session.end if provider does not emit one', async () => {
    const session = createSession()
    const events: any[] = []
    session.on('event', (e) => events.push(e))

    mockProcess.emit('close', 0)

    await new Promise((r) => setTimeout(r, 10))
    expect(events.some((e) => e.type === 'session.end')).toBe(true)
  })

  it('can send input to stdin', () => {
    const session = createSession()
    session.sendInput('user input')

    expect(mockProcess.stdin.write).toHaveBeenCalledWith('user input')
  })

  it('can kill the process', () => {
    const session = createSession()
    session.kill()

    expect(mockProcess.kill).toHaveBeenCalled()
  })

  it('handles multi-line stdout correctly', async () => {
    const session = createSession()
    const events: any[] = []
    session.on('event', (e) => events.push(e))

    const line1 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', cwd: '/', model: 'test', tools: [], claude_code_version: '1', uuid: 'u1' })
    const line2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, session_id: 'abc', uuid: '1' })

    // Send partial then complete
    mockProcess.stdout.emit('data', Buffer.from(line1))
    mockProcess.stdout.emit('data', Buffer.from('\n' + line2 + '\n'))

    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('session.start')
    expect(events[1].type).toBe('message.assistant')
  })

  describe('line ending handling', () => {
    it('handles Unix LF line endings correctly', async () => {
      const session = createSession()
      const events: any[] = []
      session.on('event', (e) => events.push(e))

      const line1 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', cwd: '/', model: 'test', tools: [], claude_code_version: '1', uuid: 'u1' })
      const line2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, session_id: 'abc', uuid: '1' })

      // Unix-style LF line endings
      mockProcess.stdout.emit('data', Buffer.from(line1 + '\n' + line2 + '\n'))

      await new Promise((r) => setTimeout(r, 10))
      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('session.start')
      expect(events[1].type).toBe('message.assistant')
    })

    it('handles Windows CRLF line endings correctly', async () => {
      const session = createSession()
      const events: any[] = []
      session.on('event', (e) => events.push(e))

      const line1 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', cwd: '/', model: 'test', tools: [], claude_code_version: '1', uuid: 'u1' })
      const line2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, session_id: 'abc', uuid: '1' })

      // Windows-style CRLF line endings
      mockProcess.stdout.emit('data', Buffer.from(line1 + '\r\n' + line2 + '\r\n'))

      await new Promise((r) => setTimeout(r, 10))
      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('session.start')
      expect(events[1].type).toBe('message.assistant')
    })

    it('handles mixed line endings correctly', async () => {
      const session = createSession()
      const events: any[] = []
      session.on('event', (e) => events.push(e))

      const line1 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', cwd: '/', model: 'test', tools: [], claude_code_version: '1', uuid: 'u1' })
      const line2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, session_id: 'abc', uuid: '1' })
      const line3 = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1, session_id: 'abc', uuid: '2' })

      // Mixed line endings: CRLF then LF
      mockProcess.stdout.emit('data', Buffer.from(line1 + '\r\n' + line2 + '\n' + line3 + '\r\n'))

      await new Promise((r) => setTimeout(r, 10))
      expect(events).toHaveLength(3)
      expect(events[0].type).toBe('session.start')
      expect(events[1].type).toBe('message.assistant')
      expect(events[2].type).toBe('session.end')
    })
  })
})

describe('CodingCliSessionManager', () => {
  let mockProcess: any
  let mockSpawn: ReturnType<typeof vi.fn>

  function makeProvider(overrides: Partial<CodingCliProvider> = {}): CodingCliProvider {
    return {
      name: 'codex',
      displayName: 'Codex',
      homeDir: '/tmp',
      getSessionGlob: () => '/tmp/*.jsonl',
      listSessionFiles: async () => [],
      parseSessionFile: () => ({}),
      resolveProjectPath: async () => '/project',
      extractSessionId: () => 'session-id',
      getCommand: () => 'codex',
      getStreamArgs: () => ['exec', '--json', 'test'],
      getResumeArgs: () => ['resume', 'session-id'],
      parseEvent: () => [],
      supportsLiveStreaming: () => true,
      supportsSessionResume: () => true,
      ...overrides,
    }
  }

  beforeEach(() => {
    mockProcess = createMockProcess()
    mockSpawn = vi.fn().mockReturnValue(mockProcess)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates and tracks sessions by provider', () => {
    const manager = new CodingCliSessionManager([claudeProvider])

    const session = manager.create('claude', {
      prompt: 'test',
      _spawn: mockSpawn as SpawnFn,
      _nanoid: () => 'id-1',
    })

    expect(session.id).toBe('id-1')
    expect(manager.get('id-1')).toBe(session)
    expect(manager.list()).toHaveLength(1)
  })

  it('returns undefined for unknown session id', () => {
    const manager = new CodingCliSessionManager([claudeProvider])
    expect(manager.get('missing')).toBeUndefined()
  })

  it('rejects providers without streaming support', () => {
    const provider = makeProvider({ supportsLiveStreaming: () => false })
    const manager = new CodingCliSessionManager([provider])

    expect(() =>
      manager.create('codex', {
        prompt: 'test',
        _spawn: mockSpawn as SpawnFn,
        _nanoid: () => 'id-1',
      })
    ).toThrow(/does not support interactive JSON streaming/i)
  })

  it('rejects resume when provider does not support streaming resume', () => {
    const provider = makeProvider({ supportsSessionResume: () => false })
    const manager = new CodingCliSessionManager([provider])

    expect(() =>
      manager.create('codex', {
        prompt: 'test',
        resumeSessionId: 'session-1',
        _spawn: mockSpawn as SpawnFn,
        _nanoid: () => 'id-1',
      })
    ).toThrow(/resume/i)
  })
})
