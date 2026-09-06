// Controlled SDK implementation used through the production sidecar import seam.
let generations = 0
export function query({ prompt, options }) {
  const generation = ++generations
  const durable = options.resume ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const queue = []
  let waiting
  let closed = false
  const push = (message) => { queue.push(message); waiting?.(); waiting = undefined }
  const current = { ...options }
  push({ type: 'system', subtype: 'init', session_id: durable, model: options.model, cwd: options.cwd, tools: [], terminal_slash_commands: ['terminal-only'] })
  void (async () => {
    for await (const message of prompt) {
      process.stdout.write(`${JSON.stringify({ type: 'probe.prompt', generation, durable, model: current.model, effort: current.effort, permissionMode: current.permissionMode, content: message.message.content })}\n`)
      push(message.message.content[0]?.text === '__fail__'
        ? { type: 'result', subtype: 'error_during_execution', errors: ['Request timed out'] }
        : { type: 'result', subtype: 'success' })
    }
  })()
  const iterator = (async function* () {
    while (!closed) {
      if (queue.length) yield queue.shift()
      else await new Promise((resolve) => { waiting = resolve })
    }
  })()
  return Object.assign(iterator, {
    initializationResult: async () => {
      if (options.model === 'unavailable') throw new Error('Model is unavailable')
      return {}
    },
    supportedCommands: async () => [
      { name: 'review', description: 'Review changes', argumentHint: '[path]' },
      { name: 'terminal-only', description: 'Requires terminal' },
    ],
    setModel: async (model) => {
      if (model === 'unavailable') throw new Error('Model is unavailable')
      current.model = model
    },
    setPermissionMode: async (permissionMode) => { current.permissionMode = permissionMode },
    applyFlagSettings: async ({ effortLevel }) => {
      if (effortLevel === 'invalid') throw new Error('Effort is unavailable')
      current.effort = effortLevel ?? undefined
    },
    close: () => { closed = true; waiting?.(); waiting = undefined },
    interrupt: async () => {},
  })
}
