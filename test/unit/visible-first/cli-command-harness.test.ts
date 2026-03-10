import { describe, expect, it } from 'vitest'
import { createCliCommandHarness } from '@test/helpers/visible-first/cli-command-harness'

describe('createCliCommandHarness', () => {
  it('captures invoked URLs, stdout, stderr, parsed JSON, and exit code without a real server', async () => {
    const harness = createCliCommandHarness({
      fetch: async (url) =>
        new Response(
          JSON.stringify({
            ok: true,
            url,
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        ),
    })

    const result = await harness.run(async ({ fetch, stdout, stderr, setExitCode }) => {
      stdout('starting\n')
      stderr('warning\n')

      const response = await fetch('http://127.0.0.1:3311/api/session-directory?query=alpha')
      stdout(`${JSON.stringify(await response.json())}\n`)
      setExitCode(0)
    })

    expect(result.requests).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: 'http://127.0.0.1:3311/api/session-directory?query=alpha',
      }),
    ])
    expect(result.stdout).toContain('starting')
    expect(result.stderr).toContain('warning')
    expect(result.json).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3311/api/session-directory?query=alpha',
    })
    expect(result.exitCode).toBe(0)
  })
})
