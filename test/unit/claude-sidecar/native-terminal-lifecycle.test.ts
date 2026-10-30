import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeNativeSessionSignal } from '../../../crates/freshell-claude-sidecar/native-session-channel.mjs'

describe('Claude terminal native lifecycle receipt', () => {
  it.each(['startup', 'resume', 'clear'])('preserves %s admission through repeated same-session compaction', async (source) => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-terminal-compact-'))
    const launch = { incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 1,
      executionGeneration: 1, requestedNativeSessionId: source === 'resume' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null }
    const environment = { FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch), FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR: directory }
    const native = { hook_event_name: 'SessionStart', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source, cwd: '/owned', transcript_path: '/owned/session.jsonl' }
    try {
      await writeNativeSessionSignal(native, environment)
      for (let index = 0; index < 2; index++) {
        await writeNativeSessionSignal({ ...native, source: 'compact' }, environment)
        const receipt = JSON.parse(await readFile(join(directory, 'session-start.json'), 'utf8'))
        expect(receipt).toEqual({ launch, native })
      }
      // A genuinely different session cannot borrow the original admission.
      await writeNativeSessionSignal({ ...native, source: 'compact', session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, environment)
      expect(JSON.parse(await readFile(join(directory, 'session-start.json'), 'utf8')).native)
        .toMatchObject({ source: 'compact', session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
      await writeNativeSessionSignal({ ...native, source: 'clear' }, environment)
      expect(JSON.parse(await readFile(join(directory, 'session-start.json'), 'utf8')).native.source).toBe('clear')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
