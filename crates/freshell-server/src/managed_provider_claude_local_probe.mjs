import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { query } from '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'

// The Rust fixture owns, terminates and joins this dedicated process group.
// The actual native MCP child records only hashes of the synthetic settings.
const [cwd, sources, consumer, consumed] = process.argv.slice(2)
const abort = new AbortController()
let prompts = 0, defaultChild = false, q
async function* emptyPrompt() {
  await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }))
}
let receipt = { failed: true, stage: 'native-local-startup' }
try {
  q = query({ prompt: emptyPrompt(), options: {
    cwd, settingSources: sources ? sources.split(',') : [], abortController: abort,
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      ANTHROPIC_API_KEY: 'synthetic-local-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    mcpServers: { localObserver: { command: '/usr/local/bin/node', args: [consumer, consumed] } },
    spawnClaudeCodeProcess: options => {
      defaultChild = options.command.includes('@anthropic-ai/claude-agent-sdk-linux-x64/')
        && options.command.endsWith('/claude')
      const child = spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stderr.resume()
      const write = child.stdin.write
      let pending = ''
      child.stdin.write = function(chunk, ...args) {
        pending += chunk.toString()
        let boundary
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const frame = pending.slice(0, boundary)
          pending = pending.slice(boundary + 1)
          try { if (JSON.parse(frame).type === 'user') prompts++ } catch {}
        }
        if (pending.length > 1024 * 1024) throw new Error('fixture-native-input-profile')
        return write.call(this, chunk, ...args)
      }
      return child
    },
  } })
  await q.initializationResult()
  for (let index = 0; index < 100; index++) {
    const statuses = await q.mcpServerStatus()
    if (statuses.some(status => status.name === 'localObserver' && status.status === 'connected')
        && existsSync(consumed)) {
      const selected = JSON.parse(readFileSync(consumed, 'utf8'))
      receipt = { failed: false, defaultChild, zeroPrompts: prompts === 0,
        uid: process.geteuid(), gid: process.getegid(), ...selected }
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
} catch {
  receipt = { failed: true, stage: 'native-local-startup', zeroPrompts: prompts === 0 }
}
process.stdout.write(JSON.stringify(receipt) + '\n')
await new Promise(() => {})
