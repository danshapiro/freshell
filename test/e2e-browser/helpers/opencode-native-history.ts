import { stripVTControlCharacters } from 'node:util'

export type { NativeAssistantTurn, NativeHistory } from './provider-native-history/types.js'
export { nativeTurnProof } from './provider-native-history/proof.js'

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

export { selectNativeAssistantTurn } from '../../../scripts/testing/provider-native-history.js'

export { hasOpenCodePromptModelText, openCodeTerminalReady } from '../../../scripts/testing/provider-native-history.js'
