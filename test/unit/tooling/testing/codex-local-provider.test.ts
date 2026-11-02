// @vitest-environment node
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The native fixture also runs directly in Node.
import { startInManagedContext } from '../../../integration/providers/codex-local-provider.mjs'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

// Execute the helper's real probes against an in-memory provider namespace.
// Every exec resolves asynchronously, like the owned Docker probe API.
function providerRig() {
  const files = new Map<string, string>()
  const signals: { pid: number; signal: string }[] = []
  const gates: Promise<void>[] = []
  const ready = { baseUrl: 'http://127.0.0.1:51991/v1', uid: 65534, gid: 0, pid: 2345, node: 'fixture' }
  let directory = ''
  const rig = {
    runtime: { isContainerRunning: vi.fn(() => true) },
    ownedProviderExec: vi.fn(async (_containerId: string, args: string[]) => {
      await (gates.shift() ?? Promise.resolve())
      if (args[0] === 'cat') return files.get(args[1]) ?? ''
      expect(args.slice(0, 2)).toEqual(['node', '-e'])
      let output = ''
      const providerFs = {
        mkdirSync: (name: string) => { directory = name },
        openSync: () => 1,
        existsSync: (name: string) => files.has(name),
        readFileSync: (name: string) => {
          if (!files.has(name)) throw new Error(`missing fixture file: ${name}`)
          return files.get(name)!
        },
        writeFileSync: (name: string, value: string) => {
          files.set(name, value)
          if (name === `${directory}/pid`) files.set(`${directory}/ready.json`, JSON.stringify(ready))
        },
      }
      vm.runInNewContext(args[2], {
        require: (name: string) => {
          if (name === 'node:fs') return providerFs
          if (name === 'node:child_process') return { spawn: () => ({ pid: ready.pid, unref() {} }) }
          throw new Error(`unexpected provider module: ${name}`)
        },
        process: {
          execPath: '/provider/node',
          stdout: { write: (value: string) => { output += value } },
          kill: (pid: number, signal: string) => {
            signals.push({ pid, signal })
            files.set(`${directory}/closed`, 'closed')
          },
        },
      })
      return output
    }),
  }
  return { rig, files, signals, gates, ready, directory: () => directory }
}

const source = { containerId: 'a'.repeat(64), handlerSource: 'async () => ({ text: "fixture" })' }

describe('managed Codex model-wire fixture', () => {
  it('awaits launch before reading and parsing readiness without eagerly reading stderr', async () => {
    const fixture = providerRig()
    const launch = barrier()
    fixture.gates.push(launch.promise)
    const started = startInManagedContext(fixture.rig, source)
    // Retain rejection until the assertion completes on the broken helper.
    void started.catch(() => {})
    await Promise.resolve()
    expect(fixture.rig.ownedProviderExec).toHaveBeenCalledTimes(1)
    launch.release()
    const model = await started
    expect(model.context).toEqual(fixture.ready)
    expect(model.baseUrl).toBe(fixture.ready.baseUrl)
    expect(fixture.rig.ownedProviderExec).toHaveBeenCalledTimes(2)
    await model.stop()
  })

  it('awaits traffic reads and returns fresh parsed wire observations', async () => {
    const fixture = providerRig()
    const model = await startInManagedContext(fixture.rig, source)
    const trafficPath = `${fixture.directory()}/traffic.jsonl`
    const first = { path: '/v1/responses', body: { model: 'first' } }
    fixture.files.set(trafficPath, `${JSON.stringify(first)}\n`)
    const read = barrier()
    fixture.gates.push(read.promise)
    let settled = false
    const pending = model.readTraffic().then((rows: unknown[]) => { settled = true; return rows })
    await Promise.resolve()
    expect(settled).toBe(false)
    read.release()
    expect(await pending).toEqual([first])
    const second = { path: '/v1/responses', body: { model: 'second' } }
    fixture.files.set(trafficPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    expect(await model.readTraffic()).toEqual([first, second])
    await model.stop()
  })

  it('awaits the owned PID signal and verified closure before finishing stop', async () => {
    const fixture = providerRig()
    const model = await startInManagedContext(fixture.rig, source)
    const signal = barrier(), closed = barrier()
    fixture.gates.push(signal.promise, closed.promise)
    const probesBeforeStop = fixture.rig.ownedProviderExec.mock.calls.length
    let settled = false
    const stopping = model.stop().then(() => { settled = true })
    await Promise.resolve()
    expect(fixture.rig.ownedProviderExec).toHaveBeenCalledTimes(probesBeforeStop + 1)
    expect(fixture.signals).toEqual([])
    signal.release()
    await vi.waitFor(() => expect(fixture.signals).toEqual([{ pid: fixture.ready.pid, signal: 'SIGTERM' }]))
    expect(settled).toBe(false)
    closed.release()
    await stopping
    expect(settled).toBe(true)
  })

  it('refuses to signal a PID whose owned record changed', async () => {
    const fixture = providerRig()
    const model = await startInManagedContext(fixture.rig, source)
    fixture.files.set(`${fixture.directory()}/pid`, '9999')
    await expect(model.stop()).rejects.toThrow('fixture PID changed')
    expect(fixture.signals).toEqual([])
  })
})
