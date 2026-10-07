import { stripVTControlCharacters } from 'node:util'

export type { NativeAssistantTurn, NativeHistory } from './provider-native-history/types.js'
export { nativeTurnProof } from './provider-native-history/proof.js'
import type { NativeAssistantTurn } from './provider-native-history/types.js'

export function openCodeCredentialFailureMessage(output: string): string | null {
  const terminalText = stripVTControlCharacters(output)
  if (/\bToken refresh failed:\s*401\b/i.test(terminalText)) {
    return 'OpenCode credential refresh was rejected with HTTP 401; provide a currently valid OpenAI auth grant'
  }
  if (
    /could not parse your authentication token|\bhttp(?:\/\d+(?:\.\d+)?)?\s+401(?:\s+unauthorized)?\b|\b401\s+unauthorized\b|\bstatus code\s*:?\s*401\b|\binvalid (?:openai )?(?:api )?key\b/i
      .test(terminalText)
  ) {
    return 'OpenCode credential was rejected by OpenAI; provide a currently valid OneCLI OAuth grant'
  }
  return null
}

export async function waitForOpenCodeTerminalCondition(params: {
  readTerminalText: () => Promise<string>
  wait: (milliseconds: number) => Promise<void>
  description: string
  succeeds: (terminalText: string) => boolean | Promise<boolean>
  timeoutMs: number
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs
  while (Date.now() < deadline) {
    const terminalText = await params.readTerminalText()
    const failure = openCodeCredentialFailureMessage(terminalText)
    if (failure) throw new Error(failure)
    if (await params.succeeds(terminalText)) return
    await params.wait(250)
  }
  throw new Error(`timed out waiting for ${params.description}`)
}

/**
 * Self-contained query-only form of the current OpenCode native-history reader.
 * Runtime chaos tests execute it only through an ownership-checked provider
 * exec because the provider volume is deliberately not mounted into the web
 * process. It emits the same bounded schema as readOpenCodeNativeHistory.
 */
export { OPENCODE_NATIVE_HISTORY_SCRIPT } from '../../../scripts/testing/runtime-sandbox.js'

export function selectNativeAssistantTurn(
  turns: readonly NativeAssistantTurn[],
  priorMessageIds: ReadonlySet<string>,
  expectedText: string,
): NativeAssistantTurn | null {
  return turns.find((turn) => (
    typeof turn.messageId === 'string' && turn.messageId.length > 0
    && !priorMessageIds.has(turn.messageId)
    && turn.toolCalls.length === 0
    && turn.text.includes(expectedText)
  )) ?? null
}

/** The configured model must appear after Build in the same visible header line. */
export function hasOpenCodePromptModelText(
  renderedText: string,
  expectedModelTexts: readonly string[],
): boolean {
  const modelTexts = expectedModelTexts.filter((modelText) => modelText.length > 0)
  if (modelTexts.length === 0) return false

  return renderedText.split(/\r\n|\n|\r/).some((line) => {
    const buildIndex = line.indexOf('Build')
    if (buildIndex === -1) return false
    const headerText = line.slice(buildIndex + 'Build'.length)
    return modelTexts.some((modelText) => headerText.includes(modelText))
  })
}

/** Resumed conversations omit the home-screen placeholder. Observe model text and actual TUI input mode. */
export function openCodeTerminalReady(
  rawOutput: string,
  expectedModelTexts: readonly string[],
): boolean {
  const modes = [...rawOutput.matchAll(/\x1b\[\?2004([hl])/g)]
  if (modes.at(-1)?.[1] !== 'h') return false
  const rendered = stripVTControlCharacters(rawOutput)
  return hasOpenCodePromptModelText(rendered, expectedModelTexts)
}
