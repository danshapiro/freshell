import { describe, expect, it, vi } from 'vitest'
import { joinCodexShutdownOwners } from '../../../server/shutdown-join.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Codex shutdown owner joining', () => {
  it('waits for planner shutdown before reporting a registry shutdown failure', async () => {
    const registryShutdown = deferred()
    const plannerShutdown = deferred()
    const registryError = new Error('registry verified teardown failed')
    const registry = {
      shutdownGracefully: vi.fn(() => registryShutdown.promise),
    }
    const codexLaunchPlanner = {
      shutdown: vi.fn(() => plannerShutdown.promise),
    }

    const joined = joinCodexShutdownOwners({
      registry,
      codexLaunchPlanner,
      terminalShutdownTimeoutMs: 5_000,
    })
    let settled = false
    void joined.then(
      () => { settled = true },
      () => { settled = true },
    )

    await vi.waitFor(() => expect(registry.shutdownGracefully).toHaveBeenCalledWith(5_000))
    await vi.waitFor(() => expect(codexLaunchPlanner.shutdown).toHaveBeenCalledTimes(1))
    registryShutdown.reject(registryError)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    plannerShutdown.resolve()
    await expect(joined).rejects.toThrow('registry verified teardown failed')
  })
})
