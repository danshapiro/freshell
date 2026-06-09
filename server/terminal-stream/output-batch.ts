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
  batch: ReplayFrame,
): number {
  if (input.payloadForFrame) {
    return measureTerminalOutputPayloadBytes(input.payloadForFrame(batch))
  }

  if (input.terminalId) {
    return measureTerminalOutputPayloadBytes(defaultPayloadForFrame(
      input.terminalId,
      input.attachRequestId,
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
  batch.serializedBytes = measureBatch(input, batch)
  return batch
}

function canMerge(
  current: TerminalOutputBatch,
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

function mergeBatches(
  current: TerminalOutputBatch,
  next: AnnotatedReplayFrame,
  nextClassification: FrameClassification,
  input: TerminalOutputBatchBuildInput,
): TerminalOutputBatch {
  const merged: TerminalOutputBatch = {
    ...current,
    seqEnd: next.seqEnd,
    data: current.data + next.data,
    bytes: current.bytes + next.bytes,
    at: next.at,
    barrier: false,
    scannerStateBefore: cloneScannerState(current.scannerStateBefore),
    scannerStateAfter: cloneScannerState(nextClassification.scannerStateAfter),
    segments: [
      ...current.segments,
      segmentForFrame(next, nextClassification, current.data.length),
    ],
    serializedBytes: 0,
  }
  delete merged.barrierReason
  merged.serializedBytes = measureBatch(input, merged)
  return merged
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
  let current: TerminalOutputBatch | null = null
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

  for (const rawFrame of input.frames) {
    const frame = rawFrame as AnnotatedReplayFrame
    const classification = classifyFrame(frame, fallbackScanner)
    const nextBatch = buildSingleBatch(frame, classification, input)

    if (!isTransparentGroundFrame(classification)) {
      if (current && !pushBatch(current)) return batches
      current = null
      if (!pushBatch(nextBatch)) return batches
      continue
    }

    if (current && canMerge(current, frame, classification, input)) {
      const merged = mergeBatches(current, frame, classification, input)
      if (merged.serializedBytes <= maxSerializedBytes) {
        current = merged
        continue
      }
    }

    if (current && !pushBatch(current)) return batches
    current = nextBatch
  }

  if (current) {
    pushBatch(current)
  }

  return batches
}
