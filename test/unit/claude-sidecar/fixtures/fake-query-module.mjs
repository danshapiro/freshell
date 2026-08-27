// test/unit/server/claude-sidecar/fixtures/fake-query-module.mjs
// Scripted fake for the FRESHELL_CLAUDE_SDK_QUERY_MODULE seam (plan case 10):
// an ESM module exporting query() with the @anthropic-ai/claude-agent-sdk
// shape (async iterable + interrupt() + close()). Its canUseTool invocations
// fire on magic prompt texts and the settled decisions are surfaced back to the
// driving test as probe.resolved frames on stdout (the same newline-JSON stream
// the sidecar speaks).

let permissionCalls = 0
let questionCalls = 0

function probe(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

export function query({ prompt, options }) {
  const iterable = (async function* () {
    for await (const msg of prompt) {
      const text = msg?.message?.content?.[0]?.text
      if (text === '__raise_permission__') {
        permissionCalls += 1
        const n = permissionCalls
        const decision = await options.canUseTool(
          'Bash',
          { command: 'ls' },
          {
            toolUseID: 'toolu_fake_1',
            signal: new AbortController().signal,
            suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
            blockedPath: '/tmp/blocked',
            decisionReason: 'needs approval',
          },
        )
        probe({ type: 'probe.resolved', kind: 'permission', n, decision })
      } else if (text === '__raise_question__') {
        questionCalls += 1
        const n = questionCalls
        const decision = await options.canUseTool(
          'AskUserQuestion',
          {
            questions: [
              {
                question: 'Pick one',
                header: 'Choice',
                options: [{ label: 'A', description: 'Option A' }],
                multiSelect: false,
              },
            ],
            marker: 'keep-me',
          },
          { toolUseID: 'toolu_fake_2', signal: new AbortController().signal },
        )
        probe({ type: 'probe.resolved', kind: 'question', n, decision })
      }
    }
  })()
  return Object.assign(iterable, {
    interrupt: async () => {
      probe({ type: 'probe.interrupted' })
    },
    close: () => {},
  })
}
