export type JsonPayload = Record<string, unknown>

export const TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE = 'x'.repeat(512)
export const TERMINAL_STREAM_ATTACH_REQUEST_ID_SERIALIZED_BYTES_RESERVE = Buffer.byteLength(
  JSON.stringify(TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE),
  'utf8',
)

export function measureSerializedJsonBytes(payload: JsonPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

export function measureTerminalOutputPayloadBytes(payload: JsonPayload): number {
  return measureSerializedJsonBytes(payload)
}

export function isTerminalStreamAttachRequestIdWithinSerializedBudget(
  attachRequestId: string | undefined,
): boolean {
  if (attachRequestId === undefined) return true
  return Buffer.byteLength(JSON.stringify(attachRequestId), 'utf8')
    <= TERMINAL_STREAM_ATTACH_REQUEST_ID_SERIALIZED_BYTES_RESERVE
}
