import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexDurabilityRestoreAmbiguousError,
  CodexDurabilityStore,
} from '../../../../../server/coding-cli/codex-app-server/durability-store.js'
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

async function writeRawRecordFile(terminalId: string, content: string): Promise<void> {
  await fsp.writeFile(path.join(tempDir, `${encodeURIComponent(terminalId)}.json`), content)
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

  it('finds restore records by terminal id', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    const stored = await store.write(record())

    await expect(store.readForRestoreLocator({ terminalId: 'term-1' })).resolves.toEqual(stored)
  })

  it('finds restore records by exact tab and pane identity', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    const stored = await store.write(record())

    await expect(store.readForRestoreLocator({
      tabId: 'tab-1',
      paneId: 'pane-1',
      serverInstanceId: 'srv-1',
    })).resolves.toEqual(stored)
  })

  it('skips bad records during tab and pane restore scans', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    const stored = await store.write(record())
    await writeRawRecordFile('malformed-record', '{not-json')
    await writeRawRecordFile('schema-invalid-record', JSON.stringify({
      schemaVersion: 1,
      terminalId: 'schema-invalid-record',
      tabId: 'tab-1',
      paneId: 'pane-1',
      serverInstanceId: 'srv-1',
      state: 'not-a-durability-state',
      updatedAt: Date.now(),
    }))
    await fsp.mkdir(path.join(tempDir, `${encodeURIComponent('directory-record')}.json`))

    await expect(store.readForRestoreLocator({
      tabId: 'tab-1',
      paneId: 'pane-1',
      serverInstanceId: 'srv-1',
    })).resolves.toEqual(stored)
  })

  it('keeps exact terminal id restore lookups strict for bad records', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await writeRawRecordFile('malformed-record', '{not-json')
    await writeRawRecordFile('schema-invalid-record', JSON.stringify({
      schemaVersion: 1,
      terminalId: 'schema-invalid-record',
      tabId: 'tab-1',
      paneId: 'pane-1',
      serverInstanceId: 'srv-1',
      state: 'not-a-durability-state',
      updatedAt: Date.now(),
    }))

    await expect(store.readForRestoreLocator({ terminalId: 'malformed-record' })).rejects.toThrow(SyntaxError)
    await expect(store.readForRestoreLocator({ terminalId: 'schema-invalid-record' }))
      .rejects.toThrow(/invalid for terminal schema-invalid-record/)
  })

  it('does not match a wrong pane or server instance', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record())

    await expect(store.readForRestoreLocator({
      tabId: 'tab-1',
      paneId: 'pane-other',
      serverInstanceId: 'srv-1',
    })).resolves.toBeUndefined()
    await expect(store.readForRestoreLocator({
      tabId: 'tab-1',
      paneId: 'pane-1',
      serverInstanceId: 'srv-other',
    })).resolves.toBeUndefined()
  })

  it('reports ambiguity instead of choosing by time', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record({ terminalId: 'term-1' }))
    await store.write(record({ terminalId: 'term-2', updatedAt: Date.now() + 10 }))
    await writeRawRecordFile('malformed-record', '{not-json')

    await expect(store.readForRestoreLocator({
      tabId: 'tab-1',
      paneId: 'pane-1',
    })).rejects.toBeInstanceOf(CodexDurabilityRestoreAmbiguousError)
  })

  it('deletes records idempotently', async () => {
    const store = new CodexDurabilityStore({ dir: tempDir })
    await store.write(record())

    await expect(store.delete('term-1')).resolves.toBeUndefined()
    await expect(store.delete('term-1')).resolves.toBeUndefined()
    await expect(store.read('term-1')).resolves.toBeUndefined()
  })
})
