import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleRuntimeRetention } from '../../../../scripts/testing/runtime-retention-sample.js'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-retention-')); roots.push(root)
  const shell = path.join(root, 'x', 'exact-incarnation'); fs.mkdirSync(shell, { recursive: true })
  fs.writeFileSync(path.join(shell, 'terminal-spool-current.jsonl'), 'current')
  fs.writeFileSync(path.join(shell, 'terminal-spool-previous.jsonl'), 'previous')
  fs.writeFileSync(path.join(shell, 'host.log'), 'host')
  return { root, shell }
}
describe('live spool measurements', () => {
  it('uses the same observations for total and segment bytes while the provider appends', () => {
    const { root, shell } = fixture()
    const target = path.join(shell, 'terminal-spool-current.jsonl')
    const original = fs.lstatSync.bind(fs)
    let reads = 0
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: any) => {
      const stat = original(file, options)
      if (String(file) === target) { reads++; fs.appendFileSync(target, 'concurrent-output') }
      return stat
    }) as any)
    const observed = sampleRuntimeRetention(root, shell)
    expect(reads).toBe(1)
    expect(observed).toEqual({ terminalSpools: 15, runtimeLogs: 4, terminalOutput: { currentBytes: 7, previousBytes: 8 } })
  })
  it('rejects a foreign spool by its exact path even if it is empty', () => {
    const { root, shell } = fixture()
    const foreign = path.join(root, 'x', 'different-incarnation'); fs.mkdirSync(foreign)
    fs.writeFileSync(path.join(foreign, 'terminal-spool-current.jsonl'), '')
    expect(() => sampleRuntimeRetention(root, shell)).toThrow(/outside the single owned/)
  })
  it('counts rotated and current segments and ignores links to other directories', () => {
    const { root, shell } = fixture()
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'))
    fs.unlinkSync(path.join(shell, 'terminal-spool-current.jsonl'))
    expect(sampleRuntimeRetention(root, shell).terminalSpools).toBe(8)
  })
})
