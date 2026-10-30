// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { readAmplifierNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/amplifier.js'
import { readClaudeNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/claude.js'
import { readCodexNativeHistory, readCodexNativeObservation } from '../../../e2e-browser/helpers/provider-native-history/codex.js'
import { readOpenCodeNativeHistory, readOpenCodeNativeObservation } from '../../../e2e-browser/helpers/provider-native-history/opencode.js'
import { nativeTurnProof } from '../../../e2e-browser/helpers/provider-native-history/proof.js'
import { selectNativeAssistantTurn } from '../../../../scripts/testing/provider-native-history.js'
import { OPENCODE_NATIVE_HISTORY_SCRIPT } from '../../../e2e-browser/helpers/opencode-native-history.js'
import { captureNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/probe-cli.js'

const roots: string[] = []

describe('native history CLI failure diagnostics', () => {
  it.each(['missing-directory', 'absent-session', 'malformed-source', 'incomplete-eof', 'invalid-database'] as const)(
    'refuses %s with fixed diagnostics and no private payload', fault => {
      const source = tempRoot('native-cli-failure')
      const sessionId = 'private-native-root'
      const privatePayload = 'private-transcript-and-grant-marker'
      if (fault === 'malformed-source') fs.writeFileSync(path.join(source, `${sessionId}.jsonl`), `${privatePayload}\n`, { mode: 0o600 })
      if (fault === 'incomplete-eof') fs.writeFileSync(path.join(source, `${sessionId}.jsonl`), JSON.stringify({ body: privatePayload }), { mode: 0o600 })
      const database = path.join(source, `${privatePayload}.db`)
      if (fault === 'invalid-database') fs.writeFileSync(database, privatePayload, { mode: 0o600 })
      const result = spawnSync(process.execPath, ['--no-warnings', '--import', path.resolve('node_modules/tsx/dist/loader.mjs'),
        path.resolve('test/e2e-browser/helpers/provider-native-history/probe-cli.ts'), fault === 'invalid-database' ? 'opencode' : 'claude',
        fault === 'missing-directory' ? path.join(source, privatePayload) : fault === 'invalid-database' ? database : source, sessionId],
      { encoding: 'utf8', timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toContain(privatePayload)
      expect(result.stderr).not.toContain(source)
      expect(result.stderr).not.toContain(sessionId)
      const diagnostic = JSON.parse(result.stderr)
      expect(diagnostic).toEqual({ severity: 'error', event: 'provider_native_history.refused',
        stage: fault === 'absent-session' ? 'source_selection' : fault === 'incomplete-eof' ? 'source_read' : 'native_capture',
        reason: fault === 'missing-directory' ? 'filesystem_entry_missing' : fault === 'absent-session' ? 'source_absent_or_ambiguous'
          : fault === 'incomplete-eof' ? 'incomplete_source_eof' : 'native_validation_failed',
        code: fault === 'missing-directory' ? 'ENOENT' : null })
    },
  )
})

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `freshell-${label}-`))
  roots.push(root)
  return root
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

describe('Claude native history proof', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111'

  it('captures only the legitimate absent fresh projects root as an empty boundary', () => {
    const home = path.join(tempRoot('claude-fresh-absent'), 'provider')
    const source = path.join(home, '.claude/projects')
    fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 })
    expect(captureNativeHistory('claude', source, sessionId, true)).toEqual({
      schemaVersion: 1, provider: 'claude', nativeSessionId: sessionId, turns: [], rawSource: null,
    })
    expect(() => captureNativeHistory('claude', source, sessionId)).toThrow()
  })

  it.each(['missing-parent', 'wrong-parent', 'redirected-parent', 'redirected-root', 'root-file', 'permission', 'malformed', 'partial', 'ambiguous', 'wrong-native'] as const)(
    'refuses an invalid fresh empty boundary (%s)', fault => {
      const home = path.join(tempRoot('claude-fresh-invalid'), 'provider')
      let source = path.join(home, '.claude/projects')
      fs.mkdirSync(home, { mode: 0o700 })
      if (fault === 'wrong-parent') source = path.join(home, 'other/projects')
      const parent = path.dirname(source)
      if (fault !== 'missing-parent') fs.mkdirSync(parent, { mode: 0o700 })
      if (fault === 'redirected-parent') {
        fs.rmdirSync(parent)
        fs.symlinkSync(tempRoot('claude-parent-outside'), parent)
      } else if (fault === 'redirected-root') fs.symlinkSync(tempRoot('claude-root-outside'), source)
      else if (fault === 'root-file') fs.writeFileSync(source, 'private-shape-marker')
      else if (fault === 'permission') fs.chmodSync(parent, 0o000)
      else if (['malformed', 'partial', 'ambiguous', 'wrong-native'].includes(fault)) {
        const file = path.join(source, `${sessionId}.jsonl`)
        const rows = [
          { type: 'user', uuid: 'input', sessionId, message: { role: 'user', content: 'private-input-marker' } },
          { type: 'assistant', uuid: 'reply', parentUuid: 'input', sessionId: fault === 'wrong-native' ? 'wrong-native' : sessionId,
            timestamp: '2026-09-01T00:00:01.000Z', message: { id: 'msg', role: 'assistant', model: 'haiku',
              stop_reason: 'end_turn', content: [{ type: 'text', text: 'private-output-marker' }] } },
        ]
        writeJsonl(file, rows)
        if (fault === 'malformed') fs.writeFileSync(file, 'private-corrupt-marker\n')
        if (fault === 'partial') fs.writeFileSync(file, JSON.stringify({ private: 'partial-marker' }))
        if (fault === 'ambiguous') writeJsonl(path.join(source, 'other', `${sessionId}.jsonl`), rows)
      }
      try { expect(() => captureNativeHistory('claude', source, sessionId, true)).toThrow() }
      finally { if (fault === 'permission') fs.chmodSync(parent, 0o700) }
    },
  )

  it('refuses a child that disappears during a present fresh projects walk', () => {
    const source = path.join(tempRoot('claude-disappearing-child'), 'provider/.claude/projects')
    const file = path.join(source, `${sessionId}.jsonl`)
    writeJsonl(file, [{ type: 'attachment', sessionId }])
    const readdir = fs.readdirSync
    const walk = vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, options: any) => {
      const entries = readdir(directory, options)
      if (directory === source) fs.unlinkSync(file)
      return entries
    }) as typeof fs.readdirSync)
    try { expect(() => captureNativeHistory('claude', source, sessionId, true)).toThrow(/ENOENT/) }
    finally { walk.mockRestore() }
  })

  function splitReply() {
    return [
      { type: 'user', uuid: 'user', sessionId, message: { role: 'user', content: 'remember the marker' } },
      { type: 'attachment', uuid: 'context', parentUuid: 'user', sessionId },
      { type: 'assistant', uuid: 'thinking', parentUuid: 'context', sessionId, requestId: 'request', apiBlockIndex: 0,
        timestamp: '2026-09-01T00:00:01.000Z', message: { id: 'msg', role: 'assistant', model: 'haiku', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'signature' }] } },
      { type: 'assistant', uuid: 'text', parentUuid: 'thinking', sessionId, requestId: 'request', apiBlockIndex: 1,
        timestamp: '2026-09-01T00:00:01.100Z', message: { id: 'msg', role: 'assistant', model: 'haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: 'remembered-marker' }] } },
    ]
  }

  it('assembles the native thinking/text rows into one selectable reply and retains both original components', () => {
    const root = tempRoot('claude-split')
    writeJsonl(path.join(root, `${sessionId}.jsonl`), splitReply())
    const history = readClaudeNativeHistory(root, sessionId)
    expect(history.turns).toHaveLength(1)
    expect(history.turns[0]).toMatchObject({ turnId: 'msg', messageId: 'text', parentMessageId: 'user', text: 'remembered-marker',
      completedAt: '2026-09-01T00:00:01.100Z', resolvedReasoningEffort: 'unknown',
      nativeEvidence: { components: [{ messageId: 'thinking', parentMessageId: 'context', recordIndex: 2 }, { messageId: 'text', parentMessageId: 'thinking', recordIndex: 3 }] } })
    expect(selectNativeAssistantTurn(history.turns, new Set(), 'remembered-marker')).toBe(history.turns[0])
    expect(selectNativeAssistantTurn(history.turns, new Set(['text']), 'remembered-marker')).toBeNull()
    expect(nativeTurnProof('initial', sessionId, history.turns[0]!, 'remembered-marker').toolCallCount).toBe(0)
  })

  it('preserves text and tool blocks in later same-provider-ID components', () => {
    const root = tempRoot('claude-split-tool'), rows = splitReply()
    rows[3]!.message!.content.push({ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } as any)
    writeJsonl(path.join(root, `${sessionId}.jsonl`), rows)
    const history = readClaudeNativeHistory(root, sessionId)
    expect(history.turns).toHaveLength(1)
    expect(history.turns[0]!.toolCalls).toEqual([{ type: 'tool_use', name: 'Read' }])
    expect(selectNativeAssistantTurn(history.turns, new Set(), 'remembered-marker')).toBeNull()
  })

  it('assembles component rows that each contain multiple native content blocks in block order', () => {
    const root = tempRoot('claude-multi-block'), rows = splitReply()
    rows[2]!.message!.content.push({ type: 'text', text: 'prefix ' } as any)
    rows[3]!.apiBlockIndex = 2
    writeJsonl(path.join(root, `${sessionId}.jsonl`), rows)
    const history = readClaudeNativeHistory(root, sessionId)
    expect(history.turns).toHaveLength(1)
    expect(history.turns[0]!.text).toBe('prefix remembered-marker')
  })

  it.each(['model', 'missing-model', 'missing-id', 'root', 'alternate-root', 'parent', 'duplicate-uuid', 'reused-id', 'partial', 'unknown-block', 'request', 'block-order', 'effort', 'invalid-effort'] as const)(
    'refuses ambiguous split Claude evidence (%s)', fault => {
      const root = tempRoot('claude-split-conflict'), rows: any[] = splitReply()
      if (fault === 'model') rows[3].message.model = 'other-model'
      if (fault === 'missing-model') delete rows[3].message.model
      if (fault === 'missing-id') delete rows[3].message.id
      if (fault === 'root') rows[3].sessionId = 'other-root'
      if (fault === 'alternate-root') rows[3].session_id = 'other-root'
      if (fault === 'parent') rows[3].parentUuid = 'other-parent'
      if (fault === 'duplicate-uuid') rows[3].uuid = 'thinking'
      if (fault === 'reused-id') rows.push({ ...rows[0], uuid: 'another-user' }, { ...rows[3], uuid: 'another-reply', parentUuid: 'another-user' })
      if (fault === 'partial') rows[3].message.stop_reason = null
      if (fault === 'unknown-block') rows[3].message.content.push({ type: 'unknown' })
      if (fault === 'request') rows[3].requestId = 'other-request'
      if (fault === 'block-order') rows[3].apiBlockIndex = 0
      if (fault === 'effort') { rows[2].effort = 'low'; rows[3].effort = 'high' }
      if (fault === 'invalid-effort') rows[3].message.effort = 42
      writeJsonl(path.join(root, `${sessionId}.jsonl`), rows)
      expect(() => readClaudeNativeHistory(root, sessionId)).toThrow()
    },
  )

  it('reads only the exact session and requires a completed assistant response with native profile metadata', () => {
    const root = tempRoot('claude-native')
    const transcript = path.join(root, '-workspace', `${sessionId}.jsonl`)
    writeJsonl(transcript, [
      { type: 'user', uuid: 'user-1', sessionId, timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'remember' } },
      {
        type: 'assistant', uuid: 'assistant-row-1', parentUuid: 'user-1', sessionId,
        timestamp: '2026-09-01T00:00:01.000Z', effort: 'low',
        message: {
          id: 'msg_01', role: 'assistant', model: 'claude-haiku-4-5-20251001',
          stop_reason: 'end_turn', content: [{ type: 'text', text: 'The codename is 00112233445566778899aabbccddeeff.' }],
        },
      },
    ])

    expect(readClaudeNativeHistory(root, sessionId)).toEqual({
      schemaVersion: 1,
      provider: 'claude',
      nativeSessionId: sessionId,
      turns: [expect.objectContaining({
        nativeEvidence: {
          kind: 'identified_message',
          turnId: 'msg_01',
          messageId: 'assistant-row-1',
          parentMessageId: 'user-1',
        },
        turnId: 'msg_01',
        messageId: 'assistant-row-1',
        parentMessageId: 'user-1',
        completedAt: '2026-09-01T00:00:01.000Z',
        text: 'The codename is 00112233445566778899aabbccddeeff.',
        toolCalls: [],
        resolvedProvider: 'anthropic',
        resolvedModel: 'claude-haiku-4-5-20251001',
        resolvedReasoningEffort: 'low',
        providerProvenance: 'claude-assistant-message',
        modelProvenance: 'claude-assistant-message.model',
        reasoningEffortProvenance: 'claude-transcript.effort',
      })],
    })
  })

  it.each([undefined, 'low'])('keeps absent Claude effort unknown and preserves message effort (%s)', (effort) => {
    const root = tempRoot('claude-optional-effort')
    writeJsonl(path.join(root, 'project', `${sessionId}.jsonl`), [
      { type: 'user', uuid: 'user-1', sessionId, message: { role: 'user', content: 'remember' } },
      { type: 'assistant', uuid: 'row-1', parentUuid: 'user-1', sessionId, timestamp: '2026-09-01T00:00:01.000Z',
        message: { id: 'msg-1', role: 'assistant', model: 'claude-haiku-4-5-20251001', effort,
          stop_reason: 'end_turn', content: [{ type: 'text', text: 'stored' }] } },
    ])
    const turn = readClaudeNativeHistory(root, sessionId).turns[0]!
    expect(turn.resolvedReasoningEffort).toBe(effort ?? 'unknown')
    expect(turn.reasoningEffortProvenance).toBe(effort ? 'claude-assistant-message.effort' : 'unsupported-native-telemetry')
  })

  it.each(['', 42, { level: 'low' }])('refuses malformed claimed Claude effort %j', (effort) => {
    const root = tempRoot('claude-invalid-effort')
    writeJsonl(path.join(root, `${sessionId}.jsonl`), [{ type: 'assistant', uuid: 'row', parentUuid: 'user', sessionId,
      timestamp: '2026-09-01T00:00:01.000Z', effort,
      message: { id: 'msg', role: 'assistant', model: 'haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: 'stored' }] } }])
    expect(() => readClaudeNativeHistory(root, sessionId)).toThrow(/effort/)
  })

  it('retains exact raw source through the unchanged stopped CLI arguments', () => {
    const root = tempRoot('claude-raw-cli')
    const file = path.join(root, 'project', `${sessionId}.jsonl`)
    writeJsonl(file, [{ type: 'assistant', uuid: 'row', parentUuid: 'user', sessionId,
      timestamp: '2026-09-01T00:00:01.000Z', effort: 'low',
      message: { id: 'msg', role: 'assistant', model: 'haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: 'private-recalled-marker' }] } }])
    const captured = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--import', path.resolve('node_modules/tsx/dist/loader.mjs'),
      path.resolve('test/e2e-browser/helpers/provider-native-history/probe-cli.ts'), 'claude', root, sessionId], { encoding: 'utf8' }))
    expect(captured.nativeSessionId).toBe(sessionId)
    expect(captured.turns[0].text).toBe('private-recalled-marker')
    expect(Buffer.from(captured.rawSource.snapshot.bytesBase64, 'base64')).toEqual(fs.readFileSync(file))
    expect(captured.rawSource.snapshot.path).toBe(file)
    expect(captured.rawSource.snapshot.completeEof).toBe(true)
    const copy = path.join(tempRoot('claude-raw-retained'), `${sessionId}.jsonl`)
    fs.writeFileSync(copy, Buffer.from(captured.rawSource.snapshot.bytesBase64, 'base64'))
    expect(readClaudeNativeHistory(path.dirname(copy), sessionId)).toEqual({ schemaVersion: captured.schemaVersion,
      provider: captured.provider, nativeSessionId: captured.nativeSessionId, turns: captured.turns })
  })

  it('fails closed on duplicate exact-session transcripts, symlinks, malformed rows, and incomplete responses', () => {
    const duplicateRoot = tempRoot('claude-duplicate')
    for (const project of ['one', 'two']) {
      writeJsonl(path.join(duplicateRoot, project, `${sessionId}.jsonl`), [{
        type: 'assistant', uuid: `row-${project}`, sessionId, timestamp: '2026-09-01T00:00:01.000Z', effort: 'low',
        message: { id: `msg-${project}`, role: 'assistant', model: 'haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
      }])
    }
    expect(() => readClaudeNativeHistory(duplicateRoot, sessionId)).toThrow(/ambiguous|duplicate/i)

    const symlinkRoot = tempRoot('claude-symlink')
    const outside = path.join(tempRoot('claude-outside'), `${sessionId}.jsonl`)
    writeJsonl(outside, [])
    fs.mkdirSync(path.join(symlinkRoot, 'project'))
    fs.symlinkSync(outside, path.join(symlinkRoot, 'project', `${sessionId}.jsonl`))
    expect(() => readClaudeNativeHistory(symlinkRoot, sessionId)).toThrow(/symlink/i)

    const malformedRoot = tempRoot('claude-malformed')
    const malformed = path.join(malformedRoot, 'project', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(malformed), { recursive: true })
    fs.writeFileSync(malformed, '{not json}\n')
    expect(() => readClaudeNativeHistory(malformedRoot, sessionId)).toThrow(/JSON/i)

    const incompleteRoot = tempRoot('claude-incomplete')
    writeJsonl(path.join(incompleteRoot, 'project', `${sessionId}.jsonl`), [{
      type: 'assistant', uuid: 'row', sessionId, timestamp: '2026-09-01T00:00:01.000Z', effort: 'low',
      message: { id: 'msg', role: 'assistant', model: 'haiku', stop_reason: null, content: [{ type: 'text', text: 'partial' }] },
    }])
    expect(() => readClaudeNativeHistory(incompleteRoot, sessionId)).toThrow(/completed assistant/i)

    const oversizedRoot = tempRoot('claude-oversized')
    const oversized = path.join(oversizedRoot, 'project', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(oversized), { recursive: true })
    fs.writeFileSync(oversized, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))
    expect(() => readClaudeNativeHistory(oversizedRoot, sessionId)).toThrow(/byte bound/i)
  })

  it('counts bounded native tool-use blocks instead of accepting a no-tools assertion by fiat', () => {
    const root = tempRoot('claude-tools')
    writeJsonl(path.join(root, 'project', `${sessionId}.jsonl`), [{
      type: 'assistant', uuid: 'assistant-row', parentUuid: 'user-row', sessionId,
      timestamp: '2026-09-01T00:00:01.000Z', effort: 'low',
      message: {
        id: 'msg-tool', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
      },
    }, {
      type: 'assistant', uuid: 'assistant-final', parentUuid: 'tool-result-row', sessionId,
      timestamp: '2026-09-01T00:00:02.000Z', effort: 'low',
      message: {
        id: 'msg-final', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      },
    }])
    expect(readClaudeNativeHistory(root, sessionId).turns[0].toolCalls).toEqual([{ type: 'tool_use', name: 'Read' }])
  })
})

describe('Codex native history proof', () => {
  const threadId = '22222222-2222-4222-8222-222222222222'

  it.each(['valid', 'duplicate-input', 'duplicate-completion', 'wrong-completion', 'missing-model'])(
    'retains native input/completion association and truthful absent effort (%s)', (fault) => {
      const root = tempRoot('codex-input'), prompt = { type: 'event_msg', payload: { type: 'user_message', message: 'remember the nonce' } }
      const completion = { type: 'event_msg', timestamp: '2026-09-01T00:00:01Z', payload: { type: 'task_complete', turn_id: fault === 'wrong-completion' ? 'other-turn' : 'turn-1', last_agent_message: 'stored' } }
      writeJsonl(path.join(root, `rollout-${threadId}.jsonl`), [
        { type: 'session_meta', payload: { id: threadId, model_provider: 'openai' } },
        { type: 'turn_context', payload: { turn_id: 'turn-1', ...(fault === 'missing-model' ? {} : { model: 'gpt-5.6-luna' }) } },
        prompt, ...(fault === 'duplicate-input' ? [prompt] : []),
        { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'assistant-1', content: [{ type: 'output_text', text: 'stored' }] } },
        completion, ...(fault === 'duplicate-completion' ? [completion] : []),
      ])
      if (fault !== 'valid') { expect(() => readCodexNativeObservation(root, threadId)).toThrow(); return }
      const observed = readCodexNativeObservation(root, threadId)
      expect(observed.inputs).toEqual([{ turnId: 'turn-1', text: 'remember the nonce' }])
      expect(observed.history.turns[0]).toMatchObject({ turnId: 'turn-1', resolvedReasoningEffort: 'unknown', reasoningEffortProvenance: 'unsupported-native-telemetry' })
    },
  )

  it('correlates a task_complete turn to its assistant response and turn_context profile', () => {
    const root = tempRoot('codex-native')
    writeJsonl(path.join(root, '2026', '09', '01', `rollout-test-${threadId}.jsonl`), [
      { timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { id: threadId, model_provider: 'openai' } },
      { timestamp: '2026-09-01T00:00:00.100Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.6-luna', effort: 'low' } },
      { timestamp: '2026-09-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'assistant-1', role: 'assistant', content: [{ type: 'output_text', text: '00112233445566778899aabbccddeeff' }] } },
      { timestamp: '2026-09-01T00:00:01.100Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '00112233445566778899aabbccddeeff' } },
    ])

    expect(readCodexNativeHistory(root, threadId).turns).toEqual([expect.objectContaining({
      turnId: 'turn-1',
      messageId: 'assistant-1',
      completedAt: '2026-09-01T00:00:01.100Z',
      text: '00112233445566778899aabbccddeeff',
      toolCalls: [],
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.6-luna',
      resolvedReasoningEffort: 'low',
      modelProvenance: 'codex-turn_context.model',
      reasoningEffortProvenance: 'codex-turn_context.effort',
    })])
  })

  it('rejects filename decoys, duplicate exact threads, missing turn metadata, and tool calls', () => {
    const decoyRoot = tempRoot('codex-decoy')
    writeJsonl(path.join(decoyRoot, `rollout-${threadId}.jsonl`), [
      { type: 'session_meta', payload: { id: '33333333-3333-4333-8333-333333333333', model_provider: 'openai' } },
    ])
    expect(() => readCodexNativeHistory(decoyRoot, threadId)).toThrow(/exact.*thread|session_meta/i)

    const duplicateRoot = tempRoot('codex-duplicate')
    for (const day of ['01', '02']) {
      writeJsonl(path.join(duplicateRoot, day, `rollout-${day}-${threadId}.jsonl`), [
        { type: 'session_meta', payload: { id: threadId, model_provider: 'openai' } },
      ])
    }
    expect(() => readCodexNativeHistory(duplicateRoot, threadId)).toThrow(/ambiguous|duplicate/i)

    const missingRoot = tempRoot('codex-missing-profile')
    writeJsonl(path.join(missingRoot, `rollout-${threadId}.jsonl`), [
      { type: 'session_meta', payload: { id: threadId, model_provider: 'openai' } },
      { timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' } },
    ])
    expect(() => readCodexNativeHistory(missingRoot, threadId)).toThrow(/turn_context|profile/i)

    const toolRoot = tempRoot('codex-tool')
    writeJsonl(path.join(toolRoot, `rollout-${threadId}.jsonl`), [
      { timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { id: threadId, model_provider: 'openai' } },
      { timestamp: '2026-09-01T00:00:00.100Z', type: 'turn_context', payload: { turn_id: 'turn-tool', model: 'gpt-5.6-luna', effort: 'low' } },
      { timestamp: '2026-09-01T00:00:00.200Z', type: 'response_item', payload: { type: 'function_call', name: 'read_file' } },
      { timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-tool', last_agent_message: 'done' } },
    ])
    expect(readCodexNativeHistory(toolRoot, threadId).turns[0].toolCalls).toEqual([{ type: 'function_call', name: 'read_file' }])
  })
})

describe('OpenCode native history proof', () => {
  it('retains safe failed outcomes and valid tool-only finalized history', () => {
    const dbPath = path.join(tempRoot('opencode-outcomes'), 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);')
      db.prepare('INSERT INTO session VALUES (?)').run('ses_exact')
      for (const [index, id] of ['failed', 'empty', 'tool-only', 'answer'].entries()) {
        db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, 'ses_exact', index, JSON.stringify({ role: 'assistant',
          parentID: 'user-' + id, providerID: 'opencode', modelID: 'big-pickle', time: { completed: index + 1 },
          ...(id === 'failed' ? { error: { name: 'APIError', data: { message: 'PRIVATE_API_ERROR' } } } : {}) }))
        if (id === 'tool-only' || id === 'answer') db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part-' + id, 'ses_exact', id, index,
          JSON.stringify(id === 'tool-only' ? { type: 'tool', tool: 'read' } : { type: 'text', text: 'ready' }))
      }
    } finally { db.close() }
    const history = readOpenCodeNativeHistory(dbPath, 'ses_exact')
    expect(history.turns).toMatchObject([
      { messageId: 'failed', outcome: 'failed', text: '' },
      { messageId: 'empty', outcome: 'completed', text: '' },
      { messageId: 'tool-only', outcome: 'completed', text: '', toolCalls: [{ type: 'tool', name: 'read' }] },
      { messageId: 'answer', outcome: 'completed', text: 'ready' },
    ])
    expect(JSON.stringify(history)).not.toContain('PRIVATE_API_ERROR')
  })

  it('retains committed WAL contents in a standalone raw database snapshot', () => {
    const root = tempRoot('opencode-live-wal'), dbPath = path.join(root, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);')
      db.prepare('INSERT INTO session VALUES (?)').run('ses_wal')
      db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg_wal', 'ses_wal', 1, JSON.stringify({ role: 'assistant', parentID: 'user_wal', providerID: 'openai', modelID: 'gpt-5.6-luna', time: { completed: 2 } }))
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part_wal', 'ses_wal', 'msg_wal', 1, JSON.stringify({ type: 'text', text: 'completed-in-wal' }))
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)
      const captured = captureNativeHistory('opencode', dbPath, 'ses_wal')
      const retained = path.join(tempRoot('opencode-retained-wal'), 'opencode.db')
      fs.writeFileSync(retained, Buffer.from(captured.rawSource!.snapshot.querySnapshotBase64!, 'base64'))
      expect(readOpenCodeNativeHistory(retained, 'ses_wal').turns[0]).toMatchObject({ text: 'completed-in-wal', resolvedProvider: 'openai', resolvedModel: 'gpt-5.6-luna' })
      expect(captured.turns[0].text).toBe('completed-in-wal')
    } finally { db.close() }
  })

  it('uses the exact SQLite session, completed assistant message, parts, and native profile', () => {
    const root = tempRoot('opencode-native')
    const dbPath = path.join(root, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO session (id) VALUES (?)').run('ses_exact')
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg-1', 'ses_exact', 1, JSON.stringify({
      role: 'assistant', parentID: 'user-1', providerID: 'opencode', modelID: 'big-pickle', time: { completed: 2 },
    }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-1', 'ses_exact', 'msg-1', 1, JSON.stringify({ type: 'text', text: '00112233445566778899aabbccddeeff' }))
    db.close()

    expect(readOpenCodeNativeHistory(dbPath, 'ses_exact').turns).toEqual([expect.objectContaining({
      turnId: 'msg-1', messageId: 'msg-1', parentMessageId: 'user-1', completedAt: 2,
      toolCalls: [], resolvedProvider: 'opencode', resolvedModel: 'big-pickle',
      resolvedReasoningEffort: 'unknown', reasoningEffortProvenance: 'unsupported-native-telemetry',
    })])
    const inEnclosure = JSON.parse(execFileSync(
      process.execPath,
      ['--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT, dbPath, 'ses_exact'],
      { encoding: 'utf8' },
    ))
    expect(inEnclosure).toMatchObject({
      schemaVersion: 1,
      provider: 'opencode',
      nativeSessionId: 'ses_exact',
      turns: [expect.objectContaining({
        messageId: 'msg-1',
        text: '00112233445566778899aabbccddeeff',
        resolvedProvider: 'opencode',
        resolvedModel: 'big-pickle',
      })],
    })
    const nativeInput = new DatabaseSync(dbPath)
    nativeInput.prepare('INSERT INTO message VALUES (?,?,?,?)').run('user-1', 'ses_exact', 0, JSON.stringify({ role: 'user' }))
    nativeInput.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('user-part', 'ses_exact', 'user-1', 0, JSON.stringify({ type: 'text', text: 'remember the nonce' }))
    nativeInput.close()
    const observed = readOpenCodeNativeObservation(dbPath, 'ses_exact')
    expect(observed.inputs).toEqual([{ messageId: 'user-1', text: 'remember the nonce' }])
    expect(observed.history.turns[0]!.parentMessageId).toBe(observed.inputs[0]!.messageId)
  })

  it('fails closed for a symlinked database and an absent exact session row', () => {
    const root = tempRoot('opencode-unsafe')
    const target = path.join(root, 'target.db')
    const db = new DatabaseSync(target)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);')
    db.close()
    const link = path.join(root, 'link.db')
    fs.symlinkSync(target, link)
    expect(() => readOpenCodeNativeHistory(link, 'ses_exact')).toThrow(/symlink/i)
    expect(() => readOpenCodeNativeHistory(target, 'ses_exact')).toThrow(/exact.*session/i)

    const missingSchema = path.join(root, 'missing-schema.db')
    const malformed = new DatabaseSync(missingSchema)
    malformed.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
    malformed.prepare('INSERT INTO session (id) VALUES (?)').run('ses_exact')
    malformed.close()
    expect(() => readOpenCodeNativeHistory(missingSchema, 'ses_exact')).toThrow(/schema|columns/i)
  })
})

describe('Amplifier native history proof', () => {
  const sessionId = '44444444-4444-4444-8444-444444444444'

  function observedSession() {
    const event = (name: string, millisecond: number, data: any = {}) => ({ event: name, session_id: sessionId,
      schema: { name: 'amplifier.log', ver: '1.0.0' }, ts: new Date(Date.parse('2026-09-01T00:00:00Z') + millisecond).toISOString(), data })
    return {
      events: [event('prompt:submit', 0, { prompt: 'remember', parent_id: null }),
        event('llm:response', 100, { model: 'glm-5.3', provider: 'vllm', continuation_count: null, parent_id: null }),
        event('prompt:complete', 200, { length: 6, response_preview: 'marker', parent_id: null }),
        event('prompt:complete', 300, { prompt: 'remember', response: 'marker', parent_id: null }),
        event('cleanup:store_end', 400, { parent_id: null })],
      transcript: [{ role: 'user', content: 'remember', metadata: { timestamp: '2026-09-01T00:00:00.000Z' } },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'marker' }], metadata: { timestamp: '2026-09-01T00:00:00.200Z' } }],
    }
  }

  it('reads actual llm:response model/provider with two completion callbacks and no session:config', () => {
    const root = tempRoot('amplifier-observed'), sessionDir = path.join(root, 'project', 'sessions', sessionId), source = observedSession()
    writeJsonl(path.join(sessionDir, 'events.jsonl'), source.events); writeJsonl(path.join(sessionDir, 'transcript.jsonl'), source.transcript)
    const history = readAmplifierNativeHistory(root, sessionId)
    expect(history.turns).toHaveLength(1)
    expect(history.turns[0]).toMatchObject({ text: 'marker', resolvedProvider: 'vllm', resolvedModel: 'glm-5.3',
      resolvedReasoningEffort: 'unknown', providerProvenance: 'amplifier-llm:response.provider', modelProvenance: 'amplifier-llm:response.model',
      reasoningEffortProvenance: 'unsupported-native-telemetry', nativeEvidence: { kind: 'append_only_record', recordIndex: 1, completionEventOrdinal: 1 } })
  })

  it.each(['missing-full', 'conflicting-preview', 'conflicting-length', 'empty-sole-data'] as const)(
    'refuses an incomplete observed Amplifier callback sequence (%s)', fault => {
      const root = tempRoot('amplifier-preview-only'), sessionDir = path.join(root, 'project', 'sessions', sessionId), source: any = observedSession()
      writeJsonl(path.join(sessionDir, 'events.jsonl'), source.events); writeJsonl(path.join(sessionDir, 'transcript.jsonl'), source.transcript)
      expect(readAmplifierNativeHistory(root, sessionId).turns).toHaveLength(1)
      source.events.splice(3, 1)
      if (fault === 'conflicting-preview') source.events[2].data.response_preview = 'unrelated'
      if (fault === 'conflicting-length') source.events[2].data.length = 100
      if (fault === 'empty-sole-data') source.events[2].data = {}
      writeJsonl(path.join(sessionDir, 'events.jsonl'), source.events)
      expect(() => readAmplifierNativeHistory(root, sessionId)).toThrow(/completion|callback|response/i)
    },
  )

  it('joins each observed profile to its own persisted prompt instead of using the first response or configuration', () => {
    const root = tempRoot('amplifier-per-prompt'), sessionDir = path.join(root, 'project', 'sessions', sessionId), source: any = observedSession()
    const second = observedSession()
    for (const event of second.events) event.ts = new Date(Date.parse(event.ts) + 1_000).toISOString()
    second.events[1]!.data.model = 'next-native-model'
    for (const row of second.transcript) row.metadata.timestamp = new Date(Date.parse(row.metadata.timestamp) + 1_000).toISOString()
    source.events.push(...second.events); source.transcript.push(...second.transcript)
    writeJsonl(path.join(sessionDir, 'events.jsonl'), source.events); writeJsonl(path.join(sessionDir, 'transcript.jsonl'), source.transcript)
    expect(readAmplifierNativeHistory(root, sessionId).turns.map(turn => turn.resolvedModel)).toEqual(['glm-5.3', 'next-native-model'])
  })

  it.each(['missing-response', 'missing-model', 'missing-provider', 'conflicting-model', 'conflicting-provider', 'foreign-root', 'late-response', 'no-submit', 'duplicate-submit', 'duplicate-completion', 'wrong-prompt', 'wrong-response', 'wrong-request', 'wrong-transcript-request', 'assistant-before-response', 'user-after-response', 'missing-store', 'unpersisted-next-prompt'] as const)(
    'refuses uncorrelated native Amplifier response evidence (%s)', fault => {
      const root = tempRoot('amplifier-observed-fault'), sessionDir = path.join(root, 'project', 'sessions', sessionId), source: any = observedSession()
      if (fault === 'missing-response') source.events.splice(1, 1)
      if (fault === 'missing-model') delete source.events[1].data.model
      if (fault === 'missing-provider') delete source.events[1].data.provider
      if (fault === 'conflicting-model') source.events.splice(2, 0, { ...source.events[1], data: { ...source.events[1].data, model: 'other-model' } })
      if (fault === 'conflicting-provider') source.events.splice(2, 0, { ...source.events[1], data: { ...source.events[1].data, provider: 'other-provider' } })
      if (fault === 'foreign-root') source.events[1].session_id = 'other-root'
      if (fault === 'late-response') source.events[1].ts = '2026-09-01T00:00:01Z'
      if (fault === 'no-submit') source.events.shift()
      if (fault === 'duplicate-submit') source.events.splice(1, 0, structuredClone(source.events[0]))
      if (fault === 'duplicate-completion') source.events.splice(3, 0, structuredClone(source.events[2]))
      if (fault === 'wrong-prompt') source.events[3].data.prompt = 'unrelated'
      if (fault === 'wrong-response') source.events[3].data.response = 'unrelated'
      if (fault === 'wrong-request') { source.events[0].request_id = 'one'; source.events[1].request_id = 'two' }
      if (fault === 'wrong-transcript-request') { for (const row of source.events) row.request_id = 'one'; source.transcript[1].metadata.request_id = 'two' }
      if (fault === 'assistant-before-response') source.transcript[1].metadata.timestamp = '2026-09-01T00:00:00.050Z'
      if (fault === 'user-after-response') source.transcript[0].metadata.timestamp = '2026-09-01T00:00:00.150Z'
      if (fault === 'missing-store') source.events.pop()
      if (fault === 'unpersisted-next-prompt') source.events.push({ ...source.events[0], ts: '2026-09-01T00:00:01Z' })
      writeJsonl(path.join(sessionDir, 'events.jsonl'), source.events); writeJsonl(path.join(sessionDir, 'transcript.jsonl'), source.transcript)
      expect(() => readAmplifierNativeHistory(root, sessionId)).toThrow()
    },
  )

  it('binds an exact session directory, stored assistant IDs, completion events, tools, and session:config', () => {
    const root = tempRoot('amplifier-native')
    const sessionDir = path.join(root, '-workspace', 'sessions', sessionId)
    writeJsonl(path.join(sessionDir, 'events.jsonl'), [
      { ts: '2026-09-01T00:00:00.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'session:config', session_id: sessionId, data: { raw: { providers: [{ id: 'lunaroute', config: { default_model: 'glm-5.3' } }] } } },
      { ts: '2026-09-01T00:00:01.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'prompt:complete', session_id: sessionId, request_id: 'turn-1', status: 'ok', data: {} },
      { ts: '2026-09-01T00:00:01.100Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'cleanup:store_end', session_id: sessionId, request_id: 'turn-1', status: 'ok', data: {} },
    ])
    writeJsonl(path.join(sessionDir, 'transcript.jsonl'), [{
      id: 'assistant-1', parent_id: 'user-1', role: 'assistant', timestamp: '2026-09-01T00:00:01.000Z',
      content: [{ type: 'text', text: '00112233445566778899aabbccddeeff' }], metadata: { request_id: 'turn-1' },
    }])

    expect(readAmplifierNativeHistory(root, sessionId).turns).toEqual([expect.objectContaining({
      nativeEvidence: expect.objectContaining({
        kind: 'append_only_record',
        recordIndex: 0,
        completionEventOrdinal: 1,
      }),
      completedAt: '2026-09-01T00:00:01.100Z', toolCalls: [],
      resolvedProvider: 'lunaroute', resolvedModel: 'glm-5.3',
      resolvedReasoningEffort: 'provider-default', providerProvenance: 'amplifier-session:config.provider',
    })])
  })

  it('keeps native tool:pre evidence visible even when the transcript omits a tool-result row', () => {
    const root = tempRoot('amplifier-tool-event')
    const sessionDir = path.join(root, 'project', 'sessions', sessionId)
    writeJsonl(path.join(sessionDir, 'events.jsonl'), [
      { ts: '2026-09-01T00:00:00.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'session:config', session_id: sessionId, data: { raw: { providers: [{ id: 'lunaroute', config: { default_model: 'glm-5.3' } }] } } },
      { ts: '2026-09-01T00:00:00.500Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'tool:pre', session_id: sessionId, data: { tool_name: 'read_file' } },
      { ts: '2026-09-01T00:00:01.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'prompt:complete', session_id: sessionId, request_id: 'turn-1', data: {} },
      { ts: '2026-09-01T00:00:01.100Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'cleanup:store_end', session_id: sessionId, request_id: 'turn-1', data: {} },
    ])
    writeJsonl(path.join(sessionDir, 'transcript.jsonl'), [{
      id: 'assistant-1', role: 'assistant', content: 'done', metadata: { request_id: 'turn-1' },
    }])
    expect(readAmplifierNativeHistory(root, sessionId).turns[0].toolCalls).toContainEqual({
      type: 'tool:pre', name: 'read_file',
    })
  })

  it('rejects ambiguous exact directories, unsafe IDs/symlinks, missing message IDs, and uncorrelated completions', () => {
    const duplicateRoot = tempRoot('amplifier-duplicate')
    for (const project of ['one', 'two']) fs.mkdirSync(path.join(duplicateRoot, project, 'sessions', sessionId), { recursive: true })
    expect(() => readAmplifierNativeHistory(duplicateRoot, sessionId)).toThrow(/ambiguous|duplicate/i)
    expect(() => readAmplifierNativeHistory(duplicateRoot, '../escape')).toThrow(/safe.*session|session id/i)

    const symlinkRoot = tempRoot('amplifier-symlink')
    const outside = path.join(tempRoot('amplifier-outside'), sessionId)
    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(symlinkRoot, 'project', 'sessions'), { recursive: true })
    fs.symlinkSync(outside, path.join(symlinkRoot, 'project', 'sessions', sessionId), 'dir')
    expect(() => readAmplifierNativeHistory(symlinkRoot, sessionId)).toThrow(/symlink/i)

    // The pinned product does not promise message/request IDs. Certify the
    // native append-only session semantics it actually exposes instead of
    // inventing an identity purely for Freshell's test harness.
    const pinnedRoot = tempRoot('amplifier-pinned-shape')
    const pinnedDir = path.join(pinnedRoot, 'project', 'sessions', sessionId)
    writeJsonl(path.join(pinnedDir, 'events.jsonl'), [
      { ts: '2026-09-01T00:00:00.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'session:config', session_id: sessionId, data: { raw: { providers: [{ id: 'lunaroute', config: { default_model: 'glm-5.3' } }] } } },
      { ts: '2026-09-01T00:00:01.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'prompt:complete', session_id: sessionId, data: {} },
      { ts: '2026-09-01T00:00:01.100Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'cleanup:store_end', session_id: sessionId, data: {} },
      { ts: '2026-09-01T00:00:02.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'prompt:complete', session_id: sessionId, data: {} },
      { ts: '2026-09-01T00:00:02.100Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'cleanup:store_end', session_id: sessionId, data: {} },
    ])
    writeJsonl(path.join(pinnedDir, 'transcript.jsonl'), [
      { role: 'user', content: 'remember it' },
      { role: 'assistant', content: '00112233445566778899aabbccddeeff', metadata: { timestamp: '2026-09-01T00:00:01.000Z' } },
      { role: 'user', content: 'recall it' },
      { role: 'assistant', content: 'still 00112233445566778899aabbccddeeff', metadata: { timestamp: '2026-09-01T00:00:02.000Z' } },
    ])
    const pinned = readAmplifierNativeHistory(pinnedRoot, sessionId) as any
    expect(pinned.turns).toHaveLength(2)
    expect(pinned.turns.map((turn: any) => turn.nativeEvidence.kind)).toEqual(['append_only_record', 'append_only_record'])
    expect(pinned.turns.map((turn: any) => turn.nativeEvidence.recordIndex)).toEqual([1, 3])
    expect(pinned.turns.every((turn: any) => /^[a-f0-9]{64}$/.test(turn.nativeEvidence.recordSha256))).toBe(true)
    expect(pinned.turns[0].messageId).toBeUndefined()
    expect(pinned.turns[0].turnId).toBeUndefined()
  })
})

describe('redacted native turn proof', () => {
  it('retains only IDs, profile provenance, tool summaries, hashes, and nonce containment', () => {
    const proof = nativeTurnProof('after_session_host_crash', 'session-1', {
      turnId: 'turn-1', messageId: 'message-1', parentMessageId: 'parent-1', completedAt: '2026-09-01T00:00:00.000Z',
      text: 'Remembered 00112233445566778899aabbccddeeff and secret sk-synthetic-do-not-retain',
      toolCalls: [], resolvedProvider: 'anthropic', resolvedModel: 'haiku', resolvedReasoningEffort: 'low',
      providerProvenance: 'native.provider', modelProvenance: 'native.model', reasoningEffortProvenance: 'native.effort',
    }, '00112233445566778899aabbccddeeff')
    expect(proof.responseContainsNonce).toBe(true)
    expect(proof.responseSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(proof)).not.toContain('00112233445566778899aabbccddeeff')
    expect(JSON.stringify(proof)).not.toContain('sk-synthetic')
  })
})
