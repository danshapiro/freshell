import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { SessionMetadataStore } from '../../../server/session-metadata-store.js'

describe('SessionMetadataStore', () => {
  let tmpDir: string
  let store: SessionMetadataStore

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-meta-'))
    store = new SessionMetadataStore(tmpDir)
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined for unknown session', async () => {
    const meta = await store.get('claude', 'nonexistent')
    expect(meta).toBeUndefined()
  })

  it('writes and reads sessionType', async () => {
    await store.set('claude', 'abc-123', { sessionType: 'freshclaude' })
    const meta = await store.get('claude', 'abc-123')
    expect(meta?.sessionType).toBe('freshclaude')
  })

  it('returns all entries via getAll', async () => {
    await store.set('claude', 'a', { sessionType: 'freshclaude' })
    await store.set('claude', 'b', { sessionType: 'kilroy' })
    const all = await store.getAll()
    expect(all['claude:a']?.sessionType).toBe('freshclaude')
    expect(all['claude:b']?.sessionType).toBe('kilroy')
  })

  it('handles missing file gracefully', async () => {
    // Store with nonexistent dir works on first read
    const emptyStore = new SessionMetadataStore(path.join(tmpDir, 'nodir'))
    const meta = await emptyStore.get('claude', 'x')
    expect(meta).toBeUndefined()
  })

  it('handles corrupt file gracefully', async () => {
    await fsp.writeFile(path.join(tmpDir, 'session-metadata.json'), 'not json', 'utf-8')
    const meta = await store.get('claude', 'x')
    expect(meta).toBeUndefined()
  })

  it('persists across instances', async () => {
    await store.set('claude', 'abc', { sessionType: 'freshclaude' })
    const store2 = new SessionMetadataStore(tmpDir)
    const meta = await store2.get('claude', 'abc')
    expect(meta?.sessionType).toBe('freshclaude')
  })

  it('returns defensive copies from get and getAll', async () => {
    await store.set('claude', 'x', { sessionType: 'freshclaude' })

    // Mutating the result of get() should not affect the store
    const entry = await store.get('claude', 'x')
    entry!.sessionType = 'mutated'
    const fresh = await store.get('claude', 'x')
    expect(fresh?.sessionType).toBe('freshclaude')

    // Mutating an entry object from getAll() should not affect the store
    const all = await store.getAll()
    all['claude:x']!.sessionType = 'mutated'
    const allAgain = await store.getAll()
    expect(allAgain['claude:x']?.sessionType).toBe('freshclaude')
  })

  it('does not allow caller to mutate cache via set input', async () => {
    const input = { sessionType: 'freshclaude' }
    await store.set('claude', 'y', input)
    input.sessionType = 'mutated'
    const meta = await store.get('claude', 'y')
    expect(meta?.sessionType).toBe('freshclaude')
  })
})
