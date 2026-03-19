// Scrollback, clipboard, link warnings, and debug logging settings.

import { useId, useState } from 'react'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  SegmentedControl,
  Toggle,
  RangeSlider,
} from './settings-controls'

export default function AdvancedSettings({
  settings,
  applyLocalSetting,
  applyServerSetting,
}: SettingsSectionProps) {
  const [terminalAdvancedOpen, setTerminalAdvancedOpen] = useState(false)
  const terminalAdvancedId = useId()

  return (
    <SettingsSection id="advanced" title="Advanced" description="Terminal internals and debugging">
      <SettingsRow label="Scrollback lines">
        <RangeSlider
          value={settings.terminal.scrollback}
          min={1000}
          max={20000}
          step={500}
          format={(v) => v.toLocaleString()}
          onChange={(v) => {
            applyServerSetting({ terminal: { scrollback: v } })
          }}
        />
      </SettingsRow>

      <SettingsRow label="Warn on external links">
        <Toggle
          checked={settings.terminal.warnExternalLinks}
          onChange={(checked) => {
            applyLocalSetting({ terminal: { warnExternalLinks: checked } })
          }}
        />
      </SettingsRow>

      <SettingsRow label="Debug logging">
        <Toggle
          checked={settings.logging?.debug ?? false}
          onChange={(checked) => {
            applyServerSetting({ logging: { debug: checked } })
          }}
        />
      </SettingsRow>

      <div className="pt-1 border-t border-border/40">
        <button
          type="button"
          aria-expanded={terminalAdvancedOpen}
          aria-controls={terminalAdvancedId}
          className="h-10 w-full px-3 text-sm bg-muted rounded-md hover:bg-muted/80 focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
          onClick={() => setTerminalAdvancedOpen((open) => !open)}
        >
          OSC52 Clipboard
        </button>
        <div
          id={terminalAdvancedId}
          hidden={!terminalAdvancedOpen}
          className="mt-3 space-y-4"
        >
          <SettingsRow label="OSC52 clipboard access">
            <SegmentedControl
              value={settings.terminal.osc52Clipboard}
              options={[
                { value: 'ask', label: 'Ask' },
                { value: 'always', label: 'Always' },
                { value: 'never', label: 'Never' },
              ]}
              onChange={(v: string) => {
                applyLocalSetting({ terminal: { osc52Clipboard: v as 'ask' | 'always' | 'never' } } as any)
              }}
            />
          </SettingsRow>
        </div>
      </div>
    </SettingsSection>
  )
}
