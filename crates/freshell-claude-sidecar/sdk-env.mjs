// The one environment builder for every Claude SDK query this package starts
// (the session sidecar in index.mjs and the model-catalog probe in
// model-catalog.mjs), so the two can never disagree about what the CLI sees.
// Port of server/sdk-bridge.ts:64-66 plus the managed OneCLI key rule.
//
// - CLAUDECODE is dropped so the CLI does not treat itself as nested.
// - ANTHROPIC_API_KEY is dropped (legacy sdk-bridge parity) unless the Rust
//   spawner selected the managed OneCLI key: FRESHELL_CLAUDE_ONECLI_API_KEY
//   is '1' only when the managed child secrets carry the key.
// - The selection flag itself never reaches the CLI.
export function createClaudeSdkCleanEnv(env = process.env) {
  const {
    CLAUDECODE: _claudeCode,
    ANTHROPIC_API_KEY: apiKey,
    FRESHELL_CLAUDE_ONECLI_API_KEY: onecliApiKey,
    ...cleanEnv
  } = env
  if (onecliApiKey === '1' && apiKey) cleanEnv.ANTHROPIC_API_KEY = apiKey
  return cleanEnv
}
