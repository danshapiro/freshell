export type OwnedCreateBarrier = {
  entered: Promise<boolean>
  release: () => void
  expired: () => boolean
}

type Entry = {
  claimed: boolean
  enter: (entered: boolean) => void
  settled: Promise<'released' | 'expired'>
  finish: (outcome: 'released' | 'expired') => void
}

/** Test-only synchronization AFTER create-policy validation, never an ownership bypass. */
export class OwnedCreateBarriers {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly ownsSoul: (soulId: string) => boolean) {}

  arm(soulId: string, timeoutMs = 10_000): OwnedCreateBarrier {
    if (!this.ownsSoul(soulId)) throw new Error('create barrier requires a receipt-owned soul')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
      throw new Error('create barrier timeout must be bounded to 1..10000ms')
    }
    if (this.entries.has(soulId)) throw new Error('this soul already has an active create barrier')
    let enter!: Entry['enter']
    let settle!: (outcome: 'released' | 'expired') => void
    let expired = false
    let finished = false
    const entered = new Promise<boolean>((resolve) => { enter = resolve })
    const settled = new Promise<'released' | 'expired'>((resolve) => { settle = resolve })
    const entry: Entry = {
      claimed: false, enter, settled,
      finish: (outcome) => {
        if (finished) return
        finished = true
        expired = outcome === 'expired'
        clearTimeout(timer)
        if (this.entries.get(soulId) === entry) this.entries.delete(soulId)
        if (!entry.claimed) enter(false)
        settle(outcome)
      },
    }
    const timer = setTimeout(() => entry.finish('expired'), timeoutMs)
    timer.unref?.()
    this.entries.set(soulId, entry)
    return { entered, release: () => entry.finish('released'), expired: () => expired }
  }

  async enter(soulId: string): Promise<'released' | 'expired' | null> {
    const entry = this.entries.get(soulId)
    if (!entry || entry.claimed) return null
    entry.claimed = true
    entry.enter(true)
    return entry.settled
  }

  releaseAll(): void {
    for (const entry of this.entries.values()) entry.finish('released')
  }
}
