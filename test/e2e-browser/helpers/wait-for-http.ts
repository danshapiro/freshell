type HttpState = 'up' | 'down'

type WaitForHttpOptions = {
  fetchHealth?: (url: string) => Promise<{ status: number }>
  pollInterval?: number
}

export async function waitForHttp(
  port: number,
  expected: HttpState,
  timeout = 60_000,
  {
    fetchHealth = (url) => fetch(url),
    pollInterval = 50,
  }: WaitForHttpOptions = {},
) {
  const deadline = Date.now() + timeout
  do {
    try {
      const response = await fetchHealth(`http://127.0.0.1:${port}/api/health`)
      if (expected === 'up' && response.status === 200) return
    } catch {
      if (expected === 'down') return
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  } while (Date.now() < deadline)

  throw new Error(`port ${port} did not become ${expected}`)
}
