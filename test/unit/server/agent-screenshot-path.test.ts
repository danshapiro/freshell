import { describe, it, expect, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { resolveScreenshotOutputPath } from '../../../server/agent-api/screenshot-path'

describe('resolveScreenshotOutputPath', () => {
  const cleanup = new Set<string>()

  afterEach(async () => {
    await Promise.all([...cleanup].map((p) => fs.rm(p, { recursive: true, force: true })))
    cleanup.clear()
  })

  it('defaults to os tmpdir and appends .png', async () => {
    const out = await resolveScreenshotOutputPath({ name: 'split-check' })
    expect(out).toBe(path.join(os.tmpdir(), 'split-check.png'))
  })

  it('treats existing directory path as directory target', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-shot-'))
    cleanup.add(dir)
    const out = await resolveScreenshotOutputPath({ name: 'pane-a', pathInput: dir })
    expect(out).toBe(path.join(dir, 'pane-a.png'))
  })

  it('treats file-looking path as full output path', async () => {
    const out = await resolveScreenshotOutputPath({
      name: 'ignored-name',
      pathInput: path.join(os.tmpdir(), 'custom.png'),
    })
    expect(out).toBe(path.join(os.tmpdir(), 'custom.png'))
  })

  it('creates missing directory when pathInput is directory intent', async () => {
    const dir = path.join(os.tmpdir(), 'freshell-new-dir', `${Date.now()}`)
    cleanup.add(dir)
    const out = await resolveScreenshotOutputPath({ name: 'view', pathInput: `${dir}/` })
    expect(out).toBe(path.join(dir, 'view.png'))
  })

  it('rejects names containing path separators (defense in depth)', async () => {
    await expect(
      resolveScreenshotOutputPath({ name: '../escape', pathInput: os.tmpdir() }),
    ).rejects.toThrow(/path separators/i)
  })

  it('rejects names containing null bytes', async () => {
    await expect(
      resolveScreenshotOutputPath({ name: 'bad\0name', pathInput: os.tmpdir() }),
    ).rejects.toThrow(/name must not contain null bytes/i)
  })

  it('rejects empty path values', async () => {
    await expect(
      resolveScreenshotOutputPath({ name: 'pane-a', pathInput: '   ' }),
    ).rejects.toThrow(/path must not be empty/i)
  })

  it('rejects path values containing null bytes', async () => {
    await expect(
      resolveScreenshotOutputPath({ name: 'pane-a', pathInput: 'bad\0path' }),
    ).rejects.toThrow(/null bytes/i)
  })
})
