import type { FreshAgentSettingScopes } from '@shared/fresh-agent-contract'

export const SETTING_SCOPE_COPY = {
  'per-send': 'Applies from the next message.',
  'create-only': 'Applies when a session starts — start a new conversation to change it.',
} as const

export type FreshAgentSettingKnob = 'model' | 'effort' | 'sandbox' | 'permissionMode'

/** Scope-driven hint. Older servers (field absent, or knob absent) fall back to
 * the pre-existing per-send copy: for a not-yet-created pane everything applies
 * at create, which that copy truthfully covers. */
export function settingScopeHint(scopes: FreshAgentSettingScopes | undefined, knob: FreshAgentSettingKnob): string {
  const scope = scopes?.[knob]
  if (scope === 'create-only') return SETTING_SCOPE_COPY['create-only']
  return SETTING_SCOPE_COPY['per-send']
}

const DIALOG_FOOTER_BASE = '↑↓ move · ←→ switch column · Enter = OK · Esc = cancel'
/** Model dialog footer: model+effort scopes decide the application clause. */
export function freshAgentDialogFooterCopy(scopes: FreshAgentSettingScopes | undefined): string {
  const createOnly = scopes?.model === 'create-only' || scopes?.effort === 'create-only'
  return `${DIALOG_FOOTER_BASE} · ${createOnly ? 'applies at session start' : 'applies from your next message'} · becomes your default`
}
