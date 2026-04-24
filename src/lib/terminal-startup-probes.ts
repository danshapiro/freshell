const ESC = '\u001b'
const BEL = '\u0007'
const C1_ST = '\u009c'
const STARTUP_PROBE_OSC11_QUERY = `${ESC}]11;?${BEL}`
const CSI_CURSOR_POSITION_QUERY = `${ESC}[6n`
const CSI_PRIMARY_DEVICE_ATTRIBUTES_QUERY = `${ESC}[c`
const CSI_CURSOR_POSITION_REPLY = `${ESC}[1;1R`
const CSI_PRIMARY_DEVICE_ATTRIBUTES_REPLY = `${ESC}[?1;2c`
const OSC_FOREGROUND_QUERY = `${ESC}]10;?${ESC}\\`
const OSC_TITLE_PREFIXES = ['0;', '1;', '2;'] as const

type CodexStartupProbeStep = {
  sequence: string
  passthrough?: true
  buildReply?: (colors: TerminalStartupProbeColors) => string | null
}

const CODEX_STARTUP_PROBE_STEPS: readonly CodexStartupProbeStep[] = [
  { sequence: `${ESC}[?2004h`, passthrough: true },
  { sequence: `${ESC}[>7u`, passthrough: true },
  { sequence: `${ESC}[?1004h`, passthrough: true },
  { sequence: CSI_CURSOR_POSITION_QUERY, buildReply: () => CSI_CURSOR_POSITION_REPLY },
  { sequence: `${ESC}[?u`, passthrough: true },
  { sequence: CSI_PRIMARY_DEVICE_ATTRIBUTES_QUERY, buildReply: () => CSI_PRIMARY_DEVICE_ATTRIBUTES_REPLY },
  { sequence: OSC_FOREGROUND_QUERY, buildReply: (colors) => buildOsc10ForegroundReply(colors.foreground) },
] as const

export type TerminalStartupProbeState = {
  pending: string
  armed: boolean
  codexStep: number
}

export type TerminalStartupProbeColors = {
  foreground?: string
  background?: string
  cursor?: string
}

export type TerminalStartupProbeResult = {
  cleaned: string
  replies: string[]
}

export type TerminalStartupProbeReplayBoundary = {
  remainder: string | null
  resumeState: TerminalStartupProbeState | null
}

type StringSequenceTerminator = {
  start: number
  end: number
  terminator: string
}

type CsiSequenceTerminator = {
  end: number
}

export function createTerminalStartupProbeState(): TerminalStartupProbeState {
  return { pending: '', armed: true, codexStep: 0 }
}

function findStringSequenceTerminator(data: string, from: number): StringSequenceTerminator | null {
  for (let i = from; i < data.length; i += 1) {
    const ch = data[i]
    if (ch === BEL || ch === C1_ST) {
      return { start: i, end: i + 1, terminator: ch }
    }
    if (ch === ESC) {
      if (i + 1 >= data.length) return null
      if (data[i + 1] === '\\') {
        return { start: i, end: i + 2, terminator: `${ESC}\\` }
      }
    }
  }

  return null
}

function findCsiSequenceTerminator(data: string, from: number): CsiSequenceTerminator | null {
  for (let i = from; i < data.length; i += 1) {
    const code = data.charCodeAt(i)
    if (code >= 0x40 && code <= 0x7e) {
      return { end: i + 1 }
    }
  }

  return null
}

function normalizeHexColor(color: string): [number, number, number] | null {
  if (!color.startsWith('#')) return null
  const hex = color.slice(1)

  if (hex.length === 3) {
    const [r, g, b] = hex.split('')
    if (!r || !g || !b) return null
    return [
      parseInt(`${r}${r}`, 16),
      parseInt(`${g}${g}`, 16),
      parseInt(`${b}${b}`, 16),
    ]
  }

  if (hex.length !== 6) return null

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

function pad16Bit(value: number): string {
  const hex = value.toString(16).padStart(2, '0')
  return `${hex}${hex}`
}

function buildOsc11BackgroundReply(color: string | undefined): string | null {
  if (!color) return null
  const rgb = normalizeHexColor(color)
  if (!rgb) return null

  const [r, g, b] = rgb
  return `${ESC}]11;rgb:${pad16Bit(r)}/${pad16Bit(g)}/${pad16Bit(b)}${ESC}\\`
}

function buildOsc10ForegroundReply(color: string | undefined): string | null {
  if (!color) return null
  const rgb = normalizeHexColor(color)
  if (!rgb) return null

  const [r, g, b] = rgb
  return `${ESC}]10;rgb:${pad16Bit(r)}/${pad16Bit(g)}/${pad16Bit(b)}${ESC}\\`
}

function matchesCodexTransparentSequence(content: string): boolean {
  return OSC_TITLE_PREFIXES.some((prefix) => content.startsWith(prefix))
}

function maybeConsumeCodexStartupStep(
  sequence: string,
  state: TerminalStartupProbeState,
  colors: TerminalStartupProbeColors,
): TerminalStartupProbeResult | null {
  const step = CODEX_STARTUP_PROBE_STEPS[state.codexStep]
  if (!step || sequence !== step.sequence) {
    return null
  }

  state.codexStep += 1
  const reply = step.buildReply?.(colors)
  const replies = reply ? [reply] : []
  const cleaned = step.passthrough ? sequence : reply ? '' : sequence
  if (state.codexStep >= CODEX_STARTUP_PROBE_STEPS.length) {
    state.armed = false
  }

  return { cleaned, replies }
}

export function getTerminalStartupProbeReplayRemainder(state: TerminalStartupProbeState): string | null {
  return getTerminalStartupProbeReplayBoundary(state).remainder
}

export function getTerminalStartupProbeReplayBoundary(
  state: TerminalStartupProbeState,
): TerminalStartupProbeReplayBoundary {
  if (!state.pending) {
    return {
      remainder: null,
      resumeState: state.armed && state.codexStep > 0
        ? { pending: '', armed: true, codexStep: state.codexStep }
        : null,
    }
  }

  if (state.codexStep === 0) {
    if (state.pending === STARTUP_PROBE_OSC11_QUERY) {
      return { remainder: null, resumeState: null }
    }
    if (STARTUP_PROBE_OSC11_QUERY.startsWith(state.pending)) {
      return {
        remainder: STARTUP_PROBE_OSC11_QUERY.slice(state.pending.length),
        resumeState: { pending: '', armed: false, codexStep: 0 },
      }
    }
  }

  const step = CODEX_STARTUP_PROBE_STEPS[state.codexStep]
  if (!step) {
    return { remainder: null, resumeState: null }
  }

  if (!step.sequence.startsWith(state.pending)) {
    return { remainder: null, resumeState: null }
  }

  const nextCodexStep = state.codexStep + 1
  return {
    remainder: step.sequence.slice(state.pending.length),
    resumeState: {
      pending: '',
      armed: nextCodexStep < CODEX_STARTUP_PROBE_STEPS.length,
      codexStep: nextCodexStep,
    },
  }
}

export function extractTerminalStartupProbes(
  chunk: string,
  state: TerminalStartupProbeState,
  colors: TerminalStartupProbeColors,
): TerminalStartupProbeResult {
  const parserState = state ?? createTerminalStartupProbeState()
  const input = `${parserState.pending}${chunk}`
  const replies: string[] = []
  let cleaned = ''
  let i = 0
  let armed = parserState.armed
  parserState.pending = ''

  while (i < input.length) {
    const ch = input[i]
    if (ch !== ESC) {
      if (armed) {
        armed = false
        parserState.codexStep = 0
      }
      cleaned += ch
      i += 1
      continue
    }

    if (i + 1 >= input.length) {
      parserState.pending = input.slice(i)
      break
    }

    const introducer = input[i + 1]
    if (introducer === '[') {
      const terminator = findCsiSequenceTerminator(input, i + 2)
      if (!terminator) {
        parserState.pending = input.slice(i)
        break
      }

      const sequence = input.slice(i, terminator.end)
      const codexStartup = armed
        ? maybeConsumeCodexStartupStep(sequence, parserState, colors)
        : null
      if (codexStartup) {
        cleaned += codexStartup.cleaned
        replies.push(...codexStartup.replies)
      } else {
        if (armed) {
          armed = false
          parserState.codexStep = 0
        }
        cleaned += sequence
      }

      i = terminator.end
      continue
    }

    if (introducer !== ']' && introducer !== 'P' && introducer !== '_') {
      if (armed) {
        armed = false
        parserState.codexStep = 0
      }
      cleaned += ch
      i += 1
      continue
    }

    const terminator = findStringSequenceTerminator(input, i + 2)
    if (!terminator) {
      parserState.pending = input.slice(i)
      break
    }

    const sequence = input.slice(i, terminator.end)
    const content = input.slice(i + 2, terminator.start)

    const codexStartup = armed
      ? maybeConsumeCodexStartupStep(sequence, parserState, colors)
      : null
    if (codexStartup) {
      cleaned += codexStartup.cleaned
      replies.push(...codexStartup.replies)
    } else if (armed && parserState.codexStep > 0 && introducer === ']' && matchesCodexTransparentSequence(content)) {
      cleaned += sequence
    } else if (armed && parserState.codexStep === 0 && introducer === ']' && content === '11;?' && terminator.terminator === BEL) {
      const reply = buildOsc11BackgroundReply(colors.background)
      if (reply) replies.push(reply)
      else cleaned += sequence
    } else {
      if (armed) {
        armed = false
        parserState.codexStep = 0
      }
      cleaned += sequence
    }

    i = terminator.end
  }

  parserState.armed = armed

  return { cleaned, replies }
}
