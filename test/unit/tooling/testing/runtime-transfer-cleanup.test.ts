import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  now: 10_000,
  stalled: false,
  serial: 0,
  calls: [] as Array<{ args: string[]; timeout: number; killSignal: unknown }>,
  containers: new Set<string>(),
  volumes: new Set<string>(),
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execute = (program: string, args: string[], options: ExecFileSyncOptions) => {
    if (program !== 'docker') return actual.execFileSync(program, args, options)
    const timeout = options.timeout!
    transport.calls.push({ args: [...args], timeout, killSignal: options.killSignal })
    if (transport.stalled) {
      // Complete the real subprocess API's timeout outcome at its own
      // deadline, without requiring a Node shim to boot inside 250 ms.
      transport.now += timeout
      throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), {
        code: 'ETIMEDOUT', syscall: 'spawnSync docker', signal: 'SIGKILL',
      })
    }
    if (args[0] === 'info') return '["rootless"]'
    if (args[0] === 'image' && args[1] === 'inspect') return `sha256:${'b'.repeat(64)}`
    if (args[0] === 'volume' && args[1] === 'create') {
      transport.volumes.add(args.at(-1)!)
      return args.at(-1)!
    }
    if (args[0] === 'create') {
      const id = (++transport.serial).toString(16).padStart(64, '0')
      transport.containers.add(id)
      return id
    }
    if (args[0] === 'start' && transport.containers.has(args.at(-1)!)) return ''
    if (args[0] === 'inspect' && transport.containers.has(args.at(-1)!)) return '0'
    if (args[0] === 'rm' && transport.containers.delete(args.at(-1)!)) return ''
    if (args[0] === 'volume' && args[1] === 'rm' && transport.volumes.delete(args.at(-1)!)) return ''
    if (args.join(' ') === 'ps -aq --no-trunc') return [...transport.containers].join('\n')
    if (args.join(' ') === 'volume ls -q') return [...transport.volumes].join('\n')
    throw new Error(`unexpected fixture Docker command: ${JSON.stringify(args)}`)
  }
  return { ...actual, execFileSync: execute, default: { ...actual.default, execFileSync: execute } }
})

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'

describe('finite transfer ownership', () => {
  it('refuses stalled transfer cleanup transport and retains unresolved resources', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-cleanup-'))
    let harness: RuntimeHarness | undefined
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => transport.now)
    transport.now = 10_000
    transport.stalled = false
    transport.serial = 0
    transport.calls.length = 0
    transport.containers.clear()
    transport.volumes.clear()
    try {
      // A broken mock must fail closed rather than ever reach an ambient daemon.
      await fs.writeFile(path.join(directory, 'docker'), '#!/bin/sh\necho unexpected real Docker invocation >&2\nexit 97\n', { mode: 0o700 })
      vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`)
      // Keep the real checkout and file admission boundaries. Only Docker IO
      // and the policy clock are controlled; no daemon or live resources exist.
      execFileSync('git', ['init', '--quiet'], { cwd: directory, timeout: 10_000 })
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Transfer fixture'], { cwd: directory, timeout: 10_000 })
      const schema = path.join(directory, 'schema.sql'), migration = path.join(directory, 'migrations.json')
      await fs.writeFile(schema, '-- owned synthetic schema\n')
      await fs.writeFile(migration, '[]')
      harness = new RuntimeHarness(directory, randomUUID(), 2)
      const cleanupBudgetMs = 1_000
      await harness.prepareTransfer(`sha256:${'b'.repeat(64)}`, {
        operationTimeoutMs: 250, cleanupTimeoutMs: cleanupBudgetMs,
        lifecycleMs: cleanupBudgetMs, memoryBytes: 1024 ** 3,
      })
      harness.startTransferProvider(process.execPath, schema, migration)
      const original = harness.transferOwnedIds()
      expect(original.containers).toHaveLength(2)
      expect(original.volumes).toHaveLength(1)
      expect(transport.calls.every(call => call.timeout === 250 && call.killSignal === 'SIGKILL')).toBe(true)

      transport.calls.length = 0
      transport.stalled = true
      const started = transport.now
      const cleanup = await harness.cleanup()
      expect(transport.now - started).toBe(cleanupBudgetMs)
      expect(transport.calls).toEqual([{
        args: ['rm', '-f', original.containers[0]], timeout: cleanupBudgetMs, killSignal: 'SIGKILL',
      }])
      expect(cleanup.ok).toBe(false)
      expect(harness.transferOwnedIds()).toEqual(original)
      const evidence = JSON.parse(await fs.readFile(path.join(harness.evidenceDir, 'cleanup.json'), 'utf8'))
      expect(evidence).toMatchObject({ ok: false, verifiedResourcesAbsent: false, ...original })
      expect(() => harness!.verifyTransferCleanup(original)).toThrow(/ETIMEDOUT/)

      transport.stalled = false
      await expect(harness.cleanup()).resolves.toEqual({ ok: true, errors: [] })
      harness.verifyTransferCleanup(original)
      expect(harness.transferOwnedIds()).toEqual({ containers: [], volumes: [] })
      expect(transport.containers.size).toBe(0)
      expect(transport.volumes.size).toBe(0)
    } finally {
      clock.mockRestore()
      vi.unstubAllEnvs()
      if (harness) await fs.rm(harness.testRoot, { recursive: true, force: true })
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
