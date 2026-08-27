const KEYMAP: Record<string, string> = {
  ENTER: '\r', 'C-C': '\x03', 'C-D': '\x04', ESCAPE: '\x1b', TAB: '\t', BSPACE: '\x7f',
  UP: '\x1b[A', DOWN: '\x1b[B', LEFT: '\x1b[D', RIGHT: '\x1b[C', SPACE: ' ',
}

export function translateKeys(keys: string[]): string {
  return keys.map((key) => {
    const upper = key.toUpperCase()
    const chord = /^C-([A-Z])$/.exec(upper)
    return KEYMAP[upper] ?? (chord ? String.fromCharCode(chord[1].charCodeAt(0) - 64) : key)
  }).join('')
}
