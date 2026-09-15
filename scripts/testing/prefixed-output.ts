import { StringDecoder } from 'node:string_decoder'

export type LinePrefixer = {
  push: (chunk: Buffer | string) => void
  /** Emit any trailing partial line; call once the stream has ended. */
  flush: () => void
}

/**
 * Prefix every line of a child that runs concurrently with phases writing
 * straight to the terminal. Each chunk's complete lines go out in a single
 * write, so a prefixed line is never split around another phase's output.
 */
export function createLinePrefixer(prefix: string, write: (text: string) => void): LinePrefixer {
  const decoder = new StringDecoder('utf8')
  let pending = ''

  const emit = (lines: string[]): void => {
    if (lines.length === 0) return
    write(lines.map((line) => `${prefix}${line.replace(/\r$/, '')}\n`).join(''))
  }

  return {
    push: (chunk) => {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      emit(lines)
    },
    flush: () => {
      pending += decoder.end()
      if (pending) emit([pending])
      pending = ''
    },
  }
}
