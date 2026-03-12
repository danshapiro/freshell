export type CliCommandHarnessRequest = {
  method: string
  url: string
  body?: string
}

export type CliCommandHarnessResult = {
  stdout: string
  stderr: string
  exitCode: number
  json: unknown | null
  requests: CliCommandHarnessRequest[]
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

type CliCommandHarnessOptions = {
  fetch?: FetchLike
}

type CliCommandHarnessContext = {
  fetch: FetchLike
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  setExitCode: (code: number) => void
}

function extractJson(stdout: string): unknown | null {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // Keep scanning upward until a JSON line is found.
    }
  }

  return null
}

export function createCliCommandHarness(options: CliCommandHarnessOptions = {}) {
  const fetchImpl: FetchLike = options.fetch ?? (async () => new Response(null, { status: 204 }))

  return {
    async run(execute: (context: CliCommandHarnessContext) => Promise<void> | void): Promise<CliCommandHarnessResult> {
      const requests: CliCommandHarnessRequest[] = []
      let stdout = ''
      let stderr = ''
      let exitCode = 0

      const wrappedFetch: FetchLike = async (url, init = {}) => {
        requests.push({
          method: init.method ?? 'GET',
          url,
          body: typeof init.body === 'string' ? init.body : undefined,
        })
        return fetchImpl(url, init)
      }

      await execute({
        fetch: wrappedFetch,
        stdout: (chunk) => {
          stdout += chunk
        },
        stderr: (chunk) => {
          stderr += chunk
        },
        setExitCode: (code) => {
          exitCode = code
        },
      })

      return {
        stdout,
        stderr,
        exitCode,
        json: extractJson(stdout),
        requests,
      }
    },
  }
}
