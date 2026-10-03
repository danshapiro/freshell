import { stopManagedRuntimeSoul } from '@/lib/api'
import type { ManagedRuntimeProjectionFields } from '@shared/managed-runtime'

/** Confirm cleanup through the persisted soul, including an already stopped lost soul. */
export async function confirmManagedRuntimeStopped(content: ManagedRuntimeProjectionFields): Promise<void> {
  if (!content.soulId || typeof content.soulIntentRevision !== 'number') {
    throw new Error('Cleanup is missing its current session revision. Your conversation has been kept.')
  }
  const result = await stopManagedRuntimeSoul(content.soulId, content.soulIntentRevision)
  if (result.outcome !== 'verified_empty') {
    throw new Error('Cleanup could not be confirmed. Your conversation has been kept. Try again.')
  }
}
