import type { Request, Response } from 'express'
import { createReadModelAbortError } from './work-scheduler.js'

export function createRequestAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController()

  const abort = () => {
    if (controller.signal.aborted) return
    controller.abort(createReadModelAbortError())
    cleanup()
  }

  const cleanup = () => {
    req.off('aborted', abort)
    req.off('close', abort)
    res.off('close', abort)
    res.off('finish', cleanup)
  }

  req.once('aborted', abort)
  req.once('close', abort)
  res.once('close', abort)
  res.once('finish', cleanup)

  return controller.signal
}
