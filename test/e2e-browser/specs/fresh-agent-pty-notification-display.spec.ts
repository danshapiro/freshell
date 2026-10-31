import { test, expect } from '../helpers/fixtures.js'

function tallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 60 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog.`,
  ).join('\n\n')
}

const PTY_EXITED_BLOCK = [
  '<pty_exited>',
  'ID: pty_d75e6fa9',
  'Description: Live backup sync run, script via stdin',
  'Exit Code: 0',
  'TimeoutSeconds: 3600',
  'Timed Out: no',
  'Output Lines: 5',
  'Last Line: SYNC_EXIT=0',
  '</pty_exited>',
  '',
  'Use pty_read to check the full output.',
].join('\n')

/** Convert the active terminal leaf into a freshopencode pane whose routed
 * thread snapshot carries the given turns. Same shape as transcript-minimap.spec.ts's
 * seedMinimapPane (which cites fresh-agent.spec.ts's installFreshclaudeStripPane):
 * network effects suppressed BEFORE the conversion so the pane never
 * WS-connects; the REST snapshot is the only fetch. No provider binary
 * involved, so the spec is cloud-legal. */
async function seedOpencodePane(page: any, sessionId: string, turns: unknown[]) {
  await page.route(`**/api/fresh-agent/threads/freshopencode/opencode/${sessionId}*`, async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: sessionId,
        sessionId,
        revision: 1,
        latestTurnId: (turns[turns.length - 1] as { id?: string } | undefined)?.id ?? null,
        status: 'idle',
        summary: '',
        // Capability values mirror the Rust opencode snapshot builder
        // (crates/freshell-freshagent/src/lib.rs, build_opencode_snapshot_json).
        capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
        settings: { model: 'default', permissionMode: 'default', plugins: [] },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        turns,
        extensions: {},
      }),
    })
  })
  await page.evaluate((currentSessionId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (!tabId || !paneId) return
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId,
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: `req-pty-notify-${currentSessionId}`,
          sessionId: currentSessionId,
          sessionRef: { provider: 'opencode', sessionId: currentSessionId },
          resumeSessionId: currentSessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, sessionId)
}

test.describe('fresh-agent PTY notification display role', () => {
  test('renders opencode-pty exit notifications as agent text with no minimap tick', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000bb201'
    await seedOpencodePane(page, sessionId, [
      { id: 'turn-pty-u1', turnId: 'turn-pty-u1', role: 'user', summary: 'Run the backup sync now', items: [{ id: 'item-pty-u1', kind: 'text', text: 'Run the backup sync now' }] },
      { id: 'turn-pty-a1', turnId: 'turn-pty-a1', role: 'assistant', summary: 'Starting it in a background session', items: [{ id: 'item-pty-a1', kind: 'text', text: tallBody('Starting') }] },
      { id: 'turn-pty-n1', turnId: 'turn-pty-n1', role: 'user', summary: PTY_EXITED_BLOCK, items: [{ id: 'item-pty-n1', kind: 'text', text: PTY_EXITED_BLOCK }] },
      { id: 'turn-pty-a2', turnId: 'turn-pty-a2', role: 'assistant', summary: 'Sync finished cleanly', items: [{ id: 'item-pty-a2', kind: 'text', text: tallBody('Finished') }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    // The notification renders as AGENT text: assistant article, no 'You' inside it.
    const ptyArticle = freshPane.locator('article[data-turn-role="assistant"]', { hasText: 'SYNC_EXIT=0' })
    await expect(ptyArticle).toBeVisible()
    await expect(ptyArticle.getByText('You')).toHaveCount(0)
    // The real human prompt is still user text.
    await expect(freshPane.locator('article[data-turn-role="user"]', { hasText: 'Run the backup sync now' })).toBeVisible()
    // No user article carries the PTY block.
    await expect(freshPane.locator('article[data-turn-role="user"]', { hasText: 'SYNC_EXIT=0' })).toHaveCount(0)

    // Minimap: exactly one tick — the real human prompt — and its label is
    // that prompt, never the PTY block.
    await expect(freshPane.getByRole('group', { name: 'Transcript minimap' })).toBeVisible()
    const ticks = freshPane.getByRole('button', { name: /Jump to prompt:/ })
    await expect(ticks).toHaveCount(1)
    await expect(freshPane.getByRole('button', { name: 'Jump to prompt: Run the backup sync now', exact: true })).toBeVisible()
  })
})
