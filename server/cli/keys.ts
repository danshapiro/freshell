const KEYMAP: Record<string, string> = {
  ENTER: '\r',
  'C-C': '\x03',
  'C-D': '\x04',
  ESCAPE: '\x1b',
  TAB: '\t',
  BSPACE: '\x7f',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
  SPACE: ' ',
}

function translateCtrlLetterChord(token: string): string | undefined {
  const match = /^C-([A-Z])$/.exec(token)
  if (!match) return undefined
  return String.fromCharCode(match[1].charCodeAt(0) - 64)
}

export function translateKeys(keys: string[]) {
  return keys.map((key) => {
    const upper = key.toUpperCase()
    const mapped = KEYMAP[upper]
    if (mapped) return mapped
    return translateCtrlLetterChord(upper) ?? key
  }).join('')
}
