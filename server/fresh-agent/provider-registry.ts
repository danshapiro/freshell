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
      this.registrationsByRuntimeProvider.set(registration.runtimeProvider, registration)
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
