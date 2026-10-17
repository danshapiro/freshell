const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function query({ prompt, options }) {
  const mode = process.env.FRESHELL_FAKE_CHECKPOINT_REPLAY || 'match'
  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'claude-native-session', model: 'fake', cwd: '/tmp' }
      const input = await prompt[Symbol.asyncIterator]().next()
      if (input.done) return
      if (!UUID_RE.test(input.value.uuid || '')) throw new Error('SDK input did not receive a valid v4 UUID')
      if (input.value.message?.role !== 'user') throw new Error('SDK input was not a user message')
      if (options.extraArgs?.['replay-user-messages'] !== null) throw new Error('replay-user-messages is not enabled')

      if (mode !== 'absent') {
        yield {
          type: 'user',
          isReplay: mode !== 'ordinary',
          uuid: mode === 'mismatch' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : input.value.uuid,
          session_id: input.value.session_id,
          message: { role: 'user', content: input.value.message.content },
          parent_tool_use_id: null,
        }
      }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'not identity evidence' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }
    },
    close() {},
  }
  return iterable
}
