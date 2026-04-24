export const CODEX_STARTUP_QUERY_FRAMES = [
  '\u001b[?2004h\u001b[>7u\u001b[?1004h\u001b[6n',
  '\u001b[?u\u001b[c',
  '\u001b]10;?\u001b\\',
] as const

export const CODEX_STARTUP_EXPECTED_CLEANED_FRAMES = [
  '\u001b[?2004h\u001b[>7u\u001b[?1004h',
  '\u001b[?u',
  '',
] as const

export const CODEX_STARTUP_EXPECTED_REPLIES = [
  '\u001b[1;1R',
  '\u001b[?1;2c',
  '\u001b]10;rgb:aaaa/bbbb/cccc\u001b\\',
] as const

export const CODEX_STARTUP_TITLE_FRAME = '\u001b]0;codex-fix-codex-appse...\u0007'
