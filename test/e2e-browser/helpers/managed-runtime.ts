import { ManagedRuntimeOwner } from '../../../scripts/testing/runtime-sandbox.js'
import { RustServer } from './rust-server.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import { resolveManagedExternalDescriptor } from '../../../scripts/testing/runtime-external-browser.js'
import { ExternalManagedRuntimeRig } from './external-managed-runtime.js'

export {
  P2_OPENCODE_VERSION, P2_OPENCODE_MODEL,
  type ManagedRuntimeView, type ManagedOpenCodeAdoptionStatus,
  type ExactRuntimeHandle, type FixtureNativeState, type RuntimeHostFacts, type NativeToolEvidence,
} from '../../../scripts/testing/runtime-sandbox.js'

/** The browser fixture supplies its owned web process to the shared owner. */
export class ManagedRuntimeBrowserRig extends ManagedRuntimeOwner {
  constructor(...args: ConstructorParameters<typeof ManagedRuntimeOwner> extends [unknown, ...infer Rest] ? Rest : never) {
    super((options) => new RustServer(options), ...args)
  }

  async start(): Promise<E2eServerInfo> {
    return super.start()
  }
}

export type ManagedFixtureRig = ManagedRuntimeBrowserRig | ExternalManagedRuntimeRig

export function createManagedRuntimeBrowserRig(...args: ConstructorParameters<typeof ManagedRuntimeBrowserRig>): ManagedFixtureRig {
  const descriptor = resolveManagedExternalDescriptor(process.env)
  if (!descriptor) return new ManagedRuntimeBrowserRig(...args)
  const configured = args[5] ?? { enabledProviders: ['opencode'] }
  return new ExternalManagedRuntimeRig(descriptor, fetch, {
    phase: args[1] ?? 2, enabledProviders: [...configured.enabledProviders],
    freshAgentModes: [...(configured.freshAgentModes ?? [])], fixtureFreshAgentModes: [...(configured.fixtureFreshAgentModes ?? [])],
  })
}
