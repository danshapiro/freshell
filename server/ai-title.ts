import { AI_CONFIG, PROMPTS } from './ai-prompts.js'

/**
 * Generate a Gemini session title from the first user message. Returns null
 * when no Gemini key is configured or the model produces nothing usable.
 *
 * Shared by the generate-title route and the indexer auto-name pass so the
 * Gemini call lives in one place.
 */
export async function generateAiSessionTitle(
  firstMessage: string,
  customPrompt?: string,
): Promise<string | null> {
  if (!AI_CONFIG.enabled()) return null
  const { generateText } = await import('ai')
  const { google } = await import('@ai-sdk/google')
  const promptConfig = PROMPTS.sessionTitle
  const model = google(promptConfig.model)
  const prompt = promptConfig.build(firstMessage, customPrompt)
  const result = await generateText({
    model,
    prompt,
    maxOutputTokens: promptConfig.maxOutputTokens,
  })
  const title = (result.text || '').trim().slice(0, 80)
  return title || null
}
