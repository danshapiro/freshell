import { createHash } from 'node:crypto'

import type {
  NativeProofStage,
  ProviderNativeTurnProof,
} from '../../../../scripts/testing/provider-qualification-receipt.js'
import type { NativeAssistantTurn } from './types.js'

export function nativeTurnProof(
  stage: NativeProofStage,
  nativeSessionId: string,
  turn: NativeAssistantTurn,
  nonce: string,
): ProviderNativeTurnProof {
  if (!turn.text.includes(nonce)) throw new Error(`${stage} native assistant response does not contain the nonce`)
  const toolCallTypes = turn.toolCalls.map((call) => call.name ? `${call.type}:${call.name}` : call.type)
  return {
    schemaVersion: 2,
    stage,
    nativeSessionId,
    nativeEvidence: turn.nativeEvidence,
    completedAt: turn.completedAt,
    responseSha256: createHash('sha256').update(turn.text).digest('hex'),
    responseContainsNonce: true,
    toolCallCount: turn.toolCalls.length,
    toolCallTypes,
    resolvedProvider: turn.resolvedProvider,
    resolvedModel: turn.resolvedModel,
    resolvedReasoningEffort: turn.resolvedReasoningEffort,
    providerProvenance: turn.providerProvenance,
    modelProvenance: turn.modelProvenance,
    reasoningEffortProvenance: turn.reasoningEffortProvenance,
  }
}
