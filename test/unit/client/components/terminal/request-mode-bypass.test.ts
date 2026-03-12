import { describe, expect, it, vi } from 'vitest'

import {
  buildTerminalRequestModeResponse,
  registerTerminalRequestModeBypass,
  snapshotTerminalRequestModes,
  type TerminalRequestModeSnapshot,
} from '@/components/terminal/request-mode-bypass'

function makeSnapshot(overrides: Partial<TerminalRequestModeSnapshot> = {}): TerminalRequestModeSnapshot {
  return {
    insertMode: false,
    convertEol: true,
    applicationCursorKeysMode: false,
    originMode: false,
    wraparoundMode: true,
    cursorBlink: true,
    cursorVisible: true,
    reverseWraparoundMode: false,
    applicationKeypadMode: false,
    mouseTrackingMode: 'none',
    mouseEncoding: 'default',
    altBufferActive: false,
    bracketedPasteMode: true,
    synchronizedOutputMode: false,
    sendFocusMode: true,
    ...overrides,
  }
}

describe('request-mode-bypass', () => {
  it('builds ANSI request mode replies', () => {
    const snapshot = makeSnapshot({ insertMode: true, convertEol: false })

    expect(buildTerminalRequestModeResponse(4, true, snapshot)).toBe('\u001b[4;1$y')
    expect(buildTerminalRequestModeResponse(20, true, snapshot)).toBe('\u001b[20;2$y')
    expect(buildTerminalRequestModeResponse(2, true, snapshot)).toBe('\u001b[2;4$y')
    expect(buildTerminalRequestModeResponse(99, true, snapshot)).toBe('\u001b[99;0$y')
  })

  it('builds DEC private request mode replies for OpenCode startup queries', () => {
    const snapshot = makeSnapshot({
      mouseEncoding: 'sgrPixels',
      bracketedPasteMode: true,
      synchronizedOutputMode: false,
      sendFocusMode: false,
    })

    expect(buildTerminalRequestModeResponse(1016, false, snapshot)).toBe('\u001b[?1016;1$y')
    expect(buildTerminalRequestModeResponse(1004, false, snapshot)).toBe('\u001b[?1004;2$y')
    expect(buildTerminalRequestModeResponse(2004, false, snapshot)).toBe('\u001b[?2004;1$y')
    expect(buildTerminalRequestModeResponse(2026, false, snapshot)).toBe('\u001b[?2026;2$y')
    expect(buildTerminalRequestModeResponse(2027, false, snapshot)).toBe('\u001b[?2027;0$y')
  })

  it('snapshots terminal state from public modes and xterm private runtime state', () => {
    const term = {
      parser: {
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      },
      modes: {
        insertMode: true,
        applicationCursorKeysMode: true,
        originMode: false,
        wraparoundMode: true,
        applicationKeypadMode: false,
        mouseTrackingMode: 'drag',
        bracketedPasteMode: false,
        synchronizedOutputMode: true,
        reverseWraparoundMode: true,
        sendFocusMode: true,
      },
      options: {
        convertEol: false,
        cursorBlink: false,
      },
      buffer: {
        active: { type: 'alternate' as const },
      },
      _core: {
        coreMouseService: {
          activeEncoding: 'SGR_PIXELS',
        },
        coreService: {
          isCursorHidden: true,
        },
      },
    }

    expect(snapshotTerminalRequestModes(term as any)).toEqual(makeSnapshot({
      insertMode: true,
      convertEol: false,
      applicationCursorKeysMode: true,
      reverseWraparoundMode: true,
      mouseTrackingMode: 'drag',
      mouseEncoding: 'sgrPixels',
      altBufferActive: true,
      bracketedPasteMode: false,
      synchronizedOutputMode: true,
      cursorBlink: false,
      cursorVisible: false,
    }))
  })

  it('falls back to safe defaults for sparse terminal mocks', () => {
    expect(snapshotTerminalRequestModes(undefined as any)).toEqual(makeSnapshot({
      convertEol: false,
      wraparoundMode: false,
      cursorBlink: false,
      bracketedPasteMode: false,
      sendFocusMode: false,
    }))
  })

  it('registers CSI handlers that bypass the broken bundled requestMode path', () => {
    const disposers = [{ dispose: vi.fn() }, { dispose: vi.fn() }]
    const registerCsiHandler = vi
      .fn()
      .mockReturnValueOnce(disposers[0])
      .mockReturnValueOnce(disposers[1])
    const sendInput = vi.fn()
    const term = {
      parser: { registerCsiHandler },
      modes: {
        insertMode: false,
        applicationCursorKeysMode: false,
        originMode: false,
        wraparoundMode: true,
        applicationKeypadMode: false,
        mouseTrackingMode: 'none',
        bracketedPasteMode: true,
        synchronizedOutputMode: false,
        reverseWraparoundMode: false,
        sendFocusMode: true,
      },
      options: {
        convertEol: true,
        cursorBlink: true,
      },
      buffer: {
        active: { type: 'normal' as const },
      },
      _core: {
        coreMouseService: {
          activeEncoding: 'DEFAULT',
        },
        coreService: {
          isCursorHidden: false,
        },
      },
    }

    const registration = registerTerminalRequestModeBypass(term as any, sendInput)

    expect(registerCsiHandler).toHaveBeenCalledTimes(2)
    const ansiHandler = registerCsiHandler.mock.calls[0]?.[1]
    const privateHandler = registerCsiHandler.mock.calls[1]?.[1]

    expect(ansiHandler([4])).toBe(true)
    expect(privateHandler([2004])).toBe(true)
    expect(sendInput).toHaveBeenNthCalledWith(1, '\u001b[4;2$y')
    expect(sendInput).toHaveBeenNthCalledWith(2, '\u001b[?2004;1$y')

    registration.dispose()
    expect(disposers[0].dispose).toHaveBeenCalledTimes(1)
    expect(disposers[1].dispose).toHaveBeenCalledTimes(1)
  })

  it('becomes a no-op when parser registration is unavailable', () => {
    const sendInput = vi.fn()
    const term = {
      modes: {
        insertMode: false,
        applicationCursorKeysMode: false,
        originMode: false,
        wraparoundMode: true,
        applicationKeypadMode: false,
        mouseTrackingMode: 'none',
        bracketedPasteMode: true,
        synchronizedOutputMode: false,
        reverseWraparoundMode: false,
        sendFocusMode: true,
      },
      options: {
        convertEol: true,
        cursorBlink: true,
      },
      buffer: {
        active: { type: 'normal' as const },
      },
    }

    const registration = registerTerminalRequestModeBypass(term as any, sendInput)

    registration.dispose()
    expect(sendInput).not.toHaveBeenCalled()
  })
})
