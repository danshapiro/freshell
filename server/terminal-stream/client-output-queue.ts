import type { ReplayFrame } from './replay-ring.js'

type QueuedReplayFrame = ReplayFrame & {
  queuedBytes: number
}

export type GapEvent = {
  type: 'gap'
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow'
}

export type QueuedFrameByteMeasure = (frame: ReplayFrame) => number

export function isGapEvent(entry: ReplayFrame | GapEvent): entry is GapEvent {
  return 'type' in entry && entry.type === 'gap'
}

export const DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES = 128 * 1024

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
  private pendingGap: GapEvent | null = null
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

  nextBatch(maxBytes: number, measureFrameBytes?: QueuedFrameByteMeasure): Array<ReplayFrame | GapEvent> {
    const out: Array<ReplayFrame | GapEvent> = []
    let budget = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0

    if (this.pendingGap) {
      out.push(this.pendingGap)
      this.pendingGap = null
    }

    if (budget <= 0) {
      return out
    }

    while (this.frames.length > 0) {
      const first = this.frames[0]
      const firstBytes = this.measureFrameForBatch(first, measureFrameBytes)
      if (firstBytes > budget && out.some((item) => !isGapEvent(item))) break

      const frame = this.frames.shift()
      if (!frame) break
      this.totalBytes -= frame.queuedBytes
      budget -= firstBytes

      const merged: ReplayFrame = this.toReplayFrame(frame)
      let mergedBytes = firstBytes
      while (this.frames.length > 0) {
        const next = this.frames[0]
        if (next.seqStart !== merged.seqEnd + 1) break
        if (next.streamId !== merged.streamId) break
        const mergedCandidate: ReplayFrame = {
          ...merged,
          seqEnd: next.seqEnd,
          data: merged.data + next.data,
          bytes: merged.bytes + next.bytes,
          at: next.at,
        }
        const mergedCandidateBytes = this.measureFrameForBatch(mergedCandidate, measureFrameBytes)
        const additionalBytes = Math.max(0, mergedCandidateBytes - mergedBytes)
        if (additionalBytes > budget) break

        const nextFrame = this.frames.shift()
        if (!nextFrame) break
        this.totalBytes -= nextFrame.queuedBytes
        budget -= additionalBytes
        merged.seqEnd = mergedCandidate.seqEnd
        merged.data = mergedCandidate.data
        merged.bytes = mergedCandidate.bytes
        merged.at = mergedCandidate.at
        mergedBytes = mergedCandidateBytes
      }

      out.push(merged)
      if (budget <= 0) break
    }

    return out
  }

  pendingBytes(): number {
    return this.totalBytes
  }

  pendingFrames(): number {
    return this.frames.length
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
    this.pendingGap = null
    this.droppedBytes = 0
  }

  private evictOverflow(): void {
    while (this.totalBytes > this.maxBytes && this.frames.length > 0) {
      const dropped = this.frames.shift()
      if (!dropped) break
      this.totalBytes -= dropped.queuedBytes
      this.droppedBytes += dropped.queuedBytes
      this.extendGap(dropped.seqStart, dropped.seqEnd)
    }
  }

  private measureFrameForBatch(frame: ReplayFrame, measureFrameBytes?: QueuedFrameByteMeasure): number {
    if (!measureFrameBytes) {
      const queuedBytes = (frame as Partial<QueuedReplayFrame>).queuedBytes
      return typeof queuedBytes === 'number' ? queuedBytes : frame.bytes
    }
    const measured = measureFrameBytes(this.toReplayFrame(frame))
    return Number.isFinite(measured) && measured > 0 ? Math.floor(measured) : 0
  }

  private toReplayFrame(frame: ReplayFrame): ReplayFrame {
    return {
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      bytes: frame.bytes,
      at: frame.at,
      ...(frame.streamId ? { streamId: frame.streamId } : {}),
    }
  }

  private extendGap(fromSeq: number, toSeq: number): void {
    if (!this.pendingGap) {
      this.pendingGap = {
        type: 'gap',
        fromSeq,
        toSeq,
        reason: 'queue_overflow',
      }
      return
    }

    this.pendingGap.fromSeq = Math.min(this.pendingGap.fromSeq, fromSeq)
    this.pendingGap.toSeq = Math.max(this.pendingGap.toSeq, toSeq)
  }
}
