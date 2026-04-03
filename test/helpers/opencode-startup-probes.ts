// Captured on 2026-04-03 from a raw `node-pty` `opencode` 1.3.13 bootstrap under
// `xterm-256color`: first the hung pre-reply query, then the first post-reply
// output chunks after writing the truthful OSC 11 background-color reply.
// The raw PTY delivered the probe as one chunk; split-boundary tests reuse the
// same captured probe bytes through this shared two-frame fixture variant.
export const OPEN_CODE_STARTUP_PROBE_FRAME = '\u001b]11;?\u0007'
export const OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES = ['\u001b]11;?', '\u0007'] as const
export const OPEN_CODE_STARTUP_VISIBLE_TEXT = '\u001b[>0q\u001b[?25l\u001b[s\u001b[?1016$p\u001b[?2027$p\u001b[?2031$p\u001b[?1004$p\u001b[?2004$p\u001b[?2026$p\u001b[?u\u001b[H\u001b]66;w=1; \u001b\\\u001b[6n\u001b[H\u001b]66;s=2; \u001b\\\u001b[6n\u001b[u\u001b[s\u001b[?1049h\u001b[>4;1m\u001b[?2027h\u001b[?2004h\u001b[?2031h\u001b[?996n\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[14t'
export const OPEN_CODE_STARTUP_POST_REPLY_FRAMES = [
  '\u001b[>0q\u001b[?25l\u001b[s\u001b[?1016$p\u001b[?2027$p\u001b[?2031$p\u001b[?1004$p\u001b[?2004$p\u001b[?2026$p\u001b[?u\u001b[H\u001b]66;w=1; \u001b\\\u001b[6n\u001b[H\u001b]66;s=2; \u001b\\\u001b[6n\u001b[u\u001b[s\u001b[?1049h\u001b[>4;1m\u001b[?2027h\u001b[?2004h\u001b[?2031h\u001b[?996n',
  '\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h',
  '\u001b[14t',
] as const
export const OPEN_CODE_STARTUP_POST_REPLY_OUTPUT = OPEN_CODE_STARTUP_POST_REPLY_FRAMES.join('')
export const OPEN_CODE_STARTUP_EXPECTED_REPLIES = ['\u001b]11;rgb:1111/2222/3333\u001b\\']
export const OPEN_CODE_STARTUP_EXPECTED_CLEANED = OPEN_CODE_STARTUP_VISIBLE_TEXT
