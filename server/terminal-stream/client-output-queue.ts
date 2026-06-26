import type { ReplayFrame } from './replay-ring.js'
import { buildTerminalOutputBatches } from './output-batch.js'

type QueuedReplayFrame = ReplayFrame & {
  queuedBytes: number
}

export type GapEvent = {
  type: 'gap'
  fromSeq: number
  toSeq: number
  streamId: string
  reason: 'queue_overflow'
}

export type QueuedFrameByteMeasure = (frame: ReplayFrame) => number
export type QueuedBatchContext = {
  terminalId?: string
  attachRequestId?: string
  source?: string
}

export type PreparedClientOutputBatch = {
  entries: Array<ReplayFrame | GapEvent>
  gapCount: number
  frameCount: number
}

export function isGapEvent(entry: ReplayFrame | GapEvent): entry is GapEvent {
  return 'type' in entry && entry.type === 'gap'
}

export const DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES = 32 * 1024 * 1024

function resolveMaxBytes(explicitMaxBytes?: number): number {
  if (typeof explicitMaxBytes === 'number' && Number.isFinite(explicitMaxBytes) && explicitMaxBytes > 0) {
    return Math.floor(explicitMaxBytes)
  }

  const envValue = Number(process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES)
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.floor(envValue)
  }

  return DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES
}

export class ClientOutputQueue {
  private readonly maxBytes: number
  private frames: QueuedReplayFrame[] = []
  private totalBytes = 0
  private pendingGaps: GapEvent[] = []
  private droppedBytes = 0

  constructor(maxBytes?: number) {
    this.maxBytes = resolveMaxBytes(maxBytes)
  }

  enqueue(frame: ReplayFrame, queuedBytes = frame.bytes): void {
    const normalizedQueuedBytes = Number.isFinite(queuedBytes) && queuedBytes > 0
      ? Math.floor(queuedBytes)
      : 0
    this.frames.push({ ...frame, queuedBytes: normalizedQueuedBytes })
    this.totalBytes += normalizedQueuedBytes
    this.evictOverflow()
  }

  prepareBatch(
    maxBytes: number,
    measureFrameBytes?: QueuedFrameByteMeasure,
    batchContext?: QueuedBatchContext,
  ): PreparedClientOutputBatch {
    const out: Array<ReplayFrame | GapEvent> = []
    const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0

    if (this.pendingGaps.length > 0) {
      out.push(...this.pendingGaps)
    }

    if (budget <= 0) {
      return {
        entries: out,
        gapCount: this.pendingGaps.length,
        frameCount: 0,
      }
    }

    const batches = buildTerminalOutputBatches({
      frames: this.frames,
      maxSerializedBytes: budget,
      maxTotalSerializedBytes: budget,
      measureFrameBytes: (frame) => this.measureFrameForBatch(frame, measureFrameBytes),
      terminalId: batchContext?.terminalId,
      attachRequestId: batchContext?.attachRequestId,
      source: batchContext?.source,
    })
    const consumedFrameCount = batches.reduce((sum, batch) => sum + batch.segments.length, 0)
    out.push(...batches)

    return {
      entries: out,
      gapCount: this.pendingGaps.length,
      frameCount: consumedFrameCount,
    }
  }

  nextBatch(
    maxBytes: number,
    measureFrameBytes?: QueuedFrameByteMeasure,
    batchContext?: QueuedBatchContext,
  ): Array<ReplayFrame | GapEvent> {
    const prepared = this.prepareBatch(maxBytes, measureFrameBytes, batchContext)
    this.acknowledgePreparedBatch(prepared)
    return prepared.entries
  }

  acknowledgePreparedBatch(prepared: PreparedClientOutputBatch, counts: { gaps?: number; frames?: number } = {}): void {
    const gaps = Math.max(0, Math.min(
      this.pendingGaps.length,
      Math.floor(counts.gaps ?? prepared.gapCount),
    ))
    if (gaps > 0) {
      this.pendingGaps.splice(0, gaps)
    }
    this.consumeFrames(Math.max(0, Math.floor(counts.frames ?? prepared.frameCount)))
  }

  pendingBytes(): number {
    return this.totalBytes
  }

  pendingFrames(): number {
    return this.frames.length
  }

  hasPendingEntries(): boolean {
    return this.pendingGaps.length > 0 || this.frames.length > 0
  }

  peekDroppedBytes(): number {
    return this.droppedBytes
  }

  consumeDroppedBytes(): number {
    const droppedBytes = this.droppedBytes
    this.droppedBytes = 0
    return droppedBytes
  }

  clear(): void {
    this.frames = []
    this.totalBytes = 0
    this.pendingGaps = []
    this.droppedBytes = 0
  }

  private evictOverflow(): void {
    while (this.totalBytes > this.maxBytes && this.frames.length > 0) {
      const dropped = this.frames.shift()
      if (!dropped) break
      this.totalBytes -= dropped.queuedBytes
      this.droppedBytes += dropped.queuedBytes
      this.extendGap(dropped.streamId, dropped.seqStart, dropped.seqEnd)
    }
  }

  private measureFrameForBatch(frame: ReplayFrame, measureFrameBytes?: QueuedFrameByteMeasure): number {
    if (!measureFrameBytes) return frame.bytes
    const measured = measureFrameBytes(this.toReplayFrame(frame))
    return Number.isFinite(measured) && measured > 0 ? Math.floor(measured) : 0
  }

  private consumeFrames(count: number): void {
    for (let consumed = 0; consumed < count; consumed += 1) {
      const frame = this.frames.shift()
      if (!frame) return
      this.totalBytes -= frame.queuedBytes
    }
  }

  private toReplayFrame(frame: ReplayFrame): ReplayFrame {
    return {
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      bytes: frame.bytes,
      at: frame.at,
      streamId: frame.streamId,
      barrier: frame.barrier,
      ...(frame.barrier && frame.barrierReason ? { barrierReason: frame.barrierReason } : {}),
      scannerStateBefore: frame.scannerStateBefore,
      scannerStateAfter: frame.scannerStateAfter,
    }
  }

  private extendGap(streamId: string, fromSeq: number, toSeq: number): void {
    const pendingGap = this.pendingGaps[this.pendingGaps.length - 1]
    if (!pendingGap || pendingGap.streamId !== streamId || fromSeq > pendingGap.toSeq + 1) {
      this.pendingGaps.push({
        type: 'gap',
        fromSeq,
        toSeq,
        streamId,
        reason: 'queue_overflow',
      })
      return
    }

    pendingGap.fromSeq = Math.min(pendingGap.fromSeq, fromSeq)
    pendingGap.toSeq = Math.max(pendingGap.toSeq, toSeq)
  }
}
