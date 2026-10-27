import fs from 'node:fs/promises'
import path from 'node:path'
import type { SessionNameRef } from '../../../shared/session-names.js'

/**
 * Name-reliability Task 12: the server logs one INFO
 * `session_names.name_changed` line per accepted saved-name change. These
 * read them back from an owned server's JSONL logs.
 */

/** One `session_names.name_changed` line. The `old_*` fields are absent
 * when the change created the record; the last four appear only when they
 * apply (binds, imports, AI naming). */
export interface NameChangedEvent {
  level: string
  name_ref: string
  cause: string
  old_name?: string
  old_source?: string
  old_revision?: number
  new_name: string
  new_source: string
  new_revision: number
  self_heal: boolean
  from_ref?: string
  import_id?: string
  evidence_key?: string
  series?: string
}

const NAME_CHANGED = 'session_names.name_changed'

/** The `name_ref` the server logs for a ref: the record's stable key. */
export function nameRefLogKey(ref: SessionNameRef): string {
  return ref.kind === 'pending'
    ? JSON.stringify(['pending', ref.id])
    : JSON.stringify(['session', ref.provider, ref.sessionId])
}

/** Every name-change event in the JSONL logs under `logsDir`, in log order. */
export async function readNameChangedEvents(logsDir: string): Promise<NameChangedEvent[]> {
  const files = (await fs.readdir(logsDir).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
  const events: NameChangedEvent[] = []
  for (const file of files) {
    const text = await fs.readFile(path.join(logsDir, file), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line.includes(NAME_CHANGED)) continue
      let parsed: { msg?: unknown }
      try {
        parsed = JSON.parse(line) as { msg?: unknown }
      } catch {
        continue // the line the server is still writing
      }
      if (parsed.msg === NAME_CHANGED) events.push(parsed as NameChangedEvent)
    }
  }
  return events
}
