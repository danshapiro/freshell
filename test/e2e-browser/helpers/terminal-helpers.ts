import type { Page, Locator } from '@playwright/test'

/**
 * Helpers for interacting with xterm.js terminals in Playwright E2E tests.
 */
export class TerminalHelper {
  constructor(private page: Page) {}

  /**
   * Get the terminal container element.
   * xterm.js renders into a div with class 'xterm'.
   */
  getTerminalContainer(nth = 0): Locator {
    return this.page.locator('.xterm').nth(nth)
  }

  /**
   * Get the hidden textarea that xterm.js uses for keyboard input.
   * This is the correct target for typing into a terminal.
   */
  getTerminalInput(nth = 0): Locator {
    return this.page.locator('.xterm-helper-textarea').nth(nth)
  }

  /**
   * Focus the terminal and type text into it.
   * Clicks the terminal first to ensure it's focused.
   */
  async typeInTerminal(text: string, nth = 0): Promise<void> {
    const container = this.getTerminalContainer(nth)
    await container.click()
    await this.page.keyboard.type(text)
  }

  /**
   * Press a key in the terminal (e.g., 'Enter', 'Escape', 'Tab').
   */
  async pressKey(key: string, nth = 0): Promise<void> {
    const container = this.getTerminalContainer(nth)
    await container.click()
    await this.page.keyboard.press(key)
  }

  /**
   * Type a command and press Enter.
   */
  async executeCommand(command: string, nth = 0): Promise<void> {
    await this.typeInTerminal(command, nth)
    await this.pressKey('Enter', nth)
  }

  /**
   * Wait for specific text to appear in the terminal output.
   * Uses the xterm.js buffer API via the test harness, which works reliably
   * with all renderers (WebGL, canvas, DOM). Does NOT use DOM scraping
   * (.xterm-rows > div) which only works with the DOM renderer.
   *
   * @param terminalId - optional: pass a specific terminalId, or omit to use
   *   the first registered terminal in the harness
   */
  async waitForOutput(
    text: string,
    options: { timeout?: number; terminalId?: string } = {},
  ): Promise<void> {
    const { timeout = 10_000, terminalId } = options

    await this.page.waitForFunction(
      ({ searchText, id }) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const buffer = harness.getTerminalBuffer(id)
        return buffer !== null && buffer.includes(searchText)
      },
      { searchText: text, id: terminalId },
      { timeout },
    )
  }

  /**
   * Get all text from the terminal buffer.
   * Uses the xterm.js buffer API via the test harness (renderer-agnostic).
   * @param terminalId - optional: specific terminal to read, or omit for first registered
   */
  async getVisibleText(terminalId?: string): Promise<string> {
    return this.page.evaluate((id) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) return ''
      return harness.getTerminalBuffer(id) ?? ''
    }, terminalId)
  }

  /**
   * Wait for the terminal to be ready (has rendered and shows a prompt).
   * Looks for common shell prompt characters: $, %, >, #
   * Uses the xterm.js buffer API via the test harness (renderer-agnostic).
   */
  async waitForPrompt(
    options: { timeout?: number; terminalId?: string } = {},
  ): Promise<void> {
    const { timeout = 15_000, terminalId } = options

    await this.page.waitForFunction(
      (id) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const buffer = harness.getTerminalBuffer(id)
        if (!buffer) return false
        // Check each line for a shell prompt character at end of line
        const lines = buffer.split('\n')
        return lines.some((line: string) => {
          const trimmed = line.trimEnd()
          return trimmed.length > 0 && /[$%>#]\s*$/.test(trimmed)
        })
      },
      terminalId,
      { timeout },
    )
  }

  /**
   * Wait for the terminal element to exist in the DOM.
   */
  async waitForTerminal(nth = 0, timeout = 15_000): Promise<void> {
    await this.getTerminalContainer(nth).waitFor({ state: 'visible', timeout })
  }
}
