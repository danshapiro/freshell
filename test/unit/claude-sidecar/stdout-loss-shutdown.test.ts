// @vitest-environment node

// The real sidecar (index.mjs), driven through the FRESHELL_CLAUDE_SDK_QUERY_MODULE
// seam, losing its stdout reader mid-turn. Rust drops that reader whenever it
// aborts a session's stdout consumer (a pane kill, a handoff stop), which can
// happen before it writes the shutdown line. A sidecar that is still streaming
// then writes into a pipe nobody reads. It must treat that like stdin EOF:
// stop its SDK query (which stops the claude CLI) and exit 0, instead of dying
// on an uncaught EPIPE and leaving the CLI running the turn.

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const children = new Set<ChildProcess>()
const directories: string[] = []
afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('Claude sidecar with a lost stdout reader', () => {
  it('stops its SDK query and exits 0 when the stdout reader goes away mid-stream', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sidecar-stdout-loss-'))
    directories.push(directory)
    const record = path.join(directory, 'sdk-record.txt')
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../crates/freshell-claude-sidecar/index.mjs', import.meta.url))], {
      env: {
        ...process.env,
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: fileURLToPath(new URL('./fixtures/streaming-query-module.mjs', import.meta.url)),
        FRESHELL_TEST_SDK_RECORD: record,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    let stderr = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const frames: Record<string, any>[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => frames.push(JSON.parse(line)))
    const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`)

    send({ type: 'create', requestId: 'create', model: 'opus' })
    await expect.poll(() => frames.find((frame) => frame.type === 'created'), { timeout: 5_000 }).toBeTruthy()
    const { sessionId } = frames.find((frame) => frame.type === 'created')!
    send({ type: 'send', sessionId, text: 'stream until stopped' })
    await expect.poll(() => frames.filter((frame) => frame.type === 'sdk.stream').length, { timeout: 5_000 }).toBeGreaterThan(2)

    child.stdout!.destroy()

    let timer: NodeJS.Timeout | undefined
    const exit = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the sidecar kept running without a stdout reader; stderr=${stderr}`)), 5_000)
      }),
    ]).finally(() => clearTimeout(timer))
    expect(exit, stderr).toEqual({ code: 0, signal: null })
    expect(fs.readFileSync(record, 'utf8').split('\n'), stderr).toEqual(expect.arrayContaining(['aborted', 'closed']))
  })
})
