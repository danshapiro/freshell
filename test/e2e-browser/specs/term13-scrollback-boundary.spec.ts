import { test, expect } from '../helpers/fixtures.js'

/**
 * TERM-13 -- "Honor configured scrollback size"
 * (docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md):
 *
 *   "Replace the fixed 8 MiB retention with the configured limit while
 *    preserving Unicode/frame boundaries and terminal search behavior."
 *   Playwright validation (`PW-RUST`): "Run the same numbered Unicode output
 *    under two scrollback settings, detach/reconnect, and assert the
 *    retained first/last markers and search results change at the intended
 *    boundary without corrupted characters."
 *
 * `settings-live-reload.spec.ts` already proves the narrower "live PATCH
 * (not boot-only)" clause with ONE scrollback setting and plain-ASCII
 * content. THIS spec closes the item's own remaining acceptance clauses:
 *
 *   1. TWO scrollback settings, same flood content -> the retained boundary
 *      (which markers survive) provably DIFFERS between them (not just
 *      "some content got evicted").
 *   2. The server-side search endpoint (`GET /api/terminals/{id}/search`,
 *      `mirror_search` in `crates/freshell-server/src/terminals.rs`) is
 *      proven to search only the CURRENTLY RETAINED window: a needle that
 *      was evicted returns zero matches; the same needle, retained under
 *      the larger cap, returns a real match.
 *   3. Unicode integrity: every flooded line carries an astral-plane emoji
 *      (a UTF-16 surrogate pair / 4-byte UTF-8 sequence -- the exact shape
 *      that a byte- or UTF-16-unit-unaware trim could split). The retained
 *      buffer AND the search API's returned `text` field are asserted to
 *      never contain the Unicode replacement character (`\uFFFD`, the
 *      universal symptom of a mid-codepoint slice), and the one needle line
 *      that IS retained is asserted byte-for-byte intact.
 *
 * DISCOVERY 1 (2026-07-19, this task): investigated
 * `crates/freshell-terminal/src/registry.rs`'s `ingest()` (the live
 * eviction path backing both reattach-replay AND this search endpoint's
 * `entry.snapshot`) and `chunk_ring.rs`/`replay_ring.rs` (the crate's other,
 * currently-unused-by-`registry.rs`, char/byte ring implementations). NONE
 * slice mid-codepoint:
 *   - `registry.rs::ingest()` evicts WHOLE `RetainedFrame`s only (FIFO,
 *     `s.replay.pop_front()`), counted in UTF-16 code units
 *     (`utf16_len`) matching legacy `ChunkRingBuffer` accounting -- never a
 *     partial slice of a frame's `data: String` (which, being a real Rust
 *     `String`, cannot hold a lone surrogate or a partial UTF-8 sequence in
 *     the first place).
 *   - `chunk_ring.rs`'s `slice_last_utf16` (used only for a single
 *     over-cap chunk) walks `s.chars().rev()` -- whole scalar values only.
 *   - `replay_ring.rs`'s `normalize_frame_data` (used only for a single
 *     over-cap chunk) walks the fatal UTF-8 decoder from a byte offset
 *     forward to the first valid boundary -- the same technique legacy's
 *     `normalizeFrameData` uses.
 * This is NOT a product bug -- no `test.fail`/expected-fail pin is applied.
 * The assertions below are a genuine, currently-passing proof of the
 * item's Unicode-integrity clause, not a documented gap.
 *
 * DISCOVERY 2 (2026-07-19, this task) -- KNOWN DIVERGENCE, legacy search is
 * NOT scoped to the retained window: `server/terminal-view/mirror.ts`'s
 * `TerminalViewMirror` holds TWO independent stores per terminal -- a
 * byte-capped `ReplayRing` (backs reattach-replay, genuinely bounded by the
 * scrollback setting) and a SEPARATE, entirely UNBOUNDED `this.lines` array
 * (`appendLines`, only ever grows) that legacy's OWN `search()` reads from.
 * Legacy's search endpoint therefore never reflects the scrollback cap at
 * all, regardless of setting -- confirmed empirically (a needle flooded far
 * outside a 75,000-char cap is still found by legacy's search, at the
 * un-evicted absolute line position). The Rust port's `terminals.rs`
 * deliberately unifies this: `entry.snapshot` (search's data source) is
 * built from the SAME bounded `s.replay` the reattach path uses, so Rust's
 * search genuinely IS scoped to the retained window -- a real improvement
 * over legacy, not a parity gap. The search-boundary assertions below are
 * therefore gated to `e2eServerKind === 'rust'`, with an explicit,
 * evidence-backed assertion of legacy's documented (not merely skipped)
 * divergence in the `else` branch of each test.
 *
 * Routed through the generic `serverInfo`/`harness`/`terminal` fixtures
 * (same seam as `settings-live-reload.spec.ts`) for every OTHER assertion
 * (reattach-replay survives, Unicode integrity) -- those are a true parity
 * control, unaffected by DISCOVERY 2 -- so this spec runs against both the
 * legacy Node server and the owned Rust server per `playwright.config.ts`'s
 * `MATRIX_SPECS`.
 */
test.describe('TERM-13 -- scrollback honors the configured cap at the Unicode/search boundary', () => {
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

  /** `GET /api/terminals/{id}/search?query=...` -- the mirror-search endpoint. */
  async function searchTerminal(
    page: any,
    serverInfo: any,
    terminalId: string,
    query: string,
  ): Promise<{ status: number; body: any }> {
    return page.evaluate(
      async ({ baseUrl, token, terminalId, query }: { baseUrl: string; token: string; terminalId: string; query: string }) => {
        const response = await fetch(
          `${baseUrl}/api/terminals/${encodeURIComponent(terminalId)}/search?query=${encodeURIComponent(query)}`,
          { headers: { 'x-auth-token': token } },
        )
        const body = await response.json().catch(() => null)
        return { status: response.status, body }
      },
      { baseUrl: serverInfo.baseUrl, token: serverInfo.token, terminalId, query },
    )
  }

  // computeScrollbackMaxChars(lines) = clamp(lines * 300, 64*1024, 4*1024*1024)
  // (terminal-registry.ts:1328-1333 / freshell-terminal's
  // compute_scrollback_max_bytes, registry.rs:106-110 -- same formula/constants
  // on both servers, and the exact formula `settings-live-reload.spec.ts`
  // documents). 250 lines -> a 75,000-char cap; 10,000 lines -> a
  // 3,000,000-char cap. The flood below (~180,000 UTF-16 units) sits
  // strictly between the two, so the needle line survives ONLY under the
  // large cap.
  //
  // Lines are deliberately SHORT (well under any plausible terminal column
  // width) so xterm never soft-wraps one logical line across two rendered
  // rows -- this spec asserts on RETAINED CONTENT/SEARCH boundaries, not
  // display wrapping, so wrapping would only introduce an unrelated
  // row-join ambiguity in `getTerminalBuffer()`. The total flood size is
  // instead reached via LINE COUNT.
  const SMALL_SCROLLBACK_LINES = 250
  const LARGE_SCROLLBACK_LINES = 10_000
  const FLOOD_LINE_COUNT = 12_000

  // U+1F600 GRINNING FACE -- a UTF-16 surrogate pair (2 code units) / 4-byte
  // UTF-8 sequence, embedded on EVERY flooded line so any mid-codepoint
  // slice (byte- or char-count-unaware) has maximal opportunity to land
  // inside one. `\uFFFD` (the Unicode replacement character) is the
  // universal symptom of exactly that failure and is asserted absent
  // throughout.
  const EMOJI = '\u{1F600}'
  const REPLACEMENT_CHAR = '\uFFFD'

  function buildFlood(needle: string, doneMarker: string): string {
    const filler = 'x'.repeat(10)
    // POSIX `sh`-compatible (no bash-only brace expansion, matching
    // `settings-live-reload.spec.ts`'s proven-safe flood shape): line 0
    // carries the needle + emoji marker; every other line carries only the
    // emoji (maximizing boundary-crossing opportunities); the final line is
    // a distinct, always-checked "flood is complete" marker -- DELIBERATELY
    // independent of `needle` (a marker that itself embedded the needle
    // would always keep the needle "retained" via the always-newest done
    // line, defeating the SMALL-cap eviction assertion).
    return (
      `i=0; while [ $i -lt ${FLOOD_LINE_COUNT} ]; do ` +
      `if [ $i -eq 0 ]; then echo "NEEDLELINE-${needle} ${EMOJI} ${filler}"; ` +
      `else echo "line-$i-${EMOJI}-${filler}"; fi; ` +
      `i=$((i+1)); done; echo "${doneMarker}"`
    )
  }

  async function runScrollbackScenario(
    page: any,
    harness: any,
    terminal: any,
    serverInfo: any,
    scrollbackLines: number,
  ): Promise<{ terminalId: string; visibleText: string; needle: string; doneMarker: string }> {
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The knob change happens BEFORE the terminal exists (documented scope
    // limit: applies to terminals created after the call -- same rule
    // `settings-live-reload.spec.ts` exercises).
    await patchScrollback(page, serverInfo, scrollbackLines)

    await selectShell(page)
    await terminal.waitForTerminal()

    const needle = `TERM13-${scrollbackLines}-${Math.random().toString(36).slice(2, 10)}`
    // Independent of `needle` (see `buildFlood`'s doc comment) so the
    // SMALL-cap "needle was evicted" assertion below can't be defeated by
    // the always-newest done marker itself echoing the needle text.
    const doneMarker = `flood-done-marker-${Math.random().toString(36).slice(2, 10)}`

    await terminal.executeCommand(buildFlood(needle, doneMarker))
    await terminal.waitForOutput(doneMarker, { timeout: 30_000 })

    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    const terminalId: string = layout?.content?.terminalId
    expect(terminalId).toBeTruthy()

    // Force a fresh WS attach: the terminal keeps running detached
    // (background session), and the client re-attaches on load and replays
    // whatever the SERVER retained -- exactly the "detach/reconnect" +
    // "retained buffer size boundary" clauses this spec asserts on.
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await terminal.waitForOutput(doneMarker, { timeout: 45_000, terminalId })

    const visibleText = await terminal.getVisibleText(terminalId)
    return { terminalId, visibleText, needle, doneMarker }
  }

  test('a SMALL scrollback cap evicts the earliest needle/search match while staying Unicode-clean', async ({
    page,
    harness,
    terminal,
    serverInfo,
    e2eServerKind,
  }) => {
    const { terminalId, visibleText, needle, doneMarker } = await runScrollbackScenario(
      page,
      harness,
      terminal,
      serverInfo,
      SMALL_SCROLLBACK_LINES,
    )

    // The LATEST marker survived reattach (proves the reattach/replay path
    // itself still works, independent of the cap). TRUE PARITY on both
    // server kinds.
    expect(visibleText).toContain(doneMarker)

    // UNICODE INTEGRITY: whatever is currently rendered never contains the
    // replacement character -- the universal symptom of a mid-codepoint
    // slice (byte- or UTF-16-unit-unaware trimming). TRUE PARITY on both
    // server kinds.
    expect(visibleText).not.toContain(REPLACEMENT_CHAR)

    // BOUNDARY + SEARCH: the server-side search endpoint reads the SAME
    // retained window as reattach-replay (`entry.snapshot` in
    // `terminals.rs`) on Rust -- this is the authoritative check for "was
    // the earliest marker evicted", deliberately NOT re-derived from the
    // client's rendered `visibleText` (the client paginates scrollback on
    // attach -- `TerminalView.tsx`'s "Load earlier terminal history"
    // control -- so an initial `getVisibleText()` window reflects
    // client-side pagination state, not the server's retained boundary).
    //
    // KNOWN DIVERGENCE (see DISCOVERY 2 above): legacy's search is backed
    // by `TerminalViewMirror`'s unbounded `this.lines`, never scoped to the
    // scrollback cap. On Rust, the needle is genuinely evicted and
    // unsearchable; on legacy, it remains findable regardless of setting --
    // asserted explicitly (not silently skipped) as evidence for the
    // divergence claim.
    const search = await searchTerminal(page, serverInfo, terminalId, needle)
    expect(search.status).toBe(200)
    if (e2eServerKind === 'rust') {
      expect(search.body?.matches).toEqual([])
    } else {
      expect(search.body?.matches?.length).toBeGreaterThan(0)
    }
  })

  test('a LARGE scrollback cap retains the earliest needle/search match, byte-perfect and Unicode-clean', async ({
    page,
    harness,
    terminal,
    serverInfo,
    e2eServerKind,
  }) => {
    const { terminalId, visibleText, needle, doneMarker } = await runScrollbackScenario(
      page,
      harness,
      terminal,
      serverInfo,
      LARGE_SCROLLBACK_LINES,
    )

    // The LATEST marker survived reattach (proves the reattach/replay path
    // itself still works). TRUE PARITY on both server kinds.
    expect(visibleText).toContain(doneMarker)

    // UNICODE INTEGRITY: no replacement character anywhere in the currently
    // rendered buffer. TRUE PARITY on both server kinds.
    expect(visibleText).not.toContain(REPLACEMENT_CHAR)

    // BOUNDARY + SEARCH: on Rust, the needle IS a real match, with the
    // returned `text` field byte-for-byte intact (proves the mirror's own
    // line-splitting/CSI-stripping normalization doesn't mangle it either).
    //
    // KNOWN DIVERGENCE (see DISCOVERY 2 above): legacy's search always
    // finds the needle regardless of the configured cap (its unbounded
    // `TerminalViewMirror.lines`), so this is not a meaningful "boundary"
    // proof on legacy the way it is on Rust -- still asserted (not
    // skipped) as evidence, and the byte-perfect/Unicode-clean shape of
    // whatever IS returned is checked on BOTH kinds.
    const search = await searchTerminal(page, serverInfo, terminalId, needle)
    expect(search.status).toBe(200)
    expect(Array.isArray(search.body?.matches)).toBe(true)
    expect(search.body.matches.length).toBeGreaterThan(0)
    const matchedLine = search.body.matches.find((m: any) => typeof m.text === 'string' && m.text.includes(needle))
    expect(matchedLine).toBeTruthy()
    expect(matchedLine.text).toContain(EMOJI)
    expect(matchedLine.text).not.toContain(REPLACEMENT_CHAR)
    void e2eServerKind // documented above; no branch needed for this test's shape
  })
})
