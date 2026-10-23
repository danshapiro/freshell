// The `replay` program step of the CLI simulator: the model's side of one
// turn the pinned CLI 2.1.237 really ran, played back into a simulated
// session. The recordings live in test/fixtures/fresh-agent/claude/
// real-cli-2.1.237/<name>/, captured by
// test/integration/providers/claude-capture-fixtures.mjs against the local
// fake endpoint:
//
//   sdk.jsonl                              the SDK messages, {t, msg}, in order
//   session.jsonl                          the transcript the CLI wrote
//   session/subagents/agent-<id>.jsonl     each subagent's transcript
//   session/subagents/agent-<id>.meta.json {agentType, description, toolUseId, spawnDepth}
//
// The step plays the recording's first turn: every SDK message after the
// turn's prompt replay up to (not including) its result, with the recorded
// spacing. Each message that the CLI persisted takes its transcript line
// (and the lines without a uuid before it) into the simulator's transcript,
// which lands about 100 ms later (F7); a subagent's lines go to its own file
// the same way, and its meta.json is written when its Agent call starts
// (F5). The simulator frames the turn as usual: system/init, the status,
// the prompt replay and its transcript line before the step, the result
// after it. So the session gets real Write/Edit results (diffs), a real
// synchronous subagent, real usage blocks and thinking, where the
// simulator's own steps have only text, Bash and a background agent.
//
// Every id of the recording is minted afresh for each replay (uuids, the
// tool_use, message and agent ids), so a session can replay a recording
// more than once and two sessions never share ids; the recorded session id
// becomes the session's own, and the recording's workspace (/fixture/ws)
// and config directory become the session's.
//
// data: {
//   recording: '<name>' (a directory under real-cli-2.1.237) or an absolute path,
//   holdBeforeMs: { '<recorded uuid>': ms }  extra time before that message
//                                            (a slow tool, so a test can look mid-turn),
//   pace: n                                  multiply the recorded spacing (default 1),
// }
// Times scale with FRESHELL_CLAUDE_SIM_TIME_SCALE like every simulated delay.
// An interrupt during a replay is not modeled: it fails the stream loudly.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { projectSlug } from './transcript.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const RECORDINGS = path.resolve(here, '../fresh-agent/claude/real-cli-2.1.237')

/** The capture tool's placeholders for the recording machine's paths. */
const RECORDED_CWD = '/fixture/ws'
const RECORDED_CONFIG_DIR = '/fixture/home/.claude'

/** Transcript lines that belong to the prompt, which the simulator writes itself. */
const PROMPT_BOOKKEEPING = new Set(['queue-operation', 'last-prompt'])

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** The API message ids and tool_use ids one recorded message or line names. */
function apiIdsOf(value, out) {
  const message = value.message ?? value.event?.message
  if (typeof message?.id === 'string') out.add(message.id)
  const blocks = [...(Array.isArray(value.message?.content) ? value.message.content : []), value.event?.content_block]
  for (const block of blocks) if (block?.type === 'tool_use' && typeof block.id === 'string') out.add(block.id)
}

/** A regex matching any of `ids` as a whole word (longest first). */
const wordsRe = (ids) => new RegExp(`\\b(?:${[...ids].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((text) => text.trim())

const recordings = new Map()

/** A recording, parsed once per process. */
export function loadRecording(name) {
  const dir = path.isAbsolute(name) ? name : path.join(RECORDINGS, name)
  const cached = recordings.get(dir)
  if (cached) return cached
  const rows = readJsonl(path.join(dir, 'sdk.jsonl')).map((text) => {
    const row = JSON.parse(text)
    return { t: row.t, msg: row.msg, text: JSON.stringify(row.msg) }
  })
  const prompt = rows.findIndex((row) => row.msg.type === 'user' && row.msg.isReplay === true && !row.msg.parent_tool_use_id)
  const result = rows.findIndex((row, index) => index > prompt && row.msg.type === 'result')
  if (prompt < 0 || result < 0) throw new Error(`the recording ${dir} has no complete turn (a prompt replay, then a result)`)
  const modelSide = rows.slice(prompt + 1, result)
  const persisted = new Set(modelSide.map((row) => row.msg.uuid).filter(Boolean))
  const lines = (file) => readJsonl(file).map((text) => ({ line: JSON.parse(text), text }))
  const main = lines(path.join(dir, 'session.jsonl'))
  const first = main.findIndex(({ line }) => persisted.has(line.uuid))
  const subagentDir = path.join(dir, 'session', 'subagents')
  const subagents = fs.existsSync(subagentDir)
    ? fs.readdirSync(subagentDir)
      .map((file) => /^agent-([A-Za-z0-9]+)\.meta\.json$/.exec(file)?.[1])
      .filter(Boolean)
      .sort()
      .map((agentId) => {
        const metaText = fs.readFileSync(path.join(subagentDir, `agent-${agentId}.meta.json`), 'utf8')
        return { agentId, metaText, toolUseId: JSON.parse(metaText).toolUseId, lines: lines(path.join(subagentDir, `agent-${agentId}.jsonl`)) }
      })
    : []
  const apiIds = new Set()
  for (const row of modelSide) apiIdsOf(row.msg, apiIds)
  for (const { line } of [...main, ...subagents.flatMap((subagent) => subagent.lines)]) apiIdsOf(line, apiIds)
  const recording = {
    dir,
    apiIds,
    sessionId: modelSide.find((row) => row.msg.session_id)?.msg.session_id ?? rows[0]?.msg.session_id,
    startT: rows[prompt].t,
    modelSide,
    // From the first line a replayed message persisted: what comes before it
    // is the prompt and its context, which the simulator wrote itself.
    main: first < 0 ? [] : main.slice(first).filter(({ line }) => !PROMPT_BOOKKEEPING.has(line.type)),
    subagents,
  }
  recordings.set(dir, recording)
  return recording
}

/** Fresh ids (and the session's paths) for one replay of a recording. */
class Remap {
  constructor(cli, recording) {
    this.uuids = new Map([[recording.sessionId, cli.sessionId]])
    const token = randomBytes(3).toString('hex')
    this.apiIds = new Map([...recording.apiIds].map((id) => [id, `${id}r${token}`]))
    this.apiIdsRe = recording.apiIds.size ? wordsRe(recording.apiIds) : null
    this.agentIds = new Map(recording.subagents.map(({ agentId }) => [agentId, `a${randomBytes(8).toString('hex')}`]))
    const jsonText = (value) => JSON.stringify(value).slice(1, -1)
    this.paths = [
      [RECORDED_CONFIG_DIR, jsonText(cli.configDir)],
      [RECORDED_CWD, jsonText(cli.cwd)],
      [projectSlug(RECORDED_CWD), projectSlug(cli.cwd)],
    ]
  }

  uuid(recorded) {
    if (!this.uuids.has(recorded)) this.uuids.set(recorded, randomUUID())
    return this.uuids.get(recorded)
  }

  agentId(recorded) {
    return this.agentIds.get(recorded) ?? recorded
  }

  /** One recorded JSON text with every id and path replaced. */
  text(recorded) {
    let text = recorded.replace(UUID_RE, (id) => this.uuid(id))
    if (this.apiIdsRe) text = text.replace(this.apiIdsRe, (id) => this.apiIds.get(id))
    for (const [from, to] of this.agentIds) text = text.split(from).join(to)
    for (const [from, to] of this.paths) text = text.split(from).join(to)
    return text
  }

  json(recorded) {
    return JSON.parse(this.text(recorded))
  }
}

/** A JSONL file the CLI appends to, flushed about 100 ms after each write (F7). */
class LaggedFile {
  constructor(cli, file) {
    this.cli = cli
    this.file = file
    this.pending = []
    this.timer = null
  }

  append(texts) {
    this.pending.push(...texts)
    if (this.timer || this.pending.length === 0) return
    this.timer = setTimeout(() => this.flush(), this.cli.ms(100))
    this.cli.timers.add(this.timer)
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.cli.timers.delete(this.timer)
      this.timer = null
    }
    // A dead CLI writes nothing more.
    if (this.cli.dead || this.pending.length === 0) return
    const texts = this.pending.splice(0)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, texts.map((text) => `${text}\n`).join(''))
  }
}

/**
 * One file's recorded lines, written in order: `through(uuid)` writes every
 * line up to and including the one with that (recorded) uuid.
 */
class LinePlayer {
  constructor(lines, write) {
    this.lines = lines
    this.next = 0
    this.write = write
  }

  has(uuid) {
    return this.lines.some(({ line }, index) => index >= this.next && line.uuid === uuid)
  }

  through(uuid) {
    const end = this.lines.findIndex(({ line }, index) => index >= this.next && line.uuid === uuid)
    if (end < 0) return
    this.write(this.lines.slice(this.next, end + 1))
    this.next = end + 1
  }

  rest() {
    this.write(this.lines.slice(this.next))
    this.next = this.lines.length
  }
}

/** The tool_use ids a (recorded) assistant message starts. */
const toolUseIdsOf = (msg) => (msg.type === 'assistant' && Array.isArray(msg.message?.content)
  ? msg.message.content.filter((block) => block?.type === 'tool_use').map((block) => block.id)
  : [])

/**
 * Play the recording's turn into `turn` (see the header). Returns 'done', or
 * 'dead' when the CLI died meanwhile (a dead CLI says nothing more).
 */
export async function replayTurn(cli, turn, data = {}) {
  if (!data.recording) throw new Error('a `replay` step needs data.recording')
  const recording = loadRecording(data.recording)
  const remap = new Remap(cli, recording)
  const pace = Number(data.pace ?? 1)
  const holds = data.holdBeforeMs ?? {}

  // The main transcript: each replayed line continues the session's chain
  // (a recorded parent the replay did not write is the session's last line).
  const written = new Set()
  const main = new LinePlayer(recording.main, (lines) => {
    for (const { text } of lines) {
      const line = remap.json(text)
      if (typeof line.parentUuid === 'string' && !written.has(line.parentUuid)) line.parentUuid = cli.transcript.lastUuid
      if (typeof line.uuid === 'string') written.add(line.uuid)
      cli.transcript.appendVerbatim(line)
    }
  })
  const subagentDir = path.join(cli.transcript.file.replace(/\.jsonl$/, ''), 'subagents')
  const subagents = recording.subagents.map((subagent) => {
    const name = `agent-${remap.agentId(subagent.agentId)}`
    const file = new LaggedFile(cli, path.join(subagentDir, `${name}.jsonl`))
    const state = { subagent, file, metaWritten: false }
    state.writeMeta = () => {
      if (state.metaWritten || cli.dead) return
      state.metaWritten = true
      fs.mkdirSync(subagentDir, { recursive: true })
      fs.writeFileSync(path.join(subagentDir, `${name}.meta.json`), remap.text(subagent.metaText))
    }
    state.player = new LinePlayer(subagent.lines, (lines) => {
      state.writeMeta()
      file.append(lines.map(({ text }) => remap.text(text)))
    })
    return state
  })

  let previousT = recording.startT
  for (const row of recording.modelSide) {
    const gap = Math.max(0, row.t - previousT) * pace + Number(holds[row.msg.uuid] ?? 0)
    previousT = row.t
    if (gap > 0 && await cli.wait(gap, turn)) {
      if (cli.dead) return 'dead'
      throw new Error('an interrupt during a replayed turn is not modeled')
    }
    if (cli.dead) return 'dead'
    // The Agent call starts its subagent: the CLI writes the meta file at spawn.
    for (const id of toolUseIdsOf(row.msg)) subagents.find((s) => s.subagent.toolUseId === id)?.writeMeta()
    if (row.msg.type !== 'stream_event' || cli.partial) cli.emit(remap.json(row.text))
    const uuid = row.msg.uuid
    if (!uuid) continue
    if (main.has(uuid)) main.through(uuid)
    else subagents.find((s) => s.player.has(uuid))?.player.through(uuid)
  }
  main.rest()
  for (const { player, file } of subagents) {
    player.rest()
    file.flush()
  }

  const topLevel = recording.modelSide.map((row) => row.msg).filter((msg) => !msg.parent_tool_use_id)
  turn.requests += topLevel.filter((msg) => msg.type === 'system' && msg.subtype === 'status' && msg.status === 'requesting').length
  const lastText = topLevel.filter((msg) => msg.type === 'assistant')
    .flatMap((msg) => msg.message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .at(-1)?.text
  if (lastText !== undefined) turn.lastText = lastText
  return 'done'
}
