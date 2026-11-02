const cancelledCreateRequestIds = new Set<string>()
const createRequestRouteById = new Map<string, { viewId?: string }>()

export function cancelCreate(requestId: string): void {
  cancelledCreateRequestIds.add(requestId)
}

export function rememberCreateRoute(requestId: string, route: { viewId?: string }): void {
  const viewId = route.viewId?.trim()
  if (viewId) {
    createRequestRouteById.set(requestId, {
      ...(viewId ? { viewId } : {}),
    })
  } else {
    createRequestRouteById.delete(requestId)
  }
}

export function consumeCreateRoute(requestId: string): { viewId?: string } | undefined {
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
