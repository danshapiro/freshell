import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { cleanupProviderParity } from '../../../helpers/provider-parity-cleanup.js'
import { exposeGrantsToHarness, fakeOnecliGrants } from '../../../helpers/provider-parity-onecli.js'

describe('provider parity teardown', () => {
  it.each(['fresh', 'managed'].flatMap(mode =>
    ['stop', 'stop-result', 'remove-directory'].map(stage => ({ mode, stage }))))(
    'restores ambient references when $mode cleanup fails during $stage', async ({ mode, stage }) => {
      vi.stubEnv('FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE', '/nonexistent/operator/auth.json')
      vi.stubEnv('FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE', undefined)
      vi.stubEnv('FRESHELL_URL', 'http://operator.invalid')
      vi.stubEnv('OPENCODE_CONFIG_DIR', '/nonexistent/operator/config')
      vi.stubEnv('OPENCODE_DISABLE_PROJECT_CONFIG', undefined)
      const fake = fakeOnecliGrants(['opencode'])
      const restore = exposeGrantsToHarness(fake.serverEnv)
      const restoreOnecliEnvironment = vi.fn(restore)
      const inheritedEnvironment = Object.fromEntries(['FRESHELL_URL', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG']
        .map(key => [key, process.env[key]]))
      Object.assign(process.env, {
        FRESHELL_URL: 'http://fixture.invalid', OPENCODE_CONFIG_DIR: '/fixture/config', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      })
      const dependencies = {
        captureVolumes: vi.fn(() => []), removeVolumes: vi.fn(() => []),
        removeDirectory: vi.fn(() => { if (stage === 'remove-directory') throw new Error('controlled directory failure') }),
      }
      const rig = {
        stop: vi.fn(async () => {
          if (stage === 'stop') throw new Error('controlled stop failure')
          return { ok: stage !== 'stop-result', errors: ['controlled stop-result failure'] }
        }),
        runtime: { writeIncident: vi.fn() },
      }
      try {
        await expect(cleanupProviderParity({
          connections: [], rig, restoreOnecliEnvironment, inheritedEnvironment,
          directories: [undefined, fake.directory],
          ...(mode === 'managed' ? { registeredVolumes: [] } : {}),
        }, dependencies)).rejects.toThrow(`controlled ${stage === 'remove-directory' ? 'directory' : stage} failure`)
        expect(rig.stop).toHaveBeenCalledOnce()
        expect(restoreOnecliEnvironment).toHaveBeenCalledOnce()
        expect(process.env.FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE).toBe('/nonexistent/operator/auth.json')
        expect(process.env.FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE).toBeUndefined()
        for (const [key, value] of Object.entries(inheritedEnvironment)) expect(process.env[key]).toBe(value)
        expect(dependencies.removeDirectory).toHaveBeenCalledExactlyOnceWith(fake.directory)
        expect(dependencies.captureVolumes).toHaveBeenCalledTimes(mode === 'managed' ? 1 : 0)
        expect(dependencies.removeVolumes).toHaveBeenCalledTimes(mode === 'managed' && stage === 'remove-directory' ? 1 : 0)
      } finally {
        restore()
        vi.unstubAllEnvs()
        fs.rmSync(fake.directory, { recursive: true, force: true })
      }
    },
  )

  it('closes every connection, captures before stop, and removes volumes only after stop succeeds', async () => {
    const order: string[] = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-parity-cleanup-'))
    const owner = {
      installationId: 'fixture-installation', soulId: 'fixture-soul', providerVolumeName: 'owned-volume',
      imageRef: 'fixture-image', hostBinaryPath: '/fixture/host', binarySha256: 'a'.repeat(64), daemonId: 'fixture-daemon',
    }
    const registeredVolumes = [owner]
    const capturedVolumes = [{ owner, labels: { 'com.freshell.soul-id': owner.soulId } }]
    const dependencies = {
      captureVolumes: vi.fn(() => { order.push('capture'); return capturedVolumes }),
      removeVolumes: vi.fn(() => { order.push('remove-volumes'); return ['owned-volume'] }),
      removeDirectory: (target: string) => { order.push('remove-directory'); fs.rmSync(target, { recursive: true, force: true }) },
    }
    const rig = {
      stop: async () => { order.push('stop'); return { ok: true, errors: [] } },
      runtime: { writeIncident: vi.fn() },
    }
    try {
      await cleanupProviderParity({
        connections: [
          { close: async () => { order.push('close-first'); throw new Error('controlled socket failure') } },
          { close: async () => { await Promise.resolve(); order.push('close-second') } },
        ],
        rig, registeredVolumes, directories: [directory],
        restoreOnecliEnvironment: () => { order.push('restore') },
      }, dependencies)
      expect(order).toEqual(['close-first', 'close-second', 'capture', 'stop', 'remove-volumes', 'restore', 'remove-directory'])
      expect(dependencies.captureVolumes).toHaveBeenCalledExactlyOnceWith(registeredVolumes)
      expect(dependencies.removeVolumes).toHaveBeenCalledExactlyOnceWith(capturedVolumes)
      expect(rig.runtime.writeIncident.mock.calls).toEqual([
        ['provider-parity-registered-volumes', capturedVolumes],
        ['provider-parity-registered-volume-cleanup', { removed: ['owned-volume'] }],
      ])
      expect(fs.existsSync(directory)).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })

  it.each(['capture', 'remove-volumes'])('stops the rig and restores references when %s fails', async stage => {
    const dependencies = {
      captureVolumes: vi.fn(() => {
        if (stage === 'capture') throw new Error('controlled volume failure')
        return []
      }),
      removeVolumes: vi.fn(() => { throw new Error('controlled volume failure') }),
      removeDirectory: vi.fn(),
    }
    const rig = {
      stop: vi.fn(async () => ({ ok: true, errors: [] })),
      runtime: { writeIncident: vi.fn() },
    }
    const restoreOnecliEnvironment = vi.fn()
    await expect(cleanupProviderParity({
      connections: [], rig, registeredVolumes: [], restoreOnecliEnvironment, directories: ['/fixture/home'],
    }, dependencies)).rejects.toThrow('controlled volume failure')
    expect(rig.stop).toHaveBeenCalledOnce()
    expect(restoreOnecliEnvironment).toHaveBeenCalledOnce()
    expect(dependencies.removeVolumes).toHaveBeenCalledTimes(stage === 'capture' ? 0 : 1)
    expect(dependencies.removeDirectory).toHaveBeenCalledExactlyOnceWith('/fixture/home')
  })

  it('removes owned directories and restores references after setup failed before rig creation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-parity-partial-'))
    const restoreOnecliEnvironment = vi.fn()
    try {
      await cleanupProviderParity({ connections: [], rig: undefined, restoreOnecliEnvironment, directories: [undefined, directory] })
      expect(restoreOnecliEnvironment).toHaveBeenCalledOnce()
      expect(fs.existsSync(directory)).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
})
