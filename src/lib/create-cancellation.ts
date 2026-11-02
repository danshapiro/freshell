export type FreshAgentCreateRoute = { viewId?: string }

type CreateRouteTable = Map<string, Map<string, FreshAgentCreateRoute>>

const cancelledCreateRoutes: CreateRouteTable = new Map()
const createRequestRouteById: CreateRouteTable = new Map()

function viewKey(viewId?: string): string {
  return viewId?.trim() ?? ''
}

function routeMap(table: CreateRouteTable, requestId: string, create = false): Map<string, FreshAgentCreateRoute> | undefined {
  let routes = table.get(requestId)
  if (!routes && create) {
    routes = new Map()
    table.set(requestId, routes)
  }
  return routes
}

function getRoute(table: CreateRouteTable, requestId: string, expectedViewId?: string): FreshAgentCreateRoute | undefined {
  const routes = routeMap(table, requestId)
  if (!routes) return undefined
  if (expectedViewId !== undefined) return routes.get(viewKey(expectedViewId))
  return routes.size === 1 ? routes.values().next().value : undefined
}

function removeRoute(table: CreateRouteTable, requestId: string, expectedViewId?: string): FreshAgentCreateRoute | undefined {
  const routes = routeMap(table, requestId)
  if (!routes) return undefined
  const key = expectedViewId !== undefined
    ? viewKey(expectedViewId)
    : routes.size === 1 ? routes.keys().next().value : undefined
  if (key === undefined) return undefined
  const route = routes.get(key)
  if (!route) return undefined
  routes.delete(key)
  if (routes.size === 0) table.delete(requestId)
  return route
}

export function cancelCreate(requestId: string, viewId?: string): void {
  const currentRoute = getRoute(createRequestRouteById, requestId, viewId)
  const normalizedViewId = viewId?.trim() || currentRoute?.viewId
  routeMap(cancelledCreateRoutes, requestId, true)?.set(viewKey(normalizedViewId),
    normalizedViewId ? { viewId: normalizedViewId } : {})
}

export function rememberCreateRoute(requestId: string, route: { viewId?: string }): void {
  const viewId = route.viewId?.trim()
  routeMap(createRequestRouteById, requestId, true)?.set(viewKey(viewId), viewId ? { viewId } : {})
}

export function getCreateRoute(requestId: string, expectedViewId?: string): FreshAgentCreateRoute | undefined {
  const route = getRoute(createRequestRouteById, requestId, expectedViewId)
  return route ? { ...route } : undefined
}

export function hasCreateRoute(requestId: string): boolean {
  return Boolean(routeMap(createRequestRouteById, requestId)?.size)
}

export function consumeCreateRoute(requestId: string, expectedViewId?: string): FreshAgentCreateRoute | undefined {
  const route = removeRoute(createRequestRouteById, requestId, expectedViewId)
  return route ? { ...route } : undefined
}

export function consumeCancelledCreateRoute(requestId: string, expectedViewId?: string): FreshAgentCreateRoute | undefined {
  const route = removeRoute(cancelledCreateRoutes, requestId, expectedViewId)
  return route ? { ...route } : undefined
}

export function consumeCancelledCreate(requestId: string, expectedViewId?: string): boolean {
  return removeRoute(cancelledCreateRoutes, requestId, expectedViewId) !== undefined
}

export function _resetCancelledCreates(): void {
  cancelledCreateRoutes.clear()
  createRequestRouteById.clear()
}
