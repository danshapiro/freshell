import type { ComponentType, SVGProps } from 'react'
import {
  ClaudeIcon,
  CodexIcon,
  FreshclaudeIcon,
  GeminiIcon,
  KimiIcon,
  OpencodeIcon,
} from '@/components/icons/provider-icons'
import { useAppSelector } from '@/store/hooks'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import type { ServerSettingsPatch } from '@/store/types'
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection, Toggle } from './settings-controls'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

type VisibleFreshAgentId = 'freshclaude' | 'freshcodex' | 'freshopencode'
type FreshAgentId = VisibleFreshAgentId | 'kilroy'

type AgentRow =
  | { kind: 'cli'; id: CodingCliProviderName; label: string; icon: IconComponent }
  | { kind: 'fresh'; id: VisibleFreshAgentId; label: string; icon: IconComponent }

const AGENT_ROWS: AgentRow[] = [
  { kind: 'cli', id: 'claude', label: 'Claude CLI', icon: ClaudeIcon },
  { kind: 'fresh', id: 'freshclaude', label: 'Freshclaude', icon: FreshclaudeIcon },
  { kind: 'cli', id: 'codex', label: 'Codex CLI', icon: CodexIcon },
  { kind: 'fresh', id: 'freshcodex', label: 'Freshcodex', icon: CodexIcon },
  { kind: 'cli', id: 'opencode', label: 'OpenCode', icon: OpencodeIcon },
  { kind: 'fresh', id: 'freshopencode', label: 'Freshopencode', icon: OpencodeIcon },
  { kind: 'cli', id: 'gemini', label: 'Gemini', icon: GeminiIcon },
  { kind: 'cli', id: 'kimi', label: 'Kimi', icon: KimiIcon },
]

const FRESH_AGENT_RUNTIME_PROVIDER: Record<VisibleFreshAgentId, CodingCliProviderName> = {
  freshclaude: 'claude',
  freshcodex: 'codex',
  freshopencode: 'opencode',
}

const VISIBLE_FRESH_AGENT_IDS: VisibleFreshAgentId[] = AGENT_ROWS
  .filter((row): row is Extract<AgentRow, { kind: 'fresh' }> => row.kind === 'fresh')
  .map((row) => row.id)
const FRESH_AGENT_IDS: FreshAgentId[] = [...VISIBLE_FRESH_AGENT_IDS, 'kilroy']
const EMPTY_AVAILABLE_CLIS: Record<string, boolean> = {}

export default function CodingAgentsSettings({
  settings,
  applyServerSetting,
}: SettingsSectionProps) {
  const enabledProviders = settings.codingCli?.enabledProviders ?? []
  const disabledItems = settings.extensions?.disabled ?? []
  const freshEnabled = settings.freshAgent?.enabled ?? false
  const availableClis = useAppSelector((s) => s.connection?.availableClis ?? EMPTY_AVAILABLE_CLIS)
  const hasCliAvailability = Object.keys(availableClis).length > 0

  const isCliAvailable = (id: CodingCliProviderName) => (
    !hasCliAvailability || availableClis[id] === true
  )

  const isCliEnabledForFreshAgent = (id: CodingCliProviderName) => (
    isCliAvailable(id) && enabledProviders.includes(id) && !disabledItems.includes(id)
  )

  const visibleRows = AGENT_ROWS.filter((row) => {
    if (row.kind === 'cli') return isCliAvailable(row.id)
    return isCliEnabledForFreshAgent(FRESH_AGENT_RUNTIME_PROVIDER[row.id])
  })

  const setCliEnabled = (id: CodingCliProviderName, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...enabledProviders, id]))
      : enabledProviders.filter((provider) => provider !== id)
    const patch: ServerSettingsPatch = { codingCli: { enabledProviders: next } }

    if (enabled && disabledItems.includes(id)) {
      patch.extensions = { disabled: disabledItems.filter((item) => item !== id) }
    }

    applyServerSetting(patch)
  }

  const setFreshEnabled = (id: VisibleFreshAgentId, enabled: boolean) => {
    const disabledSet = new Set(disabledItems)

    if (enabled && !freshEnabled) {
      for (const freshId of FRESH_AGENT_IDS) {
        if (freshId !== id) disabledSet.add(freshId)
      }
    }

    if (enabled) {
      disabledSet.delete(id)
    } else {
      disabledSet.add(id)
    }

    const anyVisibleFreshEnabled = VISIBLE_FRESH_AGENT_IDS.some((freshId) => !disabledSet.has(freshId))
    if (!anyVisibleFreshEnabled) {
      for (const freshId of FRESH_AGENT_IDS) {
        disabledSet.add(freshId)
      }
    }

    const nextDisabled = Array.from(disabledSet)
    const anyFreshEnabled = FRESH_AGENT_IDS.some((freshId) => !disabledSet.has(freshId))
    applyServerSetting({
      freshAgent: { enabled: anyFreshEnabled },
      extensions: { disabled: nextDisabled },
    })
  }

  return (
    <SettingsSection id="coding-agents" title="Coding Agents">
      {visibleRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No coding agents detected.</p>
      ) : (
        <div className="space-y-2">
          {visibleRows.map((row) => {
            const Icon = row.icon
            const checked = row.kind === 'cli'
              ? enabledProviders.includes(row.id) && !disabledItems.includes(row.id)
              : freshEnabled && !disabledItems.includes(row.id)

            return (
              <div
                key={`${row.kind}-${row.id}`}
                className="flex min-h-12 items-center justify-between gap-4 rounded-md border border-border/30 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-foreground" />
                  <span className="truncate text-sm font-medium">{row.label}</span>
                </div>
                <Toggle
                  checked={checked}
                  aria-label={row.label}
                  onChange={(next) => {
                    if (row.kind === 'cli') {
                      setCliEnabled(row.id, next)
                      return
                    }
                    setFreshEnabled(row.id, next)
                  }}
                />
              </div>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}
