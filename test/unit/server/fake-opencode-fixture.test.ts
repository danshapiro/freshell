// Focused-review ep3-r1 F3: the fake-opencode fork route copies the parent's
// messages with ids `msg_<child>_<1..N>_<role>` but never seeds the child's
// persistent `message_seq` row. The first prompt sent to the fork then mints
// sequence 1/2, and `INSERT OR REPLACE` OVERWRITES the copied first turn —
// the fixture's forked history diverges from real OpenCode, which can conceal
// history regressions in the e2e specs that rely on it. The fixture must seed
// the child's sequence past the copied tail. This test boots the fixture for
// real (scratch XDG_DATA_HOME), forks a two-turn session, prompts the fork,
// and asserts the copied turns SURVIVE and the new turn APPENDS.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../../..')
const FIXTURE = path.join(projectRoot, 'test/e2e-browser/fixtures/fake-opencode.cjs')

let scratch: string
let xdgDataHome: string
let auditLog: string
let server: ChildProcess | undefined
let port = 0

function allocPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no port'))
      })
    })
  })
}

async function waitForServer(p: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/session`, {
        headers: { 'x-opencode-directory': projectRoot },
      })
      if (res.status === 200) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`fake-opencode fixture did not come up on ${p}: ${String(lastError)}`)
}

interface FakeMessage {
  info: { id: string; role?: string }
  parts?: Array<{ type?: string; text?: string }>
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-oc-fork-'))
  xdgDataHome = path.join(scratch, 'xdg')
  auditLog = path.join(scratch, 'audit.jsonl')
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdgDataHome,
    FAKE_OPENCODE_AUDIT_LOG: auditLog,
  }
  // Two seeded turns in the source session (the CLI-shaped `run` entry point,
  // exactly how the e2e specs seed history).
  for (const prompt of ['turn one', 'turn two']) {
    const seeded = spawnSync(process.execPath, [FIXTURE, 'run', prompt, '--session', 'ses_src'], { env })
    expect(seeded.status).toBe(0)
  }
  port = await allocPort()
  server = spawn(process.execPath, [FIXTURE, 'serve', '--port', String(port)], { env })
  await waitForServer(port)
}, 30_000)

afterAll(() => {
  server?.kill('SIGTERM')
  server = undefined
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('fake-opencode fixture fork sequence parity (ep3-r1 F3)', () => {
  it('a prompt to a forked session APPENDS past the copied history', async () => {
    const headers = { 'content-type': 'application/json', 'x-opencode-directory': projectRoot }

    const forkRes = await fetch(`http://127.0.0.1:${port}/session/ses_src/fork`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(forkRes.status).toBe(200)
    const child = (await forkRes.json()) as { id: string }
    expect(child.id).toMatch(/^ses_fork_/)

    const promptRes = await fetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(child.id)}/prompt_async`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parts: [{ type: 'text', text: 'follow-up' }] }),
    })
    expect(promptRes.status).toBe(200)

    const messagesRes = await fetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(child.id)}/message`, { headers })
    expect(messagesRes.status).toBe(200)
    const messages = (await messagesRes.json()) as FakeMessage[]

    const ids = messages.map((m) => m.info.id)
    expect(new Set(ids).size).toBe(ids.length)

    const userTexts = messages
      .filter((m) => m.info.role === 'user')
      .map((m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'))
    expect(userTexts).toEqual(['turn one', 'turn two', 'follow-up'])
  }, 30_000)
})
