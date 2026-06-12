import { ExtensionsManager } from '@/components/ExtensionsView'
import { SettingsSection } from './settings-controls'

export default function ExtensionsSettings() {
  return (
    <SettingsSection
      id="extensions"
      title="Extensions"
      description="Developer extension controls"
    >
      <ExtensionsManager includeCli={false} />
    </SettingsSection>
  )
}
