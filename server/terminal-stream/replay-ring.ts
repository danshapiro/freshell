export type ReplayFrame = {
  seqStart: number
  seqEnd: number
  data: string
  bytes: number
  at: number
}

export const DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 256 * 1024

function resolveMaxBytes(explicitMaxBytes?: number): number {
  if (typeof explicitMaxBytes === 'number' && Number.isFinite(explicitMaxBytes) && explicitMaxBytes > 0) {
    return Math.floor(explicitMaxBytes)
  }

  const envValue = Number(process.env.TERMINAL_REPLAY_RING_MAX_BYTES)
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.floor(envValue)
  }

  return DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES
}

export class ReplayRing {
  private frames: ReplayFrame[] = []
  private totalBytes = 0
  private nextSeq = 1
  private head = 0
  private readonly maxBytes: number

  constructor(maxBytes?: number) {
    this.maxBytes = resolveMaxBytes(maxBytes)
  }

  append(data: string): ReplayFrame {
    const seq = this.nextSeq
    this.nextSeq += 1
    this.head = seq

    const frame: ReplayFrame = {
      seqStart: seq,
      seqEnd: seq,
      data,
      bytes: Buffer.byteLength(data, 'utf8'),
      at: Date.now(),
    }

    this.frames.push(frame)
    this.totalBytes += frame.bytes
    this.evictIfNeeded()
    return frame
  }

  replaySince(sinceSeq?: number): { frames: ReplayFrame[]; missedFromSeq?: number } {
    const normalizedSinceSeq = sinceSeq === undefined || sinceSeq === 0 ? 0 : sinceSeq
    if (this.frames.length === 0) {
      if (normalizedSinceSeq < this.head) {
        return { frames: [], missedFromSeq: normalizedSinceSeq + 1 }
      }
      return { frames: [] }
    }

    const tail = this.frames[0].seqStart
    const missedFromSeq = normalizedSinceSeq < tail - 1
      ? normalizedSinceSeq + 1
      : undefined

    const frames = this.frames.filter((frame) => frame.seqEnd > normalizedSinceSeq)
    return { frames, missedFromSeq }
  }

  headSeq(): number {
    return this.head
  }

  tailSeq(): number {
    if (this.frames.length === 0) {
      return this.head + 1
    }
    return this.frames[0].seqStart
  }

  private evictIfNeeded(): void {
    while (this.totalBytes > this.maxBytes && this.frames.length > 0) {
      const removed = this.frames.shift()
      if (!removed) break
      this.totalBytes -= removed.bytes
    }
  }
}
