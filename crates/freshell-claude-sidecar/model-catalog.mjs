import { pathToFileURL } from 'node:url'

const log = (message, details = {}) => process.stderr.write(`${JSON.stringify({ severity: 'warn', component: 'claude-model-catalog', message, ...details })}\n`)

/** A short-lived SDK control query; an empty stream never starts an agent turn. */
export async function probeModelCatalog(query, { env = process.env, timeoutMs = 10_000 } = {}) {
  const { CLAUDECODE: _claudeCode, ANTHROPIC_API_KEY: _apiKey, ...cleanEnv } = env
  const abortController = new AbortController()
  const session = query({
    prompt: (async function* () {})(),
    options: {
      abortController,
      env: cleanEnv,
      pathToClaudeCodeExecutable: env.CLAUDE_CMD || undefined,
      settingSources: ['user', 'project', 'local'],
      stderr: (data) => log('Claude capability probe stderr', { data: String(data).trimEnd() }),
    },
  })
  let timer
  try {
    return await Promise.race([
      Promise.resolve(session.supportedModels()),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort()
          reject(new Error(`Claude model catalog timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    try { await session.close() } catch (error) { log('Claude capability query close failed', { error: String(error) }) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { query } = await import(process.env.FRESHELL_CLAUDE_SDK_QUERY_MODULE || '@anthropic-ai/claude-agent-sdk')
    const models = await probeModelCatalog(query)
    process.stdout.write(`${JSON.stringify(models)}\n`)
  } catch (error) {
    log('Claude model catalog unavailable', { error: String(error) })
    process.exitCode = 1
  }
}
