import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { readAmplifierNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/amplifier.js'
import { readClaudeNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/claude.js'
import { readCodexNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/codex.js'
import { readOpenCodeNativeHistory } from '../../../e2e-browser/helpers/provider-native-history/opencode.js'
import { nativeTurnProof } from '../../../e2e-browser/helpers/provider-native-history/proof.js'

const roots: string[] = []

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
      resolvedReasoningEffort: 'provider-default',
    })])
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

  it('binds an exact session directory, stored assistant IDs, completion events, tools, and session:config', () => {
    const root = tempRoot('amplifier-native')
    const sessionDir = path.join(root, '-workspace', 'sessions', sessionId)
    writeJsonl(path.join(sessionDir, 'events.jsonl'), [
      { ts: '2026-09-01T00:00:00.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'session:config', session_id: sessionId, data: { raw: { providers: [{ id: 'freshell-onecli-anthropic', config: { default_model: 'claude-haiku-4-5-20251001', reasoning_effort: 'low' } }] } } },
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
      resolvedProvider: 'freshell-onecli-anthropic', resolvedModel: 'claude-haiku-4-5-20251001',
      resolvedReasoningEffort: 'low', providerProvenance: 'amplifier-session:config.provider',
    })])
  })

  it('keeps native tool:pre evidence visible even when the transcript omits a tool-result row', () => {
    const root = tempRoot('amplifier-tool-event')
    const sessionDir = path.join(root, 'project', 'sessions', sessionId)
    writeJsonl(path.join(sessionDir, 'events.jsonl'), [
      { ts: '2026-09-01T00:00:00.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'session:config', session_id: sessionId, data: { raw: { providers: [{ id: 'freshell-onecli-anthropic', config: { default_model: 'claude-haiku-4-5-20251001', reasoning_effort: 'low' } }] } } },
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
      { ts: '2026-09-01T00:00:00.000Z', schema: { name: 'amplifier.log', ver: '1.0.0' }, event: 'session:config', session_id: sessionId, data: { raw: { providers: [{ id: 'freshell-onecli-anthropic', config: { default_model: 'claude-haiku-4-5-20251001', reasoning_effort: 'low' } }] } } },
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
