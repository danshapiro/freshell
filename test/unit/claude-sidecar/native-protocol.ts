import { randomUUID } from 'node:crypto'

// Manual native-hook rigs exercise the same v2 envelope as the current Rust
// launch builder. Their scenario fields still name the native boot explicitly.
export function nativeProtocolRequest(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const request = value as Record<string, any>
  if (request.type === 'send' && !Object.hasOwn(request, 'uuid')) return { ...request, uuid: randomUUID() }
  if (request.type !== 'create' || Object.hasOwn(request, 'protocol')) return request
  const boot = request.resumeSessionId
    ? request.forkSession === true
      ? { kind: 'fork', resume: request.resumeSessionId, resumeSessionAt: request.resumeSessionAt, dropsTurn: request.resumeDropsTurn }
      : { kind: 'resume', resume: request.resumeSessionId }
    : { kind: 'fresh' }
  return { ...request, protocol: 2, boot }
}
