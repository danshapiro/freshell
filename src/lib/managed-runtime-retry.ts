import { z } from 'zod'
import { retryManagedRuntimeSoul } from '@/lib/api'
import { managedRecoveryBlockedMessage } from '@/lib/managed-runtime-recovery-message'
import { queueManagedRuntimeRefresh } from '@/lib/recovery/managed-runtime-recovery'
import type { AppStore } from '@/store/store'
import type { ManagedRuntimeProjectionFields } from '@shared/managed-runtime'

type ManagedConversation = ManagedRuntimeProjectionFields & { createRequestId: string }

// The supervisor serializes the blocked probe with snake_case data keys;
// RetryHint itself uses camelCase. Only fields needed for pane feedback are read.
const RetryResultSchema = z.object({
  outcome: z.string(),
  view: z.object({
    soulId: z.string(),
    intentRevision: z.number().int().nonnegative(),
    recoveryReason: z.string().optional(),
  }),
  probe: z.object({
    kind: z.literal('blocked'),
    data: z.object({
      reason: z.string(),
      retry_hint: z.object({ repair: z.string().optional() }).optional(),
    }),
  }).nullish().catch(undefined),
})

/** Retry the same conversation and keep an unresolved decision actionable. */
export async function retryManagedConversation(
  content: ManagedConversation,
  getCurrent: () => ManagedConversation | null | undefined,
  store: Pick<AppStore, 'dispatch' | 'getState'>,
): Promise<void> {
  if (!content.soulId || typeof content.soulIntentRevision !== 'number') {
    throw new Error('Managed recovery is missing its current revision.')
  }
  const isCurrent = (revision = content.soulIntentRevision) => {
    const latest = getCurrent()
    return Boolean(latest && latest.soulId === content.soulId
      && latest.createRequestId === content.createRequestId
      && latest.soulIntentRevision === revision
      && latest.recoverySummary?.recoveryState === 'blocked')
  }
  let response: unknown
  try {
    response = await retryManagedRuntimeSoul(content.soulId, content.soulIntentRevision)
  } catch (error) {
    if (!isCurrent()) return
    throw error
  }
  if (!isCurrent()) return
  const parsed = RetryResultSchema.safeParse(response)
  const result = parsed.success ? parsed.data : undefined
  if (result && (result.view.soulId !== content.soulId
    || result.view.intentRevision < content.soulIntentRevision)) return
  await queueManagedRuntimeRefresh(store, 'pane-recovery-retry')
  if (!isCurrent(result?.view.intentRevision ?? content.soulIntentRevision)) return
  // A completed HTTP request is not evidence that recovery succeeded. If the
  // refreshed pane still needs a decision, retain the supervisor's guidance.
  const repair = result?.outcome === 'blocked' ? result.probe?.data.retry_hint?.repair?.trim() : undefined
  const reason = result?.probe?.data.reason ?? result?.view.recoveryReason ?? getCurrent()?.recoverySummary?.reason
  throw new Error(repair || managedRecoveryBlockedMessage(reason))
}
