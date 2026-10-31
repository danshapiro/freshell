import type { FreshAgentPaneContent } from '@/store/paneTypes'

const CODEX_FIELDS = ['model', 'effort', 'initialCwd', 'sandbox', 'permissionMode', 'collaborationMode'] as const
type Field = typeof CODEX_FIELDS[number]
type PaneSettings = Pick<FreshAgentPaneContent, Field | 'effortIsNativeDefault'>
export type CodexStatedSettings = Omit<PaneSettings, 'effort'> & { effort?: string | null }

export type CodexSettingsConvergence = {
  identity: string
  pane: PaneSettings
  stated: CodexStatedSettings
  local: Set<Field>
}

/** Reconcile stated session defaults without undoing a newer pane edit.
 * A matching statement acknowledges that edit; absent older metadata says
 * nothing. The cursor is local to one mounted pane, not a protocol clock. */
export function convergeCodexSettings(
  previous: CodexSettingsConvergence | undefined,
  identity: string,
  pane: PaneSettings,
  stated: CodexStatedSettings,
): { cursor: CodexSettingsConvergence; updates: PaneSettings } {
  const cursor: CodexSettingsConvergence = previous?.identity === identity
    ? previous
    : { identity, pane: { ...pane }, stated: {}, local: new Set<Field>() }
  for (const field of CODEX_FIELDS) {
    if (pane[field] !== cursor.pane[field]) cursor.local.add(field)
  }
  if (pane.effortIsNativeDefault !== cursor.pane.effortIsNativeDefault) cursor.local.add('effort')
  const updates: Partial<Record<Field, string | undefined>> = {}
  let effortIsNativeDefault = pane.effortIsNativeDefault
  for (const field of CODEX_FIELDS) {
    const value = stated[field]
    if (value === undefined || value === cursor.stated[field]) continue
    Object.assign(cursor.stated, { [field]: value })
    const next = value === null ? undefined : value
    if (cursor.local.has(field) && pane[field] !== next) continue
    cursor.local.delete(field)
    if (pane[field] !== next) updates[field] = next
    if (field === 'effort') effortIsNativeDefault = value === null
  }
  const patch = updates as PaneSettings
  if (effortIsNativeDefault !== pane.effortIsNativeDefault) patch.effortIsNativeDefault = effortIsNativeDefault
  cursor.pane = { ...pane, ...patch }
  return { cursor, updates: patch }
}
