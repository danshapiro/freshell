import type { Terminal } from '@xterm/xterm'

type RequestModeStatus = 0 | 1 | 2 | 3 | 4

export type MouseEncodingMode = 'default' | 'sgr' | 'sgrPixels'

export type TerminalRequestModeSnapshot = {
  insertMode: boolean
  convertEol: boolean
  applicationCursorKeysMode: boolean
  originMode: boolean
  wraparoundMode: boolean
  cursorBlink: boolean
  cursorVisible: boolean
  reverseWraparoundMode: boolean
  applicationKeypadMode: boolean
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  mouseEncoding: MouseEncodingMode
  altBufferActive: boolean
  bracketedPasteMode: boolean
  synchronizedOutputMode: boolean
  sendFocusMode: boolean
}

const DEFAULT_REQUEST_MODE_SNAPSHOT: TerminalRequestModeSnapshot = {
  insertMode: false,
  convertEol: false,
  applicationCursorKeysMode: false,
  originMode: false,
  wraparoundMode: false,
  cursorBlink: false,
  cursorVisible: true,
  reverseWraparoundMode: false,
  applicationKeypadMode: false,
  mouseTrackingMode: 'none',
  mouseEncoding: 'default',
  altBufferActive: false,
  bracketedPasteMode: false,
  synchronizedOutputMode: false,
  sendFocusMode: false,
}

type CsiHandlerRegistration = {
  dispose: () => void
}

type ParserRegistrationTarget = {
  registerCsiHandler?: (
    identifier: { prefix?: string, intermediates?: string, final: string },
    callback: (params: XtermCsiParams) => boolean,
  ) => CsiHandlerRegistration
}

type TerminalWithRequestModeAccess = Pick<Terminal, 'modes' | 'options' | 'buffer'> & {
  parser?: ParserRegistrationTarget
}

type TerminalModeState = Partial<Terminal['modes']>
type TerminalOptionState = Partial<Terminal['options']>

type XtermPrivateState = {
  _core?: {
    coreMouseService?: {
      activeEncoding?: string
    }
    coreService?: {
      isCursorHidden?: boolean
    }
  }
}

type XtermCsiParams = readonly (number | number[])[]

function reply(mode: number, status: RequestModeStatus, ansi: boolean): string {
  return `\u001b[${ansi ? '' : '?'}${mode};${status}$y`
}

function asBool(value: unknown): boolean {
  return value === true
}

function safeRead<T>(getter: () => T): T | undefined {
  try {
    return getter()
  } catch {
    return undefined
  }
}

function normalizeMouseTrackingMode(value: string | undefined): TerminalRequestModeSnapshot['mouseTrackingMode'] {
  switch ((value || '').toLowerCase()) {
    case 'x10':
      return 'x10'
    case 'vt200':
      return 'vt200'
    case 'drag':
      return 'drag'
    case 'any':
      return 'any'
    default:
      return 'none'
  }
}

function normalizeMouseEncoding(value: string | undefined): MouseEncodingMode {
  switch ((value || '').toUpperCase()) {
    case 'SGR':
      return 'sgr'
    case 'SGR_PIXELS':
      return 'sgrPixels'
    default:
      return 'default'
  }
}

export function snapshotTerminalRequestModes(term?: Partial<TerminalWithRequestModeAccess>): TerminalRequestModeSnapshot {
  const safeTerm = term ?? {}
  const publicModes: TerminalModeState = safeRead(() => safeTerm.modes) ?? {}
  const options: TerminalOptionState = safeRead(() => safeTerm.options) ?? {}
  const core = safeRead(() => (safeTerm as Partial<TerminalWithRequestModeAccess> & XtermPrivateState)._core)
  const activeEncoding = core?.coreMouseService?.activeEncoding
  const cursorHidden = core?.coreService?.isCursorHidden
  const bufferType = safeRead(() => safeTerm.buffer?.active?.type)

  return {
    insertMode: asBool(publicModes.insertMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.insertMode,
    convertEol: asBool(options.convertEol) || DEFAULT_REQUEST_MODE_SNAPSHOT.convertEol,
    applicationCursorKeysMode: asBool(publicModes.applicationCursorKeysMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.applicationCursorKeysMode,
    originMode: asBool(publicModes.originMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.originMode,
    wraparoundMode: asBool(publicModes.wraparoundMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.wraparoundMode,
    cursorBlink: asBool(options.cursorBlink) || DEFAULT_REQUEST_MODE_SNAPSHOT.cursorBlink,
    cursorVisible: cursorHidden !== true,
    reverseWraparoundMode: asBool(publicModes.reverseWraparoundMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.reverseWraparoundMode,
    applicationKeypadMode: asBool(publicModes.applicationKeypadMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.applicationKeypadMode,
    mouseTrackingMode: normalizeMouseTrackingMode(publicModes.mouseTrackingMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.mouseTrackingMode,
    mouseEncoding: normalizeMouseEncoding(activeEncoding),
    altBufferActive: bufferType === 'alternate',
    bracketedPasteMode: asBool(publicModes.bracketedPasteMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.bracketedPasteMode,
    synchronizedOutputMode: asBool(publicModes.synchronizedOutputMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.synchronizedOutputMode,
    sendFocusMode: asBool(publicModes.sendFocusMode) || DEFAULT_REQUEST_MODE_SNAPSHOT.sendFocusMode,
  }
}

export function buildTerminalRequestModeResponse(
  mode: number,
  ansi: boolean,
  snapshot: TerminalRequestModeSnapshot,
): string {
  const boolStatus = (value: boolean): RequestModeStatus => (value ? 1 : 2)

  if (ansi) {
    switch (mode) {
      case 2:
        return reply(mode, 4, true)
      case 4:
        return reply(mode, boolStatus(snapshot.insertMode), true)
      case 12:
        return reply(mode, 3, true)
      case 20:
        return reply(mode, boolStatus(snapshot.convertEol), true)
      default:
        return reply(mode, 0, true)
    }
  }

  switch (mode) {
    case 1:
      return reply(mode, boolStatus(snapshot.applicationCursorKeysMode), false)
    case 3:
      return reply(mode, 0, false)
    case 6:
      return reply(mode, boolStatus(snapshot.originMode), false)
    case 7:
      return reply(mode, boolStatus(snapshot.wraparoundMode), false)
    case 8:
      return reply(mode, 3, false)
    case 9:
      return reply(mode, boolStatus(snapshot.mouseTrackingMode === 'x10'), false)
    case 12:
      return reply(mode, boolStatus(snapshot.cursorBlink), false)
    case 25:
      return reply(mode, boolStatus(snapshot.cursorVisible), false)
    case 45:
      return reply(mode, boolStatus(snapshot.reverseWraparoundMode), false)
    case 66:
      return reply(mode, boolStatus(snapshot.applicationKeypadMode), false)
    case 67:
      return reply(mode, 4, false)
    case 1000:
      return reply(mode, boolStatus(snapshot.mouseTrackingMode === 'vt200'), false)
    case 1002:
      return reply(mode, boolStatus(snapshot.mouseTrackingMode === 'drag'), false)
    case 1003:
      return reply(mode, boolStatus(snapshot.mouseTrackingMode === 'any'), false)
    case 1004:
      return reply(mode, boolStatus(snapshot.sendFocusMode), false)
    case 1005:
      return reply(mode, 4, false)
    case 1006:
      return reply(mode, boolStatus(snapshot.mouseEncoding === 'sgr'), false)
    case 1015:
      return reply(mode, 4, false)
    case 1016:
      return reply(mode, boolStatus(snapshot.mouseEncoding === 'sgrPixels'), false)
    case 1048:
      return reply(mode, 1, false)
    case 47:
    case 1047:
    case 1049:
      return reply(mode, boolStatus(snapshot.altBufferActive), false)
    case 2004:
      return reply(mode, boolStatus(snapshot.bracketedPasteMode), false)
    case 2026:
      return reply(mode, boolStatus(snapshot.synchronizedOutputMode), false)
    default:
      return reply(mode, 0, false)
  }
}

export function registerTerminalRequestModeBypass(
  term: TerminalWithRequestModeAccess | undefined,
  sendInput: (data: string) => void,
): CsiHandlerRegistration {
  if (!term) {
    return {
      dispose: () => {},
    }
  }

  const parser = safeRead(() => term.parser)
  if (!parser || typeof parser.registerCsiHandler !== 'function') {
    return {
      dispose: () => {},
    }
  }

  const handle = (ansi: boolean) => (params: XtermCsiParams) => {
    const first = params[0]
    const mode = typeof first === 'number'
      ? first
      : Array.isArray(first) && typeof first[0] === 'number'
        ? first[0]
        : undefined
    if (mode === undefined) return false
    const response = buildTerminalRequestModeResponse(mode, ansi, snapshotTerminalRequestModes(term))
    sendInput(response)
    return true
  }

  const ansiHandler = parser.registerCsiHandler({ intermediates: '$', final: 'p' }, handle(true))
  const privateHandler = parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, handle(false))

  return {
    dispose: () => {
      ansiHandler.dispose()
      privateHandler.dispose()
    },
  }
}
