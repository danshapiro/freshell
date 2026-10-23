// Controlled SDK implementation for the FRESHELL_CLAUDE_SDK_QUERY_MODULE seam:
// a turn whose tokens keep arriving. From the first prompt on it yields a
// `stream_event` every 5 ms (each one becomes an `sdk.stream` stdout frame)
// until the sidecar aborts or closes the query. Abort and close are appended
// to the file named by FRESHELL_TEST_SDK_RECORD, so a test can see whether
// the sidecar stopped its query even after the sidecar's stdout is gone.
import fs from 'node:fs'

function record(line) {
  const file = process.env.FRESHELL_TEST_SDK_RECORD
  if (file) fs.appendFileSync(file, `${line}\n`)
}

export function query({ prompt, options }) {
  const queue = []
  let waiting
  let stopped = false
  const wake = () => {
    const resolve = waiting
    waiting = undefined
    resolve?.()
  }
  const push = (message) => {
    queue.push(message)
    wake()
  }
  options.abortController?.signal.addEventListener('abort', () => {
    record('aborted')
    stopped = true
    wake()
  })
  push({
    type: 'system',
    subtype: 'init',
    session_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    model: options.model,
    cwd: options.cwd,
    tools: [],
  })
  void (async () => {
    for await (const _message of prompt) {
      const timer = setInterval(() => {
        if (stopped) {
          clearInterval(timer)
          return
        }
        push({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
          parent_tool_use_id: null,
        })
      }, 5)
    }
  })()
  const iterator = (async function* () {
    while (!stopped) {
      if (queue.length) yield queue.shift()
      else await new Promise((resolve) => { waiting = resolve })
    }
  })()
  return Object.assign(iterator, {
    interrupt: async () => {},
    close: () => {
      record('closed')
      stopped = true
      wake()
    },
  })
}
