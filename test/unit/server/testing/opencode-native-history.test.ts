import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nativeTurnProof, openCodeTerminalReady, selectNativeAssistantTurn } from '../../../e2e-browser/helpers/opencode-native-history.js'
import { readOpenCodeNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/opencode.js'

let root: string
let filename: string
let db: DatabaseSync
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-native-proof-'))
  filename = path.join(root, 'opencode.db')
  db = new DatabaseSync(filename)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`)
  db.prepare('INSERT INTO session (id) VALUES (?)').run('ses_owned')
  db.prepare('INSERT INTO session (id) VALUES (?)').run('ses_other')
})
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

function message(id: string, session: string, role: string, text: string, completed: number | null = 200, tool = false) {
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, session, 100, JSON.stringify({
    role, time: { created: 100, completed }, parentID: 'user-request', modelID: 'big-pickle', providerID: 'opencode',
  }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(`part-${id}`, session, id, 100, JSON.stringify({ type: 'text', text }))
  if (tool) db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(`tool-${id}`, session, id, 101, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed' } }))
}

function read(session = 'ses_owned') {
  return readOpenCodeNativeHistory(filename, session)
}

describe('live recovery proves new native assistant responses, never TUI echo or replay', () => {
  it('reads only completed assistant messages for the exact native session', () => {
    message('echo', 'ses_owned', 'user', 'nonce-in-echo')
    message('unfinished', 'ses_owned', 'assistant', 'nonce-unfinished', null)
    message('foreign', 'ses_other', 'assistant', 'nonce-foreign')
    message('answer', 'ses_owned', 'assistant', 'nonce-in-real-answer')
    expect(read()).toMatchObject({ nativeSessionId: 'ses_owned', turns: [{ messageId: 'answer', text: 'nonce-in-real-answer', toolCalls: [] }] })
    expect(read().turns).toHaveLength(1)
  })

  it('waits past unrelated completed assistant rows for the correlated no-tool answer', () => {
    const turns = [
      { turnId: 'intro', messageId: 'intro', parentMessageId: 'u0', completedAt: 1, text: 'Freshell.', toolCalls: [], resolvedProvider: 'opencode', resolvedModel: 'big-pickle', resolvedReasoningEffort: 'provider-default', providerProvenance: 'opencode-message.providerID', modelProvenance: 'opencode-message.modelID', reasoningEffortProvenance: 'opencode-native-default' },
      { turnId: 'tool', messageId: 'tool', parentMessageId: 'u1', completedAt: 2, text: 'p-target', toolCalls: [{ type: 'tool', name: 'read' }], resolvedProvider: 'opencode', resolvedModel: 'big-pickle', resolvedReasoningEffort: 'provider-default', providerProvenance: 'opencode-message.providerID', modelProvenance: 'opencode-message.modelID', reasoningEffortProvenance: 'opencode-native-default' },
      { turnId: 'answer', messageId: 'answer', parentMessageId: 'u1', completedAt: 3, text: 'The project is p-target.', toolCalls: [], resolvedProvider: 'opencode', resolvedModel: 'big-pickle', resolvedReasoningEffort: 'provider-default', providerProvenance: 'opencode-message.providerID', modelProvenance: 'opencode-message.modelID', reasoningEffortProvenance: 'opencode-native-default' },
    ]
    expect(selectNativeAssistantTurn(turns, new Set(['old']), 'p-target')?.messageId).toBe('answer')
    expect(selectNativeAssistantTurn(turns, new Set(['answer']), 'p-target')).toBeNull()
  })

  it('keeps tool activity visible so a memory-only claim cannot hide a filesystem lookup', () => {
    message('answer', 'ses_owned', 'assistant', 'nonce', 200, true)
    expect(read().turns[0].toolCalls).toEqual([{ type: 'tool', name: 'read' }])
  })

  it('does not guess the newest session or interpret a session ID as SQL', () => {
    message('foreign', 'ses_other', 'assistant', 'nonce-foreign')
    expect(() => read('ses_missing')).toThrow(/exact native session/i)
    expect(() => read("' OR 1=1 --")).toThrow(/safe opaque session id/i)
  })

  it('reads in query-only mode without modifying the native database', () => {
    message('answer', 'ses_owned', 'assistant', 'native-answer')
    const before = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    read()
    expect(createHash('sha256').update(fs.readFileSync(filename)).digest('hex')).toBe(before)
  })

  it('reports an unmaterialized provider store without fabricating a turn', () => {
    const missing = path.join(root, 'not-created.db')
    expect(() => readOpenCodeNativeHistory(missing, 'ses_owned')).toThrow(/missing|ENOENT/i)
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('retains message/parent identity and a digest without copying response text into receipts', () => {
    message('answer', 'ses_owned', 'assistant', 'private fixture answer')
    const proof = nativeTurnProof('initial', 'ses_owned', read().turns[0], 'private fixture answer')
    expect(proof).toMatchObject({ nativeSessionId: 'ses_owned', messageId: 'answer', parentMessageId: 'user-request', completedAt: 200, toolCallCount: 0 })
    expect(proof.responseSha256).toBe(createHash('sha256').update('private fixture answer').digest('hex'))
    expect(JSON.stringify(proof)).not.toContain('private fixture answer')
  })
})

describe('resumed OpenCode readiness is an input-mode signal, not a home-screen placeholder', () => {
  it('recognizes a resumed conversation that renders no Ask anything placeholder', () => {
    expect(openCodeTerminalReady('\x1b[?2004h\x1b[24;1HBuild  Big Pickle  OpenCode Zen')).toBe(true)
  })

  it('does not treat echoed text or a disabled input mode as a ready TUI', () => {
    expect(openCodeTerminalReady('Build Big Pickle')).toBe(false)
    expect(openCodeTerminalReady('\x1b[?2004hBuild Big Pickle\x1b[?2004l')).toBe(false)
    expect(openCodeTerminalReady('\x1b[?2004h')).toBe(false)
    expect(openCodeTerminalReady('')).toBe(false)
  })

  it('keeps the free-tier model banner part of readiness and handles ANSI styling', () => {
    expect(openCodeTerminalReady('\x1b[?2004hBuild Expensive model')).toBe(false)
    expect(openCodeTerminalReady('\x1b[?2004h\x1b[32mBuild\x1b[0m \x1b[31mBig Pickle\x1b[0m')).toBe(true)
  })
})
