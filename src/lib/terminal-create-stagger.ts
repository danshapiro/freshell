const STAGGER_INTERVAL_MS = 450

/**
 * TerminalCreateStagger — paces `terminal.create` wire sends at a minimum
 * interval of STAGGER_INTERVAL_MS so a client reload/reconnect restoring
 * multiple persisted panes never lands two agent-process spawns within the
 * same ~100ms window (the known OpenCode/Bun concurrent-launch crash,
 * upstream anomalyco/opencode#38366).
 *
 * Sits inside WsClient at the sendNow level — the single wire-level chokepoint
 * that all create paths (direct-ready, held-creates flush, ready-handler
 * flush, reconnect re-send) funnel through. Non-create messages bypass.
 *
 * Mirrors the RebindQueue precedent (src/lib/rebind-queue.ts) which paces
 * freshAgent.create for hidden panes, but operates at the wire level rather
 * than the view level.
 */
export class TerminalCreateStagger {
  private pending: Array<() => void> = []
  private lastSendAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  enqueue(send: () => void): void {
    this.pending.push(send)
    this.pump()
  }

  clear(): void {
    this.pending = []
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.lastSendAt = 0
  }

  resetForTests(): void {
    this.clear()
    this.lastSendAt = 0
  }

  private pump(): void {
    if (this.timer !== null || this.pending.length === 0) return
    const elapsed = Date.now() - this.lastSendAt
    const delay = Math.max(0, STAGGER_INTERVAL_MS - elapsed)
    this.timer = setTimeout(() => {
      this.timer = null
      this.lastSendAt = Date.now()
      const next = this.pending.shift()
      if (next) next()
      this.pump()
    }, delay)
  }
}

let singleton: TerminalCreateStagger | null = null

export function getTerminalCreateStagger(): TerminalCreateStagger {
  if (!singleton) singleton = new TerminalCreateStagger()
  return singleton
}

export function resetTerminalCreateStaggerForTests(): void {
  singleton?.clear()
  singleton = null
}
