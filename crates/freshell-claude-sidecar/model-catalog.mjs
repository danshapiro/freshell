import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { managedSdkSpawn } from './exec-profile.mjs'
import { cliStderrLogger, createLog, errorText } from './log.mjs'
import { isHostedSidecar } from './hosted.mjs'
import { createClaudeSdkCleanEnv } from './sdk-env.mjs'

const catalogLog = createLog('claude-model-catalog')

/** A short-lived SDK control query; an empty stream never starts an agent turn. */
export async function probeModelCatalog(query, { env = process.env, timeoutMs = 10_000, log = catalogLog } = {}) {
  const cleanEnv = createClaudeSdkCleanEnv(env)
  const abortController = new AbortController()
  const stderr = cliStderrLogger(log, { hosted: isHostedSidecar(env) })
  const session = query({
    prompt: (async function* () {})(),
    options: {
      abortController,
      env: cleanEnv,
      pathToClaudeCodeExecutable: env.CLAUDE_CMD || undefined,
      settingSources: ['user', 'project', 'local'],
      spawnClaudeCodeProcess: managedSdkSpawn(stderr, env),
      stderr,
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
    try { await session.close() } catch (error) { log('warn', 'catalog.close_failed', { error: errorText(error) }) }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    // macOS commonly exposes the same temporary/app path through aliases such
    // as /var and /private/var. Canonicalize both sides before comparing so a
    // direct launch still runs the probe when the argv path is symlinked.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    // Preserve the normal URL comparison as a best-effort fallback if a path
    // disappears during startup or the platform cannot resolve it.
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isMainModule()) {
  try {
    const { query } = await import(process.env.FRESHELL_CLAUDE_SDK_QUERY_MODULE || '@anthropic-ai/claude-agent-sdk')
    const models = await probeModelCatalog(query)
    process.stdout.write(`${JSON.stringify(models)}\n`)
  } catch (error) {
    catalogLog('error', 'catalog.unavailable', { error: errorText(error) })
    process.exitCode = 1
  }
}
