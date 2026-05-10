const cancelledCreateRequestIds = new Set<string>()

export function cancelCreate(requestId: string): void {
  cancelledCreateRequestIds.add(requestId)
}

export function consumeCancelledCreate(requestId: string): boolean {
  if (!cancelledCreateRequestIds.has(requestId)) return false
  cancelledCreateRequestIds.delete(requestId)
  return true
}

export function _resetCancelledCreates(): void {
  cancelledCreateRequestIds.clear()
}
