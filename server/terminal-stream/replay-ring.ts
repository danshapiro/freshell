import {
  createTerminalOutputBarrierScanner,
  type TerminalOutputBarrierClassification,
  type TerminalOutputBarrierReason,
  type TerminalOutputScannerState,
} from './output-barrier-scanner.js'
import { ReplayDeque } from './replay-deque.js'

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
  private readonly storage: ReplayDeque
  private maxBytes: number
  private readonly utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })
  private readonly barrierScanner = createTerminalOutputBarrierScanner()

  constructor(maxBytes?: number) {
    this.maxBytes = resolveMaxBytes(maxBytes)
    this.storage = new ReplayDeque(this.maxBytes)
  }

  setMaxBytes(nextMaxBytes?: number): void {
    const resolved = resolveMaxBytes(nextMaxBytes)
    if (resolved === this.maxBytes) return
    this.maxBytes = resolved
    this.storage.setMaxBytes(this.maxBytes)
  }

  append(data: string, metadata: { streamId: string }): ReplayFrame {
    const streamClassification = this.barrierScanner.scan(data)
    const normalizedData = this.normalizeFrameData(data)
    const wasTruncated = Buffer.byteLength(normalizedData, 'utf8') < Buffer.byteLength(data, 'utf8')
    const barrierClassification = wasTruncated
      ? this.conservativeTruncatedClassification(streamClassification)
      : streamClassification

    return this.storage.append({
      data: normalizedData,
      at: Date.now(),
      streamId: metadata.streamId,
      barrier: barrierClassification.barrier,
      ...(barrierClassification.barrier ? { barrierReason: barrierClassification.reason } : {}),
      scannerStateBefore: barrierClassification.stateBefore,
      scannerStateAfter: barrierClassification.stateAfter,
    })
  }

  consumeRetentionLoss(): boolean {
    return this.storage.consumeRetentionLoss()
  }

  replaySince(sinceSeq?: number): { frames: ReplayFrame[]; missedFromSeq?: number } {
    return this.storage.replaySince(sinceSeq)
  }

  replayBatchSince(
    sinceSeq: number | undefined,
    maxBytes: number,
    toSeq?: number,
    measureFrameBytes?: ReplayFrameByteMeasure,
    batchContext?: ReplayBatchContext,
  ): { frames: ReplayFrame[]; missedFromSeq?: number } {
    return this.storage.replayBatchSince(sinceSeq, maxBytes, toSeq, measureFrameBytes, batchContext)
  }

  headSeq(): number {
    return this.storage.headSeq()
  }

  tailSeq(): number {
    return this.storage.tailSeq()
  }

  retainedBytes(): number {
    return this.storage.totalBytes()
  }

  retentionMaxBytes(): number {
    return this.maxBytes
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
