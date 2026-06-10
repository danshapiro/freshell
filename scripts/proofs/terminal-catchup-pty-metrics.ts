import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'
import { TerminalRegistry } from '../../server/terminal-registry.js'
import { TerminalStreamBroker } from '../../server/terminal-stream/broker.js'
import { TERMINAL_STREAM_BATCH_MAX_BYTES } from '../../server/terminal-stream/constants.js'

type RawChunk = {
  at: number
  bytes: number
  chars: number
  data: string
}

type SentMessage = {
  at: number
  bytes: number
  type?: string
  message: any
}

type Scenario = {
  name: string
  command: string
  timeoutMs: number
  marker: string
}

type ScannerState = 'ground' | 'esc' | 'csi' | 'osc' | 'dcs' | 'apc' | 'pm' | 'sos' | 'stringEsc'

type ScannerFrame = {
  startState: ScannerState
  endState: ScannerState
  hasControl: boolean
  hasSideEffectBarrier: boolean
  hasReplacement: boolean
  conservativeBarrier: boolean
}

type MockSocket = WebSocket & {
  sent: SentMessage[]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const artifactDir = path.resolve(repoRoot, 'docs/superpowers/proofs/artifacts')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(values: number[]) {
  return {
    min: values.length ? Math.min(...values) : 0,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : 0,
  }
}

function createMockSocket(connectionId: string): MockSocket {
  const sent: SentMessage[] = []
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    connectionId,
    sent,
    send(data: string, cb?: (err?: Error) => void) {
      const parsed = JSON.parse(data)
      sent.push({
        at: Date.now(),
        bytes: Buffer.byteLength(data, 'utf8'),
        type: typeof parsed?.type === 'string' ? parsed.type : undefined,
        message: parsed,
      })
      cb?.()
    },
    close() {
      this.readyState = WebSocket.CLOSED
    },
  } as unknown as MockSocket
}

function scanFrame(data: string, startState: ScannerState): ScannerFrame {
  let state = startState
  let stringReturnState: ScannerState = 'osc'
  let hasControl = false
  let hasSideEffectBarrier = false
  let hasReplacement = false

  const enterString = (next: ScannerState) => {
    state = next
    stringReturnState = next
    hasControl = true
    hasSideEffectBarrier = true
  }

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]
    const code = ch.codePointAt(0) ?? 0
    if (code > 0xffff) i += 1
    if (ch === '\uFFFD') hasReplacement = true

    if (state === 'ground') {
      if (ch === '\u001b') {
        state = 'esc'
        hasControl = true
        continue
      }
      if (code === 0x9b) {
        state = 'csi'
        hasControl = true
        continue
      }
      if (code === 0x9d) {
        enterString('osc')
        continue
      }
      if (code === 0x90) {
        enterString('dcs')
        continue
      }
      if (code === 0x9f) {
        enterString('apc')
        continue
      }
      if (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') {
        hasControl = true
        if (ch === '\u0007') hasSideEffectBarrier = true
      }
      continue
    }

    if (state === 'esc') {
      if (ch === '[') {
        state = 'csi'
      } else if (ch === ']') {
        enterString('osc')
      } else if (ch === 'P') {
        enterString('dcs')
      } else if (ch === '_') {
        enterString('apc')
      } else if (ch === '^') {
        enterString('pm')
      } else if (ch === 'X') {
        enterString('sos')
      } else {
        state = 'ground'
      }
      continue
    }

    if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) {
        if (data.slice(Math.max(0, i - 16), i + 1).includes('$')) {
          hasSideEffectBarrier = true
        }
        state = 'ground'
      }
      continue
    }

    if (state === 'osc' || state === 'dcs' || state === 'apc' || state === 'pm' || state === 'sos') {
      if (ch === '\u0007') {
        state = 'ground'
      } else if (ch === '\u001b') {
        stringReturnState = state
        state = 'stringEsc'
      }
      continue
    }

    if (state === 'stringEsc') {
      state = ch === '\\' ? 'ground' : stringReturnState
    }
  }

  return {
    startState,
    endState: state,
    hasControl,
    hasSideEffectBarrier,
    hasReplacement,
    conservativeBarrier: startState !== 'ground' || state !== 'ground' || hasSideEffectBarrier || hasReplacement,
  }
}

function conservativeScannerBatches(chunks: RawChunk[], budgetBytes: number) {
  const frames: ScannerFrame[] = []
  let state: ScannerState = 'ground'
  let groups = 0
  let currentBytes = 0

  for (const chunk of chunks) {
    const frame = scanFrame(chunk.data, state)
    frames.push(frame)
    state = frame.endState
    const mustSplit = frame.conservativeBarrier || currentBytes + chunk.bytes > budgetBytes
    if (groups === 0 || mustSplit) {
      groups += 1
      currentBytes = chunk.bytes
    } else {
      currentBytes += chunk.bytes
    }
    if (frame.conservativeBarrier) {
      currentBytes = 0
    }
  }

  return {
    scannerFrameCount: frames.length,
    conservativeBatchCount: groups,
    barrierFrameCount: frames.filter((frame) => frame.conservativeBarrier).length,
    sideEffectBarrierFrameCount: frames.filter((frame) => frame.hasSideEffectBarrier).length,
    replacementFrameCount: frames.filter((frame) => frame.hasReplacement).length,
    pendingEndStateCount: frames.filter((frame) => frame.endState !== 'ground').length,
    finalState: state,
  }
}

function burstGroups(chunks: RawChunk[], maxGapMs: number) {
  if (chunks.length === 0) return []
  const groups: Array<{ chunks: number; bytes: number; durationMs: number }> = []
  let current = { chunks: 1, bytes: chunks[0].bytes, start: chunks[0].at, end: chunks[0].at }
  for (let i = 1; i < chunks.length; i += 1) {
    const previous = chunks[i - 1]
    const chunk = chunks[i]
    if (chunk.at - previous.at <= maxGapMs) {
      current.chunks += 1
      current.bytes += chunk.bytes
      current.end = chunk.at
    } else {
      groups.push({ chunks: current.chunks, bytes: current.bytes, durationMs: current.end - current.start })
      current = { chunks: 1, bytes: chunk.bytes, start: chunk.at, end: chunk.at }
    }
  }
  groups.push({ chunks: current.chunks, bytes: current.bytes, durationMs: current.end - current.start })
  return groups
}

async function waitForMarker(rawChunks: RawChunk[], marker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (rawChunks.some((chunk) => chunk.data.includes(marker))) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${marker}`)
}

async function runScenario(scenario: Scenario) {
  const rawChunks: RawChunk[] = []
  const registry = new TerminalRegistry()
  const broker = new TerminalStreamBroker(registry)
  const socket = createMockSocket(`proof-${scenario.name}`)
  const startAt = Date.now()

  const onRaw = (event: { terminalId?: string; data?: string; at?: number }) => {
    if (typeof event.data !== 'string') return
    rawChunks.push({
      at: event.at ?? Date.now(),
      bytes: Buffer.byteLength(event.data, 'utf8'),
      chars: event.data.length,
      data: event.data,
    })
  }

  registry.on('terminal.output.raw', onRaw)
  const record = registry.create({
    mode: 'shell',
    shell: 'system',
    cwd: repoRoot,
    cols: 120,
    rows: 30,
  })

  await broker.attach(
    socket,
    record.terminalId,
    'viewport_hydrate',
    120,
    30,
    0,
    `${scenario.name}-attach`,
  )

  await sleep(250)
  registry.input(record.terminalId, `${scenario.command}\r`)
  await waitForMarker(rawChunks, scenario.marker, scenario.timeoutMs)
  await sleep(300)

  await broker.attach(
    socket,
    record.terminalId,
    'transport_reconnect',
    120,
    30,
    0,
    `${scenario.name}-replay`,
  )
  await sleep(300)

  broker.close()
  registry.off('terminal.output.raw', onRaw)
  await registry.shutdownGracefully(1000)

  const outputMessages = socket.sent.filter((sent) => sent.type === 'terminal.output')
  const replayOutputMessages = outputMessages.filter(
    (sent) => sent.message.attachRequestId === `${scenario.name}-replay`,
  )
  const rawBytes = rawChunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
  const rawJoined = rawChunks.map((chunk) => chunk.data).join('')
  const durationMs = Math.max(1, Math.max(...rawChunks.map((chunk) => chunk.at), startAt) - startAt)
  const chunkBytes = rawChunks.map((chunk) => chunk.bytes)
  const interarrivalMs = rawChunks.slice(1).map((chunk, index) => chunk.at - rawChunks[index].at)
  const bursts = burstGroups(rawChunks, 10)
  const scanner = conservativeScannerBatches(rawChunks, TERMINAL_STREAM_BATCH_MAX_BYTES)
  const serializedBytes = outputMessages.map((sent) => sent.bytes)

  return {
    scenario: scenario.name,
    command: scenario.command,
    terminalId: record.terminalId,
    durationMs,
    raw: {
      chunks: rawChunks.length,
      bytes: rawBytes,
      bytesPerSecond: Math.round((rawBytes * 1000) / durationMs),
      previewStartJsonEscaped: rawJoined.slice(0, 1600),
      previewEndJsonEscaped: rawJoined.slice(-1600),
      chunkBytes: summarize(chunkBytes),
      interarrivalMs: summarize(interarrivalMs),
      burstGroupsUnder10ms: {
        count: bursts.length,
        chunks: summarize(bursts.map((burst) => burst.chunks)),
        bytes: summarize(bursts.map((burst) => burst.bytes)),
        durationMs: summarize(bursts.map((burst) => burst.durationMs)),
      },
    },
    broker: {
      sentMessages: socket.sent.length,
      outputMessages: outputMessages.length,
      replayOutputMessages: replayOutputMessages.length,
      outputSerializedBytes: summarize(serializedBytes),
      maxSerializedBytes: serializedBytes.length ? Math.max(...serializedBytes) : 0,
      maxRawDataBytesInOutputMessage: outputMessages.length
        ? Math.max(...outputMessages.map((sent) => Buffer.byteLength(sent.message.data ?? '', 'utf8')))
        : 0,
      sequenceRanges: outputMessages
        .filter((sent) => typeof sent.message.seqStart === 'number')
        .map((sent) => ({
          attachRequestId: sent.message.attachRequestId,
          seqStart: sent.message.seqStart,
          seqEnd: sent.message.seqEnd,
          dataBytes: Buffer.byteLength(sent.message.data ?? '', 'utf8'),
        }))
        .slice(0, 20),
    },
    scanner,
    ratios: {
      rawChunksPerLiveOutputMessage: outputMessages.length ? Number((rawChunks.length / outputMessages.length).toFixed(3)) : null,
      rawChunksPerReplayOutputMessage: replayOutputMessages.length ? Number((rawChunks.length / replayOutputMessages.length).toFixed(3)) : null,
      rawChunksPerConservativeScannerBatch: scanner.conservativeBatchCount
        ? Number((rawChunks.length / scanner.conservativeBatchCount).toFixed(3))
        : null,
    },
  }
}

async function dependencyVersion(packageName: string): Promise<string | null> {
  try {
    const packageJsonUrl = await import.meta.resolve(`${packageName}/package.json`)
    const parsed = JSON.parse(await fs.readFile(fileURLToPath(packageJsonUrl), 'utf8'))
    return parsed.version ?? null
  } catch {
    return null
  }
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true })
  const marker = (name: string, count: number) => `FRESHELL_PROOF_DONE:${name}:${count}`
  const printMarker = (name: string, count: number) => `printf '\\nFRESHELL_PROOF_DONE:%s:%s\\n' '${name}' '${count}'`
  const scenarios: Scenario[] = [
    {
      name: 'codex-version',
      command: `codex --version; ${printMarker('codex-version', 1)}`,
      timeoutMs: 30_000,
      marker: marker('codex-version', 1),
    },
    {
      name: 'codex-help',
      command: `codex exec --help; ${printMarker('codex-help', 1)}`,
      timeoutMs: 30_000,
      marker: marker('codex-help', 1),
    },
    {
      name: 'codex-real-turn',
      command: `codex exec --ephemeral --color always --sandbox read-only --cd /tmp --skip-git-repo-check "Print exactly 40 numbered lines, each line beginning proof-line-, and do not run shell commands."; ${printMarker('codex-real-turn', 40)}`,
      timeoutMs: 240_000,
      marker: marker('codex-real-turn', 40),
    },
    {
      name: 'agent-burst-12000',
      command: `node scripts/proofs/terminal-catchup-agent-output-generator.mjs agent-burst 12000`,
      timeoutMs: 180_000,
      marker: marker('agent-burst', 12000),
    },
    {
      name: 'control-barrier',
      command: `node scripts/proofs/terminal-catchup-agent-output-generator.mjs control-barrier 1`,
      timeoutMs: 30_000,
      marker: marker('control-barrier', 1),
    },
  ]

  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario))
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    nodeVersion: process.version,
    terminalStreamBatchMaxBytes: TERMINAL_STREAM_BATCH_MAX_BYTES,
    dependencies: {
      '@xterm/xterm': await dependencyVersion('@xterm/xterm'),
      ws: await dependencyVersion('ws'),
      'node-pty': await dependencyVersion('node-pty'),
    },
    results,
  }

  const outPath = path.resolve(artifactDir, 'terminal-catchup-pty-metrics.json')
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(JSON.stringify({ outPath, scenarioCount: results.length }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
