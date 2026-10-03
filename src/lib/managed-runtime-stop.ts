import { stopManagedRuntimeSoul, type ManagedRuntimeStopResult } from '@/lib/api'
import type { ManagedRuntimeProjectionFields } from '@shared/managed-runtime'

type ManagedConversation = ManagedRuntimeProjectionFields & { createRequestId: string }
type StopContext = {
  getCurrent: () => ManagedConversation | null | undefined
  applyIntentRevision: (revision: number) => void
}

const CLEANUP_UNCONFIRMED_MESSAGE = 'Cleanup could not be confirmed. Your conversation has been kept. Try again.'

/** Confirm cleanup through the persisted soul, including an already stopped lost soul. */
export async function confirmManagedRuntimeStopped(content: ManagedConversation, context: StopContext): Promise<boolean> {
  if (!content.soulId || typeof content.soulIntentRevision !== 'number') {
    throw new Error('Cleanup is missing its current session revision. Your conversation has been kept.')
  }
  const isCurrent = (latest: ManagedConversation | null | undefined): latest is ManagedConversation & { soulIntentRevision: number } => latest?.soulId === content.soulId
    && latest?.createRequestId === content.createRequestId
    && typeof latest?.soulIntentRevision === 'number'
  let result: ManagedRuntimeStopResult
  try {
    result = await stopManagedRuntimeSoul(content.soulId, content.soulIntentRevision)
  } catch (error) {
    const latest = context.getCurrent()
    if (!isCurrent(latest) || latest.soulIntentRevision > content.soulIntentRevision) return false
    throw error
  }
  const latest = context.getCurrent()
  if (!isCurrent(latest)) return false
  if (result.soul.soulId !== content.soulId || result.soul.intentRevision < content.soulIntentRevision) {
    throw new Error(CLEANUP_UNCONFIRMED_MESSAGE)
  }
  if (latest.soulIntentRevision > result.soul.intentRevision) return false
  // Stop commits its intent before attempting cleanup. Even an uncertain
  // result is the revision authority for the user's immediate retry.
  context.applyIntentRevision(result.soul.intentRevision)
  if (result.outcome !== 'verified_empty') {
    throw new Error(CLEANUP_UNCONFIRMED_MESSAGE)
  }
  return true
}
