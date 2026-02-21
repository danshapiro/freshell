type LayoutSchedulerArgs = {
  requestFrame?: (cb: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}

export function createLayoutScheduler(run: () => void, args: LayoutSchedulerArgs = {}) {
  const requestFrame = args.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = args.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  let rafId: number | null = null
  let scheduled = false

  return {
    request() {
      if (scheduled) return
      scheduled = true
      rafId = requestFrame(() => {
        scheduled = false
        rafId = null
        run()
      })
    },
    cancel() {
      if (scheduled && rafId !== null) {
        cancelFrame(rafId)
      }
      scheduled = false
      rafId = null
    },
  }
}
