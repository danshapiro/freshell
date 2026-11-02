export type FreshAgentCreateRoute = { viewId?: string }

const cancelledCreateRoutes = new Map<string, FreshAgentCreateRoute>()
const createRequestRouteById = new Map<string, { viewId?: string }>()

export function cancelCreate(requestId: string, viewId?: string): void {
  const normalizedViewId = viewId?.trim() || createRequestRouteById.get(requestId)?.viewId
  cancelledCreateRoutes.set(requestId, normalizedViewId ? { viewId: normalizedViewId } : {})
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

export function getCreateRoute(requestId: string): FreshAgentCreateRoute | undefined {
  const route = createRequestRouteById.get(requestId)
  return route ? { ...route } : undefined
}

export function consumeCreateRoute(requestId: string, expectedViewId?: string): FreshAgentCreateRoute | undefined {
  const route = createRequestRouteById.get(requestId)
  if (expectedViewId && route?.viewId !== expectedViewId) return undefined
  createRequestRouteById.delete(requestId)
  return route ? { ...route } : undefined
}

export function consumeCancelledCreateRoute(requestId: string): FreshAgentCreateRoute | undefined {
  const route = cancelledCreateRoutes.get(requestId)
  if (!route) return undefined
  cancelledCreateRoutes.delete(requestId)
  return { ...route }
}

export function consumeCancelledCreate(requestId: string, expectedViewId?: string): boolean {
  const route = cancelledCreateRoutes.get(requestId)
  if (!route || (expectedViewId && route.viewId !== expectedViewId)) return false
  cancelledCreateRoutes.delete(requestId)
  return true
}

export function _resetCancelledCreates(): void {
  cancelledCreateRoutes.clear()
  createRequestRouteById.clear()
}
