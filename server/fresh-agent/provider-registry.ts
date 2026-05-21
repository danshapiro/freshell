import type { FreshAgentSessionType, FreshAgentRuntimeProvider } from '../../shared/fresh-agent.js'
import type { FreshAgentRuntimeAdapter } from './runtime-adapter.js'

export type FreshAgentProviderRegistration = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  adapter: FreshAgentRuntimeAdapter
}

export class FreshAgentProviderRegistry {
  private readonly registrationsBySessionType = new Map<FreshAgentSessionType, FreshAgentProviderRegistration>()
  private readonly registrationsByRuntimeProvider = new Map<FreshAgentRuntimeProvider, FreshAgentProviderRegistration>()

  constructor(registrations: FreshAgentProviderRegistration[]) {
    for (const registration of registrations) {
      this.registrationsBySessionType.set(registration.sessionType, registration)
      const runtimeRegistration = this.registrationsByRuntimeProvider.get(registration.runtimeProvider)
      if (!runtimeRegistration) {
        this.registrationsByRuntimeProvider.set(registration.runtimeProvider, registration)
      } else if (runtimeRegistration.adapter !== registration.adapter) {
        throw new Error(
          `Fresh-agent runtime provider ${registration.runtimeProvider} has multiple adapters; register shared session types with the same adapter instance.`,
        )
      }
    }
  }

  resolveBySessionType(sessionType: FreshAgentSessionType): FreshAgentProviderRegistration | undefined {
    return this.registrationsBySessionType.get(sessionType)
  }

  resolveByRuntimeProvider(runtimeProvider: FreshAgentRuntimeProvider): FreshAgentProviderRegistration | undefined {
    return this.registrationsByRuntimeProvider.get(runtimeProvider)
  }
}

export function createFreshAgentProviderRegistry(registrations: FreshAgentProviderRegistration[]) {
  return new FreshAgentProviderRegistry(registrations)
}
