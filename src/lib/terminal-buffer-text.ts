import type { IBuffer } from '@xterm/xterm'

/** Text of the active emulator surface, with its actual logical line breaks. */
export function terminalBufferText(buffer: IBuffer): string {
  let text = ''
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    if (y > 0 && !line.isWrapped) text += '\n'
    // Padding at a soft wrap is part of the logical line (including spaces).
    const continues = buffer.getLine(y + 1)?.isWrapped === true
    text += line.translateToString(!continues)
  }
  return text
}
