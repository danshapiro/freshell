// AI feature settings — Gemini API key, session title generation, and prompt customization.

import type { SettingsSectionProps } from './settings-types'
import { SettingsSection, SettingsRow, Toggle } from './settings-controls'

export default function AISettings({
  settings,
  applyServerSetting,
  scheduleServerTextSettingSave,
}: SettingsSectionProps) {
  return (
    <>
      <SettingsSection id="ai" title="AI" description="Gemini-powered features">
        <SettingsRow
          label="Gemini API key"
          description="Required for AI features. Get a key from Google AI Studio."
        >
          <input
            type="password"
            value={settings.ai?.geminiApiKey || ''}
            placeholder="Enter Gemini API key"
            onChange={(e) => {
              const key = e.target.value || undefined
              scheduleServerTextSettingSave('ai.geminiApiKey', { ai: { geminiApiKey: key } })
            }}
            className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8"
          />
        </SettingsRow>

        <SettingsRow
          label="Auto-generate session titles"
          description="Use Gemini to generate titles for new coding sessions."
        >
          <Toggle
            checked={settings.sidebar?.autoGenerateTitles ?? true}
            onChange={(checked) => {
              applyServerSetting({ sidebar: { autoGenerateTitles: checked } })
            }}
            aria-label="Auto-generate session titles"
          />
        </SettingsRow>

        <SettingsRow
          label="Title prompt"
          description="Instructions sent to Gemini for generating session titles."
        >
          <textarea
            value={settings.ai?.titlePrompt || ''}
            placeholder={'Generate a short title (3-8 words) for a coding assistant conversation.\nThe title should describe the task or topic, not the tool being used.\nReturn ONLY the title text. No quotes, no markdown, no explanation.'}
            onChange={(e) => {
              const prompt = e.target.value || undefined
              scheduleServerTextSettingSave('ai.titlePrompt', { ai: { titlePrompt: prompt } })
            }}
            rows={4}
            className="w-full px-3 py-2 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border font-mono"
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
