import { TextDecoder } from 'node:util'
import type WebSocket from 'ws'

export type JsonRpcFrameInput = WebSocket.RawData | ArrayBuffer | string

export type JsonRpcEnvelopeScanSuccess = {
  ok: true
  root: 'object'
  id?: string | number
  method?: string
  duplicateTopLevelKeys: string[]
}

export type JsonRpcEnvelopeScanFailure = {
  ok: false
  reason:
    | 'batch_unsupported'
    | 'malformed_json'
    | 'non_object_root'
    | 'token_too_large'
}

export type JsonRpcEnvelopeScanResult = JsonRpcEnvelopeScanSuccess | JsonRpcEnvelopeScanFailure

export const MAX_FULL_PARSE_BYTES = 1 * 1024 * 1024
export const MAX_RAW_FORWARD_BYTES = 64 * 1024 * 1024
export const MAX_SCANNED_TOKEN_BYTES = 8 * 1024

const BYTE_TAB = 0x09
const BYTE_LF = 0x0a
const BYTE_CR = 0x0d
const BYTE_SPACE = 0x20
const BYTE_QUOTE = 0x22
const BYTE_MINUS = 0x2d
const BYTE_COMMA = 0x2c
const BYTE_DOT = 0x2e
const BYTE_COLON = 0x3a
const BYTE_BACKSLASH = 0x5c
const BYTE_OPEN_BRACKET = 0x5b
const BYTE_CLOSE_BRACKET = 0x5d
const BYTE_OPEN_BRACE = 0x7b
const BYTE_CLOSE_BRACE = 0x7d

const utf8Decoder = new TextDecoder('utf-8')

type ByteReader = {
  readonly length: number
  byteAt(index: number): number
  sliceToUtf8String(start: number, end: number): string
}

type ScanFailureReason = JsonRpcEnvelopeScanFailure['reason']
type IndexScanResult = { ok: true; next: number } | JsonRpcEnvelopeScanFailure
type StringScanResult = { ok: true; value: string; next: number } | JsonRpcEnvelopeScanFailure
type IdScanResult = { ok: true; value: string | number | undefined; next: number } | JsonRpcEnvelopeScanFailure
type NumberScanResult = { ok: true; start: number; end: number; next: number } | JsonRpcEnvelopeScanFailure
type StringBoundsScanResult =
  | { ok: true; contentStart: number; contentEnd: number; next: number }
  | JsonRpcEnvelopeScanFailure
type ContainerFrame =
  | {
      type: 'array'
      state: 'expectValueOrEnd' | 'expectValue' | 'expectCommaOrEnd'
    }
  | {
      type: 'object'
      state: 'expectKeyOrEnd' | 'expectKey' | 'expectColon' | 'expectValue' | 'expectCommaOrEnd'
    }

class StringByteReader implements ByteReader {
  readonly length: number

  constructor(private readonly value: string) {
    this.length = value.length
  }

  byteAt(index: number): number {
    return this.value.charCodeAt(index)
  }

  sliceToUtf8String(start: number, end: number): string {
    return this.value.slice(start, end)
  }
}

class Uint8ArrayByteReader implements ByteReader {
  readonly length: number

  constructor(private readonly value: Uint8Array) {
    this.length = value.byteLength
  }

  byteAt(index: number): number {
    return this.value[index]!
  }

  sliceToUtf8String(start: number, end: number): string {
    return utf8Decoder.decode(this.value.subarray(start, end))
  }
}

class SegmentedByteReader implements ByteReader {
  readonly length: number
  private readonly starts: number[]
  private cursor = 0

  constructor(private readonly segments: Uint8Array[]) {
    this.starts = []
    let offset = 0
    for (const segment of segments) {
      this.starts.push(offset)
      offset += segment.byteLength
    }
    this.length = offset
  }

  byteAt(index: number): number {
    let segmentIndex = this.cursor
    if (segmentIndex >= this.segments.length || index < this.starts[segmentIndex]!) {
      segmentIndex = 0
    }
    while (
      segmentIndex + 1 < this.segments.length &&
      index >= this.starts[segmentIndex + 1]!
    ) {
      segmentIndex += 1
    }
    this.cursor = segmentIndex
    const segment = this.segments[segmentIndex]!
    return segment[index - this.starts[segmentIndex]!]!
  }

  sliceToUtf8String(start: number, end: number): string {
    const bytes = new Uint8Array(end - start)
    for (let index = start; index < end; index += 1) {
      bytes[index - start] = this.byteAt(index)
    }
    return utf8Decoder.decode(bytes)
  }
}

export function scanJsonRpcEnvelope(input: JsonRpcFrameInput): JsonRpcEnvelopeScanResult {
  const reader = createByteReader(input)
  let index = skipWhitespace(reader, 0)
  if (index >= reader.length) return failure('malformed_json')

  const root = reader.byteAt(index)
  if (root === BYTE_OPEN_BRACKET) return failure('batch_unsupported')
  if (root !== BYTE_OPEN_BRACE) return failure('non_object_root')

  return scanRootObject(reader, index)
}

function scanRootObject(reader: ByteReader, start: number): JsonRpcEnvelopeScanResult {
  const duplicateTopLevelKeys: string[] = []
  const seenKeys = new Set<string>()
  const duplicateKeys = new Set<string>()
  let id: string | number | undefined
  let hasId = false
  let method: string | undefined
  let hasMethod = false
  let index = skipWhitespace(reader, start + 1)

  if (index >= reader.length) return failure('malformed_json')
  if (reader.byteAt(index) === BYTE_CLOSE_BRACE) {
    return finishRootObject(reader, index + 1, {
      duplicateTopLevelKeys,
      hasId,
      id,
      hasMethod,
      method,
    })
  }

  while (index < reader.length) {
    const keyResult = parseBoundedString(reader, index)
    if (!keyResult.ok) return keyResult
    const key = keyResult.value
    recordDuplicateKey(key, seenKeys, duplicateKeys, duplicateTopLevelKeys)

    index = skipWhitespace(reader, keyResult.next)
    if (index >= reader.length || reader.byteAt(index) !== BYTE_COLON) {
      return failure('malformed_json')
    }
    index = skipWhitespace(reader, index + 1)
    if (index >= reader.length) return failure('malformed_json')

    if (key === 'id') {
      const idResult = scanTopLevelId(reader, index)
      if (!idResult.ok) return idResult
      index = idResult.next
      if (idResult.value === undefined) {
        id = undefined
        hasId = false
      } else {
        id = idResult.value
        hasId = true
      }
    } else if (key === 'method') {
      const methodResult = scanTopLevelMethod(reader, index)
      if (!methodResult.ok) return methodResult
      index = methodResult.next
      if (methodResult.value === undefined) {
        method = undefined
        hasMethod = false
      } else {
        method = methodResult.value
        hasMethod = true
      }
    } else {
      const skipped = skipValue(reader, index)
      if (!skipped.ok) return skipped
      index = skipped.next
    }

    index = skipWhitespace(reader, index)
    if (index >= reader.length) return failure('malformed_json')
    const delimiter = reader.byteAt(index)
    if (delimiter === BYTE_COMMA) {
      index = skipWhitespace(reader, index + 1)
      continue
    }
    if (delimiter === BYTE_CLOSE_BRACE) {
      return finishRootObject(reader, index + 1, {
        duplicateTopLevelKeys,
        hasId,
        id,
        hasMethod,
        method,
      })
    }
    return failure('malformed_json')
  }

  return failure('malformed_json')
}

function finishRootObject(
  reader: ByteReader,
  next: number,
  envelope: {
    duplicateTopLevelKeys: string[]
    hasId: boolean
    id: string | number | undefined
    hasMethod: boolean
    method: string | undefined
  },
): JsonRpcEnvelopeScanResult {
  const trailing = skipWhitespace(reader, next)
  if (trailing !== reader.length) return failure('malformed_json')

  const result: JsonRpcEnvelopeScanSuccess = {
    ok: true,
    root: 'object',
    duplicateTopLevelKeys: envelope.duplicateTopLevelKeys,
  }
  if (envelope.hasId) result.id = envelope.id
  if (envelope.hasMethod) result.method = envelope.method
  return result
}

function scanTopLevelId(reader: ByteReader, index: number): IdScanResult {
  const valueStart = skipWhitespace(reader, index)
  if (valueStart >= reader.length) return failure('malformed_json')
  const first = reader.byteAt(valueStart)

  if (first === BYTE_QUOTE) {
    const parsed = parseBoundedString(reader, valueStart)
    if (!parsed.ok) return parsed
    return { ok: true, value: parsed.value, next: parsed.next }
  }

  if (first === BYTE_MINUS || isDigit(first)) {
    const parsed = parseNumberToken(reader, valueStart, MAX_SCANNED_TOKEN_BYTES)
    if (!parsed.ok) return parsed
    if (numberTokenHasFractionOrExponent(reader, parsed.start, parsed.end)) {
      return { ok: true, value: undefined, next: parsed.next }
    }
    const value = Number(reader.sliceToUtf8String(parsed.start, parsed.end))
    return {
      ok: true,
      value: Number.isFinite(value) && Number.isInteger(value) ? value : undefined,
      next: parsed.next,
    }
  }

  const skipped = skipValue(reader, valueStart)
  if (!skipped.ok) return skipped
  return { ok: true, value: undefined, next: skipped.next }
}

function scanTopLevelMethod(reader: ByteReader, index: number): StringScanResult | { ok: true; value: undefined; next: number } {
  const valueStart = skipWhitespace(reader, index)
  if (valueStart >= reader.length) return failure('malformed_json')
  if (reader.byteAt(valueStart) === BYTE_QUOTE) {
    return parseBoundedString(reader, valueStart)
  }

  const skipped = skipValue(reader, valueStart)
  if (!skipped.ok) return skipped
  return { ok: true, value: undefined, next: skipped.next }
}

function skipValue(reader: ByteReader, index: number): IndexScanResult {
  const valueStart = skipWhitespace(reader, index)
  if (valueStart >= reader.length) return failure('malformed_json')

  const stack: ContainerFrame[] = []
  let value = beginSkippedValue(reader, valueStart, stack)
  if (!value.ok) return value
  let next = value.next
  if (stack.length === 0) return { ok: true, next }

  while (stack.length > 0) {
    next = skipWhitespace(reader, next)
    if (next >= reader.length) return failure('malformed_json')

    const frame = stack[stack.length - 1]!
    if (frame.type === 'array') {
      if (frame.state === 'expectValueOrEnd') {
        if (reader.byteAt(next) === BYTE_CLOSE_BRACKET) {
          stack.pop()
          next += 1
          continue
        }
        frame.state = 'expectCommaOrEnd'
        value = beginSkippedValue(reader, next, stack)
        if (!value.ok) return value
        next = value.next
        continue
      }

      if (frame.state === 'expectValue') {
        frame.state = 'expectCommaOrEnd'
        value = beginSkippedValue(reader, next, stack)
        if (!value.ok) return value
        next = value.next
        continue
      }

      const delimiter = reader.byteAt(next)
      if (delimiter === BYTE_COMMA) {
        frame.state = 'expectValue'
        next += 1
        continue
      }
      if (delimiter === BYTE_CLOSE_BRACKET) {
        stack.pop()
        next += 1
        continue
      }
      return failure('malformed_json')
    }

    if (frame.state === 'expectKeyOrEnd') {
      if (reader.byteAt(next) === BYTE_CLOSE_BRACE) {
        stack.pop()
        next += 1
        continue
      }
      const key = skipString(reader, next)
      if (!key.ok) return key
      frame.state = 'expectColon'
      next = key.next
      continue
    }

    if (frame.state === 'expectKey') {
      const key = skipString(reader, next)
      if (!key.ok) return key
      frame.state = 'expectColon'
      next = key.next
      continue
    }

    if (frame.state === 'expectColon') {
      if (reader.byteAt(next) !== BYTE_COLON) return failure('malformed_json')
      frame.state = 'expectValue'
      next += 1
      continue
    }

    if (frame.state === 'expectValue') {
      frame.state = 'expectCommaOrEnd'
      value = beginSkippedValue(reader, next, stack)
      if (!value.ok) return value
      next = value.next
      continue
    }

    const delimiter = reader.byteAt(next)
    if (delimiter === BYTE_COMMA) {
      frame.state = 'expectKey'
      next += 1
      continue
    }
    if (delimiter === BYTE_CLOSE_BRACE) {
      stack.pop()
      next += 1
      continue
    }
    return failure('malformed_json')
  }

  return { ok: true, next }
}

function beginSkippedValue(reader: ByteReader, valueStart: number, stack: ContainerFrame[]): IndexScanResult {
  const first = reader.byteAt(valueStart)

  if (first === BYTE_QUOTE) return skipString(reader, valueStart)
  if (first === BYTE_OPEN_BRACE) {
    stack.push({ type: 'object', state: 'expectKeyOrEnd' })
    return { ok: true, next: valueStart + 1 }
  }
  if (first === BYTE_OPEN_BRACKET) {
    stack.push({ type: 'array', state: 'expectValueOrEnd' })
    return { ok: true, next: valueStart + 1 }
  }
  if (first === BYTE_MINUS || isDigit(first)) {
    const parsed = parseNumberToken(reader, valueStart)
    if (!parsed.ok) return parsed
    return { ok: true, next: parsed.next }
  }
  if (matchesLiteral(reader, valueStart, 'true')) return { ok: true, next: valueStart + 4 }
  if (matchesLiteral(reader, valueStart, 'false')) return { ok: true, next: valueStart + 5 }
  if (matchesLiteral(reader, valueStart, 'null')) return { ok: true, next: valueStart + 4 }

  return failure('malformed_json')
}

function parseBoundedString(reader: ByteReader, index: number): StringScanResult {
  const bounds = scanStringBounds(reader, index, MAX_SCANNED_TOKEN_BYTES)
  if (!bounds.ok) return bounds

  const raw = reader.sliceToUtf8String(bounds.contentStart, bounds.contentEnd)
  const value = decodeJsonStringContent(raw)
  if (value === undefined) return failure('malformed_json')
  return { ok: true, value, next: bounds.next }
}

function skipString(reader: ByteReader, index: number): IndexScanResult {
  const bounds = scanStringBounds(reader, index)
  if (!bounds.ok) return bounds
  return { ok: true, next: bounds.next }
}

function scanStringBounds(reader: ByteReader, start: number, maxTokenBytes?: number): StringBoundsScanResult {
  if (reader.byteAt(start) !== BYTE_QUOTE) return failure('malformed_json')

  let index = start + 1
  while (index < reader.length) {
    if (maxTokenBytes !== undefined && index - start + 1 > maxTokenBytes) {
      return failure('token_too_large')
    }

    const byte = reader.byteAt(index)
    if (byte === BYTE_QUOTE) {
      return { ok: true, contentStart: start + 1, contentEnd: index, next: index + 1 }
    }
    if (byte < BYTE_SPACE) return failure('malformed_json')

    if (byte === BYTE_BACKSLASH) {
      index += 1
      if (index >= reader.length) return failure('malformed_json')
      const escaped = reader.byteAt(index)
      if (escaped === 0x75) {
        for (let offset = 1; offset <= 4; offset += 1) {
          if (index + offset >= reader.length || !isHexDigit(reader.byteAt(index + offset))) {
            return failure('malformed_json')
          }
        }
        index += 5
        continue
      }
      if (!isSimpleEscape(escaped)) return failure('malformed_json')
    }

    index += 1
  }

  return failure('malformed_json')
}

function parseNumberToken(reader: ByteReader, start: number, maxTokenBytes?: number): NumberScanResult {
  let index = start
  if (reader.byteAt(index) === BYTE_MINUS) {
    index += 1
    if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
  }

  if (index >= reader.length) return failure('malformed_json')
  const firstIntegerByte = reader.byteAt(index)
  if (firstIntegerByte === 0x30) {
    index += 1
    if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
  } else if (firstIntegerByte >= 0x31 && firstIntegerByte <= 0x39) {
    index += 1
    while (index < reader.length && isDigit(reader.byteAt(index))) {
      index += 1
      if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
    }
  } else {
    return failure('malformed_json')
  }

  if (index < reader.length && reader.byteAt(index) === BYTE_DOT) {
    index += 1
    if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
    if (index >= reader.length || !isDigit(reader.byteAt(index))) return failure('malformed_json')
    while (index < reader.length && isDigit(reader.byteAt(index))) {
      index += 1
      if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
    }
  }

  if (index < reader.length && isExponentMarker(reader.byteAt(index))) {
    index += 1
    if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
    if (index < reader.length && isSign(reader.byteAt(index))) {
      index += 1
      if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
    }
    if (index >= reader.length || !isDigit(reader.byteAt(index))) return failure('malformed_json')
    while (index < reader.length && isDigit(reader.byteAt(index))) {
      index += 1
      if (isOverLimit(start, index, maxTokenBytes)) return failure('token_too_large')
    }
  }

  return { ok: true, start, end: index, next: index }
}

function decodeJsonStringContent(raw: string): string | undefined {
  let decoded = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (char.charCodeAt(0) < BYTE_SPACE) return undefined
    if (char !== '\\') {
      decoded += char
      continue
    }

    index += 1
    if (index >= raw.length) return undefined
    const escaped = raw[index]!
    if (escaped === '"') decoded += '"'
    else if (escaped === '\\') decoded += '\\'
    else if (escaped === '/') decoded += '/'
    else if (escaped === 'b') decoded += '\b'
    else if (escaped === 'f') decoded += '\f'
    else if (escaped === 'n') decoded += '\n'
    else if (escaped === 'r') decoded += '\r'
    else if (escaped === 't') decoded += '\t'
    else if (escaped === 'u') {
      if (index + 4 >= raw.length) return undefined
      let codeUnit = 0
      for (let offset = 1; offset <= 4; offset += 1) {
        const value = hexValue(raw.charCodeAt(index + offset))
        if (value === undefined) return undefined
        codeUnit = codeUnit * 16 + value
      }
      decoded += String.fromCharCode(codeUnit)
      index += 4
    } else {
      return undefined
    }
  }
  return decoded
}

function numberTokenHasFractionOrExponent(reader: ByteReader, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const byte = reader.byteAt(index)
    if (byte === BYTE_DOT || isExponentMarker(byte)) return true
  }
  return false
}

function recordDuplicateKey(
  key: string,
  seenKeys: Set<string>,
  duplicateKeys: Set<string>,
  duplicateTopLevelKeys: string[],
): void {
  if (seenKeys.has(key)) {
    if (!duplicateKeys.has(key)) {
      duplicateKeys.add(key)
      duplicateTopLevelKeys.push(key)
    }
    return
  }
  seenKeys.add(key)
}

function createByteReader(input: JsonRpcFrameInput): ByteReader {
  if (typeof input === 'string') return new StringByteReader(input)
  if (Array.isArray(input)) {
    return new SegmentedByteReader(input.map((chunk) => toUint8Array(chunk)))
  }
  if (input instanceof ArrayBuffer) return new Uint8ArrayByteReader(new Uint8Array(input))
  return new Uint8ArrayByteReader(toUint8Array(input))
}

function toUint8Array(input: ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function skipWhitespace(reader: ByteReader, start: number): number {
  let index = start
  while (index < reader.length && isWhitespace(reader.byteAt(index))) {
    index += 1
  }
  return index
}

function matchesLiteral(reader: ByteReader, start: number, literal: string): boolean {
  if (start + literal.length > reader.length) return false
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (reader.byteAt(start + offset) !== literal.charCodeAt(offset)) return false
  }
  return true
}

function isWhitespace(byte: number): boolean {
  return byte === BYTE_SPACE || byte === BYTE_TAB || byte === BYTE_LF || byte === BYTE_CR
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}

function isHexDigit(byte: number): boolean {
  return hexValue(byte) !== undefined
}

function hexValue(byte: number): number | undefined {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  return undefined
}

function isSimpleEscape(byte: number): boolean {
  return (
    byte === BYTE_QUOTE ||
    byte === BYTE_BACKSLASH ||
    byte === 0x2f ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  )
}

function isExponentMarker(byte: number): boolean {
  return byte === 0x45 || byte === 0x65
}

function isSign(byte: number): boolean {
  return byte === 0x2b || byte === BYTE_MINUS
}

function isOverLimit(start: number, next: number, maxTokenBytes: number | undefined): boolean {
  return maxTokenBytes !== undefined && next - start > maxTokenBytes
}

function failure(reason: ScanFailureReason): JsonRpcEnvelopeScanFailure {
  return { ok: false, reason }
}
