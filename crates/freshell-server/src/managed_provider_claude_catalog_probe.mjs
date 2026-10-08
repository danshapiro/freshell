import { spawn } from 'node:child_process'
import { query } from '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'

// The Rust owner terminates and joins this dedicated process group after the
// bounded receipt. Keep the real query alive; never submit a user message.
const abort = new AbortController()
let prompts = 0, defaultChild = false
async function* emptyPrompt() {
  await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }))
}
let q
try {
  q = query({ prompt: emptyPrompt(), options: {
    cwd: process.argv[2], settingSources: ['project'], abortController: abort,
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      ANTHROPIC_API_KEY: 'synthetic-catalog-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
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
          try { if (JSON.parse(frame).type === 'user') prompts++ } catch { /* non-JSON transport */ }
        }
        if (pending.length > 1024 * 1024) throw new Error('fixture-native-input-profile')
        return write.call(this, chunk, ...args)
      }
      return child
    },
  } })
  const commands = await q.supportedCommands()
  process.stdout.write(JSON.stringify({
    failed: false, uid: process.geteuid(), gid: process.getegid(), defaultChild,
    zeroPrompts: prompts === 0,
    mainSelected: commands.some(command => command.name === process.argv[3]),
    nestedSelected: commands.some(command => command.name === process.argv[4]),
  }) + '\n')
} catch {
  process.stdout.write(JSON.stringify({ failed: true, stage: 'native-catalog' }) + '\n')
}
// The finite owner stops the actual native child and all inherited-group
// descendants, then waits/reaps before it restores originals or starts a case.
await new Promise(() => {})
