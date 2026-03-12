import type { CodingCliProviderName } from './coding-cli/types.js'

export type SidebarSessionLocator = {
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
}

function sessionKey(locator: Pick<SidebarSessionLocator, 'provider' | 'sessionId'>): string {
  return `${locator.provider}:${locator.sessionId}`
}

function locatorPriority(locator: SidebarSessionLocator, serverInstanceId: string): number {
  if (locator.serverInstanceId === serverInstanceId) return 3
  if (locator.serverInstanceId == null) return 2
  return 1
}

export function buildSidebarOpenSessionKeys(
  locators: SidebarSessionLocator[],
  serverInstanceId: string,
): Set<string> {
  const keys = new Set<string>()

  for (const locator of locators) {
    if (locatorPriority(locator, serverInstanceId) < 2) continue
    keys.add(sessionKey(locator))
  }

  return keys
}
