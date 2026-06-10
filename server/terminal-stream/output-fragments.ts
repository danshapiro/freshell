import { measureSerializedJsonBytes, type JsonPayload } from './serialized-budget.js'

export function containsLoneSurrogate(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = data.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

export function fragmentTerminalOutputForPayloadBudget(input: {
  maxSerializedBytes: number
  data: string
  payloadForData: (data: string) => JsonPayload
}): string[] {
  const maxSerializedBytes = Math.max(1, Math.floor(input.maxSerializedBytes))
  if (measureSerializedJsonBytes(input.payloadForData(input.data)) <= maxSerializedBytes) {
    return [input.data]
  }

  // node-pty currently gives Freshell terminal output as JavaScript strings.
  // Fragment on code points so Task 5 preserves that string contract without
  // splitting surrogate pairs or claiming byte-perfect PTY replay.
  const codePoints = Array.from(input.data)
  const chunks: string[] = []
  let offset = 0

  while (offset < codePoints.length) {
    let low = 1
    let high = codePoints.length - offset
    let best = 0

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = codePoints.slice(offset, offset + mid).join('')
      const bytes = measureSerializedJsonBytes(input.payloadForData(candidate))
      if (bytes <= maxSerializedBytes) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    if (best <= 0) {
      throw new Error('terminal output payload budget is too small for one code point')
    }

    chunks.push(codePoints.slice(offset, offset + best).join(''))
    offset += best
  }

  return chunks
}
