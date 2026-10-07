export function query({ prompt }) {
  return (async function* () {
    for await (const _ of prompt) {
      yield { type: 'user', uuid: 'native-user-uuid', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-original', content: 'Denied', is_error: true }] } }
      yield { type: 'result', subtype: 'success', uuid: 'native-result-uuid', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', is_error: false, stop_reason: 'end_turn',
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu-original', tool_input: { command: 'owned-effect' } }] }
    }
  })()
}
