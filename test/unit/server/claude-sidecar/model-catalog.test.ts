import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
// @ts-expect-error The standalone sidecar helper is a plain Node ESM module.
import { probeModelCatalog } from '../../../../crates/freshell-claude-sidecar/model-catalog.mjs'

describe('Claude model catalog helper', () => {
  it('reads models without sending a prompt and always closes the query', async () => {
    const models = [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }]
    const close = vi.fn()
    const query = vi.fn((_input: any) => ({ supportedModels: async () => models, close }))
    expect(await probeModelCatalog(query, { env: { CLAUDE_CMD: '/custom/claude', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'unwanted', KEEP: 'yes' } })).toEqual(models)
    const { prompt, options } = query.mock.calls[0][0]
    expect(await prompt.next()).toEqual({ value: undefined, done: true })
    expect(options.pathToClaudeCodeExecutable).toBe('/custom/claude')
    expect(options.env).toEqual({ CLAUDE_CMD: '/custom/claude', KEEP: 'yes' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes a failed query and preserves the failure', async () => {
    const close = vi.fn()
    await expect(probeModelCatalog(() => ({ supportedModels: async () => { throw new Error('login required') }, close }))).rejects.toThrow('login required')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('aborts and closes a hung probe within its budget', async () => {
    const close = vi.fn()
    let signal!: AbortSignal
    const query = ({ options }: any) => {
      signal = options.abortController.signal
      return { supportedModels: () => new Promise(() => {}), close }
    }
    await expect(probeModelCatalog(query, { timeoutMs: 10 })).rejects.toThrow('timed out')
    expect(signal.aborted).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('runs the standalone catalog command with the configured SDK module', async () => {
    const entry = fileURLToPath(new URL('../../../../crates/freshell-claude-sidecar/model-catalog.mjs', import.meta.url))
    const fixture = fileURLToPath(new URL('./fixtures/model-catalog-query.mjs', import.meta.url))
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [entry], {
      env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: fixture },
      timeout: 5_000,
    })
    expect(JSON.parse(stdout)).toEqual([{ value: 'sonnet', displayName: 'Claude Sonnet', supportedEffortLevels: ['low', 'high'] }])
    expect(stderr).toBe('')
  })
})
