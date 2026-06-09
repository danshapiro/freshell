import type { ReplayFrame } from './replay-ring.js'
import {
  createTerminalOutputBarrierScanner,
  type TerminalOutputBarrierReason,
  type TerminalOutputScannerState,
} from './output-barrier-scanner.js'
import { measureTerminalOutputPayloadBytes, type JsonPayload } from './serialized-budget.js'

type FrameBoundaryMetadata = {
  attachRequestId?: string
  source?: string
}

export type TerminalOutputBatchSegment = {
  seqStart: number
  seqEnd: number
  streamId: string
  offset: number
  endOffset: number
  bytes: number
  barrier: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore: TerminalOutputScannerState
  scannerStateAfter: TerminalOutputScannerState
}

export type TerminalOutputBatch = ReplayFrame & FrameBoundaryMetadata & {
  serializedBytes: number
  segments: TerminalOutputBatchSegment[]
  barrier: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore: TerminalOutputScannerState
  scannerStateAfter: TerminalOutputScannerState
}

export type TerminalOutputBatchBuildInput<TFrame extends ReplayFrame = ReplayFrame> = {
  frames: Iterable<TFrame>
  maxSerializedBytes: number
  maxTotalSerializedBytes?: number
  terminalId?: string
  attachRequestId?: string
  source?: string
  payloadForFrame?: (frame: ReplayFrame) => JsonPayload
  measureFrameBytes?: (frame: ReplayFrame) => number
}

type FrameClassification = {
  barrier: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore: TerminalOutputScannerState
  scannerStateAfter: TerminalOutputScannerState
}

type AnnotatedReplayFrame = ReplayFrame & Partial<FrameClassification> & FrameBoundaryMetadata

type MutableTerminalOutputBatch = FrameBoundaryMetadata & {
  seqStart: number
  seqEnd: number
  chunks: string[]
  dataLength: number
  dataJsonContentBytes: number
  bytes: number
  at: number
  streamId: string
  serializedBytes: number
  segments: TerminalOutputBatchSegment[]
  barrier: false
  scannerStateBefore: TerminalOutputScannerState
  scannerStateAfter: TerminalOutputScannerState
}

function normalizeBudget(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function cloneScannerState(state: TerminalOutputScannerState): TerminalOutputScannerState {
  return { mode: state.mode }
}

function defaultPayloadForFrame(
  terminalId: string,
  attachRequestId: string | undefined,
  frame: ReplayFrame,
): JsonPayload {
  return {
    type: 'terminal.output',
    terminalId,
    streamId: frame.streamId,
    seqStart: frame.seqStart,
    seqEnd: frame.seqEnd,
    data: frame.data,
    ...(attachRequestId ? { attachRequestId } : {}),
  }
}

function jsonStringContentBytes(data: string): number {
  return Math.max(0, Buffer.byteLength(JSON.stringify(data), 'utf8') - 2)
}

function classifyFrame(
  frame: AnnotatedReplayFrame,
  fallbackScanner: ReturnType<typeof createTerminalOutputBarrierScanner>,
): FrameClassification {
  if (
    typeof frame.barrier === 'boolean'
    && frame.scannerStateBefore
    && frame.scannerStateAfter
  ) {
    return {
      barrier: frame.barrier,
      ...(frame.barrier && frame.barrierReason ? { barrierReason: frame.barrierReason } : {}),
      scannerStateBefore: cloneScannerState(frame.scannerStateBefore),
      scannerStateAfter: cloneScannerState(frame.scannerStateAfter),
    }
  }

  const scanned = fallbackScanner.scan(frame.data)
  return {
    barrier: scanned.barrier,
    ...(scanned.barrier ? { barrierReason: scanned.reason } : {}),
    scannerStateBefore: cloneScannerState(scanned.stateBefore),
    scannerStateAfter: cloneScannerState(scanned.stateAfter),
  }
}

function isTransparentGroundFrame(classification: FrameClassification): boolean {
  return !classification.barrier
    && classification.scannerStateBefore.mode === 'ground'
    && classification.scannerStateAfter.mode === 'ground'
}

function frameAttachRequestId(
  frame: AnnotatedReplayFrame,
  inputAttachRequestId: string | undefined,
): string | undefined {
  return frame.attachRequestId ?? inputAttachRequestId
}

function frameSource(frame: AnnotatedReplayFrame, inputSource: string | undefined): string | undefined {
  return frame.source ?? inputSource
}

function measureBatch(
  input: TerminalOutputBatchBuildInput,
  batch: ReplayFrame & FrameBoundaryMetadata,
  dataJsonContentBytes?: number,
): number {
  if (input.payloadForFrame) {
    return measureTerminalOutputPayloadBytes(input.payloadForFrame(batch))
  }

  if (input.terminalId) {
    if (dataJsonContentBytes !== undefined) {
      const emptyPayloadBytes = measureTerminalOutputPayloadBytes(defaultPayloadForFrame(
        input.terminalId,
        batch.attachRequestId ?? input.attachRequestId,
        { ...batch, data: '' },
      ))
      return emptyPayloadBytes - 2 + dataJsonContentBytes + 2
    }

    return measureTerminalOutputPayloadBytes(defaultPayloadForFrame(
      input.terminalId,
      batch.attachRequestId ?? input.attachRequestId,
      batch,
    ))
  }

  if (input.measureFrameBytes) {
    const measured = input.measureFrameBytes(batch)
    return Number.isFinite(measured) && measured > 0 ? Math.floor(measured) : 0
  }

  return batch.bytes
}

function segmentForFrame(
  frame: ReplayFrame,
  classification: FrameClassification,
  offset: number,
): TerminalOutputBatchSegment {
  return {
    seqStart: frame.seqStart,
    seqEnd: frame.seqEnd,
    streamId: frame.streamId,
    offset,
    endOffset: offset + frame.data.length,
    bytes: frame.bytes,
    barrier: classification.barrier,
    ...(classification.barrier && classification.barrierReason
      ? { barrierReason: classification.barrierReason }
      : {}),
    scannerStateBefore: cloneScannerState(classification.scannerStateBefore),
    scannerStateAfter: cloneScannerState(classification.scannerStateAfter),
  }
}

function buildSingleBatch(
  frame: AnnotatedReplayFrame,
  classification: FrameClassification,
  input: TerminalOutputBatchBuildInput,
): TerminalOutputBatch {
  const attachRequestId = frameAttachRequestId(frame, input.attachRequestId)
  const source = frameSource(frame, input.source)
  const batch: TerminalOutputBatch = {
    ...frame,
    seqStart: frame.seqStart,
    seqEnd: frame.seqEnd,
    data: frame.data,
    bytes: frame.bytes,
    at: frame.at,
    streamId: frame.streamId,
    ...(attachRequestId ? { attachRequestId } : {}),
    ...(source ? { source } : {}),
    barrier: classification.barrier,
    ...(classification.barrier && classification.barrierReason
      ? { barrierReason: classification.barrierReason }
      : {}),
    scannerStateBefore: cloneScannerState(classification.scannerStateBefore),
    scannerStateAfter: cloneScannerState(classification.scannerStateAfter),
    serializedBytes: 0,
    segments: [segmentForFrame(frame, classification, 0)],
  }
  batch.serializedBytes = measureBatch(input, batch, jsonStringContentBytes(batch.data))
  return batch
}

function canMerge(
  current: MutableTerminalOutputBatch,
  next: AnnotatedReplayFrame,
  nextClassification: FrameClassification,
  input: TerminalOutputBatchBuildInput,
): boolean {
  if (!isTransparentGroundFrame(nextClassification)) return false
  if (current.barrier) return false
  if (current.scannerStateBefore.mode !== 'ground' || current.scannerStateAfter.mode !== 'ground') return false
  if (next.seqStart !== current.seqEnd + 1) return false
  if (next.streamId !== current.streamId) return false
  if (frameAttachRequestId(next, input.attachRequestId) !== current.attachRequestId) return false
  if (frameSource(next, input.source) !== current.source) return false
  return true
}

function startMutableBatch(
  frame: AnnotatedReplayFrame,
  classification: FrameClassification,
  input: TerminalOutputBatchBuildInput,
): MutableTerminalOutputBatch {
  const attachRequestId = frameAttachRequestId(frame, input.attachRequestId)
  const source = frameSource(frame, input.source)
  const dataJsonContentBytes = jsonStringContentBytes(frame.data)
  const batch: MutableTerminalOutputBatch = {
    seqStart: frame.seqStart,
    seqEnd: frame.seqEnd,
    chunks: [frame.data],
    dataLength: frame.data.length,
    dataJsonContentBytes,
    bytes: frame.bytes,
    at: frame.at,
    streamId: frame.streamId,
    ...(attachRequestId ? { attachRequestId } : {}),
    ...(source ? { source } : {}),
    barrier: false,
    scannerStateBefore: cloneScannerState(classification.scannerStateBefore),
    scannerStateAfter: cloneScannerState(classification.scannerStateAfter),
    segments: [segmentForFrame(frame, classification, 0)],
    serializedBytes: 0,
  }
  batch.serializedBytes = measureBatch(input, materializeMutableBatchFrame(batch), dataJsonContentBytes)
  return batch
}

function materializeMutableBatchFrame(batch: MutableTerminalOutputBatch): ReplayFrame & FrameBoundaryMetadata {
  return {
    seqStart: batch.seqStart,
    seqEnd: batch.seqEnd,
    data: batch.chunks.join(''),
    bytes: batch.bytes,
    at: batch.at,
    streamId: batch.streamId,
    barrier: false,
    scannerStateBefore: batch.scannerStateBefore,
    scannerStateAfter: batch.scannerStateAfter,
    ...(batch.attachRequestId ? { attachRequestId: batch.attachRequestId } : {}),
    ...(batch.source ? { source: batch.source } : {}),
  }
}

function flushMutableBatch(batch: MutableTerminalOutputBatch): TerminalOutputBatch {
  const frame = materializeMutableBatchFrame(batch)
  return {
    ...frame,
    serializedBytes: batch.serializedBytes,
    segments: batch.segments,
  }
}

function measureMergedBatch(
  current: MutableTerminalOutputBatch,
  next: AnnotatedReplayFrame,
  nextClassification: FrameClassification,
  input: TerminalOutputBatchBuildInput,
): number {
  const dataJsonContentBytes = current.dataJsonContentBytes + jsonStringContentBytes(next.data)
  const candidate: ReplayFrame & FrameBoundaryMetadata = {
    seqStart: current.seqStart,
    seqEnd: next.seqEnd,
    data: '',
    bytes: current.bytes + next.bytes,
    at: next.at,
    streamId: current.streamId,
    barrier: false,
    scannerStateBefore: current.scannerStateBefore,
    scannerStateAfter: nextClassification.scannerStateAfter,
    ...(current.attachRequestId ? { attachRequestId: current.attachRequestId } : {}),
    ...(current.source ? { source: current.source } : {}),
  }

  if (input.terminalId && !input.payloadForFrame) {
    return measureBatch(input, candidate, dataJsonContentBytes)
  }
  if (!input.payloadForFrame && !input.measureFrameBytes) {
    return candidate.bytes
  }

  candidate.data = `${current.chunks.join('')}${next.data}`
  return measureBatch(input, candidate, dataJsonContentBytes)
}

function appendMutableBatch(
  current: MutableTerminalOutputBatch,
  next: AnnotatedReplayFrame,
  nextClassification: FrameClassification,
  serializedBytes: number,
): void {
  const offset = current.dataLength
  current.seqEnd = next.seqEnd
  current.chunks.push(next.data)
  current.dataLength += next.data.length
  current.dataJsonContentBytes += jsonStringContentBytes(next.data)
  current.bytes += next.bytes
  current.at = next.at
  current.scannerStateAfter = cloneScannerState(nextClassification.scannerStateAfter)
  current.segments.push(segmentForFrame(next, nextClassification, offset))
  current.serializedBytes = serializedBytes
}

export function buildTerminalOutputBatches<TFrame extends ReplayFrame>(
  input: TerminalOutputBatchBuildInput<TFrame>,
): TerminalOutputBatch[] {
  const maxSerializedBytes = normalizeBudget(input.maxSerializedBytes)
  const maxTotalSerializedBytes = input.maxTotalSerializedBytes === undefined
    ? Number.POSITIVE_INFINITY
    : normalizeBudget(input.maxTotalSerializedBytes)
  if (maxSerializedBytes <= 0 || maxTotalSerializedBytes <= 0) return []

  const fallbackScanner = createTerminalOutputBarrierScanner()
  const batches: TerminalOutputBatch[] = []
  let current: MutableTerminalOutputBatch | null = null
  let totalSerializedBytes = 0

  const pushBatch = (batch: TerminalOutputBatch): boolean => {
    if (
      Number.isFinite(maxTotalSerializedBytes)
      && totalSerializedBytes + batch.serializedBytes > maxTotalSerializedBytes
      && batches.length > 0
    ) {
      return false
    }
    batches.push(batch)
    totalSerializedBytes += batch.serializedBytes
    return true
  }

  const pushCurrent = (): boolean => {
    if (!current) return true
    const batch = flushMutableBatch(current)
    current = null
    return pushBatch(batch)
  }

  for (const rawFrame of input.frames) {
    const frame = rawFrame as AnnotatedReplayFrame
    const classification = classifyFrame(frame, fallbackScanner)

    if (!isTransparentGroundFrame(classification)) {
      if (!pushCurrent()) return batches
      const nextBatch = buildSingleBatch(frame, classification, input)
      if (!pushBatch(nextBatch)) return batches
      continue
    }

    if (current && canMerge(current, frame, classification, input)) {
      const mergedSerializedBytes = measureMergedBatch(current, frame, classification, input)
      if (mergedSerializedBytes <= maxSerializedBytes) {
        appendMutableBatch(current, frame, classification, mergedSerializedBytes)
        continue
      }
    }

    if (!pushCurrent()) return batches
    current = startMutableBatch(frame, classification, input)
  }

  pushCurrent()

  return batches
}
