import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import {
  amplifierProvider,
  defaultAmplifierHome,
  parseAmplifierMetadata,
} from '../../../../server/coding-cli/providers/amplifier'

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures', 'coding-cli', 'amplifier')
const interactiveMetadataPath = path.join(fixturesDir, 'interactive.metadata.json')
const subagentMetadataPath = path.join(fixturesDir, 'subagent.metadata.json')

describe('amplifier-provider', () => {
  describe('defaultAmplifierHome()', () => {
    const originalEnv = process.env.AMPLIFIER_HOME

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.AMPLIFIER_HOME
      } else {
        process.env.AMPLIFIER_HOME = originalEnv
      }
    })

    it('respects AMPLIFIER_HOME when set', () => {
      process.env.AMPLIFIER_HOME = '/custom/amplifier/home'
      expect(defaultAmplifierHome()).toBe('/custom/amplifier/home')
    })

    it('falls back to os.homedir()/.amplifier when AMPLIFIER_HOME is unset', () => {
      delete process.env.AMPLIFIER_HOME
      expect(defaultAmplifierHome()).toBe(path.join(os.homedir(), '.amplifier'))
    })
  })

  it('maps interactive metadata to ParsedSessionMeta', async () => {
    const content = await fsp.readFile(interactiveMetadataPath, 'utf8')
    const raw = JSON.parse(content)

    const meta = await amplifierProvider.parseSessionFile(content, interactiveMetadataPath)

    expect(meta.sessionId).toBe('1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8')
    expect(meta.cwd).toBe('/home/dan/code/freshell')
    expect(meta.title).toBe('Porting freshell to Rust/Tauri')
    expect(meta.summary).toBe('Autonomously porting freshell to a Rust/Tauri stack.')
    expect(meta.createdAt).toBe(Date.parse(raw.created))
    // lastActivityAt is the max of description_updated_at / name_generated_at / created.
    expect(meta.lastActivityAt).toBe(Date.parse(raw.description_updated_at))
    expect(meta.messageCount).toBe(7)
    expect(meta.isSubagent).toBe(false)
    // firstUserMessage is a bounded read of the sibling transcript.jsonl.
    expect(meta.firstUserMessage).toBe('Port freshell to Rust/Tauri')
  })

  it('flags subagent sessions when parent_id is present', async () => {
    const content = await fsp.readFile(subagentMetadataPath, 'utf8')

    const meta = await amplifierProvider.parseSessionFile(content, subagentMetadataPath)

    expect(meta.isSubagent).toBe(true)
    expect(meta.sessionId).toBe('0000000000000000-793624e9e3c3486d')
  })

  it('parseAmplifierMetadata maps fields without touching disk', () => {
    const meta = parseAmplifierMetadata(
      JSON.stringify({ session_id: 's1', working_dir: '/x', name: 'Title', turn_count: 4 }),
    )
    expect(meta).toMatchObject({ sessionId: 's1', cwd: '/x', title: 'Title', messageCount: 4, isSubagent: false })
  })

  it('parseAmplifierMetadata returns an empty object for malformed JSON', () => {
    expect(parseAmplifierMetadata('not json')).toEqual({})
  })

  it('parseAmplifierMetadata floors fractional numeric timestamps to integer epoch-ms', () => {
    // Numeric timestamps can be fractional (sub-ms precision); createdAt and
    // lastActivityAt are validated downstream with z.number().int().
    const meta = parseAmplifierMetadata(
      JSON.stringify({
        session_id: 's1',
        working_dir: '/x',
        created: 1783380081359.8726,
        description_updated_at: 1783380090000.5,
      }),
    )
    expect(meta.createdAt).toBe(1783380081359)
    expect(meta.lastActivityAt).toBe(1783380090000)
  })

  it('marks the provider name as an authoritative provider-generated title', () => {
    const meta = parseAmplifierMetadata(
      JSON.stringify({ session_id: 's1', working_dir: '/x', name: 'Real Provider Name' }),
    )
    expect(meta.title).toBe('Real Provider Name')
    expect(meta.titleSource).toBe('provider-generated')
  })

  it('leaves titleSource undefined when the session has no name', () => {
    const meta = parseAmplifierMetadata(JSON.stringify({ session_id: 's1', working_dir: '/x' }))
    expect(meta.title).toBeUndefined()
    expect(meta.titleSource).toBeUndefined()
  })

  it('extractSessionId returns the session_id from parsed metadata', () => {
    expect(
      amplifierProvider.extractSessionId('/whatever/sessions/abcd/metadata.json', { sessionId: 'sess-123' }),
    ).toBe('sess-123')
  })

  it('extractSessionId falls back to the session directory name', () => {
    expect(
      amplifierProvider.extractSessionId(
        '/home/.amplifier/projects/-home-dan-code-freshell/sessions/abcd-1234/metadata.json',
      ),
    ).toBe('abcd-1234')
  })

  it('getResumeArgs builds resume args', () => {
    expect(amplifierProvider.getResumeArgs('abc')).toEqual(['resume', 'abc'])
  })

  it('getStreamArgs returns a default run invocation', () => {
    expect(amplifierProvider.getStreamArgs({ prompt: 'Hello' })).toEqual([
      'run',
      '--output-format',
      'json',
      'Hello',
    ])
  })

  it('getSessionGlob targets metadata.json under projects/**/sessions', () => {
    const glob = amplifierProvider.getSessionGlob() as string
    const normalized = glob.split(path.sep).join('/')
    expect(normalized.endsWith('projects/**/sessions/**/metadata.json')).toBe(true)
  })

  it('getSessionRoots targets projects/ and the watch base is the amplifier home', () => {
    const projectsDir = path.join(amplifierProvider.homeDir, 'projects')
    expect(amplifierProvider.getSessionRoots()).toEqual([projectsDir])
    // Watch base is the home dir (not projects/) so cold-start creation is caught.
    expect(amplifierProvider.getSessionWatchBases?.()).toEqual([amplifierProvider.homeDir])
  })

  it('does not read a first user message located beyond the 64KB bound', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'amplifier-cap-'))
    try {
      const metadata = JSON.stringify({ session_id: 'big', working_dir: '/x' })
      await fsp.writeFile(path.join(dir, 'metadata.json'), metadata)
      // >64KB of assistant filler (no user lines), then the ONLY user line -- past the window.
      const filler = `${JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(240) }] })}\n`
      const fillerCount = Math.ceil((70 * 1024) / filler.length)
      const userLine = `${JSON.stringify({ role: 'user', content: 'LATE MESSAGE beyond the cap' })}\n`
      await fsp.writeFile(path.join(dir, 'transcript.jsonl'), filler.repeat(fillerCount) + userLine)

      const meta = await amplifierProvider.parseSessionFile(metadata, path.join(dir, 'metadata.json'))
      expect(meta.firstUserMessage).toBeUndefined()
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  describe('getActivityMtimeMs()', () => {
    it('returns the newest sidecar mtime across transcript.jsonl and events.jsonl', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'amplifier-activity-'))
      try {
        const metadataPath = path.join(dir, 'metadata.json')
        const transcriptPath = path.join(dir, 'transcript.jsonl')
        const eventsPath = path.join(dir, 'events.jsonl')
        await fsp.writeFile(metadataPath, JSON.stringify({ session_id: 's', working_dir: '/x' }))
        await fsp.writeFile(transcriptPath, '{"role":"user","content":"hi"}\n')
        await fsp.writeFile(eventsPath, '{"event":"noop"}\n')

        // The transcript is the most recently written sidecar (session active until 20:44),
        // while events.jsonl is older. getActivityMtimeMs must reflect the newest of the two.
        const olderTime = new Date('2026-01-01T18:58:00.000Z')
        const newerTime = new Date('2026-01-01T20:44:00.000Z')
        await fsp.utimes(eventsPath, olderTime, olderTime)
        await fsp.utimes(transcriptPath, newerTime, newerTime)

        const transcriptMtimeMs = (await fsp.stat(transcriptPath)).mtimeMs
        const eventsMtimeMs = (await fsp.stat(eventsPath)).mtimeMs
        expect(typeof amplifierProvider.getActivityMtimeMs).toBe('function')

        const result = await amplifierProvider.getActivityMtimeMs!(metadataPath)
        expect(result).toBe(Math.max(transcriptMtimeMs, eventsMtimeMs))
        expect(result).toBe(transcriptMtimeMs)
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    })

    it('considers events.jsonl when it is the newest sidecar and transcript.jsonl is absent', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'amplifier-activity-'))
      try {
        const metadataPath = path.join(dir, 'metadata.json')
        const eventsPath = path.join(dir, 'events.jsonl')
        await fsp.writeFile(metadataPath, JSON.stringify({ session_id: 's', working_dir: '/x' }))
        await fsp.writeFile(eventsPath, '{"event":"noop"}\n')

        const eventTime = new Date('2026-01-01T20:44:00.000Z')
        await fsp.utimes(eventsPath, eventTime, eventTime)
        const eventsMtimeMs = (await fsp.stat(eventsPath)).mtimeMs

        expect(typeof amplifierProvider.getActivityMtimeMs).toBe('function')
        const result = await amplifierProvider.getActivityMtimeMs!(metadataPath)
        expect(result).toBe(eventsMtimeMs)
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    })

    it('returns integer epoch-ms even when the sidecar mtime has sub-ms precision', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'amplifier-activity-'))
      try {
        const metadataPath = path.join(dir, 'metadata.json')
        const transcriptPath = path.join(dir, 'transcript.jsonl')
        await fsp.writeFile(metadataPath, JSON.stringify({ session_id: 's', working_dir: '/x' }))
        await fsp.writeFile(transcriptPath, '{"role":"user","content":"hi"}\n')

        // Set a fractional mtime (sub-ms precision). Filesystems like ext4 (WSL2)
        // preserve this, making fs.Stats.mtimeMs fractional; downstream schemas
        // require integer epoch-ms. On coarser filesystems the fraction is dropped
        // and the assertions still hold.
        const fractionalSeconds = 1783380081.3598726
        await fsp.utimes(transcriptPath, fractionalSeconds, fractionalSeconds)
        const rawMtimeMs = (await fsp.stat(transcriptPath)).mtimeMs

        const result = await amplifierProvider.getActivityMtimeMs!(metadataPath)
        expect(result).toBeDefined()
        expect(Number.isInteger(result)).toBe(true)
        expect(result).toBe(Math.floor(rawMtimeMs))
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    })

    it('returns undefined when no activity sidecars exist', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'amplifier-activity-'))
      try {
        const metadataPath = path.join(dir, 'metadata.json')
        await fsp.writeFile(metadataPath, JSON.stringify({ session_id: 's', working_dir: '/x' }))

        expect(typeof amplifierProvider.getActivityMtimeMs).toBe('function')
        const result = await amplifierProvider.getActivityMtimeMs!(metadataPath)
        expect(result).toBeUndefined()
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('parseEvent maps a user line to message.user', () => {
    const events = amplifierProvider.parseEvent(JSON.stringify({ role: 'user', content: 'Hello there' }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('message.user')
    expect(events[0].message).toEqual({ role: 'user', content: 'Hello there' })
  })

  it('parseEvent maps assistant thinking/text blocks to reasoning + message.assistant', () => {
    const line = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Reasoning here' },
        { type: 'text', text: 'Visible reply' },
      ],
    })

    const events = amplifierProvider.parseEvent(line)

    expect(events.map((event) => event.type)).toEqual(['reasoning', 'message.assistant'])
    expect(events[0].reasoning).toBe('Reasoning here')
    expect(events[1].message).toEqual({ role: 'assistant', content: 'Visible reply' })
  })

  it('parseEvent maps a tool line to tool.result', () => {
    const events = amplifierProvider.parseEvent(
      JSON.stringify({ role: 'tool', name: 'read_file', tool_call_id: 'toolu_1', content: 'ok' }),
    )
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tool.result')
    expect(events[0].tool).toEqual({ callId: 'toolu_1', name: 'read_file', output: 'ok', isError: false })
  })

  it('parseEvent returns [] for blank, malformed, or unknown lines', () => {
    expect(amplifierProvider.parseEvent('')).toEqual([])
    expect(amplifierProvider.parseEvent('   ')).toEqual([])
    expect(amplifierProvider.parseEvent('not json')).toEqual([])
    expect(amplifierProvider.parseEvent(JSON.stringify({ role: 'system', content: 'x' }))).toEqual([])
  })

  it('advertises history + resume but no live streaming', () => {
    expect(amplifierProvider.supportsLiveStreaming()).toBe(false)
    expect(amplifierProvider.supportsSessionResume()).toBe(true)
  })
})
