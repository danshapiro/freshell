// @vitest-environment node
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import { freshAgentAssistantResponseDomFacts } from '../../../../scripts/testing/fresh-agent-ordinary-turn.js'

it('reads assistant baseline facts from the chat view when pane identity is shared by shell and header', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div data-pane-id="pane-one" data-pane-shell="true">
        <header data-pane-id="pane-one" data-context="pane-header"></header>
        <div data-pane-id="pane-one" data-context="fresh-agent">
          <article data-turn-role="assistant"><div class="fresh-agent-transcript-copy">
            <div data-markdown-body>fixture</div>
          </div></article>
        </div>
      </div>
    `)
    const facts = await freshAgentAssistantResponseDomFacts(page, 'pane-one')
    expect(facts).toEqual({ rows: 1, textCharacters: 7 })
  } finally {
    await browser.close()
  }
})
