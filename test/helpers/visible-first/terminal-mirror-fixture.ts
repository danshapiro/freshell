import { ReplayRing, type ReplayFrame } from '../../../server/terminal-stream/replay-ring'

export type TerminalMirrorViewport = {
  lines: string[]
  tailSeq: number
  runtime: {
    cols: number
    rows: number
    title: string
    status: 'running'
  }
}

export type TerminalMirrorScrollbackItem = {
  line: number
  text: string
}

export type TerminalMirrorSearchMatch = {
  line: number
  column: number
  text: string
}

type TerminalMirrorFixtureOptions = {
  cols?: number
  rows?: number
  replayMaxBytes?: number
}

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu

function normalizeOutput(value: string): string {
  return value
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
}

export function createTerminalMirrorFixture(options: TerminalMirrorFixtureOptions = {}) {
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24
  const replayRing = new ReplayRing(options.replayMaxBytes)
  const lines = ['']

  const appendText = (value: string) => {
    const parts = value.split('\n')
    lines[lines.length - 1] += parts[0]
    for (let index = 1; index < parts.length; index += 1) {
      lines.push(parts[index])
    }
  }

  return {
    applyOutput(rawOutput: string): ReplayFrame {
      const normalized = normalizeOutput(rawOutput)
      const frame = replayRing.append(normalized)
      appendText(normalized)
      return frame
    },

    serializeViewport(viewport: { rows?: number } = {}): TerminalMirrorViewport {
      const height = viewport.rows ?? rows
      const start = Math.max(0, lines.length - height)
      return {
        lines: lines.slice(start, start + height),
        tailSeq: replayRing.headSeq(),
        runtime: {
          cols,
          rows,
          title: 'Shell',
          status: 'running',
        },
      }
    },

    getScrollbackPage(options: { cursor?: number; limit?: number } = {}): {
      items: TerminalMirrorScrollbackItem[]
      nextCursor: number | null
    } {
      const cursor = options.cursor ?? 0
      const limit = options.limit ?? rows
      const slice = lines.slice(cursor, cursor + limit)
      return {
        items: slice.map((text, index) => ({
          line: cursor + index,
          text,
        })),
        nextCursor: cursor + limit < lines.length ? cursor + limit : null,
      }
    },

    search(query: string, options: { cursor?: number; limit?: number } = {}): {
      matches: TerminalMirrorSearchMatch[]
      nextCursor: number | null
    } {
      const cursor = options.cursor ?? 0
      const limit = options.limit ?? 50
      const lowerQuery = query.toLowerCase()
      const matches: TerminalMirrorSearchMatch[] = []

      for (let lineIndex = cursor; lineIndex < lines.length; lineIndex += 1) {
        if (matches.length >= limit) break
        const line = lines[lineIndex]
        const column = line.toLowerCase().indexOf(lowerQuery)
        if (column === -1) continue
        matches.push({
          line: lineIndex,
          column,
          text: line,
        })
      }

      const lastLine = matches.at(-1)?.line
      return {
        matches,
        nextCursor: lastLine !== undefined && lastLine + 1 < lines.length ? lastLine + 1 : null,
      }
    },

    replaySince(sinceSeq?: number) {
      return replayRing.replaySince(sinceSeq)
    },
  }
}
