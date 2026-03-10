import { ReplayRing, type ReplayFrame } from '../terminal-stream/replay-ring.js'
import type { TerminalViewportRuntime, TerminalViewportSnapshot } from './types.js'

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu

function normalizeOutput(value: string): string {
  return value
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
}

function appendLines(lines: string[], value: string): string[] {
  const next = [...lines]
  const parts = value.split('\n')
  next[next.length - 1] += parts[0]
  for (let index = 1; index < parts.length; index += 1) {
    next.push(parts[index])
  }
  return next
}

export class TerminalViewMirror {
  private readonly replayRing: ReplayRing
  private lines = ['']
  private revision = 1
  private cols: number
  private rows: number
  private runtime: TerminalViewportRuntime

  constructor(options: {
    terminalId: string
    cols: number
    rows: number
    runtime: TerminalViewportRuntime
    replayMaxBytes?: number
  }) {
    this.terminalId = options.terminalId
    this.cols = options.cols
    this.rows = options.rows
    this.runtime = { ...options.runtime }
    this.replayRing = new ReplayRing(options.replayMaxBytes)
  }

  readonly terminalId: string

  applyOutput(rawOutput: string): ReplayFrame {
    const normalized = normalizeOutput(rawOutput)
    const frame = this.replayRing.append(normalized)
    this.lines = appendLines(this.lines, normalized)
    this.revision += 1
    return frame
  }

  seedSnapshot(snapshot: string): void {
    if (this.replayRing.headSeq() !== 0 || snapshot.length === 0) return
    this.applyOutput(snapshot)
  }

  setLayout(layout: { cols: number; rows: number }): void {
    if (this.cols === layout.cols && this.rows === layout.rows) return
    this.cols = layout.cols
    this.rows = layout.rows
    this.revision += 1
  }

  setRuntime(runtime: TerminalViewportRuntime): void {
    const unchanged = (
      this.runtime.title === runtime.title &&
      this.runtime.status === runtime.status &&
      this.runtime.cwd === runtime.cwd &&
      this.runtime.pid === runtime.pid
    )
    if (unchanged) return
    this.runtime = { ...runtime }
    this.revision += 1
  }

  getViewportSnapshot(): TerminalViewportSnapshot {
    const start = Math.max(0, this.lines.length - this.rows)
    return {
      terminalId: this.terminalId,
      revision: this.revision,
      serialized: this.lines.slice(start, start + this.rows).join('\n'),
      cols: this.cols,
      rows: this.rows,
      tailSeq: this.replayRing.headSeq(),
      runtime: { ...this.runtime },
    }
  }
}
