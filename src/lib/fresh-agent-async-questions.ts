/** Context for ordinary user input. None of these identities is a native control request. */
export type AsyncQuestionAnswer = { itemId: string; questionId: string; question: string; text: string }
export type AsyncQuestionAnswerStatus = 'draft' | 'sending' | 'accepted' | 'refused' | 'ambiguous'
export const asyncQuestionKey = (itemId: string, questionId: string) => JSON.stringify([itemId, questionId])
const HEADER = 'Answer to Codex question: '

export function asyncQuestionDraftPrefix(itemId: string, questionId: string): string {
  return HEADER + JSON.stringify({ itemId, questionId }).slice(0, -1) + ','
}

export function formatAsyncQuestionAnswer(answer: AsyncQuestionAnswer): string {
  return HEADER + JSON.stringify({ itemId: answer.itemId, questionId: answer.questionId, question: answer.question, answer: answer.text })
}

/** Recover only an ordinary draft's context on explicit Send, never a pending RPC or an automatic send. */
export function asyncQuestionKeysInText(text: string): string[] {
  const keys = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith(HEADER)) continue
    try {
      const value: unknown = JSON.parse(line.slice(HEADER.length))
      if (!value || typeof value !== 'object') continue
      const answer = value as Record<string, unknown>
      if (typeof answer.itemId === 'string' && typeof answer.questionId === 'string' && typeof answer.question === 'string' && typeof answer.answer === 'string') keys.add(asyncQuestionKey(answer.itemId, answer.questionId))
    } catch { /* Edited ordinary prose remains ordinary prose. */ }
  }
  return [...keys]
}
