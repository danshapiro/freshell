/**
 * Terminal ids whose server-side subscription has already been (or is about
 * to be) released by an explicit send — currently terminal.kill. The detach
 * middleware consumes a mark instead of sending a redundant terminal.detach
 * for a terminal the server just removed (the server replies with an error
 * for detach on a non-existent terminal).
 *
 * Terminal ids are server-generated and never reused, so a stale mark can
 * only ever suppress a detach for a terminal that no longer needs one.
 * Marks for terminals never referenced by any layout (e.g. background session
 * kills) are intentionally left unconsumed — benign because terminal ids are
 * never reused.
 */
const releasedTerminalIds = new Set<string>()

export function markTerminalReleased(terminalId: string): void {
  releasedTerminalIds.add(terminalId)
}

export function consumeTerminalReleaseMark(terminalId: string): boolean {
  return releasedTerminalIds.delete(terminalId)
}

export function resetTerminalReleaseMarks(): void {
  releasedTerminalIds.clear()
}
