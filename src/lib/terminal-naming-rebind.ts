import type { SessionLocator, TerminalPaneContent } from '@/store/paneTypes'

/**
 * Name reliability (Task 10, G45): a server-authoritative conversation switch
 * (the CLI's `/clear` or `/resume`, an OpenCode session switch, a new Codex
 * thread) moves a terminal pane from `previousSessionId` to `next`. The pane's
 * pre-durable naming handle — and a naming ref that named the superseded
 * session — belong to the OLD conversation (the server bound that handle to
 * it), so they are released and the pane's name resolves through its new
 * session from then on (`resolvePaneNameRef` falls through to `sessionRef`).
 * The old session keeps its own saved name; nothing is copied over.
 *
 * Call on the reducer draft BEFORE `content.sessionRef` is overwritten.
 * A first association (no previous session) and a same-session association
 * keep the naming identity. Answers whether anything was released.
 */
export function releaseSupersededConversationNaming(
  content: TerminalPaneContent,
  next: SessionLocator,
  previousSessionId: string | undefined,
): boolean {
  if (!previousSessionId || previousSessionId === next.sessionId) return false
  const current = content.sessionRef
  if (current?.provider !== next.provider || current.sessionId !== previousSessionId) return false
  const nameRef = content.nameRef
  const nameRefIsSuperseded = nameRef !== undefined && (
    nameRef.kind === 'pending'
    || (nameRef.provider === current.provider && nameRef.sessionId === previousSessionId)
  )
  if (!content.namingHandle && !nameRefIsSuperseded) return false
  content.namingHandle = undefined
  if (nameRefIsSuperseded) content.nameRef = undefined
  return true
}
