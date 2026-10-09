// Controlled loader used only to exercise the real sidecar/native-hook boundary.
import { exec } from 'node:child_process'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const nativeChildren = new Set()
let nativeForks = 0
export function query({ prompt, options }) {
  if (process.env.FRESHELL_SIDECAR_TEST_PREINIT_PERMISSION === '1') {
    void options.canUseTool('Bash', { command: 'owned-preinit-effect' }, {}).then((decision) =>
      process.stdout.write(JSON.stringify({ type: 'probe.preinit-permission', decision }) + '\n'))
  }
  const nativeRoot = options.forkSession
    ? (++nativeForks === 1 ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    : options.resume ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const checkpointScenario = process.env.FRESHELL_SIDECAR_TEST_CHECKPOINT === '1'
  const child = checkpointScenario && process.env.FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY === '1'
    ? options.spawnClaudeCodeProcess({ command: process.execPath,
      args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),150))"], env: options.env }) : undefined
  if (child) {
    if (nativeChildren.size) process.stdout.write(JSON.stringify({ type: 'probe.native-overlap' }) + '\n')
    nativeChildren.add(child.pid)
    process.stdout.write(JSON.stringify({ type: 'probe.native-child', pid: child.pid }) + '\n')
    child.once('close', () => nativeChildren.delete(child.pid))
  }
  const transcriptPath = checkpointScenario ? join(options.cwd, 'native.jsonl') : '/owned/native.jsonl'
  const loaded = new Promise((resolve, reject) => {
    const command = options.settings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command
    const child = exec(command, { env: options.env }, (error) => {
      if (error) reject(error)
      else setTimeout(() => options.model === 'restore-failure' ? reject(new Error('native restoration failed')) : resolve({}), 100)
    })
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: nativeRoot, source: options.resume ? 'resume' : 'startup', cwd: options.cwd, transcript_path: transcriptPath }))
  })
  if (!checkpointScenario) void (async () => { for await (const message of prompt) process.stdout.write(JSON.stringify({ type: 'probe.native-input', text: message.message.content }) + '\n') })()
  return {
    initializationResult: () => loaded,
    async *[Symbol.asyncIterator]() {
      if (!checkpointScenario) { await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true })); return }
      await loaded
      const eager = process.env.FRESHELL_SIDECAR_TEST_CHECKPOINT_EAGER_RESUME === '1'
      async function* inputs() {
        if (eager) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          yield { eager: true }
        }
        for await (const message of prompt) yield message
      }
      for await (const message of inputs()) {
        process.stdout.write(JSON.stringify({ type: message.eager ? 'probe.native-eager-operation' : 'probe.native-input' }) + '\n')
        const input = { command: 'fixture owned harmless counter' }
        const toolUseID = 'toolu_original1'
        const assistant = { type: 'assistant', sessionId: nativeRoot, session_id: nativeRoot,
          uuid: 'assistant-original', version: '2.1.237',
          message: { id: 'msg_fixture_original', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input }] } }
        const callback = message.eager && process.env.FRESHELL_SIDECAR_TEST_CHECKPOINT_EAGER_CALLBACK_ONLY === '1'
          ? undefined : options.hooks?.PreToolUse?.[0]?.hooks?.[0]
        const hookInput = { hook_event_name: 'PreToolUse', session_id: nativeRoot,
          tool_name: 'Bash', tool_input: input, tool_use_id: toolUseID }
        if (['1', 'incomplete'].includes(process.env.FRESHELL_SIDECAR_TEST_SPLIT_BATCH)) {
          yield { type: 'stream_event', session_id: nativeRoot, event: { type: 'message_start', message: { id: assistant.message.id } } }
          yield assistant
          const first = callback(hookInput, toolUseID, { signal: options.abortController.signal })
          await new Promise((resolve) => setTimeout(resolve, 20))
          const secondInput = { command: 'second owned harmless counter' }
          yield { ...assistant, uuid: 'assistant-second', message: { id: assistant.message.id,
            content: [{ type: 'tool_use', id: 'toolu_second1', name: 'Bash', input: secondInput }] } }
          const second = callback({ ...hookInput, tool_use_id: 'toolu_second1', tool_input: secondInput },
            'toolu_second1', { signal: options.abortController.signal })
          if (process.env.FRESHELL_SIDECAR_TEST_SPLIT_BATCH !== 'incomplete') {
            yield { type: 'stream_event', session_id: nativeRoot, event: { type: 'message_stop' } }
          }
          process.stdout.write(JSON.stringify({ type: 'probe.batch-hooks', outcomes: await Promise.all([first, second]) }) + '\n')
          continue
        }
        const hookFirst = callback && process.env.FRESHELL_SIDECAR_TEST_CHECKPOINT_HOOK_FIRST === '1'
          ? callback(hookInput, toolUseID, { signal: options.abortController.signal }) : undefined
        if (!message.eager) {
          yield { type: 'stream_event', session_id: nativeRoot, event: { type: 'message_start', message: { id: assistant.message.id } } }
          yield assistant
          yield { type: 'stream_event', session_id: nativeRoot, event: { type: 'message_stop' } }
        }
        const outcome = hookFirst ? await hookFirst : callback ? await callback(hookInput, toolUseID,
          { signal: options.abortController.signal }) : {}
        if (outcome.hookSpecificOutput?.permissionDecision === 'defer') {
          const attachment = { type: 'attachment', sessionId: nativeRoot, uuid: 'checkpoint-original', version: '2.1.237',
            attachment: { type: 'hook_deferred_tool', toolUseID, toolName: 'Bash', toolInput: input,
              hookEvent: 'PreToolUse', permissionMode: options.permissionMode } }
          const bytes = JSON.stringify(assistant) + '\n' + JSON.stringify(attachment) + '\n'
          if (process.env.FRESHELL_SIDECAR_TEST_DEFERRED_TRANSCRIPT_DELAY === '1') {
            setTimeout(() => { void writeFile(transcriptPath, bytes) }, 150)
          } else await writeFile(transcriptPath, bytes)
          yield { type: 'result', subtype: 'success', session_id: nativeRoot, is_error: false,
            stop_reason: 'tool_deferred', deferred_tool_use: { id: toolUseID, name: 'Bash', input } }
        } else {
          const result = outcome.hookSpecificOutput?.permissionDecision === 'deny'
            ? { behavior: 'deny' }
            : await options.canUseTool('Bash', input, { toolUseID,
              requestId: process.env.FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID ?? 'native-query-current', signal: options.abortController.signal })
          const is_error = result.behavior !== 'allow'
          if (!is_error) await appendFile(join(options.cwd, 'effect-count'), '1\n')
          const nativeResult = { type: 'user', sessionId: nativeRoot, session_id: nativeRoot,
            uuid: 'tool-result-original', message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error }] } }
          await appendFile(transcriptPath, JSON.stringify(nativeResult) + '\n')
          yield nativeResult
          yield { type: 'result', subtype: 'success', session_id: nativeRoot, is_error: false, stop_reason: 'end_turn' }
        }
      }
    },
    close() { child?.stdin.end(); options.abortController.abort() },
  }
}
