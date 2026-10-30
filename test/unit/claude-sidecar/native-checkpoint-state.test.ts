import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNativeCheckpointStore } from '../../../crates/freshell-claude-sidecar/native-checkpoint-state.mjs'

const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const toolUseID = 'toolu_original1'
const input = { command: 'harmless effect counter' }
const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
const profileDigest = 'b'.repeat(64)
const binding = { launch: { incarnationId: 'current', launchNonce: 'nonce', evidenceRevision: 0,
  executionGeneration: 1, requestedNativeSessionId: root }, queryGeneration: 2, nativeRequestId: 'native-current' }

async function scenario(run: (store: any, reopen: (profile?: string) => any, paths: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'native-checkpoint-state-'))
  const transcriptPath = join(directory, root + '.jsonl')
  const recordPath = join(directory, 'checkpoint.json')
  const assistant = { type: 'assistant', sessionId: root, uuid: 'assistant-original', version: '2.1.237',
    message: { id: 'msg_original', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input }] } }
  const attachment = { type: 'attachment', sessionId: root, uuid: 'checkpoint-original', version: '2.1.237',
    attachment: { type: 'hook_deferred_tool', toolUseID, toolName: 'Bash', toolInput: input,
      hookEvent: 'PreToolUse', permissionMode: 'default' } }
  await writeFile(transcriptPath, JSON.stringify(assistant) + '\n' + JSON.stringify(attachment) + '\n')
  const reopen = (profile = profileDigest) => createNativeCheckpointStore({ recordPath, transcriptPath,
    nativeSessionId: root, profileDigest: profile })
  try { await run(reopen(), reopen, { recordPath, transcriptPath }) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

describe('restricted native checkpoint durable phases', () => {
  it('admits the first child input only from the verified native parent prefix and prefers an existing child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-parent-fork-'))
    const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const parentPath = join(directory, parent + '.jsonl')
    const transcriptPath = join(directory, root + '.jsonl')
    const rows = [
      { type: 'user', sessionId: parent, uuid: 'first-user', parentUuid: null, message: { content: 'kept' } },
      { type: 'assistant', sessionId: parent, uuid: 'first-answer', parentUuid: 'first-user', message: { content: [] } },
      { type: 'user', sessionId: parent, uuid: 'undone-user', parentUuid: 'first-answer', message: { content: 'removed' } },
    ]
    const bytes = rows.map((row) => JSON.stringify(row) + '\n').join('')
    const parentFork = { childSessionId: root, parentSessionId: parent, parentTranscript: parentPath,
      childTranscript: transcriptPath, parentSha256: createHash('sha256').update(bytes).digest('hex'),
      target: { kind: 'prefix', cutoffUuid: 'first-answer', dropTurnUuid: 'undone-user' } }
    const open = (recipe: typeof parentFork & { recoveryDisabled?: boolean } = parentFork) => createNativeCheckpointStore({ recordPath: join(directory, 'checkpoint.json'),
      transcriptPath, nativeSessionId: root, profileDigest, parentFork: recipe })
    try {
      await writeFile(parentPath, bytes)
      expect(await open().inputState()).toBe('clear')
      const live = open()
      expect(await live.inputState()).toBe('clear')
      live.disableParentFork()
      expect(await live.inputState()).toBe('blocked')
      expect(await open({ ...parentFork, childSessionId: parent }).inputState()).toBe('blocked')
      expect(await open({ ...parentFork, recoveryDisabled: true }).inputState()).toBe('blocked')
      expect(await open({ ...parentFork, target: { ...parentFork.target, cutoffUuid: 'missing' } }).inputState()).toBe('blocked')
      expect(await open({ ...parentFork, target: { ...parentFork.target, dropTurnUuid: 'wrong' } }).inputState()).toBe('blocked')
      const unfinished = rows.map((row, index) => JSON.stringify(index === 1 ? { ...row,
        message: { content: [{ type: 'tool_use', id: 'toolu_parentPending', name: 'Bash', input }] } } : row) + '\n').join('')
      await writeFile(parentPath, unfinished)
      expect(await open({ ...parentFork, parentSha256: createHash('sha256').update(unfinished).digest('hex') }).inputState()).toBe('blocked')
      await writeFile(parentPath, bytes + '{}\n')
      expect(await open().inputState()).toBe('blocked')
      await writeFile(parentPath, bytes)
      await writeFile(transcriptPath, '{partial')
      expect(await open().inputState()).toBe('blocked')
      for (const row of [{ type: 'mode', sessionId: root }, { type: 'user', sessionId: parent }]) {
        await writeFile(transcriptPath, JSON.stringify(row) + '\n')
        expect(await open().inputState()).toBe('blocked')
      }
      await writeFile(transcriptPath, JSON.stringify({ type: 'assistant', sessionId: root,
        message: { content: [{ type: 'tool_use', id: 'toolu_unfinished', name: 'Bash', input }] } }) + '\n')
      expect(await open().inputState()).toBe('blocked')
      await rm(parentPath)
      expect(await open().inputState()).toBe('blocked')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it.each([1, 2])('blocks %i unfinished native tools without a checkpoint or callback to replay', async (count) => scenario(async (store, reopen, paths) => {
    const tools = Array.from({ length: count }, (_, index) => ({ type: 'tool_use', id: 'toolu_unfinished' + index, name: 'Bash', input }))
    const assistant = { type: 'assistant', sessionId: root, message: { content: tools } }
    await writeFile(paths.transcriptPath, JSON.stringify(assistant) + '\n')
    expect(await store.inputState()).toBe('blocked')
    expect(await reopen().readRecoverable()).toBeNull()
    for (const tool of tools) {
      expect(await reopen().inputState()).toBe('blocked')
      await writeFile(paths.transcriptPath, JSON.stringify({ type: 'user', sessionId: root,
        message: { content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'native refusal', is_error: true }] } }) + '\n', { flag: 'a' })
    }
    expect(await reopen().inputState()).toBe('clear')
  }))
  it('keeps a later unfinished native tool blocked after an earlier checkpoint was consumed', async () => scenario(async (store, reopen, paths) => {
    await store.publish(toolUseID, inputDigest)
    await writeFile(paths.transcriptPath, JSON.stringify({ type: 'user', sessionId: root,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: false }] } }) + '\n'
      + JSON.stringify({ type: 'assistant', sessionId: root,
        message: { content: [{ type: 'tool_use', id: 'toolu_later1', name: 'Bash', input }] } }) + '\n', { flag: 'a' })
    expect(await reopen().inputState()).toBe('blocked')
  }))
  it('publishes only the inspected native checkpoint and keeps its record body-free', async () => scenario(async (store, reopen, paths) => {
    const checkpoint = await store.publish(toolUseID, inputDigest)
    expect(checkpoint).toMatchObject({ nativeSessionId: root, toolUseID, inputDigest, profileDigest, phase: 'checkpointed' })
    expect(await reopen().readRecoverable()).toEqual(checkpoint)
    expect(await readFile(paths.recordPath, 'utf8')).not.toContain(input.command)
  }))
  it('never automatically replays a continuation or decision that became ambiguous across reopen', async () => scenario(async (store, reopen) => {
    await store.publish(toolUseID, inputDigest)
    expect(await store.beginContinuation()).toBe(true)
    expect(await reopen().readRecoverable()).toBeNull()
    expect(await store.parkPermission(toolUseID, inputDigest, binding)).toBe(true)
    expect(await reopen().readRecoverable()).toMatchObject({ phase: 'approval_waiting', nativeBinding: binding })
    expect(await store.beginDecision('old-native')).toBe(false)
    expect(await store.beginDecision(binding.nativeRequestId)).toBe(true)
    expect(await reopen().readRecoverable()).toBeNull()
    expect(await store.finishNativeResult(toolUseID, false)).toBe(true)
    expect(await reopen().readRecoverable()).toBeNull()
  }))
  it('refuses a changed profile and wrong current native operation', async () => scenario(async (store, reopen) => {
    await store.publish(toolUseID, inputDigest)
    expect(await reopen('c'.repeat(64)).readRecoverable()).toBeNull()
    await store.beginContinuation()
    expect(await store.parkPermission('toolu_other1', inputDigest, binding)).toBe(false)
    expect(await store.parkPermission(toolUseID, 'd'.repeat(64), binding)).toBe(false)
    expect(await store.finishNativeResult('toolu_other1', false)).toBe(false)
  }))
  it('keeps an explicit interrupted operation unavailable and serializes one continuation claim', async () => scenario(async (store, reopen) => {
    await store.publish(toolUseID, inputDigest)
    expect(await Promise.all([store.beginContinuation(), store.beginContinuation()])).toEqual([true, false])
    await store.parkPermission(toolUseID, inputDigest, binding)
    await store.interrupt()
    expect(await reopen().readRecoverable()).toBeNull()
    expect(await store.beginDecision(binding.nativeRequestId)).toBe(false)
  }))
  it('refuses a native checkpoint consumed after metadata publication', async () => scenario(async (store, reopen, paths) => {
    await store.publish(toolUseID, inputDigest)
    const original = await readFile(paths.transcriptPath, 'utf8')
    await writeFile(paths.transcriptPath, original + JSON.stringify({ type: 'user', sessionId: root,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: false }] } }) + '\n')
    expect(await reopen().readRecoverable()).toBeNull()
    expect(await store.beginContinuation()).toBe(false)
  }))
  it('blocks ordinary resume input for an unregistered or ambiguous native marker and clears only native consumption', async () => scenario(async (store, reopen, paths) => {
    expect(await store.inputState()).toBe('blocked')
    await store.publish(toolUseID, inputDigest)
    expect(await store.inputState()).toBe('recoverable')
    await store.beginContinuation()
    expect(await reopen().inputState()).toBe('blocked')
    await store.parkPermission(toolUseID, inputDigest, binding)
    expect(await reopen('c'.repeat(64)).inputState()).toBe('blocked')
    await store.beginDecision(binding.nativeRequestId)
    expect(await reopen().inputState()).toBe('blocked')
    const original = await readFile(paths.transcriptPath, 'utf8')
    await writeFile(paths.transcriptPath, original + JSON.stringify({ type: 'user', sessionId: root,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: false }] } }) + '\n')
    expect(await reopen().inputState()).toBe('clear')
    expect(await reopen().readRecoverable()).toBeNull()
    await writeFile(paths.recordPath, '{unfinished')
    expect(await reopen().inputState()).toBe('blocked')
  }))
})
