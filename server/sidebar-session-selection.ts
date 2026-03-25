import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'

export type SidebarSessionLocator = {
  provider: CodingCliProviderName
  sessionId: string
  cwd?: string
  serverInstanceId?: string
}

function sessionKey(locator: Pick<SidebarSessionLocator, 'provider' | 'sessionId' | 'cwd'>): string {
  return makeSessionKey(locator.provider, locator.sessionId, locator.cwd)
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
