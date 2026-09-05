import { z } from 'zod'
import type { PickerEntry } from './profile.js'

export interface ChooseProfileHandlerDeps {
  entries: PickerEntry[]
  /** Defense-in-depth: only the picker window may drive this channel. */
  isAllowedSender: (event: unknown) => boolean
  /** Relaunch the app pinned to the chosen profile id, then exit this
   *  launcher process. 'default' is a valid id -- the relaunched process is
   *  an explicit launch of the default profile. */
  relaunchWithProfile: (id: string) => void
}

export type ProfileChoiceResult = { ok: true } | { ok: false; error: string }

export function createChooseProfileHandler(deps: ChooseProfileHandlerDeps) {
  const allowed = new Set(deps.entries.map((e) => e.id))
  return async (event: unknown, rawId: unknown): Promise<ProfileChoiceResult> => {
    if (!deps.isAllowedSender(event)) {
      return { ok: false, error: 'Unexpected profile request.' }
    }
    const parsed = z.string().safeParse(rawId)
    if (!parsed.success || !allowed.has(parsed.data)) {
      return { ok: false, error: 'Unknown profile.' }
    }
    deps.relaunchWithProfile(parsed.data)
    return { ok: true }
  }
}
