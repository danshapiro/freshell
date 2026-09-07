import { getWsClient } from '@/lib/ws-client'
import { setActiveTab } from '@/store/tabsSlice'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { sendTerminalInterrupt } from '@/lib/terminal-interrupt'
import type { AppDispatch, RootState } from '@/store/store'
import type { ApproveTarget, StopTarget } from './deck-selectors'

export type DeckStore = { getState(): RootState; dispatch: AppDispatch }

export function focusTabFromDeck(store: DeckStore, tabId: string): void {
  if (store.getState().settings.settings.panes.attentionDismiss === 'click') {
    store.dispatch(dismissTabGreen(tabId))
  }
  store.dispatch(setActiveTab(tabId))
}

export function sendDeckApproval(target: ApproveTarget): void {
  getWsClient().send({
    type: 'freshAgent.approval.respond',
    sessionId: target.sessionId,
    sessionType: target.sessionType,
    provider: target.provider,
    requestId: target.requestId,
    // freshopencode auth keys embed cwd server-side; cwd-less durable-opencode frames die UNAUTHORIZED.
    // The selector (Task 3) sets target.cwd only for freshopencode; claude/codex/kilroy stay cwd-less.
    ...(target.cwd ? { cwd: target.cwd } : {}),
    // A defined updatedInput (even {}) wholesale replaces the tool input. Omit it.
    decision: { behavior: 'allow' },
  })
}

export function executeDeckStop(target: StopTarget, escalate: boolean): void {
  if (target.kind === 'fresh-agent') {
    // HARD RULE: never send raw keys to a fresh-agent pane (they become prompt text).
    getWsClient().send({
      type: 'freshAgent.interrupt',
      sessionId: target.sessionId,
      sessionType: target.sessionType,
      provider: target.provider,
      ...(target.runtimeId && target.runtimeGeneration !== undefined ? {
        expectedRuntimeId: target.runtimeId,
        expectedGeneration: target.runtimeGeneration,
      } : {}),
      ...(target.cwd ? { cwd: target.cwd } : {}),
    })
    return
  }
  sendTerminalInterrupt(target.content, target.terminalId, escalate ? 'ctrl-c' : 'esc')
}
