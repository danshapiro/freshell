const cancelledCreateRequestIds = new Set<string>()
const createRequestRouteById = new Map<string, { cwd?: string }>()

export function cancelCreate(requestId: string): void {
  cancelledCreateRequestIds.add(requestId)
}

export function rememberCreateRoute(requestId: string, route: { cwd?: string }): void {
  const cwd = route.cwd?.trim()
  if (cwd) {
    createRequestRouteById.set(requestId, { cwd })
  } else {
    createRequestRouteById.delete(requestId)
  }
}

export function consumeCreateRoute(requestId: string): { cwd?: string } | undefined {
  const route = createRequestRouteById.get(requestId)
  createRequestRouteById.delete(requestId)
  return route
}

export function consumeCancelledCreate(requestId: string): boolean {
  if (!cancelledCreateRequestIds.has(requestId)) return false
  cancelledCreateRequestIds.delete(requestId)
  return true
}

export function _resetCancelledCreates(): void {
  cancelledCreateRequestIds.clear()
  createRequestRouteById.clear()
}
