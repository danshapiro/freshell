import { stripAnsi } from '../ai-prompts.js'

export function renderCapture(
  snapshot: string,
  { includeAnsi, joinLines, start }: { includeAnsi?: boolean; joinLines?: boolean; start?: number },
) {
  const text = includeAnsi ? snapshot : stripAnsi(snapshot)
  let lines = text.split(/\r?\n/)
  if (typeof start === 'number' && !Number.isNaN(start)) {
    const idx = start < 0 ? Math.max(0, lines.length + start) : start
    lines = lines.slice(idx)
  }
  return joinLines ? lines.join('') : lines.join('\n')
}
