// Sidebar and keyboard shortcut settings.

import { useState, useEffect, useRef } from 'react'
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts'
import type {
  SidebarSortMode,
  WorktreeGrouping,
} from '@/store/types'
import { parseNormalizedLineList } from '@shared/string-list'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  Toggle,
  ShortcutRow,
} from './settings-controls'

export default function WorkspaceSettings({
  settings,
  applyLocalSetting,
  applyServerSetting,
  scheduleServerTextSettingSave,
}: SettingsSectionProps) {
  const [excludeFirstChatInput, setExcludeFirstChatInput] = useState(
    () => (settings.sidebar?.excludeFirstChatSubstrings ?? []).join('\n'),
  )
  const lastSettingsExcludeFirstChatRef = useRef(
    (settings.sidebar?.excludeFirstChatSubstrings ?? []).join('\n'),
  )

  useEffect(() => {
    const next = (settings.sidebar?.excludeFirstChatSubstrings ?? []).join('\n')
    if (excludeFirstChatInput === lastSettingsExcludeFirstChatRef.current) {
      setExcludeFirstChatInput(next)
    }
    lastSettingsExcludeFirstChatRef.current = next
  }, [excludeFirstChatInput, settings.sidebar?.excludeFirstChatSubstrings])

  return (
    <>
      <SettingsSection id="workspace" title="Sidebar" description="Session list and navigation">
        <SettingsRow label="Sort mode">
          <select
            value={settings.sidebar?.sortMode || 'activity'}
            onChange={(e) => {
              const v = e.target.value as SidebarSortMode
              applyLocalSetting({ sidebar: { sortMode: v } })
            }}
            className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
          >
            <option value="recency">Recency</option>
            <option value="recency-pinned">Recency (tabs first)</option>
            <option value="activity">Activity (tabs first)</option>
            <option value="project">Project</option>
          </select>
        </SettingsRow>

        <SettingsRow label="Worktree grouping">
          <select
            value={settings.sidebar?.worktreeGrouping || 'repo'}
            onChange={(e) => {
              const v = e.target.value as WorktreeGrouping
              applyLocalSetting({ sidebar: { worktreeGrouping: v } })
            }}
            className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
          >
            <option value="repo">Repository</option>
            <option value="worktree">Worktree</option>
          </select>
        </SettingsRow>

        <SettingsRow label="Show project badges">
          <Toggle
            checked={settings.sidebar?.showProjectBadges ?? true}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { showProjectBadges: checked } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Show subagent sessions">
          <Toggle
            checked={settings.sidebar?.showSubagents ?? false}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { showSubagents: checked } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Ignore Codex subagent sessions">
          <Toggle
            checked={settings.sidebar?.ignoreCodexSubagents ?? true}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { ignoreCodexSubagents: checked } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Show non-interactive sessions">
          <Toggle
            checked={settings.sidebar?.showNoninteractiveSessions ?? false}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { showNoninteractiveSessions: checked } })
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="Hide empty sessions"
          description="Hide sessions that have no messages yet (e.g. newly started Claude Code sessions)."
        >
          <Toggle
            checked={settings.sidebar?.hideEmptySessions ?? true}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { hideEmptySessions: checked } })
            }}
            aria-label="Hide empty sessions"
          />
        </SettingsRow>

        <SettingsRow
          label="Hide sessions by first chat"
          description="One substring per line. Matching sessions are hidden from the sidebar."
        >
          <textarea
            value={excludeFirstChatInput}
            onChange={(event) => {
              const nextInput = event.target.value
              setExcludeFirstChatInput(nextInput)
              const excludeFirstChatSubstrings = parseNormalizedLineList(nextInput)
              scheduleServerTextSettingSave('sidebar.excludeFirstChatSubstrings', {
                sidebar: { excludeFirstChatSubstrings },
              })
            }}
            className="min-h-20 w-full rounded-md bg-muted border-0 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-border md:w-[24rem]"
            placeholder="__AUTO__"
            aria-label="Sidebar first chat exclusion substrings"
          />
        </SettingsRow>

        <SettingsRow label="First chat must start with match">
          <Toggle
            checked={settings.sidebar?.excludeFirstChatMustStart ?? false}
            onChange={(checked) => {
              applyServerSetting({ sidebar: { excludeFirstChatMustStart: checked } })
            }}
            aria-label="Require first chat exclusion substring at start"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Keyboard shortcuts" description="Navigation and terminal">
        <div className="space-y-2 text-sm">
          {KEYBOARD_SHORTCUTS.map((entry) => (
            <ShortcutRow key={entry.description} keys={entry.keys} alternateKeys={entry.alternateKeys} description={entry.description} />
          ))}
        </div>
      </SettingsSection>
    </>
  )
}
