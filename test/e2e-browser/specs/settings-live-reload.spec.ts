import { test, expect } from '../helpers/fixtures.js'

// NARROW live settings reload (this fix): exactly two knobs -
// `settings.safety.autoKillIdleMinutes` and `settings.terminal.scrollback` -
// take effect via `PATCH /api/settings` WITHOUT a server restart. Legacy
// applies both live via `registry.setSettings(updated)`
// (`server/settings-router.ts:138` -> `terminal-registry.ts:1316-1322`); the
// Rust port wires the SAME shared `TerminalRegistry` into the
// `PATCH /api/settings` handler (`crates/freshell-server/src/settings_store.rs`).
//
// This spec is the CONTROL for both servers (`legacy-chromium` AND
// `rust-chromium` -- no `test.fail` gate): the scrollback knob is
// deterministic and fast to prove end-to-end, unlike the idle-kill knob
// (which requires waiting out a 30s sweep interval on both servers). If
// legacy ever regressed to boot-only for this knob too, this spec would
// catch it on `legacy-chromium` as well, which is the intended parity bar.
test.describe('Settings Live Reload (narrow: scrollback)', () => {
  async function selectShell(page: any): Promise<void> {
    const alreadyVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
    if (alreadyVisible) return
    const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
    for (const name of shellNames) {
      const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      try {
        await button.click({ timeout: 5000 })
        await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
        return
      } catch {
        continue
      }
    }
    throw new Error('No shell option available for the active tab')
  }

  async function patchScrollback(page: any, serverInfo: any, lines: number): Promise<void> {
    const result = await page.evaluate(
      async ({ baseUrl, token, lines }: { baseUrl: string; token: string; lines: number }) => {
        const response = await fetch(`${baseUrl}/api/settings`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': token,
          },
          body: JSON.stringify({ terminal: { scrollback: lines } }),
        })
        return { ok: response.ok, status: response.status }
      },
      { baseUrl: serverInfo.baseUrl, token: serverInfo.token, lines },
    )
    expect(result.ok).toBe(true)
  }

  // computeScrollbackMaxChars(lines) = clamp(lines * 300, 64*1024, 4*1024*1024)
  // (terminal-registry.ts:1328-1333 / freshell-terminal's
  // compute_scrollback_max_bytes, registry.rs:106-110 -- same formula/constants
  // on both servers). scrollback:250 -> a 75,000-char cap: comfortably above
  // the clamp floor (65,536) so this proves the PATCHED value took effect,
  // not just a floor clamp, and comfortably below the ~3,000,000-char DEFAULT
  // cap (scrollback:10000) so a flood sized between the two can only survive
  // intact if the live knob did NOT take effect (the boot-only regression
  // this spec exists to catch).
  const PATCHED_SCROLLBACK_LINES = 250
  const FLOOD_LINE_COUNT = 2000 // ~150,000 chars total: 2x the patched cap, ~5% of the default cap

  test('a live PATCH of terminal.scrollback caps a terminal created AFTER it, surviving reattach', async ({
    page,
    harness,
    terminal,
    serverInfo,
  }) => {
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The knob change happens BEFORE the terminal exists, matching the
    // registry's documented scope limit (`set_scrollback_max_bytes` doc
    // comment, `registry.rs`): applies to terminals created after the call.
    await patchScrollback(page, serverInfo, PATCHED_SCROLLBACK_LINES)

    await selectShell(page)
    await terminal.waitForTerminal()

    // POSIX `sh`-compatible flood (no bash-only brace expansion): each line
    // is ~78 chars ("scrollmark-<i>-" + a 61-char filler), so 2000 lines is
    // safely between the patched cap (75,000 chars) and the default cap
    // (~3,000,000 chars).
    const filler = 'x'.repeat(61)
    await terminal.executeCommand(
      `i=0; while [ $i -lt ${FLOOD_LINE_COUNT} ]; do echo "scrollmark-$i-${filler}"; i=$((i+1)); done`,
    )
    await terminal.waitForOutput(`scrollmark-${FLOOD_LINE_COUNT - 1}-`, { timeout: 30_000 })

    // Force a fresh WS attach: the terminal keeps running detached
    // (background session), and the client re-attaches on load and replays
    // whatever the SERVER retained -- exactly the "retained buffer size
    // boundary" this spec asserts on.
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The most recent output must have survived the replay (proves the
    // reattach/replay path itself works, independent of the cap).
    await terminal.waitForOutput(`scrollmark-${FLOOD_LINE_COUNT - 1}-`, { timeout: 15_000 })

    // The EARLIEST output must have been evicted by the LIVE-patched
    // 75,000-char cap. If the patch only took effect at boot (the bug this
    // fix closes), the terminal would still be capped at the ~3,000,000-char
    // default and this line -- well under that -- would still be present.
    const bufferAfterReattach = await terminal.getVisibleText()
    expect(bufferAfterReattach).not.toContain('scrollmark-0-')
  })
})
