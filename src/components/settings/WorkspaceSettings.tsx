// Sidebar, panes, notifications, editor, and keyboard shortcut settings.

import { useState, useEffect, useRef } from 'react'
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts'
import type {
  SidebarSortMode,
  WorktreeGrouping,
  SessionOpenMode,
  TabAttentionStyle,
  AttentionDismiss,
} from '@/store/types'
import { parseNormalizedLineList } from '@shared/string-list'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  SegmentedControl,
  Toggle,
  ShortcutRow,
  RangeSlider,
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

      <SettingsSection title="Panes" description="Pane layout and behavior">
        <SettingsRow
          label="Open sidebar session in"
          description="Where to open a coding agent session when clicked in the sidebar."
        >
          <SegmentedControl
            value={settings.panes?.sessionOpenMode ?? 'tab'}
            options={[
              { value: 'tab', label: 'New tab' },
              { value: 'split', label: 'Split pane' },
            ]}
            onChange={(v: string) => {
              applyLocalSetting({ panes: { sessionOpenMode: v as SessionOpenMode } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Default new pane">
          <select
            aria-label="Default new pane"
            value={settings.panes?.defaultNewPane || 'ask'}
            onChange={(e) => {
              const v = e.target.value as 'ask' | 'shell' | 'browser' | 'editor'
              applyServerSetting({ panes: { defaultNewPane: v } })
            }}
            className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
          >
            <option value="ask">Ask</option>
            <option value="shell">Shell</option>
            <option value="browser">Browser</option>
            <option value="editor">Editor</option>
          </select>
        </SettingsRow>

        <SettingsRow label="Snap distance">
          <RangeSlider
            value={settings.panes?.snapThreshold ?? 2}
            min={0}
            max={8}
            step={1}
            labelWidth="w-10"
            format={(v) => v === 0 ? 'Off' : `${v}%`}
            onChange={(v) => {
              applyLocalSetting({ panes: { snapThreshold: v } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Icons on tabs">
          <Toggle
            checked={settings.panes?.iconsOnTabs ?? true}
            onChange={(checked) => {
              applyLocalSetting({ panes: { iconsOnTabs: checked } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Tab completion indicator">
          <SegmentedControl
            value={settings.panes?.tabAttentionStyle ?? 'highlight'}
            options={[
              { value: 'highlight', label: 'Highlight' },
              { value: 'pulse', label: 'Pulse' },
              { value: 'darken', label: 'Darken' },
              { value: 'none', label: 'None' },
            ]}
            onChange={(v: string) => {
              const tabAttentionStyle = v as TabAttentionStyle
              applyLocalSetting({ panes: { tabAttentionStyle } })
            }}
          />
        </SettingsRow>

        <SettingsRow label="Dismiss attention on">
          <SegmentedControl
            value={settings.panes?.attentionDismiss ?? 'click'}
            options={[
              { value: 'click', label: 'Tab click' },
              { value: 'type', label: 'Typing' },
            ]}
            onChange={(v: string) => {
              const attentionDismiss = v as AttentionDismiss
              applyLocalSetting({ panes: { attentionDismiss } })
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Notifications" description="Sound and alert preferences">
        <SettingsRow label="Sound on completion">
          <Toggle
            checked={settings.notifications?.soundEnabled ?? true}
            onChange={(checked) => {
              applyLocalSetting({ notifications: { soundEnabled: checked } })
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Agent chat" description="Display settings for agent chat panes">
        <SettingsRow label="Show thinking">
          <Toggle
            checked={settings.agentChat?.showThinking ?? false}
            onChange={(checked) => {
              applyLocalSetting({ agentChat: { showThinking: checked } })
            }}
          />
        </SettingsRow>
        <SettingsRow label="Show tools">
          <Toggle
            checked={settings.agentChat?.showTools ?? false}
            onChange={(checked) => {
              applyLocalSetting({ agentChat: { showTools: checked } })
            }}
          />
        </SettingsRow>
        <SettingsRow label="Show timecodes &amp; model">
          <Toggle
            checked={settings.agentChat?.showTimecodes ?? false}
            onChange={(checked) => {
              applyLocalSetting({ agentChat: { showTimecodes: checked } })
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Editor" description="External editor for file opening">
        <SettingsRow label="External editor" description="Which editor to use when opening files from the editor pane">
          <select
            value={settings.editor?.externalEditor ?? 'auto'}
            onChange={(e) => {
              const v = e.target.value as 'auto' | 'cursor' | 'code' | 'custom'
              applyServerSetting({ editor: { externalEditor: v } })
            }}
            className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
          >
            <option value="auto">Auto (system default)</option>
            <option value="cursor">Cursor</option>
            <option value="code">VS Code</option>
            <option value="custom">Custom command</option>
          </select>
        </SettingsRow>
        {settings.editor?.externalEditor === 'custom' && (
          <SettingsRow
            label="Custom command"
            description="Command template. Use {file}, {line}, {col} as placeholders."
          >
            <input
              type="text"
              value={settings.editor?.customEditorCommand ?? ''}
              placeholder="nvim +{line} {file}"
              onChange={(e) => {
                scheduleServerTextSettingSave('editor.customEditorCommand', {
                  editor: { customEditorCommand: e.target.value },
                })
              }}
              className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:max-w-xs"
            />
          </SettingsRow>
        )}
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
