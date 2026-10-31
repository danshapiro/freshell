import {
  getTerminalOutputWriteScope,
  type TerminalOutputSideEffect,
  type TerminalOutputSource,
} from './terminal-output-write-scope.js'

export type TerminalOutputSideEffectMode = 'shell' | 'claude' | 'codex' | 'opencode' | string

export type ShouldAllowTerminalOutputSideEffectInput = {
  terminalInstanceId?: string
  source?: TerminalOutputSource
  effect: TerminalOutputSideEffect
  mode?: TerminalOutputSideEffectMode
  generation?: string
}

const INTERNAL_WRITE_CALLBACK_EFFECTS = new Set<TerminalOutputSideEffect>([
  'parser_applied_checkpoint',
  'attach_completion',
  'cursor_persist',
])

const LIVE_EXTERNAL_EFFECTS = new Set<TerminalOutputSideEffect>([
  'startup_reply',
  'osc52_prompt',
  'osc52_clipboard_write',
  'request_mode_reply',
  'title_update',
  'turn_complete',
  'link_action',
  'terminal_action',
  'local_xterm_notice',
])

// Truly-idle alerting: green/sound edges for all five terminal CLIs are
// server-emitted (terminal.idle broadcast). The client must never mint a
// completion from output for them; other/custom CLI modes keep the BEL path.
function isServerAuthoritativeTurnCompleteMode(mode: string | undefined): boolean {
  return mode === 'claude' || mode === 'codex' || mode === 'opencode' || mode === 'amplifier' || mode === 'antigravity'
}

export function shouldAllowTerminalOutputSideEffect(
  input: ShouldAllowTerminalOutputSideEffectInput,
): boolean {
  if (input.source) {
    if (input.source === 'replay') {
      return INTERNAL_WRITE_CALLBACK_EFFECTS.has(input.effect)
        && Boolean(getTerminalOutputWriteScope(input.terminalInstanceId))
    }

    if (input.effect === 'turn_complete') {
      return !isServerAuthoritativeTurnCompleteMode(input.mode)
    }

    if (INTERNAL_WRITE_CALLBACK_EFFECTS.has(input.effect)) {
      return true
    }

    if (LIVE_EXTERNAL_EFFECTS.has(input.effect)) {
      return true
    }

    return false
  }

  const scope = getTerminalOutputWriteScope(input.terminalInstanceId)
  if (input.generation && scope && scope.generation !== input.generation) {
    return false
  }

  if (scope?.suppressExternalSideEffects === true && !INTERNAL_WRITE_CALLBACK_EFFECTS.has(input.effect)) {
    return false
  }

  const source = scope?.source
  if (!source) return false

  if (source === 'replay') {
    return INTERNAL_WRITE_CALLBACK_EFFECTS.has(input.effect) && Boolean(scope)
  }

  if (input.effect === 'turn_complete') {
    return !isServerAuthoritativeTurnCompleteMode(input.mode)
  }

  if (INTERNAL_WRITE_CALLBACK_EFFECTS.has(input.effect)) {
    return true
  }

  if (LIVE_EXTERNAL_EFFECTS.has(input.effect)) {
    return true
  }

  return false
}

const XTERM_FOCUS_IN = '\u001b[I'
const XTERM_FOCUS_OUT = '\u001b[O'

/**
 * xterm fires ESC[I / ESC[O synchronously from its parser every time it
 * parses a ?1004h arm byte — including when that byte arrives via history
 * replay (kata 9gy8). Such a replay-triggered report is a phantom: nothing
 * about user focus changed, and the app receives an invented keypress.
 * The replay write scope (“suppressExternalSideEffects”) is held open until
 * xterm's write callback, which covers both synchronous and deferred parses,
 * so it is the correct discriminator; the exact-bytes check keeps all other
 * input untouched.
 */
export function isReplayPhantomFocusReport(
  data: string,
  terminalInstanceId: string | undefined,
): boolean {
  if (data !== XTERM_FOCUS_IN && data !== XTERM_FOCUS_OUT) return false
  return getTerminalOutputWriteScope(terminalInstanceId)?.suppressExternalSideEffects === true
}
