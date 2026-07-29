// @vitest-environment node
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildServerProcessEnv,
  startServerProcess,
  waitForFileContent,
} from './logger.separation.harness.js'

describe('logger separation harness', () => {
  it('does not inject a startup-only WSL port-forward suppression env var', () => {
    const childEnv = buildServerProcessEnv({}, {})

    expect(childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD).toBeUndefined()
  })

  it('reports child exit details instead of waiting for impossible file content', async () => {
    const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-logger-harness-test-'))
    const handle = await startServerProcess(
      [
        process.execPath,
        '-e',
        "process.stdout.write('probe stdout\\n'); process.stderr.write('probe stderr\\n'); process.exitCode = 7",
      ],
      {},
      process.cwd(),
    )

    try {
      let failure: unknown
      try {
        await waitForFileContent(
          handle,
          path.join(targetDir, 'missing.log'),
          /never appears/,
          30_000,
        )
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('exit code 7')
      expect((failure as Error).message).toContain('stdout/stderr:')
      expect((failure as Error).message).toContain('probe stdout')
      expect((failure as Error).message).toContain('probe stderr')
    } finally {
      await fsp.rm(targetDir, { recursive: true, force: true })
      await fsp.rm(handle.stderrLogDir, { recursive: true, force: true })
    }
  })
})
