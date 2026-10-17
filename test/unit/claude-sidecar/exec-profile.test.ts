// @vitest-environment node
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function consume(model: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sdk-exec-profile-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../crates/freshell-claude-sidecar/index.mjs', import.meta.url))], {
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd,
      FRESHELL_HOSTED_FRESH_AGENT: 'claude',
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: fileURLToPath(new URL('./fixtures/exec-profile-query-module.mjs', import.meta.url)),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: any[] = []
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', line => frames.push(JSON.parse(line)))
  child.stdin!.write(`${JSON.stringify({ type: 'create', requestId: 'exec-profile', model, cwd })}\n`)
  try {
    const deadline = Date.now() + 5_000
    while (!frames.some(frame => ['create.failed', 'sdk.assistant', 'sdk.error'].includes(frame.type)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { frames, stderr }
  } finally {
    lines.close()
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await rm(cwd, { recursive: true })
  }
}

it('rejects the actual SDK grandchild final environment after SDK additions', async () => {
  const { frames } = await consume('oversized')
  expect(frames.find(frame => frame.type === 'create.failed')?.message).toContain('provider exec profile')
  expect(frames.some(frame => frame.type === 'sdk.assistant')).toBe(false)
})

it('lets a valid SDK child consume its finite environment through the real spawn callback', async () => {
  const { frames, stderr } = await consume('valid')
  const digest = createHash('sha256').update('x'.repeat(64 * 1024)).digest('hex')
  expect(frames.find(frame => frame.type === 'sdk.assistant')?.content).toEqual([{ type: 'text', text: digest }])
  expect(frames.some(frame => frame.type === 'create.failed')).toBe(false)
  expect(stderr).not.toContain('synthetic-private-sdk-stderr')
  expect(stderr.split('\n').filter(Boolean).map(line => JSON.parse(line))).toContainEqual({ severity: 'warn', component: 'claude-sidecar', event: 'provider.stderr', bytes: 28 })
})
