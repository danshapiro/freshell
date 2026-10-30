// @vitest-environment node
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { setupRuntimeBuildPreflight } from '../../setup/runtime-build-preflight.js'

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('../../support/owned-fixture-processes.mjs', () => ({ prepareFixtureProcessOwner: prepare }))

const project = {
  config: { root: process.cwd() },
  vitest: { state: { getPaths: () => [path.resolve('test/unit/provider-fixtures/claude-fixture-cleanup.test.ts')] } },
  onTestsRerun() {},
}

describe('Windows fixture preparation before timed cleanup tests', () => {
  it('waits for the native helper before suite startup', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    let release: (() => void) | undefined
    prepare.mockReset().mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let started = false
    const setup = setupRuntimeBuildPreflight(project).then(() => { started = true })
    try {
      await Promise.resolve()
      expect(prepare).toHaveBeenCalledOnce()
      expect(started).toBe(false)
      release!()
      await setup
      expect(started).toBe(true)
    } finally {
      release?.()
      await setup
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('propagates a failed helper build before starting the suite', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    prepare.mockReset().mockRejectedValue(new Error('fixture helper build failed'))
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(setupRuntimeBuildPreflight(project)).rejects.toThrow('fixture helper build failed')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
