const ESC = '\u001b'
const BEL = '\u0007'
const C1_ST = '\u009c'

export type TerminalStartupProbeState = {
  pending: string
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

type StringSequenceTerminator = {
  start: number
  end: number
  terminator: string
}

export function createTerminalStartupProbeState(): TerminalStartupProbeState {
  return { pending: '' }
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
  parserState.pending = ''

  while (i < input.length) {
    const ch = input[i]
    if (ch !== ESC) {
      cleaned += ch
      i += 1
      continue
    }

    if (i + 1 >= input.length) {
      parserState.pending = input.slice(i)
      break
    }

    const introducer = input[i + 1]
    if (introducer !== ']' && introducer !== 'P' && introducer !== '_') {
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

    if (introducer === ']' && content === '11;?' && terminator.terminator === BEL) {
      const reply = buildOsc11BackgroundReply(colors.background)
      if (reply) {
        replies.push(reply)
      } else {
        cleaned += sequence
      }
    } else {
      cleaned += sequence
    }

    i = terminator.end
  }

  return { cleaned, replies }
}
