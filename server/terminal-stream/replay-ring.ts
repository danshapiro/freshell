import {
  createTerminalOutputBarrierScanner,
  type TerminalOutputBarrierClassification,
  type TerminalOutputBarrierReason,
  type TerminalOutputScannerState,
} from './output-barrier-scanner.js'
import { buildTerminalOutputBatches } from './output-batch.js'

export type ReplayFrame = {
  seqStart: number
  seqEnd: number
  data: string
  bytes: number
  at: number
  streamId: string
  barrier: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore: TerminalOutputScannerState
  scannerStateAfter: TerminalOutputScannerState
}

export const DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 1024 * 1024

export type ReplayFrameByteMeasure = (frame: ReplayFrame) => number
export type ReplayBatchContext = {
  terminalId?: string
  attachRequestId?: string
  source?: string
}

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
  private retentionLossPending = false
  private readonly utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })
  private readonly barrierScanner = createTerminalOutputBarrierScanner()

  constructor(maxBytes?: number) {
    this.maxBytes = resolveMaxBytes(maxBytes)
  }

  setMaxBytes(nextMaxBytes?: number): void {
    const resolved = resolveMaxBytes(nextMaxBytes)
    if (resolved === this.maxBytes) return
    this.maxBytes = resolved
    this.evictIfNeeded()
  }

  append(data: string, metadata: { streamId: string }): ReplayFrame {
    const seq = this.nextSeq
    this.nextSeq += 1
    this.head = seq
    const streamClassification = this.barrierScanner.scan(data)
    const normalizedData = this.normalizeFrameData(data)
    const wasTruncated = Buffer.byteLength(normalizedData, 'utf8') < Buffer.byteLength(data, 'utf8')
    const barrierClassification = wasTruncated
      ? this.conservativeTruncatedClassification(streamClassification)
      : streamClassification

    const frame: ReplayFrame = {
      seqStart: seq,
      seqEnd: seq,
      data: normalizedData,
      bytes: Buffer.byteLength(normalizedData, 'utf8'),
      at: Date.now(),
      streamId: metadata.streamId,
      barrier: barrierClassification.barrier,
      ...(barrierClassification.barrier ? { barrierReason: barrierClassification.reason } : {}),
      scannerStateBefore: barrierClassification.stateBefore,
      scannerStateAfter: barrierClassification.stateAfter,
    }

    this.frames.push(frame)
    this.totalBytes += frame.bytes
    this.evictIfNeeded()
    return frame
  }

  consumeRetentionLoss(): boolean {
    const retentionLossPending = this.retentionLossPending
    this.retentionLossPending = false
    return retentionLossPending
  }

  retagRetainedStreamSuffix(fromStreamId: string, toStreamId: string): void {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]
      if (frame.streamId !== fromStreamId) break
      frame.streamId = toStreamId
    }
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
    batchContext?: ReplayBatchContext,
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
    const frames = buildTerminalOutputBatches({
      frames: this.iterReplayFrames(normalizedSinceSeq, normalizedToSeq),
      maxSerializedBytes: normalizedMaxBytes,
      maxTotalSerializedBytes: normalizedMaxBytes,
      measureFrameBytes,
      terminalId: batchContext?.terminalId,
      attachRequestId: batchContext?.attachRequestId,
      source: batchContext?.source,
    })

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
      this.retentionLossPending = true
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

  private *iterReplayFrames(sinceSeq: number, toSeq: number): IterableIterator<ReplayFrame> {
    const startIndex = this.firstFrameIndexAfter(sinceSeq)
    for (let index = startIndex; index < this.frames.length; index += 1) {
      const frame = this.frames[index]
      if (frame.seqStart > toSeq) break
      yield frame
    }
  }

  private conservativeTruncatedClassification(
    classification: TerminalOutputBarrierClassification,
  ): {
    barrier: true
    reason: TerminalOutputBarrierReason
    stateBefore: TerminalOutputScannerState
    stateAfter: TerminalOutputScannerState
  } {
    return {
      barrier: true,
      reason: classification.barrier ? classification.reason : 'control',
      stateBefore: classification.stateBefore,
      stateAfter: classification.stateAfter,
    }
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
