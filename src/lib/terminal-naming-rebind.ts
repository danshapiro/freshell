import { SessionNameRefSchema, sessionNameRefKey, type SessionNameRef } from '@shared/session-names'
import type { SessionLocator, TerminalPaneContent } from '@/store/paneTypes'

/** Adopt the server's naming binding for an accepted session association or
 * materialization. This works before the non-persisted redirect cache
 * loads: a durable binding releases the old pending handle; a still-pending
 * binding preserves the zero-turn name the server will transfer later. */
export function adoptAuthoritativeConversationNameRef(
  content: { nameRef?: SessionNameRef; namingHandle?: string },
  sessionRef: SessionLocator,
  rawNameRef: unknown,
): boolean {
  const parsed = SessionNameRefSchema.safeParse(rawNameRef)
  if (!parsed.success) return false
  const ref = parsed.data
  if (ref.kind === 'session' && (
    ref.provider !== sessionRef.provider || ref.sessionId !== sessionRef.sessionId
  )) return false
  content.nameRef = ref
  content.namingHandle = ref.kind === 'pending' ? ref.id : undefined
  return true
}

/**
 * Name reliability (Task 10, G45): a server-authoritative conversation switch
 * (the CLI's `/clear` or `/resume`, an OpenCode session switch, a new Codex
 * thread) moves a terminal pane from `previousSessionId` to `next`. The
 * server moves the terminal's naming binding with it only when that binding
 * is DURABLE; a still-pending handle stays the binding, and the server's
 * verified bind lane later transfers it onto the NEW session.
 *
 * The client mirrors that exactly. It releases the pane's naming identity
 * (so the name resolves through the new session from then on) only when the
 * identity was durable for the superseded session: a naming ref naming that
 * session, or a pending handle the server already SPENT — its pending→durable
 * redirect is in the client's name cache (`spentHandles`). A still-pending
 * handle (a zero-turn switch, before any transfer) is kept, so pane and
 * server row agree throughout. The old session keeps its own saved name;
 * nothing is copied over.
 *
 * Call on the reducer draft BEFORE `content.sessionRef` is overwritten.
 * A first association (no previous session) and a same-session association
 * keep the naming identity. Answers whether anything was released.
 */
export function releaseSupersededConversationNaming(
  content: TerminalPaneContent,
  next: SessionLocator,
  previousSessionId: string | undefined,
  spentHandles: readonly string[] = [],
): boolean {
  if (!previousSessionId || previousSessionId === next.sessionId) return false
  const current = content.sessionRef
  if (current?.provider !== next.provider || current.sessionId !== previousSessionId) return false
  const isSpent = (handle: string | undefined) => handle !== undefined && spentHandles.includes(handle)
  const nameRef = content.nameRef
  const nameRefSuperseded = nameRef !== undefined && (
    nameRef.kind === 'pending'
      ? isSpent(nameRef.id)
      : nameRef.provider === current.provider && nameRef.sessionId === previousSessionId
  )
  const handleSuperseded = content.namingHandle !== undefined
    && (nameRefSuperseded || isSpent(content.namingHandle))
  if (!nameRefSuperseded && !handleSuperseded) return false
  if (handleSuperseded) content.namingHandle = undefined
  if (nameRefSuperseded) content.nameRef = undefined
  return true
}

/**
 * The pending naming handles held by `contents` (their pending naming ref or
 * pre-durable handle) that the server already transferred onto a durable
 * session: the client's name cache holds a redirect from each.
 */
export function spentPendingNamingHandles(
  contents: readonly TerminalPaneContent[],
  redirects: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (!redirects) return []
  const spent = new Set<string>()
  for (const content of contents) {
    const handles = [
      content.nameRef?.kind === 'pending' ? content.nameRef.id : undefined,
      content.namingHandle,
    ]
    for (const handle of handles) {
      if (handle && redirects[sessionNameRefKey({ kind: 'pending', id: handle })]) spent.add(handle)
    }
  }
  return [...spent]
}
