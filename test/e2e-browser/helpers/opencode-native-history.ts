import { stripVTControlCharacters } from 'node:util'

export type { NativeAssistantTurn } from './provider-native-history/types.js'
export { nativeTurnProof } from './provider-native-history/proof.js'
import type { NativeAssistantTurn } from './provider-native-history/types.js'

export function selectNativeAssistantTurn(
  turns: readonly NativeAssistantTurn[],
  priorMessageIds: ReadonlySet<string>,
  expectedText: string,
): NativeAssistantTurn | null {
  return turns.find((turn) => (
    !priorMessageIds.has(turn.messageId)
    && turn.toolCalls.length === 0
    && turn.text.includes(expectedText)
  )) ?? null
}

/** Resumed conversations omit the home-screen placeholder. Observe actual TUI input mode. */
export function openCodeTerminalReady(rawOutput: string): boolean {
  const modes = [...rawOutput.matchAll(/\x1b\[\?2004([hl])/g)]
  if (modes.at(-1)?.[1] !== 'h') return false
  const rendered = stripVTControlCharacters(rawOutput)
  return rendered.includes('Build') && rendered.includes('Big Pickle')
}
