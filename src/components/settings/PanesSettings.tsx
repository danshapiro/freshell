import type {
  AttentionDismiss,
  SessionOpenMode,
  TabAttentionStyle,
} from '@/store/types'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  SegmentedControl,
  Toggle,
  RangeSlider,
} from './settings-controls'

export default function PanesSettings({
  settings,
  applyLocalSetting,
  applyServerSetting,
  scheduleServerTextSettingSave,
}: SettingsSectionProps) {
  return (
    <>
      <SettingsSection id="panes" title="Pane behavior">
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
            className="h-10 w-full px-3 pr-8 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
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

        <SettingsRow label="Multi-row tabs" description="Show tabs in multiple rows instead of a single scrollable row.">
          <Toggle
            checked={settings.panes?.multirowTabs ?? false}
            onChange={(checked) => {
              applyLocalSetting({ panes: { multirowTabs: checked } })
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

        <SettingsRow label="Sound on completion">
          <Toggle
            checked={settings.notifications?.soundEnabled ?? true}
            onChange={(checked) => {
              applyLocalSetting({ notifications: { soundEnabled: checked } })
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Editor pane" description="External editor for file opening">
        <SettingsRow label="External editor" description="Which editor to use when opening files from the editor pane">
          <select
            value={settings.editor?.externalEditor ?? 'auto'}
            onChange={(e) => {
              const v = e.target.value as 'auto' | 'cursor' | 'code' | 'custom'
              applyServerSetting({ editor: { externalEditor: v } })
            }}
            className="h-10 w-full px-3 pr-8 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
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
    </>
  )
}
