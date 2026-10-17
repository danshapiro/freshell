import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyRendererReady } from '../../../electron/renderer-readiness.js'

const url = 'http://localhost:4455/?token=secret'
const mounted = { href: 'http://localhost:4455/', documentUri: 'http://localhost:4455/', ready: true, mounted: true }
function fixture(snapshot: Record<string, unknown> = mounted) {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'http://localhost:4455/'),
      executeJavaScript: vi.fn().mockResolvedValue(snapshot),
    }),
  }
}

describe('native document readiness', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accepts mounted content after auth removes the token', async () => {
    await expect(verifyRendererReady(fixture(), url)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { ...mounted, href: 'http://other-host:4455/' },
    { ...mounted, href: 'http://localhost:4455/other' },
    { ...mounted, documentUri: 'chrome-error://chromewebdata/' },
    { ...mounted, mounted: false },
    { ...mounted, ready: false },
  ])('bounds unusable document %j', async snapshot => {
    const result = expect(verifyRendererReady(fixture(snapshot), url)).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks the native URL as well as evaluated document identity', async () => {
    const window = fixture()
    window.webContents.getURL.mockReturnValue('chrome-error://chromewebdata/')
    const result = expect(verifyRendererReady(window, url)).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  })

  it('waits for mount, but rejects a stale navigation owner', async () => {
    const window = fixture()
    window.webContents.executeJavaScript.mockResolvedValueOnce({ ...mounted, mounted: false })
    const result = verifyRendererReady(window, url)
    await vi.advanceTimersByTimeAsync(100)
    await result
    await expect(verifyRendererReady(window, url, { isCurrent: () => false })).rejects.toThrow('navigation changed')
  })

  it.each(['deadline', 'cancel'] as const)('retires a hung native evaluation on %s', async mode => {
    const window = fixture()
    let settle!: (value: typeof mounted) => void
    window.webContents.executeJavaScript.mockImplementation(() => new Promise(resolve => { settle = resolve }))
    const controller = new AbortController()
    const result = expect(verifyRendererReady(window, url, { signal: controller.signal })).rejects.toThrow(
      mode === 'deadline' ? 'renderer readiness timed out' : 'renderer recovery cancelled',
    )
    if (mode === 'deadline') await vi.advanceTimersByTimeAsync(10_000)
    else controller.abort()
    await result
    settle(mounted)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects destroyed native objects', async () => {
    const window = fixture()
    window.isDestroyed.mockReturnValue(true)
    await expect(verifyRendererReady(window, url)).rejects.toThrow('renderer window destroyed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
