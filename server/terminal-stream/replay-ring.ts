import { fragmentTerminalOutputForPayloadBudget } from './output-fragments.js'
import type { JsonPayload } from './serialized-budget.js'

export type ReplayFrame = {
  seqStart: number
  seqEnd: number
  data: string
  bytes: number
  at: number
  streamId?: string
}

export const DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 1024 * 1024

export type ReplayFrameByteMeasure = (frame: ReplayFrame) => number

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
  private maxBytes: number
  private readonly utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })

  constructor(maxBytes?: number) {
    this.maxBytes = resolveMaxBytes(maxBytes)
  }

  setMaxBytes(nextMaxBytes?: number): void {
    const resolved = resolveMaxBytes(nextMaxBytes)
    if (resolved === this.maxBytes) return
    this.maxBytes = resolved
    this.evictIfNeeded()
  }

  append(data: string, metadata?: { streamId?: string }): ReplayFrame {
    const seq = this.nextSeq
    this.nextSeq += 1
    this.head = seq
    const normalizedData = this.normalizeFrameData(data)

    const frame: ReplayFrame = {
      seqStart: seq,
      seqEnd: seq,
      data: normalizedData,
      bytes: Buffer.byteLength(normalizedData, 'utf8'),
      at: Date.now(),
      ...(metadata?.streamId ? { streamId: metadata.streamId } : {}),
    }

    this.frames.push(frame)
    this.totalBytes += frame.bytes
    this.evictIfNeeded()
    return frame
  }

  appendFragmentedForPayloadBudget(input: {
    data: string
    maxSerializedBytes: number
    payloadForData: (data: string) => JsonPayload
    streamId?: string
  }): ReplayFrame[] {
    const fragments = fragmentTerminalOutputForPayloadBudget(input)
    return fragments.map((fragment) => this.append(fragment, { streamId: input.streamId }))
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

    const frames = this.frames.slice(this.firstFrameIndexAfter(normalizedSinceSeq))
    return { frames, missedFromSeq }
  }

  replayBatchSince(
    sinceSeq: number | undefined,
    maxBytes: number,
    toSeq?: number,
    measureFrameBytes?: ReplayFrameByteMeasure,
  ): { frames: ReplayFrame[]; missedFromSeq?: number } {
    const normalizedSinceSeq = sinceSeq === undefined || sinceSeq === 0 ? 0 : sinceSeq
    const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0
    const normalizedToSeq = typeof toSeq === 'number' && Number.isFinite(toSeq)
      ? Math.max(0, Math.floor(toSeq))
      : Number.POSITIVE_INFINITY

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
    const frames: ReplayFrame[] = []
    let budget = normalizedMaxBytes

    if (budget <= 0) {
      return { frames, missedFromSeq }
    }

    const startIndex = this.firstFrameIndexAfter(normalizedSinceSeq)
    for (let i = startIndex; i < this.frames.length; i += 1) {
      const frame = this.frames[i]
      if (frame.seqStart > normalizedToSeq) break
      const frameBytes = this.measureFrameForBatch(frame, measureFrameBytes)

      const previous = frames[frames.length - 1]
      if (previous && frame.seqStart === previous.seqEnd + 1) {
        if (frame.streamId !== previous.streamId) {
          if (frameBytes > budget && frames.length > 0) break
          frames.push({ ...frame })
          budget -= frameBytes
          if (budget <= 0) break
          continue
        }
        const mergedCandidate: ReplayFrame = {
          ...previous,
          seqEnd: frame.seqEnd,
          data: previous.data + frame.data,
          bytes: previous.bytes + frame.bytes,
          at: frame.at,
        }
        const previousBytes = this.measureFrameForBatch(previous, measureFrameBytes)
        const mergedBytes = this.measureFrameForBatch(mergedCandidate, measureFrameBytes)
        const additionalBytes = Math.max(0, mergedBytes - previousBytes)
        if (additionalBytes > budget) break
        previous.seqEnd = mergedCandidate.seqEnd
        previous.data = mergedCandidate.data
        previous.bytes = mergedCandidate.bytes
        previous.at = mergedCandidate.at
        budget -= additionalBytes
      } else {
        if (frameBytes > budget && frames.length > 0) break
        frames.push({ ...frame })
        budget -= frameBytes
      }
      if (budget <= 0) break
    }

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

  private firstFrameIndexAfter(seq: number): number {
    let low = 0
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

  private measureFrameForBatch(frame: ReplayFrame, measureFrameBytes?: ReplayFrameByteMeasure): number {
    if (!measureFrameBytes) return frame.bytes
    const measured = measureFrameBytes(frame)
    return Number.isFinite(measured) && measured > 0 ? Math.floor(measured) : 0
  }

  private decodeUtf8Fatal(bytes: Uint8Array): string | null {
    try {
      return this.utf8FatalDecoder.decode(bytes)
    } catch {
      return null
    }
  }

  private normalizeFrameData(data: string): string {
    if (!data) return ''
    if (this.maxBytes <= 0) return ''

    const encoded = Buffer.from(data, 'utf8')
    if (encoded.byteLength <= this.maxBytes) {
      return data
    }

    const startOffset = Math.max(0, encoded.byteLength - this.maxBytes)
    for (let start = startOffset; start <= encoded.byteLength; start += 1) {
      const decoded = this.decodeUtf8Fatal(encoded.subarray(start))
      if (decoded !== null) return decoded
    }
    return ''
  }
}
