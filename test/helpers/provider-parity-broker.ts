import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

import type { InitialProviderVolumeAuthorization, RestrictedDockerBroker } from '../../scripts/testing/runtime-test-broker.js'
import type { RuntimeHarness } from '../../scripts/testing/runtime-sandbox.js'

/** The run-owned installation, session-host artifact, and daemon behind every initial provider volume. */
export type ProviderParitySource = Omit<InitialProviderVolumeAuthorization, 'soulId' | 'providerVolumeName'>

/** `FreshProvider::as_str()` in crates/freshell-runtime-protocol. */
export type FreshAgentRuntimeProvider = 'claude' | 'kilroy' | 'codex' | 'opencode'

/** `stable_hex` in crates/freshell-server (managed_runtime.rs and fresh_agent_proxy.rs). */
function stableHex(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/** `stable_soul_id` in crates/freshell-server/src/managed_runtime.rs, keyed by the create request id. */
function managedTerminalSoulId(requestId: string): string {
  return `soul-terminal-${stableHex(requestId)}`
}

/** `stable_soul_id` in crates/freshell-server/src/fresh_agent_proxy.rs, keyed by the create request id. */
function freshAgentSoulId(provider: FreshAgentRuntimeProvider, requestId: string): string {
  return `soul-fresh-${provider}-${stableHex(requestId)}`
}

/** `stable_provider_volume_name` in crates/freshell-supervisor/src/registry.rs. */
function providerVolumeName(installationId: string, soulId: string): string {
  return `freshell-provider-${createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}`
}

function authorizeProviderParitySoul(
  broker: RestrictedDockerBroker,
  source: ProviderParitySource,
  soulId: string,
): InitialProviderVolumeAuthorization {
  const authorization = { ...source, soulId, providerVolumeName: providerVolumeName(source.installationId, soulId) }
  broker.authorizeInitialProviderVolume(authorization)
  return authorization
}

/** Register a managed terminal create before its first initial-volume observation. */
export function authorizeProviderParityRequest(
  broker: RestrictedDockerBroker,
  source: ProviderParitySource,
  requestId: string,
): InitialProviderVolumeAuthorization {
  return authorizeProviderParitySoul(broker, source, managedTerminalSoulId(requestId))
}

/** Register a hosted fresh-agent create before its first initial-volume observation. */
export function authorizeFreshAgentParityRequest(
  broker: RestrictedDockerBroker,
  source: ProviderParitySource,
  provider: FreshAgentRuntimeProvider,
  requestId: string,
): InitialProviderVolumeAuthorization {
  return authorizeProviderParitySoul(broker, source, freshAgentSoulId(provider, requestId))
}

/** Read this run's provider source through its own broker after the supervisor reports its installation. */
export async function readProviderParitySource(
  runtime: Pick<RuntimeHarness, 'broker' | 'imageRef' | 'testHostBinary'>,
  installationId: string,
): Promise<ProviderParitySource> {
  const daemon = await new Promise<{ ID: string }>((resolve, reject) => {
    const request = http.get({ socketPath: runtime.broker.proxySocketPath, path: '/v1.47/info' }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 64 * 1024) request.destroy(new Error('owned daemon metadata exceeds fixture bound'))
        else chunks.push(Buffer.from(chunk))
      })
      response.once('error', reject)
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('owned daemon metadata unavailable')
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
  })
  return {
    installationId,
    imageRef: runtime.imageRef,
    hostBinaryPath: runtime.testHostBinary,
    binarySha256: createHash('sha256').update(fs.readFileSync(runtime.testHostBinary)).digest('hex'),
    daemonId: daemon.ID,
  }
}

export {
  captureInitialProviderVolumes as captureProviderParityVolumes,
  cleanupInitialProviderVolumes as cleanupProviderParityVolumes,
} from "../../scripts/testing/initial-provider-volume.js"
