import { query } from '@anthropic-ai/claude-agent-sdk'
import { pathToFileURL } from 'node:url'

import { AgentChatCapabilitiesSchema } from '../../../shared/agent-chat-capabilities.js'
import {
  normalizeAgentChatCapabilityCatalog,
} from '../../../server/agent-chat-capability-registry.js'
import { createClaudeSdkOptions } from '../../../server/sdk-bridge.js'

const PROBE_ENV = 'FRESHELL_RUN_LIVE_SUPPORTED_MODELS_PROBE'
const PROBE_TIMEOUT_MS = 10_000

export async function runLiveSupportedModelsProbe() {
  const abortController = new AbortController()
  const probeQuery = query({
    prompt: (async function* emptyPrompt() {})(),
    options: createClaudeSdkOptions({ abortController }),
  })
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    const rawModels = await Promise.race([
      Promise.resolve(probeQuery.supportedModels()),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort()
          reject(new Error(`supportedModels() probe timed out after ${PROBE_TIMEOUT_MS}ms`))
        }, PROBE_TIMEOUT_MS)
      }),
    ])

    const normalizedModels = normalizeAgentChatCapabilityCatalog(rawModels)
    const parsed = AgentChatCapabilitiesSchema.parse({
      provider: 'freshclaude',
      fetchedAt: Date.now(),
      models: normalizedModels,
    })

    return {
      rawModels,
      normalizedModels,
      parsed,
    }
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
    await Promise.resolve(probeQuery.close())
  }
}

async function main() {
  if (process.env[PROBE_ENV] !== '1') {
    console.log(
      `${PROBE_ENV} is not set; skipping live supportedModels() differential probe.`,
    )
    return
  }

  const result = await runLiveSupportedModelsProbe()
  console.log(JSON.stringify({
    rawModels: result.rawModels,
    normalizedModels: result.normalizedModels,
    parsedModelIds: result.parsed.models.map((model) => model.id),
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      error: error instanceof Error
        ? {
            message: error.message,
            stack: error.stack,
          }
        : String(error),
    }, null, 2))
    process.exitCode = 1
  })
}
