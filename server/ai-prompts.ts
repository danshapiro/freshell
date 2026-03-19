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
  /** Activate the Gemini key from a settings-provided value at runtime. */
  applySettingsKey: (key: string | undefined) => {
    if (key && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = key
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
    build: (firstMessage: string) => {
      return [
        'Generate a short title (3-8 words) for a coding assistant conversation.',
        'The title should describe the task or topic, not the tool being used.',
        'Return ONLY the title text. No quotes, no markdown, no explanation.',
        '',
        'First message from the user:',
        firstMessage.slice(0, 2000),
      ].join('\n')
    },
  },
} as const
