import type { Page } from '@playwright/test'

/** Same-origin API calls must use the same auth contract as src/lib/api.ts. */
export async function runtimeBrowserPost<T = unknown>(
  page: Page, token: string, route: string, body: unknown,
): Promise<T> {
  const parsed = new URL(route, 'https://runtime.invalid')
  if (!route.startsWith('/api/') || parsed.origin !== 'https://runtime.invalid'
    || !parsed.pathname.startsWith('/api/')) throw new Error('invalid runtime API route')
  if (!token) throw new Error('runtime API token is missing')
  return page.evaluate(async ({ token: authToken, route: apiRoute, body: requestBody }) => {
    const response = await fetch(apiRoute, {
      method: 'POST',
      headers: { 'x-auth-token': authToken, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    // Error bodies may contain provider diagnostics. Keep them out of browser
    // qualification logs; the owned server log is retained separately.
    if (!response.ok) throw new Error(`runtime API HTTP ${response.status}`)
    let value: any
    try { value = await response.json() } catch { throw new Error('runtime API returned invalid JSON') }
    if (value?.status === 'error' || value?.success === false) throw new Error('runtime API returned an error envelope')
    return value && typeof value === 'object' && 'data' in value ? value.data : value
  }, { token, route, body }) as Promise<T>
}

/** Simulate missing managed views without altering saved layout or tombstones. */
export function pruneRuntimeBrowserLayout(value: unknown, keepTabId: string): any {
  if (!value || typeof value !== 'object') throw new Error('persisted layout is missing')
  const layout = structuredClone(value) as any
  if (!Array.isArray(layout.tabs?.tabs) || !layout.panes?.layouts) throw new Error('persisted layout has an invalid shape')
  if (!layout.tabs.tabs.some((tab: any) => tab.id === keepTabId) || !layout.panes.layouts[keepTabId]) {
    throw new Error('persisted layout does not contain the requested saved tab and pane')
  }
  layout.tabs.tabs = layout.tabs.tabs.filter((tab: any) => tab.id === keepTabId)
  layout.tabs.activeTabId = keepTabId
  for (const field of ['layouts', 'activePane', 'paneTitles', 'paneTitleSetByUser']) {
    const table = layout.panes[field]
    if (table && typeof table === 'object' && !Array.isArray(table)) {
      layout.panes[field] = Object.fromEntries(Object.entries(table).filter(([tabId]) => tabId === keepTabId))
    }
  }
  return layout
}
