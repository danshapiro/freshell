type HttpState = 'up' | 'down'

type WaitForHttpOptions = {
  fetchHealth?: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<{ status: number }>
  pollInterval?: number
}

function isRequestTimeout(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const candidate = current as {
      cause?: unknown
      code?: unknown
      name?: unknown
    }
    if (
      candidate.name === 'AbortError'
      || candidate.name === 'TimeoutError'
      || candidate.code === 'ETIMEDOUT'
      || candidate.code === 'UND_ERR_CONNECT_TIMEOUT'
      || candidate.code === 'UND_ERR_HEADERS_TIMEOUT'
      || candidate.code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
}

export async function waitForHttp(
  port: number,
  expected: HttpState,
  timeout = 60_000,
  {
    fetchHealth = (url, init) => fetch(url, init),
    pollInterval = 50,
  }: WaitForHttpOptions = {},
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const signal = AbortSignal.timeout(Math.max(1, remaining))
    try {
      const response = await fetchHealth(
        `http://127.0.0.1:${port}/api/health`,
        { signal },
      )
      if (expected === 'up' && response.status === 200) return
    } catch (error) {
      if (signal.aborted || isRequestTimeout(error)) break
      if (expected === 'down') return
    }
    const pollDelay = Math.min(pollInterval, deadline - Date.now())
    if (pollDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollDelay))
    }
  }

  throw new Error(`port ${port} did not become ${expected}`)
}
