import { buildTerminalOutputBatches } from './output-batch.js'
import type {
  TerminalOutputBarrierReason,
  TerminalOutputScannerState,
} from './output-barrier-scanner.js'
import type {
  ReplayBatchContext,
  ReplayFrame,
  ReplayFrameByteMeasure,
} from './replay-ring.js'

const DEFAULT_STREAM_ID = 'stream-1'
const GROUND_SCANNER_STATE: TerminalOutputScannerState = { mode: 'ground' }
const COMPACT_MIN_EVICTED_FRAMES = 1024

export type ReplayDequeAppendInput = string | {
  data: string
  streamId?: string
  barrier?: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore?: TerminalOutputScannerState
  scannerStateAfter?: TerminalOutputScannerState
  at?: number
}

function normalizeMaxBytes(maxBytes: number): number {
  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    return Math.floor(maxBytes)
  }
  return 0
}

function cloneScannerState(state: TerminalOutputScannerState): TerminalOutputScannerState {
  return { mode: state.mode }
}

export class ReplayDeque {
  private frames: ReplayFrame[] = []
  private startIndex = 0
  private retainedBytes = 0
  private nextSeq = 1
  private head = 0
  private maxBytes: number
  private retentionLossPending = false

  constructor(maxBytes: number) {
    this.maxBytes = normalizeMaxBytes(maxBytes)
  }

  setMaxBytes(nextMaxBytes: number): void {
    const normalizedMaxBytes = normalizeMaxBytes(nextMaxBytes)
    if (normalizedMaxBytes === this.maxBytes) return
    this.maxBytes = normalizedMaxBytes
    this.evictIfNeeded()
  }

  append(input: ReplayDequeAppendInput): ReplayFrame {
    const frameInput = typeof input === 'string' ? { data: input } : input
    const seq = this.nextSeq
    this.nextSeq += 1
    this.head = seq

    const barrier = frameInput.barrier ?? false
    const frame: ReplayFrame = {
      seqStart: seq,
      seqEnd: seq,
      data: frameInput.data,
      bytes: Buffer.byteLength(frameInput.data, 'utf8'),
      at: frameInput.at ?? Date.now(),
      streamId: frameInput.streamId ?? DEFAULT_STREAM_ID,
      barrier,
      ...(barrier && frameInput.barrierReason ? { barrierReason: frameInput.barrierReason } : {}),
      scannerStateBefore: cloneScannerState(frameInput.scannerStateBefore ?? GROUND_SCANNER_STATE),
      scannerStateAfter: cloneScannerState(frameInput.scannerStateAfter ?? GROUND_SCANNER_STATE),
    }

    this.frames.push(frame)
    this.retainedBytes += frame.bytes
    this.evictIfNeeded()
    return frame
  }

  consumeRetentionLoss(): boolean {
    const retentionLossPending = this.retentionLossPending
    this.retentionLossPending = false
    return retentionLossPending
  }

  replaySince(sinceSeq?: number): { frames: ReplayFrame[]; missedFromSeq?: number } {
    const normalizedSinceSeq = this.normalizeSinceSeq(sinceSeq)
    const missedFromSeq = this.missedFromSeq(normalizedSinceSeq)
    if (this.retainedCount() === 0) {
      return missedFromSeq === undefined ? { frames: [] } : { frames: [], missedFromSeq }
    }

    const frames = Array.from(this.iterReplayFrames(normalizedSinceSeq, Number.POSITIVE_INFINITY))
    return missedFromSeq === undefined ? { frames } : { frames, missedFromSeq }
  }

  replayBatchSince(
    sinceSeq: number | undefined,
    maxBytes: number,
    toSeq?: number,
    measureFrameBytes?: ReplayFrameByteMeasure,
    batchContext?: ReplayBatchContext,
  ): { frames: ReplayFrame[]; missedFromSeq?: number } {
    const normalizedSinceSeq = this.normalizeSinceSeq(sinceSeq)
    const missedFromSeq = this.missedFromSeq(normalizedSinceSeq)
    if (this.retainedCount() === 0) {
      return missedFromSeq === undefined ? { frames: [] } : { frames: [], missedFromSeq }
    }

    const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
    const normalizedToSeq = typeof toSeq === 'number' && Number.isFinite(toSeq)
      ? Math.max(0, Math.floor(toSeq))
      : Number.POSITIVE_INFINITY

    const frames = buildTerminalOutputBatches({
      frames: this.iterReplayFrames(normalizedSinceSeq, normalizedToSeq),
      maxSerializedBytes: normalizedMaxBytes,
      maxTotalSerializedBytes: normalizedMaxBytes,
      measureFrameBytes,
      terminalId: batchContext?.terminalId,
      attachRequestId: batchContext?.attachRequestId,
      source: batchContext?.source,
    })

    return missedFromSeq === undefined ? { frames } : { frames, missedFromSeq }
  }

  totalBytes(): number {
    return this.retainedBytes
  }

  headSeq(): number {
    return this.head
  }

  tailSeq(): number {
    const firstFrame = this.firstFrame()
    return firstFrame ? firstFrame.seqStart : this.head + 1
  }

  private normalizeSinceSeq(sinceSeq?: number): number {
    return sinceSeq === undefined || sinceSeq === 0 ? 0 : sinceSeq
  }

  private missedFromSeq(normalizedSinceSeq: number): number | undefined {
    const firstFrame = this.firstFrame()
    if (!firstFrame) {
      return normalizedSinceSeq < this.head ? normalizedSinceSeq + 1 : undefined
    }

    return normalizedSinceSeq < firstFrame.seqStart - 1
      ? normalizedSinceSeq + 1
      : undefined
  }

  private evictIfNeeded(): void {
    while (this.retainedBytes > this.maxBytes && this.retainedCount() > 0) {
      const removed = this.frames[this.startIndex]
      if (!removed) break
      this.startIndex += 1
      this.retainedBytes -= removed.bytes
      this.retentionLossPending = true
    }
    this.compactIfNeeded()
  }

  private compactIfNeeded(): void {
    if (this.startIndex === 0) return
    const retainedCount = this.retainedCount()
    if (retainedCount === 0) {
      this.frames = []
      this.startIndex = 0
      return
    }
    if (
      this.startIndex < COMPACT_MIN_EVICTED_FRAMES
      || this.startIndex < retainedCount
    ) {
      return
    }

    this.frames = this.frames.slice(this.startIndex)
    this.startIndex = 0
  }

  private retainedCount(): number {
    return this.frames.length - this.startIndex
  }

  private firstFrame(): ReplayFrame | undefined {
    return this.retainedCount() > 0 ? this.frames[this.startIndex] : undefined
  }

  private firstFrameIndexAfter(seq: number): number {
    let low = this.startIndex
    let high = this.frames.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (this.frames[mid].seqEnd <= seq) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  private *iterReplayFrames(sinceSeq: number, toSeq: number): IterableIterator<ReplayFrame> {
    const start = this.firstFrameIndexAfter(sinceSeq)
    for (let index = start; index < this.frames.length; index += 1) {
      const frame = this.frames[index]
      if (frame.seqStart > toSeq) break
      yield frame
    }
  }
}
