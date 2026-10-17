import { spawn } from 'node:child_process'

// Public pinned SDK SpawnOptions contract, exercising a real private child.
// The synthetic SDK-added environment is created after the Rust sidecar spawn.
export function query({ options }) {
  options.stderr('synthetic-private-sdk-stderr')
  const count = options.model === 'oversized' ? 17 : 1
  const env = Object.fromEntries(Array.from({ length: count }, (_, i) => [`FRESHELL_EXEC_FIXTURE_${i}`, 'x'.repeat(64 * 1024)]))
  const command = {
    command: process.execPath,
    args: ['-e', "process.stdout.write(require('crypto').createHash('sha256').update(process.env.FRESHELL_EXEC_FIXTURE_0).digest('hex'))"],
    cwd: options.cwd,
    env,
    signal: new AbortController().signal,
  }
  const child = options.spawnClaudeCodeProcess
    ? options.spawnClaudeCodeProcess(command)
    : spawn(command.command, command.args, { cwd: command.cwd, env, signal: command.signal, stdio: ['pipe', 'pipe', 'pipe'] })
  const complete = new Promise((resolve, reject) => {
    let digest = ''
    child.stdout.on('data', chunk => { digest += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(digest) : reject(new Error('synthetic grandchild failed')))
  })
  return {
    async *[Symbol.asyncIterator]() {
      const digest = await complete
      yield { type: 'system', subtype: 'init', session_id: 'synthetic-exec-session', model: 'synthetic', tools: [] }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: digest }] } }
      yield { type: 'result', subtype: 'success', session_id: 'synthetic-exec-session', result: '' }
    },
    close() { if (child.exitCode === null) child.kill() },
    interrupt() {},
  }
}
