import type { CodingCliProviderName } from '@/lib/coding-cli-types'

export type AgentChatProviderName = 'freshclaude'

export interface AgentChatProviderConfig {
  /** Unique identifier for this agent chat provider */
  name: AgentChatProviderName
  /** Display label in UI */
  label: string
  /** Underlying coding CLI provider used for directory preferences and CLI availability checks */
  codingCliProvider: CodingCliProviderName
  /** React component for the pane icon */
  icon: React.ComponentType<{ className?: string }>
  /** Default model ID */
  defaultModel: string
  /** Default permission mode */
  defaultPermissionMode: string
  /** Default effort level */
  defaultEffort: 'low' | 'medium' | 'high' | 'max'
  /** Default display settings */
  defaultShowThinking: boolean
  defaultShowTools: boolean
  defaultShowTimecodes: boolean
  /** Which settings are visible in the settings popover */
  settingsVisibility: {
    model: boolean
    permissionMode: boolean
    effort: boolean
    thinking: boolean
    tools: boolean
    timecodes: boolean
  }
  /** Keyboard shortcut in pane picker */
  pickerShortcut: string
}
