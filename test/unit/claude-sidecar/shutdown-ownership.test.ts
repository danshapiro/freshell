// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { startRealSidecar } from './harness.js'

it.each(['shutdown', 'stdout-closed'])('on %s, retains the native child and its pipes until that child closes', async (mode) => {
  const sidecar = await startRealSidecar({ env: {
    FRESHELL_CLAUDE_SDK_QUERY_MODULE: fileURLToPath(new URL('./fixtures/shutdown-child-query-module.mjs', import.meta.url)),
  } })
  const created = await sidecar.requestCreate()
  expect(created.type, sidecar.stderr()).toBe('created')
  const pid = created.cliPid as number
  const marker = (name: string) => path.join(sidecar.cwd, `native-${name}`)
  try {
    sidecar.send({ type: 'send', sessionId: created.sessionId, text: 'keep streaming' })
    await sidecar.waitFor('sdk.stream')
    if (mode === 'stdout-closed') sidecar.child.stdout!.destroy()
    else sidecar.send({ type: 'shutdown' })

    // The held child has received termination, or the sidecar incorrectly
    // exited first. The latter must fail even if cleanup later succeeds.
    await expect.poll(() => fs.existsSync(marker('terminated')) || sidecar.child.exitCode !== null).toBe(true)
    expect(sidecar.child.exitCode, sidecar.stderr()).toBeNull()
    expect(fs.existsSync(marker('terminated')), sidecar.stderr()).toBe(true)
    fs.writeFileSync(marker('release'), 'yes')
    expect(await sidecar.waitExit(), sidecar.stderr()).toEqual({ code: 0, signal: null })
    expect(fs.existsSync(marker('exited'))).toBe(true)
  } finally {
    fs.writeFileSync(marker('release'), 'yes')
    await expect.poll(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    }, { timeout: 5_000 }).toBe(true)
  }
})
