// Synthetic SDK stream for the body-free ordinary-turn completion contract.
export function query({ prompt, options }) {
  const queue = []
  let wake
  let closed = false
  const push = (message) => {
    queue.push(message)
    wake?.()
    wake = undefined
  }
  const close = () => {
    closed = true
    wake?.()
    wake = undefined
  }

  push({ type: 'system', subtype: 'init', session_id: options.sessionId, model: 'synthetic', tools: [] })
  void (async () => {
    for await (const message of prompt) {
      const marker = message?.message?.content?.[0]?.text
      if (marker === '__test_pending_eof__') {
        setTimeout(close, 20)
        return
      }
      push({
        type: 'result',
        subtype: marker === '__test_failed_result__' ? 'error_during_execution' : 'success',
        ...(marker === '__test_failed_result__' ? { errors: ['synthetic provider failure detail'] } : {}),
      })
    }
  })()

  const iterable = (async function* () {
    while (!closed || queue.length > 0) {
      if (queue.length > 0) yield queue.shift()
      else await new Promise((resolve) => { wake = resolve })
    }
  })()
  return Object.assign(iterable, { initializationResult: async () => ({}), close, interrupt: async () => {} })
}
