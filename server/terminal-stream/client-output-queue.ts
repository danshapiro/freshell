import type { ReplayFrame } from './replay-ring.js'

export type GapEvent = {
  type: 'gap'
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow'
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
  private frames: ReplayFrame[] = []
  private totalBytes = 0
  private pendingGap: GapEvent | null = null

  constructor(maxBytes?: number) {
    this.maxBytes = resolveMaxBytes(maxBytes)
  }

  enqueue(frame: ReplayFrame): void {
    this.frames.push({ ...frame })
    this.totalBytes += frame.bytes
    this.evictOverflow()
  }

  nextBatch(maxBytes: number): Array<ReplayFrame | GapEvent> {
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
      if (first.bytes > budget && out.some((item) => item.type !== 'gap')) break

      const frame = this.frames.shift()
      if (!frame) break
      this.totalBytes -= frame.bytes
      budget -= frame.bytes

      const merged: ReplayFrame = { ...frame }
      while (this.frames.length > 0) {
        const next = this.frames[0]
        if (next.seqStart !== merged.seqEnd + 1) break
        if (next.bytes > budget) break

        const nextFrame = this.frames.shift()
        if (!nextFrame) break
        this.totalBytes -= nextFrame.bytes
        budget -= nextFrame.bytes
        merged.seqEnd = nextFrame.seqEnd
        merged.data += nextFrame.data
        merged.bytes += nextFrame.bytes
        merged.at = nextFrame.at
      }

      out.push(merged)
      if (budget <= 0) break
    }

    return out
  }

  pendingBytes(): number {
    return this.totalBytes
  }

  private evictOverflow(): void {
    while (this.totalBytes > this.maxBytes && this.frames.length > 0) {
      const dropped = this.frames.shift()
      if (!dropped) break
      this.totalBytes -= dropped.bytes
      this.extendGap(dropped.seqStart, dropped.seqEnd)
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
