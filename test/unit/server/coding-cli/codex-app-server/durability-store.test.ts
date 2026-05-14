import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexDurabilityStore } from '../../../../../server/coding-cli/codex-app-server/durability-store.js'
import type { CodexDurabilityStoreRecord } from '../../../../../shared/codex-durability.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-store-'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

function record(overrides: Partial<CodexDurabilityStoreRecord> = {}): CodexDurabilityStoreRecord {
  const now = Date.now()
  return {
    schemaVersion: 1,
    terminalId: 'term-1',
    tabId: 'tab-1',
    paneId: 'pane-1',
    serverInstanceId: 'srv-1',
    state: 'captured_pre_turn',
    candidate: {
      provider: 'codex',
      candidateThreadId: 'thread-1',
      rolloutPath: path.join(tempDir, 'rollout.jsonl'),
      source: 'thread_start_response',
      capturedAt: now,
    },
    updatedAt: now,
    ...overrides,
  }
}

describe('CodexDurabilityStore', () => {
  it('atomically writes and reads a record', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    const written = await store.write(record())

    await expect(store.read('term-1')).resolves.toEqual(written)
  })

  it('treats a duplicate matching candidate as idempotent', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    const first = record()
    await store.write(first)
    const second = record({ state: 'turn_in_progress_unproven', updatedAt: first.updatedAt + 1 })

    await expect(store.write(second)).resolves.toEqual(second)
  })

  it('rejects a mismatched candidate for the same terminal', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record())

    await expect(store.write(record({
      candidate: {
        provider: 'codex',
        candidateThreadId: 'thread-2',
        rolloutPath: path.join(tempDir, 'other.jsonl'),
        source: 'thread_start_response',
        capturedAt: Date.now(),
      },
    }))).rejects.toThrow(/candidate mismatch/)
  })

  it('returns undefined for older layouts with no durability store record', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })

    await expect(store.read('legacy-terminal')).resolves.toBeUndefined()
  })

  it('deletes records idempotently', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record())

    await expect(store.delete('term-1')).resolves.toBeUndefined()
    await expect(store.delete('term-1')).resolves.toBeUndefined()
    await expect(store.read('term-1')).resolves.toBeUndefined()
  })

  it('deletes stale records owned by older server instances', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record({ terminalId: 'term-current', serverInstanceId: 'srv-current' }))
    await store.write(record({ terminalId: 'term-old', serverInstanceId: 'srv-old' }))

    await expect(store.deleteRecordsForOtherServers('srv-current')).resolves.toBe(1)

    await expect(store.read('term-current')).resolves.toMatchObject({
      terminalId: 'term-current',
      serverInstanceId: 'srv-current',
    })
    await expect(store.read('term-old')).resolves.toBeUndefined()
  })

  it('deletes invalid stale files during startup reaping', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record({ terminalId: 'term-current', serverInstanceId: 'srv-current' }))
    await fsp.writeFile(path.join(tempDir, 'bad.json'), '{bad json\n')
    await fsp.writeFile(path.join(tempDir, 'wrong-shape.json'), '{}\n')

    await expect(store.deleteRecordsForOtherServers('srv-current')).resolves.toBe(2)

    await expect(fsp.readdir(tempDir)).resolves.toEqual(['term-current.json'])
  })
})
