import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()

type LegacyCoverageMapping = {
  legacyPath: string
  replacementPaths: string[]
  requiredFreshAgentSignals: string[]
}

const coverageMatrix: LegacyCoverageMapping[] = [
  {
    legacyPath: 'test/unit/client/agentChatSlice.test.ts',
    replacementPaths: [
      'test/unit/client/store/freshAgentSlice.test.ts',
      'test/unit/client/lib/fresh-agent-ws.test.ts',
      'test/unit/client/components/fresh-agent/FreshAgentView.test.tsx',
    ],
    requiredFreshAgentSignals: ['freshAgentSlice', 'freshAgent', 'permission', 'history', 'stream'],
  },
  {
    legacyPath: 'test/unit/client/store/agentChatSlice.test.ts',
    replacementPaths: ['test/unit/client/store/freshAgentSlice.test.ts'],
    requiredFreshAgentSignals: ['freshAgentSlice', 'streaming'],
  },
  {
    legacyPath: 'test/unit/client/store/agentChatThunks.test.ts',
    replacementPaths: ['test/unit/client/lib/fresh-agent-ws.test.ts'],
    requiredFreshAgentSignals: ['freshAgent', 'snapshot'],
  },
  {
    legacyPath: 'test/unit/client/sdk-message-handler.test.ts',
    replacementPaths: ['test/unit/client/lib/fresh-agent-ws.test.ts'],
    requiredFreshAgentSignals: ['freshAgent.event', 'freshAgent.created'],
  },
  {
    legacyPath: 'test/unit/client/lib/sdk-message-handler.test.ts',
    replacementPaths: ['test/unit/client/lib/fresh-agent-ws.test.ts'],
    requiredFreshAgentSignals: ['freshAgent.event', 'freshAgent.created'],
  },
  {
    legacyPath: 'test/unit/client/lib/sdk-message-handler.session-lost.test.ts',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['FRESH_AGENT_LOST_SESSION', 'restoreError'],
  },
  {
    legacyPath: 'test/unit/client/ws-client-sdk.test.ts',
    replacementPaths: ['test/unit/client/lib/fresh-agent-ws.test.ts'],
    requiredFreshAgentSignals: ['freshAgent', 'stale'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['restore', 'freshAgent.attach'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['FRESH_AGENT_LOST_SESSION', 'RESTORE_UNAVAILABLE'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['split', 'StoreBackedFreshAgentView'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentView.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx',
    ],
    requiredFreshAgentSignals: ['settings', 'provider', 'showThinking'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx',
    ],
    requiredFreshAgentSignals: ['keyboard', 'mobile'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.scrollToBottom.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['scroll', 'new-message'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.status.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['running', 'pending', 'status'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.auto-title.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['auto-title', 'updatePaneTitle'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.scroll.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['scroll'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['watermark', 'fresh-agent-pane'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/ChatComposer.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx',
    ],
    requiredFreshAgentSignals: ['history', 'ArrowUp', 'mobile'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx',
    ],
    requiredFreshAgentSignals: ['mobile', 'keyboard'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/MessageBubble.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx',
    ],
    requiredFreshAgentSignals: ['markdown', 'XSS', 'tool'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/PermissionBanner.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx'],
    requiredFreshAgentSignals: ['Allow tool use', 'Always allow'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx'],
    requiredFreshAgentSignals: ['Allow tool use', 'touch'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/QuestionBanner.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentQuestionBanner.test.tsx'],
    requiredFreshAgentSignals: ['Question from', 'Submit answer'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentQuestionBanner.test.tsx'],
    requiredFreshAgentSignals: ['touch', 'Submit answer'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatSettings.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['FreshAgentSettingsButton', 'model', 'effort'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentView.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx',
    ],
    requiredFreshAgentSignals: ['FreshAgentSettingsButton', 'mobile'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/ToolBlock.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx'],
    requiredFreshAgentSignals: ['data-tool-input', 'data-tool-output'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/ToolBlock.autocollapse.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx'],
    requiredFreshAgentSignals: ['collapse', 'tool'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/ToolStrip.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['Activity strip', 'tool used'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/ThinkingIndicator.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['Thinking', 'showThinking'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/CollapsedTurn.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['transcript turn', 'summary'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/DiffView.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx'],
    requiredFreshAgentSignals: ['diff view', 'data-file-path'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/SlotReel.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx'],
    requiredFreshAgentSignals: ['SlotReel'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/tool-preview.test.ts',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx'],
    requiredFreshAgentSignals: ['tool', 'input'],
  },
  {
    legacyPath: 'test/unit/client/components/agent-chat/useStreamDebounce.test.ts',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['stream'],
  },
  {
    legacyPath: 'test/unit/client/components/context-menu/agent-chat-actions.test.ts',
    replacementPaths: ['test/unit/client/components/context-menu/fresh-agent-actions.test.ts'],
    requiredFreshAgentSignals: ['copyFreshAgentCodeBlock', 'copyFreshAgentDiffNew'],
  },
  {
    legacyPath: 'test/unit/client/components/context-menu/menu-defs.test.ts',
    replacementPaths: ['test/unit/client/components/context-menu/menu-defs.test.ts'],
    requiredFreshAgentSignals: ['fresh-agent', 'copyFreshAgentCodeBlock'],
  },
  {
    legacyPath: 'test/unit/client/context-menu/menu-defs.test.ts',
    replacementPaths: ['test/unit/client/context-menu/menu-defs.test.ts'],
    requiredFreshAgentSignals: ['fresh-agent', 'copyFreshAgentCodeBlock'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-context-menu-flow.test.tsx',
    replacementPaths: ['test/unit/client/components/context-menu/menu-defs.test.ts'],
    requiredFreshAgentSignals: ['fresh-agent', 'fc-copy-code-block'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-polish-flow.test.tsx',
    replacementPaths: [
      'test/unit/client/components/fresh-agent/FreshAgentView.test.tsx',
      'test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx',
    ],
    requiredFreshAgentSignals: ['FreshAgentView', 'FreshAgentTranscript'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-capability-settings-flow.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['capability', 'FreshAgentSettingsButton'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-restore-flow.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['restore', 'freshAgent.attach'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-resume-history-flow.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentView.test.tsx'],
    requiredFreshAgentSignals: ['resume', 'history'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-input-history-flow.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx'],
    requiredFreshAgentSignals: ['history', 'ArrowUp'],
  },
  {
    legacyPath: 'test/e2e/agent-chat-tab-shortcut-focus.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx'],
    requiredFreshAgentSignals: ['Tab', 'focus'],
  },
  {
    legacyPath: 'test/e2e/tool-coalesce.test.tsx',
    replacementPaths: ['test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx'],
    requiredFreshAgentSignals: ['coalesces paired tool calls', 'Activity strip'],
  },
]

const legacyLocations = [
  'test/unit/client/agentChatSlice.test.ts',
  'test/unit/client/store/agentChatSlice.test.ts',
  'test/unit/client/store/agentChatThunks.test.ts',
  'test/unit/client/sdk-message-handler.test.ts',
  'test/unit/client/lib/sdk-message-handler.test.ts',
  'test/unit/client/lib/sdk-message-handler.session-lost.test.ts',
  'test/unit/client/ws-client-sdk.test.ts',
  'test/unit/client/components/agent-chat/AgentChatSettings.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.auto-title.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.scroll.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.scrollToBottom.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx',
  'test/unit/client/components/agent-chat/AgentChatView.status.test.tsx',
  'test/unit/client/components/agent-chat/ChatComposer.mobile.test.tsx',
  'test/unit/client/components/agent-chat/ChatComposer.test.tsx',
  'test/unit/client/components/agent-chat/CollapsedTurn.test.tsx',
  'test/unit/client/components/agent-chat/DiffView.test.tsx',
  'test/unit/client/components/agent-chat/MessageBubble.test.tsx',
  'test/unit/client/components/agent-chat/PermissionBanner.mobile.test.tsx',
  'test/unit/client/components/agent-chat/PermissionBanner.test.tsx',
  'test/unit/client/components/agent-chat/QuestionBanner.mobile.test.tsx',
  'test/unit/client/components/agent-chat/QuestionBanner.test.tsx',
  'test/unit/client/components/agent-chat/SlotReel.test.tsx',
  'test/unit/client/components/agent-chat/ThinkingIndicator.test.tsx',
  'test/unit/client/components/agent-chat/ToolBlock.autocollapse.test.tsx',
  'test/unit/client/components/agent-chat/ToolBlock.test.tsx',
  'test/unit/client/components/agent-chat/ToolStrip.test.tsx',
  'test/unit/client/components/agent-chat/tool-preview.test.ts',
  'test/unit/client/components/agent-chat/useStreamDebounce.test.ts',
  'test/unit/client/components/context-menu/agent-chat-actions.test.ts',
  'test/unit/client/components/context-menu/menu-defs.test.ts',
  'test/unit/client/context-menu/menu-defs.test.ts',
  'test/e2e/agent-chat-capability-settings-flow.test.tsx',
  'test/e2e/agent-chat-context-menu-flow.test.tsx',
  'test/e2e/agent-chat-input-history-flow.test.tsx',
  'test/e2e/agent-chat-polish-flow.test.tsx',
  'test/e2e/agent-chat-restore-flow.test.tsx',
  'test/e2e/agent-chat-resume-history-flow.test.tsx',
  'test/e2e/agent-chat-tab-shortcut-focus.test.tsx',
  'test/e2e/tool-coalesce.test.tsx',
]

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('fresh-agent legacy behavior coverage', () => {
  it('maps every legacy agent-chat test file that still exists before deletion', () => {
    const mapped = new Set(coverageMatrix.map((entry) => entry.legacyPath))
    const existingLegacyFiles = legacyLocations.filter((relativePath) => existsSync(join(repoRoot, relativePath)))

    expect(existingLegacyFiles.filter((relativePath) => !mapped.has(relativePath))).toEqual([])
  })

  it('has executable fresh-agent replacements for each legacy behavior bucket', () => {
    for (const entry of coverageMatrix) {
      const replacementText = entry.replacementPaths.map((relativePath) => {
        const absolutePath = join(repoRoot, relativePath)
        expect(existsSync(absolutePath), `${entry.legacyPath} replacement ${relativePath} should exist`).toBe(true)
        const content = readRepoFile(relativePath)
        expect(content, `${relativePath} should contain executable Vitest coverage`).toMatch(/\b(it|test)\s*\(/)
        expect(content, `${relativePath} should not import legacy agent-chat modules`).not.toMatch(/@\/(?:components\/agent-chat|store\/agentChat(?:Slice|Thunks|Types))/)
        return content
      }).join('\n')

      for (const signal of entry.requiredFreshAgentSignals) {
        expect(replacementText, `${entry.legacyPath} replacement should cover ${signal}`).toContain(signal)
      }
    }
  })
})
