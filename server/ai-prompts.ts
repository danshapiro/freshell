/**
 * AI prompts and model configuration.
 * All LLM prompts live here for easy maintenance.
 */

// Strip ANSI escape codes from terminal output
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?0-9;]*[a-zA-Z]/g, '')
}

export const AI_CONFIG = {
  model: 'gemini-2.5-flash-lite',
  enabled: () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
  /** Apply a Gemini key from settings. Does not overwrite an env-provided key on startup,
   *  but always updates when called from the settings save path. */
  applySettingsKey: (key: string | undefined, { force = false } = {}) => {
    if (key) {
      if (force || !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key
      }
    }
  },
} as const

export const PROMPTS = {
  terminalSummary: {
    model: AI_CONFIG.model,
    maxOutputTokens: 120,
    build: (terminalOutput: string) => {
      const cleaned = stripAnsi(terminalOutput)
      return [
        'You are summarizing a terminal session for an overview page.',
        'Return a single short description (1-2 sentences, max 200 chars).',
        'No markdown. No quotes.',
        '',
        'Terminal output:',
        cleaned,
      ].join('\n')
    },
  },
  sessionTitle: {
    model: AI_CONFIG.model,
    maxOutputTokens: 30,
    defaultPrompt: [
      'Generate a title for a tab that contains the coding agent for this conversation.',
      'Only the first word or two will show, so most specific and informative words first.',
      'E.g. if we\'re investigating a crash in freshell that happens when you mention sardines, "Sardine crash investigation" because sardine is specific, crash is less specific, and investigation is common to almost all tabs.',
      'Return ONLY the title text. No quotes, no markdown, no explanation.',
    ].join('\n'),
    build: (firstMessage: string, customPrompt?: string) => {
      const instructions = customPrompt?.trim() || PROMPTS.sessionTitle.defaultPrompt
      return [
        instructions,
        '',
        'First message from the user:',
        firstMessage.slice(0, 2000),
      ].join('\n')
    },
  },
} as const
