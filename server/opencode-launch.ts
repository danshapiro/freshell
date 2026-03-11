type EnvSource = Record<string, string | undefined>

const OPENCODE_DEFAULT_GOOGLE_MODEL = 'google/gemini-3-pro-preview'
const OPENCODE_DEFAULT_OPENAI_MODEL = 'openai/gpt-5'
const OPENCODE_DEFAULT_ANTHROPIC_MODEL = 'anthropic/claude-sonnet-4-5'

function resolveGoogleApiKey(env: EnvSource): string | undefined {
  return env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY
}

export function getOpencodeEnvOverrides(env: EnvSource): Record<string, string> {
  const overrides: Record<string, string> = {}
  const googleApiKey = resolveGoogleApiKey(env)
  if (googleApiKey && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    overrides.GOOGLE_GENERATIVE_AI_API_KEY = googleApiKey
  }
  return overrides
}

export function resolveOpencodeLaunchModel(
  explicitModel: string | undefined,
  env: EnvSource,
): string | undefined {
  if (explicitModel) return explicitModel
  if (resolveGoogleApiKey(env)) return OPENCODE_DEFAULT_GOOGLE_MODEL
  if (env.OPENAI_API_KEY) return OPENCODE_DEFAULT_OPENAI_MODEL
  if (env.ANTHROPIC_API_KEY) return OPENCODE_DEFAULT_ANTHROPIC_MODEL
  return undefined
}
