// HARNESS-03 — deterministic provider-fixture core engine.
//
// Shared engine behind the six remaining fake provider executables in this
// directory (fake-claude / fake-gemini / fake-kimi / fake-amplifier terminal
// CLIs, fake-codex-app-server, fake-opencode-server). It provides two uniform,
// provider-independent observability surfaces plus a scriptable event engine:
//
//   - Launch ledger (env FRESHELL_FAKE_LEDGER): one JSONL row per process
//     launch — { t, pid, provider, argv, cwd, env } where `env` is STRICTLY
//     allowlisted (see recordedEnv) so credentials can never leak into test
//     artifacts.
//   - Event ledger (env FRESHELL_FAKE_EVENTS): one JSONL row per emitted
//     event — { t, pid, provider, kind, data, trigger } — recorded for every
//     event regardless of how the provider's wire protocol renders it, so a
//     contract spec can assert one uniform stream across all seven fakes.
//
// Event kinds (the checklist enumeration): session, activity, approval,
// question, completion, crash, resume — plus `marker` (fixture-only
// diagnostics).
//
// Control surface (the "controllable" part): a JSON program supplied via
// FRESHELL_FAKE_PROGRAM (inline) or FRESHELL_FAKE_PROGRAM_FILE (path; inline
// wins):
//
//   {
//     "sessionId": "fixed-id",                        // optional
//     "rules": [
//       { "on": "start",                              // trigger, see parseOn
//         "match": { "text": "please ask" },          // optional deep-subset
//         "once": true,                               // optional
//         "emit": [
//           { "kind": "activity" },
//           { "kind": "completion", "delayMs": 50, "data": { "subtype": "success" } }
//         ] }
//     ]
//   }
//
// Trigger grammar: "start" | "stdin:<regex>" | "msg:<type>" | "rpc:<method>"
// | "http:<METHOD> <path-regex>". `match` applies to: stdin {line}, the whole
// bridge message, rpc params, or the http body. Emissions run in array order;
// `delayMs` sleeps before that emission. `crash` records the event then exits
// through the injected exit seam (production adapters pass process.exit)
// defaulting to code 1.
//
// Adapter contract: construct `new FixtureEngine({ provider, program, env,
// write, exitFn })`, call `engine.start()` once, then feed triggers via
// handleStdinLine/handleMessage/handleRpc/handleHttp. Each returns a Set of
// the kinds it emitted for that trigger so adapters can skip provider
// defaults the program deliberately replaced (e.g. a program that emits its
// own completion suppresses the adapter's canned one). `write` receives the
// normalized { provider, kind, data, trigger } for wire rendering.
import fs from 'node:fs'
import path from 'node:path'

export const LEDGER_ENV = 'FRESHELL_FAKE_LEDGER'
export const EVENTS_ENV = 'FRESHELL_FAKE_EVENTS'
export const PROGRAM_ENV = 'FRESHELL_FAKE_PROGRAM'
export const PROGRAM_FILE_ENV = 'FRESHELL_FAKE_PROGRAM_FILE'
export const ENV_RECORD_ENV = 'FRESHELL_FAKE_ENV_RECORD'
export const PROVIDER_ENV = 'FRESHELL_FAKE_PROVIDER'

const CONTROL_ENV_PREFIX = 'FRESHELL_FAKE_'

/** Deep-subset match: every key in `match` must deep-equal (recursively) in `payload`. Arrays must be exactly equal. */
export function isSubset(match, payload) {
  if (match === undefined || match === null) return true
  if (
    typeof match === 'object' &&
    !Array.isArray(match) &&
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    return Object.keys(match).every((key) => isSubset(match[key], payload[key]))
  }
  if (Array.isArray(match) || Array.isArray(payload)) {
    if (!Array.isArray(match) || !Array.isArray(payload)) return false
    if (match.length !== payload.length) return false
    return match.every((entry, i) => isSubset(entry, payload[i]))
  }
  return Object.is(match, payload)
}

/**
 * The env-block of a ledger row: ONLY keys under the FRESHELL_FAKE_ control
 * namespace plus the exact names requested via FRESHELL_FAKE_ENV_RECORD
 * (comma-separated). Nothing else is ever recorded — a fixture must never
 * become a credential-exfiltration channel (ANTHROPIC_API_KEY et al stay out
 * of test artifacts).
 */
export function recordedEnv(env) {
  const out = {}
  for (const key of Object.keys(env)) {
    if (key.startsWith(CONTROL_ENV_PREFIX)) out[key] = env[key]
  }
  const requested = (env[ENV_RECORD_ENV] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  for (const name of requested) {
    if (env[name] !== undefined) out[name] = env[name]
  }
  return out
}

/** Append one JSONL row to `filePath` (creating parent dirs); no-op on a falsy path. */
export function appendJsonl(filePath, row) {
  if (!filePath) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`)
}

/** Append the launch row { t, pid, provider, argv, cwd, env } to FRESHELL_FAKE_LEDGER. No-op when unset. */
export function appendLaunchLedger({ provider, argv, env, cwd }) {
  const ledgerPath = env[LEDGER_ENV]
  if (!ledgerPath) return
  appendJsonl(ledgerPath, {
    t: Date.now(),
    pid: process.pid,
    provider,
    argv: argv ?? process.argv.slice(2),
    cwd: cwd ?? process.cwd(),
    env: recordedEnv(env),
  })
}

/** Load the fixture program. Inline JSON beats the file. Absent → { rules: [] }. */
export function loadProgram(env = process.env) {
  const inline = env[PROGRAM_ENV]
  const file = env[PROGRAM_FILE_ENV]
  if (inline !== undefined && inline.trim().length > 0) {
    try {
      return normalizeProgram(JSON.parse(inline))
    } catch (err) {
      throw new Error(`Invalid ${PROGRAM_ENV} JSON: ${err?.message ?? err}`)
    }
  }
  if (file) {
    try {
      return normalizeProgram(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (err) {
      throw new Error(`Invalid ${PROGRAM_FILE_ENV} JSON (${file}): ${err?.message ?? err}`)
    }
  }
  return normalizeProgram({})
}

function normalizeProgram(program) {
  if (!program || typeof program !== 'object' || Array.isArray(program)) {
    throw new Error('Fixture program must be a JSON object')
  }
  return { ...program, rules: Array.isArray(program.rules) ? program.rules : [] }
}

/** Parse a rule trigger into { kind, arg }. Throws on an unknown family so typos fail loudly. */
export function parseOn(on) {
  if (typeof on !== 'string' || on.length === 0) {
    throw new Error(`Fixture rule requires a string "on", got: ${JSON.stringify(on)}`)
  }
  if (on === 'start') return { kind: 'start' }
  for (const family of ['stdin', 'msg', 'rpc']) {
    if (on.startsWith(`${family}:`)) return { kind: family, arg: on.slice(family.length + 1) }
  }
  if (on.startsWith('http:')) {
    const rest = on.slice('http:'.length)
    const space = rest.indexOf(' ')
    if (space <= 0) throw new Error(`http trigger must be "http:<METHOD> <path-regex>", got: ${on}`)
    return { kind: 'http', method: rest.slice(0, space).toUpperCase(), pathRegex: rest.slice(space + 1) }
  }
  throw new Error(`Unknown fixture trigger: ${on}`)
}

function ruleMatches(rule, trigger, payload) {
  const spec = parseOn(rule.on)
  if (spec.kind !== trigger) return false
  switch (spec.kind) {
    case 'start':
      return true
    case 'stdin':
      if (!new RegExp(spec.arg).test(String(payload?.line ?? ''))) return false
      return isSubset(rule.match, { line: String(payload?.line ?? '') })
    case 'msg':
      return payload?.type === spec.arg && isSubset(rule.match, payload)
    case 'rpc':
      return payload?.method === spec.arg && isSubset(rule.match, payload?.params)
    case 'http':
      return (
        String(payload?.method ?? '').toUpperCase() === spec.method &&
        new RegExp(spec.pathRegex).test(String(payload?.path ?? '')) &&
        isSubset(rule.match, payload?.body)
      )
    default:
      return false
  }
}

export class FixtureEngine {
  /**
   * @param {{ provider: string, program?: object, env?: object,
   *           write?: (event: object) => (void|Promise<void>),
   *           exitFn?: (code: number) => void }} opts
   */
  constructor({ provider, program, env = process.env, write = () => {}, exitFn = (code) => process.exit(code) }) {
    this.provider = provider
    this.program = program ?? loadProgram(env)
    this.env = env
    this.write = write
    this.exitFn = exitFn
    this.firedOnceRules = new Set()
    this.started = false
  }

  /** Fire all `start` rules (exactly once). */
  async start() {
    if (this.started) return new Set()
    this.started = true
    return this.fire('start', {})
  }

  /** Record + render one event. Returns the normalized event. */
  async emitEvent(kind, data, trigger) {
    const event = { provider: this.provider, kind, data: data ?? {}, trigger }
    appendJsonl(this.env[EVENTS_ENV], {
      t: Date.now(),
      pid: process.pid,
      provider: this.provider,
      kind,
      data: data ?? {},
      trigger,
    })
    await this.write(event)
    if (kind === 'crash') {
      // `delayMs` on an emission is consumed by fire()'s schedule BEFORE the
      // event lands; once a crash is recorded the process exits immediately
      // (real CLIs don't linger after dying).
      const code = Number.isFinite(Number(data?.code)) ? Number(data.code) : 1
      setTimeout(() => this.exitFn(code), 0)
    }
    return event
  }

  /** The resume edge (argv-shaped resume launch, or an HTTP resume probe). */
  async emitResume(id, trigger = 'argv') {
    return this.emitEvent('resume', { id }, trigger)
  }

  /** The session-identity edge (argv-shaped launch, or an RPC/HTTP create). */
  async emitSession(id, trigger = 'argv') {
    return this.emitEvent('session', { id }, trigger)
  }

  /** Fire every matching rule for a trigger. Returns the Set of emitted kinds. */
  async fire(trigger, payload) {
    const emitted = new Set()
    let ruleIndex = -1
    for (const rule of this.program.rules ?? []) {
      ruleIndex += 1
      if (rule.once && this.firedOnceRules.has(ruleIndex)) continue
      if (!ruleMatches(rule, trigger, payload)) continue
      if (rule.once) this.firedOnceRules.add(ruleIndex)
      for (const emission of rule.emit ?? []) {
        const delay = Number(emission?.delayMs ?? 0)
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
        const data = emission?.data !== undefined ? { ...emission.data } : {}
        await this.emitEvent(emission?.kind, data, rule.on)
        emitted.add(emission?.kind)
      }
    }
    return emitted
  }

  handleStdinLine(line) {
    return this.fire('stdin', { line })
  }

  handleMessage(message) {
    return this.fire('msg', message)
  }

  handleRpc(method, params) {
    return this.fire('rpc', { method, params })
  }

  handleHttp(method, pathName, body) {
    return this.fire('http', { method, path: pathName, body })
  }
}

/** Keep an interactive fixture process alive (like a real TUI waiting on stdin). */
export function keepAlive() {
  process.stdin.resume()
  setInterval(() => {}, 60_000)
}

/**
 * Line-buffering stdin driver for terminal-CLI adapters: accumulates chunks,
 * invokes onLine for each completed line (CR/LF terminated), flushes the
 * remainder on end. Returns the chunk handler.
 */
export function lineDriver(onLine) {
  let carry = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    carry += String(chunk)
    let idx
    while ((idx = carry.search(/[\r\n]/)) !== -1) {
      const line = carry.slice(0, idx)
      carry = carry.slice(idx + 1)
      if (line.length > 0) void onLine(line)
    }
  })
  process.stdin.on('end', () => {
    if (carry.length > 0) void onLine(carry)
    carry = ''
  })
}
