// test/unit/server/claude-sidecar/fixtures/fake-query-module.mjs
// Scripted fake for the FRESHELL_CLAUDE_SDK_QUERY_MODULE seam (plan case 10):
// an ESM module exporting query() with the @anthropic-ai/claude-agent-sdk
// shape (async iterable + interrupt() + close()). Its canUseTool invocations
// fire on magic prompt texts and the settled decisions are surfaced back to the
// driving test as probe.resolved frames on stdout (the same newline-JSON stream
// the sidecar speaks).
//
// ep4-r6 (F1 realism): the prompt-reading side RUNS EAGERLY and asynchronous
// output lives on its own queue — the real SDK drains submitted inputs
// independently of producing their results, which is exactly the window an
// unrelated earlier result landing inside a still-armed handed-compact window
// needs. Category summary of the branches:
//  - `__raise_permission__` / `__raise_question__`: park-and-answer via the
//    injected canUseTool (unchanged, one-at-a-time);
//  - `__park_<ms>__`: parks the THIS-SIDE input pump for ms (models an SDK
//    consumer that is provably not awaiting — sidecar-queue items persist).
//  - `__open_turn__`: emits an assistant frame right away and returns (no
//    result — a still-open turn).
//  - `/compact ...`: emits probe.compact_running now, then (via the out queue,
//    after the prompt loop moves on) status compacting at +300ms and the run
//    result at +500ms. Between those deferred emissions OTHER prompts are
//    processed normally — the compact's so-called handoff window.
//  - `__one_result__`: emits a bare result frame immediately (models an
//    unrelated turn's terminal landing inside another op's window).

let permissionCalls = 0
let questionCalls = 0

function probe(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function query({ prompt, options }) {
  const outQueue = []
  let outResolve = null
  const pushOut = (v) => {
    outQueue.push(v)
    if (outResolve) {
      const r = outResolve
      outResolve = null
      r()
    }
  }

  ;(async () => {
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
      } else if (text && /^__park_\d+__$/.test(text)) {
        // Parks the prompt-pump (the THIS-SIDE consumer is provably not
        // awaiting next"); pushes from the sidecar stack up in its queue.
        const ms = Number(text.slice('__park_'.length, -2))
        await sleep(ms)
      } else if (text === '__open_turn__') {
        // Emits an assistant frame right away but never a result — the
        // sidecar's turnOpen flag stays true until one.
        pushOut({ type: 'assistant', message: { content: [] }, session_id: 'ses-open' })
      } else if (typeof text === 'string' && /^\s*\/compact(\s|$)/.test(text)) {
        // The compact RUN starts now but its evidence is deferred: status at
        // +300ms, result at +500ms — and meanwhile OTHER prompts process
        // normally (the unrelated-result-inside-the-window scenario, ep4-r6).
        probe({ type: 'probe.compact_running', text })
        setTimeout(() => {
          pushOut({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'ses-compact' })
        }, 300)
        setTimeout(() => {
          pushOut({ type: 'result', subtype: 'success', session_id: 'ses-compact' })
        }, 500)
      } else if (text === '__one_result__') {
        pushOut({ type: 'result', subtype: 'success', session_id: 'other-turn' })
      }
    }
  })()

  const iterable = (async function* () {
    while (true) {
      if (outQueue.length > 0) {
        yield outQueue.shift()
      } else {
        await new Promise((resolve) => {
          outResolve = resolve
        })
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
