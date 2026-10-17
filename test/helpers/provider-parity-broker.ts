import { createHash } from 'node:crypto'

import type { InitialProviderVolumeAuthorization, RestrictedDockerBroker } from '../../scripts/testing/runtime-test-broker.js'

export {
  captureInitialProviderVolumes as captureProviderParityVolumes,
  cleanupInitialProviderVolumes as cleanupProviderParityVolumes,
} from '../../scripts/testing/initial-provider-volume.js'

export function authorizeProviderParityRequest(
  broker: RestrictedDockerBroker,
  source: Omit<InitialProviderVolumeAuthorization, 'soulId' | 'providerVolumeName'>,
  requestId: string,
): InitialProviderVolumeAuthorization {
  const soulId = `soul-terminal-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`
  const providerVolumeName = `freshell-provider-${createHash('sha256').update(`${source.installationId}\0${soulId}`).digest('hex').slice(0, 24)}`
  const authorization = { ...source, soulId, providerVolumeName }
  broker.authorizeInitialProviderVolume(authorization)
  return authorization
}
