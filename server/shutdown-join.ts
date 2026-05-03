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
