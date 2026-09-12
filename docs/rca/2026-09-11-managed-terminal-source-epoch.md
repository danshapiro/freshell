# Managed terminal source epoch overwritten by inventory projection

## Observed failure

The live managed OpenCode browser test launched the pinned real provider and
rendered its TUI, but timed out before submitting a prompt. Earlier failure
screenshots showed `Offline` and `Reconnecting`; those screenshots were taken
**after** the test's `finally` block stopped the owned web server. They were not
evidence of a live WebSocket failure.

A pre-teardown diagnostic reproduced the failure on the parent source at
`ba37c013aab91b405a38df1405d693fb3ec4b8ad` (only test diagnostics were added).
It recorded connection status `ready`, browser bracketed-paste mode enabled,
both provider banners rendered, source readiness true, and identical source /
pane incarnation IDs. Only stream identity disagreed: the browser held the
launch seed, while the actual source epoch included the host-minted suffix.

Evidence in the worktree:

- `.runtime-evidence/ba37c013aab91b405a38df1405d693fb3ec4b8ad/43e4b592-5659-48c9-a6e1-cf63a925dde5/browser/managed-provider-input-readiness.json`
- `.runtime-evidence/stage-5a/opencode-readiness-diagnostic.log`
- `.runtime-evidence/stage-5a/stream-projection-red.log`

These are local test-run artifacts, not deployed-service evidence.

## Cause and correction

`HostedPty::spawn` derives a fresh source epoch from `TerminalLaunchSpec.stream_id`
and a unique suffix when it creates the PTY. The supervisor inventory's
`terminalStreamId`, in contrast, is the stored **launch seed** read from that
launch specification. The seed is not an output sequence domain.

`managedTerminalContent` incorrectly copied the inventory seed into the pane's
`streamId`. A normal revisioned inventory refresh could therefore replace the
actual epoch already established by `terminal.attach.ready`. The browser and
provider were live, but the pane's stream/checkpoint identity was no longer the
one whose output it was rendering. During replacement this could also interfere
with the stream-change hydration handshake.

The projection no longer assigns `streamId`. Reconstructed panes leave it unset
until attachment. Existing surfaces retain their actual epoch until an
attachment or stream-change control frame advances it. The authenticated
supervisor still owns soul identity, incarnation, limits, recovery status, and
view intent; this change does not transfer those authorities to the browser.

Four new unit regressions cover both arrival orders, reconstructed panes, and
replacement projection. The real-browser P2-G01 test now reasserts a view through
the real supervisor API after attachment, waits for the new view revision to
reach the pane, and verifies that the attached epoch is unchanged. It repeats
this after all ten graceful/abrupt web restarts, alongside its existing usable
input, advancing output, stable child process, and one-runtime assertions.

## A second, independent test sequencing failure

With the projection corrected, real OpenCode accepted the initial prompt. A
read-only query inside the exact receipt-owned test container verified one
completed native assistant response containing the random test nonce, under the
expected provider and model. The test nevertheless waited until timeout.

`executeAndAwaitNonceOutput` required two visible copies of the nonce: one in
the echoed prompt and one in the response. An interactive terminal does not
preserve that count: line wrapping, scrolling, and redraws change its rendered
buffer. Conversely, seeing a nonce in partial output does not prove that a turn
has completed or been durably stored. This was not model latency or a reason to
increase timeouts.

The scenario now submits each prompt once, then waits for a new **completed
provider-native assistant record** in the exact session. It verifies that the
previously observed native prefix remains unchanged, accepts exactly one new
no-tools answer, and rejects reused message/turn or append-only record identity.
The final stopped-provider history must equal all three observed responses.
Existing exact-session recovery, real-binary/model, one-writer, old-enclosure
emptiness, resource, and cleanup checks remain intact.

Evidence: `.runtime-evidence/stage-5a/opencode-native-sequencing-diagnostic.json`,
`opencode-stream-fix-live.log`, and `native-sequence-green.log` in that directory.

## Scope

Dan explicitly deferred Gemini, Kimi, and extension/plugin support from Stage 5a
on September 11. Claude terminal, FreshClaude, Kilroy, Codex terminal, FreshCodex,
OpenCode terminal, FreshOpenCode, and Amplifier remain required. The scope change
does not classify deferred implementations as passing tests, remove legacy
behavior, or relax failure-closed managed capability checks.

## Validation record

The initial focused results are 20 projection/recovery-UI tests, 171 terminal
lifecycle/retry tests, and 31 native-reader/sequencing tests passing. P2-G01 passes
in real Chromium with ten web restarts, successful cleanup, and zero unsafe
broker attempts. Runtime/browser typechecks pass; lint reports zero errors and
the same eleven pre-existing warnings. These observations were made in the
working tree; the Stage 5a plan records the subsequent final commit and live
matrix results separately. Neither a partial run nor an old passing run is a
claim that the entire Stage 5a acceptance matrix passed.


The complete managed OpenCode scenario subsequently passed in the corrected
working tree: verification run `d87f033a-1504-4bd8-9984-1ddb22ea5a28`, runtime run
`e6bb1206-9e59-483e-9544-cf2816b305b3`. It observed three different completed native
assistant records in one exact session through host loss and provider-process
loss, retained one writer, verified old enclosures empty, and ended with no loss
notices, successful cleanup, and zero unsafe broker attempts. This establishes
the targeted recovery fix, not completion of unexecuted provider/stress checks.
