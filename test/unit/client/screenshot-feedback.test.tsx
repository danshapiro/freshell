import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import html2canvas from 'html2canvas'
import { ScreenshotProgressToast } from '@/components/ScreenshotProgressToast'
import { captureUiScreenshot } from '@/lib/ui-screenshot'
import { createClientLogger, getClientLogLevel, setClientLogLevel } from '@/lib/client-logger'
import { suspendTerminalRenderersForScreenshot } from '@/lib/screenshot-capture-env'

vi.mock('html2canvas', () => ({ default: vi.fn() }))
vi.mock('@/lib/screenshot-capture-env', () => ({
  suspendTerminalRenderersForScreenshot: vi.fn(async () => async () => {}),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function canvas() {
  return { width: 320, height: 180, toDataURL: () => 'data:image/png;base64,PRIVATE_IMAGE_BYTES' } as HTMLCanvasElement
}

describe('screenshot feedback', () => {
  const oldLevel = getClientLogLevel()
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div data-context="global"><input aria-label="Active editor" /></div>'
    vi.mocked(html2canvas).mockResolvedValue(canvas())
    vi.mocked(suspendTerminalRenderersForScreenshot).mockResolvedValue(async () => {})
  })
  afterEach(() => {
    cleanup()
    setClientLogLevel(oldLevel)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps passive progress visible through rendering and renderer restoration, then removes it', async () => {
    render(<ScreenshotProgressToast />)
    const drawing = deferred<HTMLCanvasElement>(), restoring = deferred<void>()
    vi.mocked(html2canvas).mockReturnValue(drawing.promise)
    vi.mocked(suspendTerminalRenderersForScreenshot).mockResolvedValue(() => restoring.promise)
    const editor = screen.getByRole('textbox')
    editor.focus()
    let pending!: ReturnType<typeof captureUiScreenshot>
    act(() => { pending = captureUiScreenshot({ scope: 'view' }) })
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.getByRole('status')).toHaveAttribute('data-html2canvas-ignore')
    expect(document.activeElement).toBe(editor)
    await waitFor(() => expect(html2canvas).toHaveBeenCalledTimes(1))
    await act(async () => { drawing.resolve(canvas()); await Promise.resolve() })
    expect(screen.getByRole('status')).toBeVisible()
    await act(async () => { restoring.resolve(); await pending })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(editor)
  })

  it('keeps progress for another in-flight capture when the first one fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ScreenshotProgressToast />)
    const first = deferred<HTMLCanvasElement>(), second = deferred<HTMLCanvasElement>()
    vi.mocked(html2canvas).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    let a!: ReturnType<typeof captureUiScreenshot>, b!: ReturnType<typeof captureUiScreenshot>
    act(() => { a = captureUiScreenshot({ scope: 'view' }); b = captureUiScreenshot({ scope: 'view' }) })
    expect(screen.getByRole('status')).toBeVisible()
    await waitFor(() => expect(html2canvas).toHaveBeenCalledTimes(2))
    await act(async () => { first.reject(new Error('render broke')); expect((await a).ok).toBe(false) })
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ stage: 'render', error: 'render broke' }))
    expect(screen.getByRole('status')).toBeVisible()
    await act(async () => { second.resolve(canvas()); expect((await b).ok).toBe(true) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('removes progress when target resolution or renderer restoration fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ScreenshotProgressToast />)
    await act(async () => { expect((await captureUiScreenshot({ scope: 'pane' })).ok).toBe(false) })
    expect(error).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'target' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    vi.mocked(suspendTerminalRenderersForScreenshot).mockResolvedValue(async () => { throw new Error('restore broke') })
    await act(async () => { expect((await captureUiScreenshot({ scope: 'view' })).ok).toBe(false) })
    expect(error).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'restore', error: 'restore broke' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('allows a paint before cloning and has a bounded fallback when animation frames stop', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    render(<ScreenshotProgressToast />)
    let pending!: ReturnType<typeof captureUiScreenshot>
    act(() => { pending = captureUiScreenshot({ scope: 'view' }) })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('status')).toBeVisible()
    expect(html2canvas).not.toHaveBeenCalled()
    await act(async () => { frames.shift()!(10); await Promise.resolve() })
    expect(html2canvas).not.toHaveBeenCalled()
    await act(async () => { frames.shift()!(20); await pending })
    expect(html2canvas).toHaveBeenCalledTimes(1)
    let fallback!: ReturnType<typeof captureUiScreenshot>
    act(() => { fallback = captureUiScreenshot({ scope: 'view' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(250); expect((await fallback).ok).toBe(true) })
    expect(html2canvas).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ships correlated success and failure diagnostics with debug off without image bytes', async () => {
    setClientLogLevel('warn')
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createClientLogger({ enableNetwork: true, flushIntervalMs: 60_000, maxBatchSize: 100 })
    const uninstall = logger.installConsoleCapture()
    try {
      expect((await captureUiScreenshot({ scope: 'view' }, 'broker-success')).ok).toBe(true)
      vi.mocked(html2canvas).mockRejectedValueOnce(new Error('render broke'))
      expect((await captureUiScreenshot({ scope: 'view' }, 'broker-failure')).ok).toBe(false)
      await logger.flush()
    } finally { uninstall() }
    expect(fetch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string)
    const records = payload.entries.map((entry: any) => ({ severity: entry.severity, ...entry.args[0] }))
    const success = records.filter((entry: any) => entry.requestId === 'broker-success')
    const failure = records.filter((entry: any) => entry.requestId === 'broker-failure')
    expect(success).toHaveLength(2)
    expect(failure).toHaveLength(2)
    expect(success[1]).toMatchObject({ severity: 'info', event: 'screenshot.capture.completed', scope: 'view', width: 320, height: 180, durationMs: expect.any(Number), timings: expect.any(Object) })
    expect(failure[1]).toMatchObject({ severity: 'error', event: 'screenshot.capture.failed', stage: 'render', error: 'render broke', durationMs: expect.any(Number) })
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_IMAGE_BYTES')
  })

  it('reports iframe placeholders and correlation drift without logging iframe URLs', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const frame = document.createElement('iframe')
    frame.src = 'https://private.invalid/?token=DO_NOT_LOG'
    frame.getBoundingClientRect = () => ({ width: 100, height: 100 }) as DOMRect
    document.querySelector('[data-context="global"]')!.appendChild(frame)
    vi.mocked(html2canvas).mockImplementation(async (_target, options) => {
      const copy = document.implementation.createHTMLDocument('clone')
      const target = copy.createElement('div')
      copy.body.appendChild(target)
      // The live iframe disappeared between pre-render and clone.
      await options!.onclone!(copy, target)
      return canvas()
    })
    expect((await captureUiScreenshot({ scope: 'view' }, 'iframe-request')).ok).toBe(true)
    expect(info).toHaveBeenLastCalledWith(expect.objectContaining({
      iframes: { count: 1, placeholders: 1, skipped: 0, correlationMismatch: true },
    }))
    expect(JSON.stringify(info.mock.calls)).not.toContain('DO_NOT_LOG')
    expect(JSON.stringify(info.mock.calls)).not.toContain('private.invalid')
  })
})
