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

export function scanJsonRpcEnvelope(_input: JsonRpcFrameInput): JsonRpcEnvelopeScanResult {
  throw new Error('scanJsonRpcEnvelope is not implemented yet.')
}
