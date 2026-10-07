// Controlled loader used only to exercise the real sidecar/native-hook boundary.
import { exec } from 'node:child_process'
export function query({ prompt, options }) {
  if (process.env.FRESHELL_SIDECAR_TEST_PREINIT_PERMISSION === '1') {
    void options.canUseTool('Bash', { command: 'owned-preinit-effect' }, {}).then((decision) =>
      process.stdout.write(JSON.stringify({ type: 'probe.preinit-permission', decision }) + '\n'))
  }
  const nativeRoot = options.resume ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const loaded = new Promise((resolve, reject) => {
    const command = options.settings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command
    const child = exec(command, { env: options.env }, (error) => {
      if (error) reject(error)
      else setTimeout(() => options.model === 'restore-failure' ? reject(new Error('native restoration failed')) : resolve({}), 100)
    })
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: nativeRoot, source: options.resume ? 'resume' : 'startup', cwd: options.cwd, transcript_path: '/owned/native.jsonl' }))
  })
  void (async () => { for await (const message of prompt) process.stdout.write(JSON.stringify({ type: 'probe.native-input', text: message.message.content }) + '\n') })()
  return {
    initializationResult: () => loaded,
    async *[Symbol.asyncIterator]() { await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true })) },
    close() { options.abortController.abort() },
  }
}
