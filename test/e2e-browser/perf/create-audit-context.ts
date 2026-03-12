import { devices, type BrowserContextOptions, type CDPSession } from '@playwright/test'
import type { VisibleFirstProfileId } from './audit-contract.js'

const MOBILE_NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: 1_600_000 / 8,
  uploadThroughput: 750_000 / 8,
}

export function buildAuditContextOptions(input: {
  profileId: VisibleFirstProfileId
}): BrowserContextOptions {
  if (input.profileId === 'mobile_restricted') {
    const device = devices['iPhone 14']
    return {
      ...device,
      serviceWorkers: 'block',
    }
  }

  return {
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  }
}

export async function applyProfileNetworkConditions(
  cdpSession: Pick<CDPSession, 'send'>,
  profileId: VisibleFirstProfileId,
): Promise<void> {
  await cdpSession.send('Network.enable')
  await cdpSession.send('Network.setCacheDisabled', { cacheDisabled: true })

  if (profileId === 'mobile_restricted') {
    await cdpSession.send('Network.emulateNetworkConditions', MOBILE_NETWORK)
  }
}
