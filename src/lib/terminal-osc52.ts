const ESC = '\u001b'
const BEL = '\u0007'
const C1_ST = '\u009c'

export type Osc52Policy = 'ask' | 'always' | 'never'

export type Osc52Event = {
  target: string
  text: string
}

export type Osc52ParserState = {
  pending: string
}

export function createOsc52ParserState(): Osc52ParserState {
  return { pending: '' }
}

function findOscTerminator(data: string, from: number): { start: number; end: number } | null {
  for (let i = from; i < data.length; i += 1) {
    const ch = data[i]
    if (ch === BEL || ch === C1_ST) {
      return { start: i, end: i + 1 }
    }
    if (ch === ESC) {
      if (i + 1 >= data.length) return null
      if (data[i + 1] === '\\') {
        return { start: i, end: i + 2 }
      }
    }
  }
  return null
}

function decodeBase64Text(payload: string): string | null {
  const normalized = payload.replace(/\s+/g, '')
  if (!normalized) return ''

  try {
    if (typeof atob === 'function') {
      const binary = atob(normalized)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(normalized, 'base64').toString('utf8')
    }
  } catch {
    return null
  }

  return null
}

function parseOsc52(content: string): Osc52Event | null {
  if (!content.startsWith('52;')) return null
  const body = content.slice(3)
  const splitAt = body.indexOf(';')
  if (splitAt < 0) return null

  const target = body.slice(0, splitAt)
  const payload = body.slice(splitAt + 1)
  const text = decodeBase64Text(payload)
  if (text == null) return null

  return { target, text }
}

export function extractOsc52Events(
  data: string,
  state: Osc52ParserState,
): { cleaned: string; events: Osc52Event[] } {
  const parserState = state ?? createOsc52ParserState()
  const input = `${parserState.pending}${data}`
  let cleaned = ''
  const events: Osc52Event[] = []
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

    if (input[i + 1] !== ']') {
      cleaned += ch
      i += 1
      continue
    }

    const term = findOscTerminator(input, i + 2)
    if (!term) {
      parserState.pending = input.slice(i)
      break
    }

    const oscContent = input.slice(i + 2, term.start)
    if (oscContent.startsWith('52;')) {
      const osc52 = parseOsc52(oscContent)
      if (osc52) {
        events.push(osc52)
      }
    } else {
      cleaned += input.slice(i, term.end)
    }

    i = term.end
  }

  return { cleaned, events }
}
