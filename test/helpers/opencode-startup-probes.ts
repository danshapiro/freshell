// Captured on 2026-04-03 from the first hung raw-PTY bootstrap bytes of
// `opencode` 1.3.13 under `xterm-256color`, before any Freshell/xterm replies.
export const OPEN_CODE_STARTUP_PROBE_FRAME = '\u001b]11;?\u0007'
export const OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES = ['\u001b]11;?', '\u0007']
export const OPEN_CODE_STARTUP_VISIBLE_TEXT = 'OpenCode ready\r\n'
export const OPEN_CODE_STARTUP_EXPECTED_REPLIES = ['\u001b]11;rgb:1111/2222/3333\u001b\\']
export const OPEN_CODE_STARTUP_EXPECTED_CLEANED = OPEN_CODE_STARTUP_VISIBLE_TEXT
