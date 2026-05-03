export async function collectShutdownFailures(tasks: Iterable<PromiseLike<unknown>>): Promise<unknown[]> {
  const results = await Promise.allSettled([...tasks])
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
}

export function throwShutdownFailures(failures: unknown[], message: string): void {
  if (failures.length === 0) return
  if (failures.length === 1) {
    throw failures[0]
  }
  throw new AggregateError(failures, message)
}

export async function waitForAllSettledOrThrow(
  tasks: Iterable<PromiseLike<unknown>>,
  message: string,
): Promise<void> {
  throwShutdownFailures(await collectShutdownFailures(tasks), message)
}

function invokeShutdownTask(task: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    return Promise.resolve(task())
  } catch (error) {
    return Promise.reject(error)
  }
}

type CodexShutdownOwners = {
  registry: {
    shutdownGracefully(timeoutMs?: number): Promise<void>
  }
  codexLaunchPlanner: {
    shutdown(): Promise<void>
  }
  terminalShutdownTimeoutMs: number
}

export async function joinCodexShutdownOwners({
  registry,
  codexLaunchPlanner,
  terminalShutdownTimeoutMs,
}: CodexShutdownOwners): Promise<void> {
  await waitForAllSettledOrThrow([
    invokeShutdownTask(() => registry.shutdownGracefully(terminalShutdownTimeoutMs)),
    invokeShutdownTask(() => codexLaunchPlanner.shutdown()),
  ], 'Codex shutdown owners failed.')
}
