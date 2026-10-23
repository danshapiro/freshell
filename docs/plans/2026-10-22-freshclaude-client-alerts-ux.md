# Plan: client alerts and UX for freshclaude and kilroy (gaps G11, G17, G20, G25, G26)

Base: worktree `/home/dan/code/freshell/.worktrees/freshclaude-parity`, branch `feat/freshclaude-parity` (identical to `origin/main` 1c7e4dff7).
Phase: design only. No repo files were changed.
Inputs: `audit-gaps.md` and `audit-matrix.md` in the scratchpad. New real-CLI probes for this plan are in `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/perm-probe/probe-perm.mjs`, with scenarios `remember`, `remember-session`, `shapes`, `plan-allow`, `plan-setmode`, `plan-bypass`, `plan-empty` and `plan-file`. They drive the pinned CLI 2.1.237 / SDK 0.3.237 against a local fake Anthropic endpoint only.

Kilroy is sessionType `kilroy` on the same claude runtime, so every claude change below covers kilroy too. Kilroy-specific tests are listed where the path differs, which is mostly the picker or settings key `kilroy`.

---

## 0. Summary of the workstream

| Gap | What the user sees today | What changes | Layers touched |
|---|---|---|---|
| G11 | A model saved for Freshclaude/Kilroy is ignored. Every new or resumed pane opens on Opus 1M. | New and resumed panes start on the saved default model. Its effort levels go with it. One shared resolver replaces two copies of the logic that had drifted apart. | client, plus a settings schema field |
| G17 | On a phone, the tab strip and the tab switcher never show that a tab finished or is waiting. | Both mobile surfaces show the same needs-attention mark as desktop, built from one shared selector, one class helper and one indicator component. Clicking the active card dismisses the mark in click mode. | client |
| G20 | Claude's own "don't ask again" rules are dropped. "Always allow Bash" is a client-only bypass that covers every command and is lost on reload. A plan-mode exit shows raw JSON. After a plan approval the pane still says "plan" while the CLI has left plan mode. | "Allow and don't ask again" returns the CLI's own suggestions, so the CLI enforces scoped rules such as `Bash(npm test *)`. A plan card renders the plan as markdown and offers approval options. The pane's permission mode follows the CLI's real mode. For claude, the client-only bypass is removed. | sidecar, Rust, shared contract, client |
| G25 | A turn that ends while the browser's WebSocket is down never highlights or rings. | The server keeps the last attention-edge time for each claude session and sends it in `ready` on every connection. The client replays only edges newer than what this page already knew. A reload or first connect never replays anything. A notice for a server restart mid-turn is specified, with the server part handed to core. | Rust, protocol, client |
| G26 | A chime that never fires `ended` silences every later bell until reload. A hidden pane that receives an approval or question can take up to 3 s after reveal to show the card. | The ring queue gets a watchdog plus `pause`/`abort` release. Hidden panes owe a non-blocking surface refresh. They do not use the blocking "transcript dirty" path, which would stall for 15 s and then show an error (see 1.5). | client |

Proposed PRs: four separate PRs, in this order. Each needs explicit user approval before `gh pr create`, per AGENTS.md.
1. PR-A: G26 and G11. These are client only and low risk.
2. PR-B: G17.
3. PR-C: G20.
4. PR-D: G25. This one depends on the core-runtime edge choke point (section 7).

---

## 1. Verified current behavior

### 1.1 G11: the saved default model is ignored

- `src/components/panes/PaneContainer.tsx:712-724`: `providerDefaultModel` (the saved `freshAgent.providers[type].modelSelection.modelId`) and `runtimeProviderModel` (`codingCli.providers[runtime].model`) are only consulted when `runtimeProvider === 'codex' || 'opencode'`. Claude gets `freshAgentType.defaultModel` unconditionally.
- `PaneContainer.tsx:726,750-751`: claude panes always persist `model`, which here is always `'opus[1m]'`. They also persist the saved `modelSelection`.
- `src/lib/fresh-agent-registry.ts:176-184`: `resolveEffectiveFreshAgentModel` prefers `content.model` over `content.modelSelection` and the provider defaults. Create and every send therefore carry opus[1m]. The view uses it at `FreshAgentView.tsx:1911` (send) and `:2050` (create).
- `src/lib/session-type-utils.ts:223`: the resume path hardcodes `model: freshAgentType.defaultModel` for every fresh provider. This also affects codex resume (`FRESHCODEX_DEFAULT_MODEL`).
- The defaults themselves: `fresh-agent-registry.ts:69` (freshclaude) and `:105` (kilroy) are both `'opus[1m]'`.
- Saving works. `FreshAgentModelDialog.tsx:384-391` and `FreshAgentSettingsButton.tsx:186-197,406-409` save `{modelSelection:{kind:'exact',modelId}, effort}` per sessionType. For claude they also stamp the model's effort levels, but only into pane content: `FreshAgentModelDialog.tsx:368-370` and `FreshAgentSettingsButton.tsx:394-396` (`modelEffortLevels`). The provider defaults schema (`shared/settings.ts:143-148,748-768`) has no place for those levels. A saved catalog-only model, such as one not in the static opus table at `shared/fresh-agent-models.ts:20-28`, would therefore start with effort normalized against the opus table. For example, a model with no effort levels would still be sent `effort: 'high'`.
- The test gap: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx:361-421` saves `opus[1m]`, which equals the default, so the test cannot fail.
- History: the claude exclusion came from commit 24b490d80 ("Fix fresh-agent runtime edge cases"), which only widened the codex branch. No commit records a deliberate reason for leaving claude out.

### 1.2 G17: mobile tab surfaces have no attention mark

- `src/components/TabBar.tsx:737-746`: on mobile, TabBar renders only `MobileTabStrip` and `TabSwitcher`.
- `src/components/MobileTabStrip.tsx:23-120`: the selectors read activity and busy state only, plus a Busy badge. There is no `turnCompletion` selector at all.
- `src/components/TabSwitcher.tsx:44-163`: the cards render title, status and a Busy badge. There is no `turnCompletion` selector. A card click dispatches `setActiveTab` only (`:63-70`), so tapping the already-active card never dismisses its attention in click mode. Desktop does dismiss on click: `TabBar.tsx:583-587` dispatches `dismissTabGreen` when `attentionDismiss==='click'`.
- Desktop draws the mark in `TabItem.tsx:90-94,168-190`. It shows the union `selectTabStripAttention` (`src/store/turnCompletionAttention.ts:22-25`, which is attention plus the watched-completion mark), styled by `tabAttentionStyle` (highlight/pulse/darken/none). The deck repeats similar logic in `src/deck/deck-selectors.ts:183-200`, and `focusTabFromDeck` (`src/deck/deck-actions.ts:10-15`) duplicates TabBar's "dismiss then activate" logic.
- Clearing on tab switch already works for every surface. `useTurnCompletionNotifications.ts:101-112` dismisses on any `activeTabId` change in click mode, and `pane-focus-ownership.ts:312-345` clears watched marks on `setActiveTab`/`switchToNext`/`switchToPrev`. The mobile chevrons and switcher therefore only lack the rendering, plus the dismiss on an already-active card.
- Sidebar rows do show attention (`Sidebar.tsx:400-412,1039,1143`), so a phone user who opens the sidebar sees it.
- Out of scope: the OS-level escalation (Web Notification or title flash) is part of kata 1wyr and is not included here.

### 1.3 G20: claude approvals

Code facts:
- `crates/freshell-claude-sidecar/permission-channel.mjs:36-73` parks the SDK `suggestions`, `blockedPath` and `decisionReason` and forwards them on `sdk.permission.request`. `respondPermission` (`:136-143`) resolves the client's decision verbatim.
- Rust `PendingApprovalEntry` (`crates/freshell-freshagent/src/claude.rs:490-523`) and its fold (`claude.rs:9151-9181`) drop `suggestions`. The WS broadcast relays the line verbatim (`claude.rs:9340-9363`), but the card renders only from the REST snapshot's `pendingApprovals` (`FreshAgentView.tsx:4320,4646`). `FreshAgentPendingApprovalSchema` is `.strict()` with no `suggestions` (`shared/fresh-agent-contract.ts:262-270`).
- `respondToApproval` always sends `{behavior:'allow'}` or the deny shape (`FreshAgentView.tsx:4389-4403`).
- "Always allow <Tool> this session" is `alwaysAllowToolsRef` (`FreshAgentView.tsx:1620`). It is cleared on a new conversation (`:2134`), lost on remount or reload, and auto-answers every later approval with the same tool name (`:4131-4154`), whatever the command.
- `FreshAgentApprovalCard.tsx:56-62` has no ExitPlanMode branch, so the plan is shown as `JSON.stringify(input)`.
- The sidecar forwards only `system/status` with `status:'compacting'` (`index.mjs:286-287`). `permissionMode` on `system/status` and `system/init` is ignored, and `sdk.session.init` does not carry it (`index.mjs:265-279`). The Rust consumer folds the permission mode only from `sdk.configured` (`claude.rs:8451-8490`).

Probe facts (CLI 2.1.237, fake endpoint, `perm-probe/probe-perm.mjs`):
1. `Bash npm test` in default mode: `options.suggestions = [{type:'addRules', rules:[{toolName:'Bash', ruleContent:'npm test *'}], behavior:'allow', destination:'localSettings'}]`, plus `decisionReason`, `displayName` and `description` (no `title`).
2. Returning `{behavior:'allow', updatedPermissions: suggestions}`, with or without `updatedInput`, writes `{"permissions":{"allow":["Bash(npm test *)"]}}` to `<cwd>/.claude/settings.local.json`. The next `npm test` is not prompted. A different command (`ls /`) still is.
3. The same suggestions with `destination:'session'` also stop the next prompt, and no file is written.
4. Other shapes:
   - `Write` in default mode: `[{type:'setMode', mode:'acceptEdits', destination:'session'}]`.
   - `Read /etc/hostname`: `[{type:'addRules', rules:[{toolName:'Read', ruleContent:'//etc/**'}], behavior:'allow', destination:'session'}]` with `decisionReason:'Path is outside allowed working directories'`.
   - A compound Bash command: two suggestions with mixed destinations.
   - `ls /`: an empty list plus `blockedPath:'/'`.
5. `ExitPlanMode` in plan mode gets no suggestions. When a plan file exists, the CLI injects `input.plan` (the file's text) and `input.planFilePath` (`plan-file`). With no plan file the input is `{}` (`plan-empty`).
6. Approving `ExitPlanMode` makes the CLI emit `system/status {permissionMode}` at once, and the next turn's `system/init` reports the same mode:
   - plain allow gives `default`;
   - `updatedPermissions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]` gives `acceptEdits`;
   - `setMode bypassPermissions` gives `bypassPermissions`. This works because the sidecar sets `allowDangerouslySkipPermissions:true`.

Consequence: the mode drifts today, and it would drift further once suggestions are honored. Pane content still says `plan` while the CLI is in `default`. The sidecar's `session.settings.permissionMode` (`session-settings.mjs:22-29`) also still says `plan`. Picking "Plan" again from the popover is then a silent no-op: `configureSession` diffs against the stale `plan` and never calls `setPermissionMode`.

### 1.4 G25: attention edges missed while disconnected

- Fresh-agent frames go out on the shared bus only (`claude.rs:1850-1854`). Nothing is buffered per session.
- A plain reconnect re-attaches every pane (`FreshAgentView.tsx:2782-2826`). For a claude session the server still tracks, attach answers with no frame at all (`claude.rs:6658-6672`, "tracked-and-alive: no frame").
- Death-minted edges are emitted after eviction (`claude.rs:8832-8859`), so no later per-session state survives to report them.
- The client dedupe is `recordTurnComplete`'s `at <= last` check, keyed by `provider:sessionId` and `…#waiting` (`turnCompletionSlice.ts:81-96`, `turnCompletionThunks.ts:99-149`). Baselines are reset on the first ready of the page and on a server restart (`App.tsx:1338-1359`).
- The stale comment at `turnCompletionThunks.ts:128-133` ("server buffers and replays … FIRST subscriber") and the claim at `:92-97` ("never replayed from a snapshot") describe a Node-era server.
- The WS layer subscribes to the bus before building the handshake (`crates/freshell-ws/src/lib.rs:857-860`). An edge recorded after the handshake snapshot is therefore always delivered live, so there is no gap between the `ready` snapshot and the live stream. `ready` already carries an optional, capability-gated, additive payload (`runtimeOwners`, `lib.rs:650-700`; `server_messages.rs:1263-1288`; client parser `src/lib/ready-message-schema.ts:12-55` with `.catch(undefined)`).
- Part 2, a restart mid-turn: `FreshClaudeState::shutdown` drains the map and aborts consumers before the kill (`claude.rs:1828-1847`). The death arm and its banner never fire, and the pane cold-resumes idle with no notice.

### 1.5 G26: bell queue and hidden-pane approvals

- `src/hooks/useNotificationSound.ts:80-136`: `ringingRef` is released only by `finish()`. That runs on Audio `ended`, on the fallback oscillator's `ended`, or when there is no audio machinery. There is no timer and no `pause`/`abort` listener, so a chime paused without `ended` wedges every later bell until the page reloads.
- `FreshAgentView.tsx:149-182`: `permission.request`, `permission.cancelled`, `question.request` and `question.cancelled` are snapshot-invalidating but not transcript-invalidating. `:3141-3155`: while hidden, the pane neither marks itself dirty nor refreshes for them. On reveal, `requestRevealRefresh` is skipped unless the pane is dirty (`:1769-1778,2832-2836`). The card then waits for the 3 s busy poll (`:4029-4042`).
- The audit's suggested fix (`markSnapshotDirty()` on these events) would be wrong, for this reason:
  - A dirty pane shows the blocking "Refreshing conversation" overlay (`:4360,4780-4800`).
  - The overlay clears only when the refreshed snapshot's `revision` is greater than the revision recorded when the pane was marked dirty (`:3384-3402`).
  - The claude revision is the transcript file's mtime (`claude_snapshot.rs:1187-1223`), and a permission request does not have to touch the transcript.
  - The revealed pane would therefore retry for 15 s (`REVEAL_REFRESH_MAX_WAIT_MS`) and then show "The conversation did not finish refreshing".
  - This is why `FreshAgentView.hidden-rebind.test.tsx:312` pins "does not mark a hidden pane stale for a status-only snapshot event". The fix needs a separate, non-blocking lane.

---

## 2. Target behavior

### G11
- A new Freshclaude or Kilroy pane uses the saved default for its type. Precedence is: saved model, then the registry default.
- A pane created to resume a session from the sidebar, context menu, handoff, tab restore or the tabs thunk uses the same rule.
- An existing pane keeps its own model, including in lost-session recovery and re-creates.
- When the saved model is catalog-only, its effort levels (captured when it was picked) go with it. Effort is clamped against those levels, never against the opus table.
- One function computes new-pane model defaults for every provider. For codex and opencode, new panes behave as they do today. Codex resume now honors the saved codex default as a side effect of using the shared resolver (decision D2).

### G17
- MobileTabStrip:
  - The active tab's title pill uses the same attention treatment as desktop when that tab has the union mark.
  - A status badge says "N other tabs need attention" when other tabs have it.
  - The previous and next chevrons each show a small dot when an attention tab lies in that direction.
- TabSwitcher: each card carries the attention treatment, and its accessible name includes "needs attention". In click mode, tapping a card dismisses its attention, including the already-active card, by the same path as desktop and the deck.
- `tabAttentionStyle: 'none'` hides every mark on every tab surface.
- One selector, one class helper (`tabAttentionClassName`) and one presentational `TabAttentionIndicator` serve TabItem, MobileTabStrip and TabSwitcher. TabItem's look is unchanged; the refactor is protected by the existing class tests.

### G20
- The claude approval card shows these actions:
  - "Allow";
  - "Allow and don't ask again" when the CLI offered suggestions. It is described in plain language, one line per suggestion: "Always allow `Bash(npm test *)` in this project (saved to .claude/settings.local.json)", "Allow `Read(//etc/**)` for the rest of this conversation", "Auto-accept file edits for the rest of this conversation", and so on. It sends exactly the displayed, server-normalized suggestions as `updatedPermissions`;
  - "Deny".
  The client-only "Always allow <Tool>" bypass is gone for claude.
- Codex keeps its client-only behavior. Its label is corrected to "Always allow <Tool> in this pane", with the tooltip "Until this pane reloads" (decision D3).
- ExitPlanMode gets its own "Plan ready for review" card. It renders `input.plan` as markdown, shows `planFilePath` in small mono text, and offers four actions:
  - "Approve plan": plain allow, so the CLI goes to `default`;
  - "Approve and auto-accept edits": `setMode acceptEdits`, session;
  - "Approve and stop asking for permission": `setMode bypassPermissions`, session;
  - "Keep planning", with an optional "What should change?" field. It sends deny with that text, or the default "The user wants to keep planning."
  An empty plan gets clear copy.
- The pane's permission mode follows the CLI:
  1. The sidecar folds `permissionMode` from `system/status` and `system/init` into its own session state and emits `sdk.session.metadata{permissionMode}` on a real change.
  2. Rust folds that into the session's settings, persisting it the same way as configure, and relays `freshAgent.session.metadata{permissionMode}`.
  3. The client stores `session.permissionMode` and converges the pane's `permissionMode`. It does not save this as a provider default.

### G25
- Every connection that opts in with `hello.capabilities.freshAgentAttentionReplayV1` gets `ready.freshAgentAttention`: for every claude session the server knows, `{provider, sessionId, sessionType, lastTurnCompleteAt?, lastWaitingAt?}`. `lastWaitingAt` is present only while approvals or questions are still pending.
- The client folds this after the restart and first-ready baseline reset:
  - A session this page has never observed is seeded silently. This covers every session at page load and every session after a server restart, so a reload never replays anything.
  - For a session already observed, an edge newer than the page's high-water mark is replayed through the normal `applyFreshAgentCompletion`/`applyFreshAgentWaiting` path. That gives the same receipt-time watched classification, highlight, pane mark and single bell as a live edge.
- "Observed" means one of: seeded by `ready`, seen in `freshAgent.created`, seen in a `freshAgent.session.snapshot` ack, or seen as a live edge, even one for a session with no pane on this device.
- Part 2: after a server restart mid-turn, the next attach of that session shows the banner "The server restarted while this turn was running. The turn was stopped." It does not ring, because a restart is a requested teardown. The server part is specified for the core-runtime workstream (section 7).

### G26
- Each ring has a backstop watchdog (`RING_WATCHDOG_MS = 5000`; the chime is about 1.03 s, the fallback tone 0.12 s). An Audio `pause` releases the queue and an `abort` falls back to the tone. A firing logs `warn` (`notification_ring_watchdog_fired`) once per ring. The timer is cleared on normal finish and on unmount.
- A hidden pane that receives a permission or question request, or their cancellation, records that it owes a surface refresh. On reveal it runs one non-blocking `requestSnapshotRefresh('reveal-surface')`. There is no overlay and no revision gate. If the pane is also transcript-dirty, the blocking reveal refresh covers it instead.

---

## 3. Design and changes, file by file

### 3.1 G26

`src/hooks/useNotificationSound.ts`
- Export `RING_WATCHDOG_MS = 5_000`.
- In `startRing`:
  - Arm `const watchdog = window.setTimeout(onWatchdog, RING_WATCHDOG_MS)` and keep the handle in `activeWatchdogRef`. `onWatchdog` logs `log.warn({event:'notification_ring_watchdog_fired', stage: fallbackArmed ? 'fallback' : 'chime'})`, then calls `finish()`.
  - `finish()` clears the timer.
  - Add `audio.addEventListener('pause', finish, {once:true})`. Per the HTML spec, a natural end fires `pause` and then `ended`, so this stays idempotent.
  - Add `audio.addEventListener('abort', armFallback, {once:true})`.
- The unmount cleanup clears `activeWatchdogRef`.
- Logger: `createLogger('useNotificationSound')` from `src/lib/client-logger.ts`.

`src/components/fresh-agent/FreshAgentView.tsx`
- Add `surfaceRefreshOwedRef = useRef(false)`.
- In the WS handler near `:3147-3155`, classify the event with a new pure helper `classifyHiddenPaneEvent(message, {busySnapshotSettled})`, which returns `'transcript' | 'surface' | 'none'`. Put it in a new file `src/components/fresh-agent/fresh-agent-event-classes.ts`, together with the two sets moved from `:149-182`.
  - `'transcript'` keeps today's `markSnapshotDirty()` path.
  - `'surface'` while hidden sets `surfaceRefreshOwedRef.current = true`.
  - `'surface'` covers `permission.request`, `permission.cancelled`, `question.request` and `question.cancelled`. Snapshot and status frames that are not busy-settled stay `'none'`, so the pinned behavior at test line 312 is unchanged.
- In the reveal effect (`:2832-2836`): if `surfaceRefreshOwedRef.current` is set, clear it, and if the pane is not snapshot-dirty, call `requestSnapshotRefresh('reveal-surface')`. The new trigger value goes into the `requestSnapshotRefresh` trigger union and the snapshot audit stages.

### 3.2 G11

`src/lib/fresh-agent-registry.ts` gets a new export:

```ts
export function resolveFreshAgentPaneModelDefaults(args: {
  entry: FreshAgentRegistryEntry
  providerSettings?: FreshAgentProviderDefaults
  runtimeProviderModel?: string   // codingCli.providers[runtime].model; PaneContainer only
}): { model: string | undefined; persistModel: boolean; modelEffortLevels?: string[] }
```

- `saved` is `providerSettings.modelSelection.modelId`, trimmed and non-empty.
- `configured`:
  - claude: `saved ?? entry.defaultModel` (decision D1);
  - codex and opencode: `saved ?? runtimeProviderModel ?? entry.defaultModel`, which is today's rule.
- `model` is `normalizeFreshAgentModel(...) ?? configured`.
- `persistModel` keeps today's rule (`provider !== 'opencode' || saved || runtimeProviderModel`).
- `modelEffortLevels` comes from `providerSettings.modelEffortLevels.levels`, but only when the provider is claude and `providerSettings.modelEffortLevels.modelId === model`. The levels are stored paired with their model so a later model change cannot pick up the wrong levels.
- Extend `resolveFreshAgentPaneCreateEffort` with an optional `modelEffortLevels`. It reuses one extracted helper, `clampEffortToStampedLevels(levels, staged)`, which `getEffectiveFreshAgentEffort` (`:201-224`) also switches to.

`src/components/panes/PaneContainer.tsx:706-765`
- Replace the inline model logic (`:712-726`) with the resolver. Spread `modelEffortLevels` into the content when defined, and pass it into `resolveFreshAgentPaneCreateEffort`.

`src/lib/session-type-utils.ts:198-226`
- Replace `model: freshAgentType.defaultModel` with the resolver, called with no `runtimeProviderModel`. Spread `model` when `persistModel` is true, and spread `modelEffortLevels`.

`shared/settings.ts`
- `FreshAgentProviderDefaults` (`:143-148`) and both schemas (`:748-768`) gain `modelEffortLevels?: { modelId: string; levels: string[] }`. The patch schema accepts `null` to clear it.
- `normalizeLegacyFreshAgentProviderDefaultsInput` pick list (`:1270-1272`) and the patch normalizer (`:1005-1037`) carry the new key.
- The Rust settings store deep-merges the `freshAgent` subtree (`crates/freshell-server/src/settings_store.rs:1697`, with no per-field provider validation). Add a Rust round-trip test to prove it is kept, as commit B4.

`FreshAgentModelDialog.tsx:384-391` and `FreshAgentSettingsButton.tsx:186-197,406-409`
- When the provider is claude, also save `modelEffortLevels: {modelId, levels}`, where `levels` is the same array they already stamp on the pane.

### 3.3 G17

- `src/store/selectors/tabAttentionSelectors.ts` (new): memoized with `createSelector`.
  - `selectTabAttentionStyle(state)`.
  - `selectAttentionTabIds(state)`: tab ids, in tab order, whose union mark (`attentionByTab ∪ watchedCompletionByTab`) is set. Empty when the style is `'none'`.
  - `selectTabNeedsAttention(state, tabId)`: style-gated.
  - Re-export `selectTabStripAttention` for TabItem.
- `src/lib/tab-attention.ts` (new):
  - `tabAttentionClassName({needsAttention, style, active, surface: 'tab' | 'card' | 'pill'})`. It is the single owner of the emerald, darken and pulse class tokens.
  - The `'tab'` surface returns exactly TabItem's current strings, from `TabItem.tsx:170-190`.
  - `'card'` uses an emerald border and background, keeping the active ring.
  - `'pill'` is a rounded emerald background for the mobile title.
- `src/components/TabAttentionIndicator.tsx` (new): an emerald dot, optionally with a count.
  - Props are `{count?: number; label: string; className?: string}`.
  - It renders `role="status"` with `aria-label={label}` and `aria-live="polite"`, and nothing when the count is 0.
  - It also has a `variant="dot"` for the chevrons, which renders `aria-hidden` and lets the chevron button's `aria-description`/`title` carry the meaning.
- `src/components/MobileTabStrip.tsx`:
  - Select `selectAttentionTabIds` and the style.
  - Apply the pill class to the title span when the active tab is in the set.
  - Render the indicator ("1 other tab needs attention" / "N other tabs need attention") next to `i / N`.
  - Show dots on prev/next when any attention tab id lies before or after the active index.
  - Keep the existing `aria-label`s so current tests and e2e locators stay stable.
- `src/components/TabSwitcher.tsx`:
  - Apply the card class per card.
  - Add a visible "Needs attention" badge styled like the Busy badge. The final wording is decision D6.
  - Append ", needs attention" to the card's `aria-label`.
  - Card click dispatches the shared thunk below.
- `src/store/turnCompletionAttention.ts`: add a thunk `activateTabFromSurface(tabId)` that dismisses in click mode and then calls `setActiveTab`. Use it in TabBar (`:583-588`), TabSwitcher and `focusTabFromDeck` (`deck-actions.ts:10-15`), and delete the duplicates.
- `TabItem.tsx:168-190`: use `tabAttentionClassName(surface:'tab')`. This is a pure refactor.

### 3.4 G20

Sidecar (`crates/freshell-claude-sidecar/`):
- `session-settings.mjs`: new `foldReportedPermissionMode(session, reported)`.
  - It accepts only freshell's four claude modes (`default | plan | acceptEdits | bypassPermissions`; `shared/settings.ts:40`). On a real change it updates both `session.settings.permissionMode` and `session.permissionMode` (the bypass fast path in `permission-channel.mjs:174-185` reads the latter) and returns `true`.
  - Any other reported mode returns `false`, and the caller logs `warn` with `event:'claude.permission_mode.unsupported'`.
- `index.mjs` `case 'system'` (`:264`): before the subtype branches, if `foldReportedPermissionMode(st, msg.permissionMode)` returns true, emit `{type:'sdk.session.metadata', sessionId, permissionMode: st.settings.permissionMode}`. Document the new frame in the protocol header (`:25-47`).

Rust (`crates/freshell-freshagent/`):
- New `src/claude_permission_update.rs`:
  - `normalize_permission_updates(v: Option<&Value>) -> Option<Vec<Value>>` keeps only well-formed known variants with exactly the documented keys:
    - `addRules`, `replaceRules` and `removeRules`, with `rules:[{toolName, ruleContent?}]`, `behavior ∈ allow|deny|ask` and a destination;
    - `setMode`, with a mode from the SDK `PermissionMode` set;
    - `addDirectories` and `removeDirectories`, with `directories:[string]`.
    - The destination must be one of `userSettings`, `projectSettings`, `localSettings`, `session` or `cliArg`.
    - Unknown variants and keys are dropped, and an empty result becomes `None`. This follows the strict-snapshot lesson behind `normalize_question_definitions` (AGENT-06).
  - `validate_decision(decision: &Value) -> Result<(), String>`: when `updatedPermissions` is present, it must be an array that normalizes to itself.
- `claude.rs`:
  - Add a `suggestions: Option<Vec<Value>>` field to `PendingApprovalEntry` (`:490-523`), filled in the fold (`:9151`) via the normalizer and emitted by `to_json`.
  - `handle_approval_respond` (`:4876-4892`): after the object check, call `validate_decision`. On failure it emits `freshAgent.error{code:'INVALID_APPROVAL_DECISION'}` and keeps the request pending, the same discipline as D2-M3.
  - Consumer fold, next to the `sdk.configured` arm (`:8451`): `Some("sdk.session.metadata")` with a string `permissionMode` updates `session.configuration.settings.permission_mode` and persists the binding settings through the same ledger write the configure path uses. The line keeps being relayed verbatim as `freshAgent.session.metadata`; the table at `:9344` already maps it. Absent `model`/`effort` keys mean "no statement" to the client fold (`freshAgentSlice.ts:275-283`).
  - Log `info` with `freshagent.claude.permission_mode_reported` (session id and mode).

Shared contract (`shared/fresh-agent-contract.ts`)
- Add `FreshAgentPermissionUpdateSchema`, a strict discriminated union that mirrors the Rust normalizer.
- `FreshAgentPendingApprovalSchema` gains `suggestions: z.array(FreshAgentPermissionUpdateSchema).optional()`.

Client
- `src/lib/fresh-agent-ws.ts:384-393`: pass `permissionMode` through. `freshAgentSlice.sessionMetadataReceived` (`:255-290`) stores `session.permissionMode` (string, or null for a clear). `FreshAgentSessionState` (`freshAgentTypes.ts:92-110`) gains the field.
- `src/lib/fresh-agent-permission-updates.ts` (new, pure):
  - `describePermissionUpdate(update, {cwdLabel})` returns plain-language text.
  - `rememberLabel(updates)` returns "Allow and don't ask again", or "Allow and auto-accept edits" when the only update is `setMode acceptEdits`.
  - `buildAllowDecision(updates?)`, `buildDenyDecision(message?)`, `buildPlanDecision(choice, feedback?)`.
- `FreshAgentApprovalCard.tsx`:
  - New props `onAllowWithUpdates?(updates)` and an optional `onAlwaysAllow`. The client-only button renders only when the caller provides `onAlwaysAllow`.
  - Show the remember button plus the description list when `approval.suggestions?.length`.
  - Route `toolName === 'ExitPlanMode'` to the new `FreshAgentPlanApprovalCard.tsx`. It uses `FreshAgentMarkdownBody` (`FreshAgentItemCard.tsx:338`), is `role="alert"` with `aria-label="Plan approval request"`, and keeps the touch targets of at least 44 px from the existing classes.
- `FreshAgentView.tsx`:
  - `respondToApproval` takes a decision built by the helpers.
  - For `provider==='claude'`, do not pass `onAlwaysAllow`, and skip the `alwaysAllowToolsRef` effect (`:4131-4154`). Gate the effect on `provider !== 'claude'` so a claude approval is never auto-answered on the client.
  - New effect: when `agentSession.permissionMode` is a string different from `paneContent.permissionMode`, dispatch `mergePaneContent({permissionMode})`. Never call `saveServerSettingsPatch` from it.
- `src/deck/deck-actions.ts` `sendDeckApproval`: use `buildAllowDecision()` so there is one decision builder. The behavior is unchanged.

### 3.5 G25

Rust:
- New `crates/freshell-freshagent/src/attention_ledger.rs`, provider-agnostic and populated only by claude in this workstream:

```rust
pub struct AttentionLedger { inner: std::sync::Mutex<Inner> }   // no await while held
pub struct AttentionMark { pub session_id: String, pub session_type: String,
    pub last_turn_complete_at: Option<i64>, pub last_waiting_at: Option<i64> }
impl AttentionLedger {
  pub fn with_capacity(cap: usize) -> Self;           // LRU by last touch; default 4096
  pub fn observe(&self, id: &str, session_type: &str); // create / resume registration
  pub fn record_turn_complete(&self, id: &str, at: i64); // max()
  pub fn record_waiting(&self, id: &str, at: i64);       // max()
  pub fn clear_waiting(&self, id: &str);                 // pending reached 0
  pub fn alias(&self, from: &str, to: &str);             // envelope id flip; copies marks
  pub fn forget(&self, id: &str);                        // requested kill
  pub fn snapshot(&self) -> Vec<AttentionMark>;
}
```

- `FreshClaudeState` owns `attention_ledger: Arc<AttentionLedger>`. The calls go in these places:
  - `observe`: `handle_create` after `FreshAgentCreated` (`:1894` and the sibling create broadcasts at `:2686`, `:2787`), and in cold-resume registration (`resume_for_attach`, `:7033`).
  - `record_turn_complete` and `record_waiting`: at the single claude edge choke point (section 7, I-1). For forwarded edges that is in the stdout consumer before `broadcast_tx.send` (`:8708-8725`), reading `value["at"]`. For Rust-minted edges it is the death mint (`:8832-8859`) and core's future deadman mint (G07).
  - `clear_waiting`: after `fold_pending_frame` and after the respond handlers remove an entry, whenever `permissions` and `questions` are both empty.
  - `alias(old, durable)`: in `try_rebind_to_live` (`:7009`) and anywhere else the envelope id changes (I-2).
  - `forget`: in `handle_kill`'s success path.
  - `pub fn attention_marks(&self) -> Vec<FreshAgentAttentionMark>` maps `snapshot()` to the protocol type with `provider:"claude"`.
- `crates/freshell-protocol/src/server_messages.rs`:
  - `ReadyCapabilities.fresh_agent_attention_replay_v1: Option<bool>`.
  - `Ready.fresh_agent_attention: Option<Vec<FreshAgentAttentionMark>>` (camelCase: `freshAgentAttention`, `lastTurnCompleteAt`, `lastWaitingAt`; `skip_serializing_if` None).
- `crates/freshell-ws/src/lib.rs`:
  - Parse `hello.capabilities.freshAgentAttentionReplayV1`, next to the others at `:899-947`.
  - Refactor first: replace the seven positional booleans of `build_handshake_with_capabilities` (`:634-643`) with a `HandshakeCapabilities` struct.
  - When the client opted in, set `fresh_agent_attention = Some(state.fresh_claude.attention_marks())`, or `None` when empty, and echo the capability.
  - Log `debug` with `ws.handshake.attention_marks` and a count.
  - The ordering guarantee comes from the existing subscribe-before-handshake order (`:857-860`).

Shared and client:
- `shared/ws-protocol.ts`: `HelloSchema` capabilities (`:438` and `:1188`) gain `freshAgentAttentionReplayV1: z.literal(true).optional()`. `ReadyMessage` gains `freshAgentAttention?`.
- `src/lib/ws-client.ts:553-562`: advertise `freshAgentAttentionReplayV1: true`.
- `src/lib/ready-message-schema.ts`: add `freshAgentAttention: z.array(z.object({provider, sessionId, sessionType?, lastTurnCompleteAt: z.number().finite().optional(), lastWaitingAt: z.number().finite().optional()})).optional().catch(undefined)`.
- `src/store/turnCompletionSlice.ts`: new reducer `advanceCompletionBaseline({terminalId, at})`. It sets `lastAtByTerminalId[terminalId] = max(existing ?? -Infinity, at)` and never queues an event.
- `src/store/turnCompletionThunks.ts`:
  - Extract `completionDedupeKey(provider, id)` and `waitingDedupeKey(provider, id)`, which are today's inline strings.
  - `applyFreshAgentCompletion` and `applyFreshAgentWaiting`: when no pane matches, dispatch `advanceCompletionBaseline`. An edge this page observed without a pane can never be replayed later.
  - New thunk `observeFreshAgentSession({provider, sessionId})`: for both keys, if the key is unknown, set its baseline to 0.
  - New thunk `foldReadyFreshAgentAttention(marks)`. For each mark and each kind:

```
known = lastAtByTerminalId[key]
if known === undefined -> advanceCompletionBaseline(key, at ?? 0)  // first observation: never replay
else if at !== undefined && at > known -> log.info('fresh_agent_attention_replayed', {key, at}); apply<Kind>({provider, sessionId, at})
```

  - Rewrite the stale doc comments (`:92-97,128-133`).
- `src/lib/fresh-agent-ws.ts`: `freshAgent.created` (`:178-207`) dispatches `observeFreshAgentSession` before `sessionCreated`. `freshAgent.session.snapshot` (`:361-371`) dispatches it too.
- `src/App.tsx:1358-1369`: after `resetCompletionDedupeBaselines` (when it runs) and `foldReadyRuntimeOwners`, dispatch `foldReadyFreshAgentAttention(ready.data.freshAgentAttention)`.
- `AGENTS.md` "Agent Status Indicators": add one sentence. A reconnect replays unwitnessed claude edges from `ready.freshAgentAttention` above the page's high-water mark; a reload or first connect seeds and never replays.

Part 2 (restart notice): specified in section 7, I-5. The client already renders `freshAgent.error` codes through `sessionError` (`fresh-agent-ws.ts:518-532`). The only client work is one unit test pinning that `TURN_INTERRUPTED_BY_RESTART` shows the banner and records no attention event.

---

## 4. Ordered TDD commits

Rules for every commit:
- Write the failing test first and run it to see it fail for the right reason.
- Then make the smallest change that passes, then refactor.
- Commit with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Unit commands: `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`.
- Rust commands: `cargo test -p <crate> <filter>`.

### PR-A (G26 and G11)

A1 (red, then green). The ring watchdog releases a wedged chime. `test/unit/client/hooks/useNotificationSound.test.tsx`:
- (a) An Audio that never emits `ended`: after two `play()` calls and advancing `RING_WATCHDOG_MS`, a second `Audio` is constructed. The logger spy shows one `warn` with `notification_ring_watchdog_fired`.
- (b) After normal `ended` at 1 s, advancing to 5.5 s constructs no extra Audio. This proves the timer is cleared.
- (c) Unmounting with a pending watchdog does not drain after unmount.

A2 (red, then green). `pause` releases the queue and `abort` plays the fallback. Same file:
- Emitting `pause` starts the next ring at once.
- Emitting `abort` invokes the oscillator path, once, and the queue continues.

A3 (refactor). Name the ring lifecycle (`createRingAttempt`) inside the hook, with no behavior change. All the useNotificationSound tests must stay green.

A4 (red, then green). A hidden pane owes a non-blocking refresh for approvals and questions. `test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`:
- Setup: a hidden claude pane whose snapshot has revision 5 and no approvals.
- A WS `freshAgent.permission.request` arrives: there is no fetch while hidden.
- The snapshot mock then returns revision 5 with one pending approval, and the test sets `hidden=false`.
- Expect exactly one snapshot fetch, `role="alert"` with the name "Permission request for Bash" visible, and no "Refreshing conversation" status.
- Repeat for `question.request` and for a `permission.cancelled` that removes a visible card.
- The existing status-only test (`:312`) stays green.

A5 (refactor). Extract `classifyHiddenPaneEvent` and the two event sets into `fresh-agent-event-classes.ts`, with a table-driven unit test over every event type: transcript, surface or none.

B1 (red, then green). New panes honor the saved claude default. `PaneContainer.createContent.test.tsx`:
- A saved `freshclaude.modelSelection {kind:'exact', modelId:'sonnet'}` gives `content.model === 'sonnet'` and the matching `modelSelection`.
- The same for `kilroy` with the feature flag on.
- With nothing saved, `'opus[1m]'`.
- Codex and opencode cases unchanged: the existing tests at `:423-481` stay green.

B2 (red, then green). Resume honors the saved default. `test/unit/client/lib/session-type-utils.test.ts`:
- `buildResumeContent({sessionType:'freshclaude', freshAgentProviderSettings:{modelSelection:{…'sonnet'}}})` gives `model: 'sonnet'`.
- No settings gives `opus[1m]`; kilroy likewise.
- Codex with a saved `gpt-5.6-luna` gives `'gpt-5.6-luna'` (decision D2).

B3 (refactor). Introduce `resolveFreshAgentPaneModelDefaults` and use it in both call sites, deleting the inline logic. Add a unit test of the resolver's precedence table in `test/unit/client/lib/fresh-agent-registry.test.ts`.

B4 (red, then green). The saved levels travel with the saved model.
- `test/unit/shared/settings.test.ts`: the provider-defaults patch round-trips and clears `modelEffortLevels` (`null`).
- Dialog and popover tests: a claude commit saves `{modelId, levels}` (`FreshAgentModelDialog.test.tsx`, `FreshAgentSettingsButton.test.tsx`).
- PaneContainer: a saved catalog-only `claude-haiku-x` with levels `[]` gives `content.modelEffortLevels === []`, and the create frame (asserted through FreshAgentView's create send) carries no `effort`.
- A mismatched pair (levels for model X, selection for Y) is ignored.
- Rust `settings_store` test: a PATCH then GET keeps `freshAgent.providers.freshclaude.modelEffortLevels`.

B5 (refactor). Extract `clampEffortToStampedLevels` and use it in both `getEffectiveFreshAgentEffort` and `resolveFreshAgentPaneCreateEffort`. Existing effort tests stay green.

B6 (e2e). New `test/e2e-browser/specs/freshagent-default-model-rust.spec.ts`, using the fake claude sidecar lane from `fresh-agent-control-rust.spec.ts:541` `bootClaudeLane` and its stdin log:
- PATCH `/api/settings` to save the `sonnet` default.
- Create a Freshclaude pane through the picker: the stdin `create.model` is `'sonnet'`.
- Resume that session from the sidebar into a new pane: the `create` carries `resumeSessionId` and `model:'sonnet'`.
- Repeat for kilroy on the `KILROY_ENABLED` gate.

### PR-B (G17)

C1 (red, then green). Selectors. `test/unit/client/store/tabAttentionSelectors.test.ts`:
- Tab order is respected.
- The set is the union of attention and watched marks.
- Style `'none'` gives an empty set.
- The result is memoized (same reference while inputs are unchanged).

C2 (red, then green). `TabAttentionIndicator.test.tsx`:
- A count of 2 gives a status named "2 other tabs need attention".
- A count of 0 renders nothing.
- The dot variant is `aria-hidden`.

C3 (red, then green). `MobileTabStrip.test.tsx` (store gains a `turnCompletion` slice):
- When the active tab has attention, the title carries the pill class.
- Attention on two other tabs gives the status "2 other tabs need attention".
- Attention only on a later tab gives the next-chevron dot and no prev dot.
- Watched-only marks count as marks.
- Style `none` shows nothing.
- The existing tests stay green, with unchanged labels.

C4 (red, then green). `TabSwitcher.test.tsx`:
- A card with attention has the "Needs attention" badge and an accessible name ending ", needs attention".
- In click mode, tapping the active card clears `attentionByTab` and the pane flags.
- In type mode it does not.
- Tapping an inactive card with attention activates it and clears it.
- The existing "closes without changing tab when tapping the active tab card" still passes.

C5 (refactor). Move `activateTabFromSurface` into `turnCompletionAttention.ts` and use it in TabBar, TabSwitcher and the deck. TabItem uses `tabAttentionClassName('tab')`. Gates: `TabItem.test.tsx:107-160`, `TabBar.test.tsx`, deck tests and `turnCompletionAttention.test.ts` (with a new case for the thunk).

C6 (e2e). New `test/e2e-browser/specs/fresh-agent-mobile-attention.spec.ts`, at viewport 390×844, cloud-legal on the program-lane pattern of `fresh-agent-error-turn-attention.spec.ts`:
- Tab A is freshclaude. It sends a turn whose completion has `delayMs: 3000`.
- The user goes to tab B with "New tab" on the strip.
- When the edge lands: the status "1 other tab needs attention" appears and the prev chevron has a dot.
- Open the switcher: the card named "Switch to … needs attention" is visible. Tap it: tab A is active and `turnCompletion.attentionByTab` is empty.
- An approval raise (the `waiting` edge) in a background tab produces the same mark.

C7 (docs). Update the mobile comment in `docs/index.html:86-92` to mention the attention marks. No README change.

### PR-C (G20)

D0 (contract pin, written first, green on arrival). New `test/integration/providers/claude-permission-contract.mjs` and `.test.ts`, following the pattern of `claude-checkpoint-uuid-replay.*` and adapted from `perm-probe/probe-perm.mjs`. It pins the CLI behavior the UI relies on:
- the suggestion shapes for Bash, Write and Read outside cwd;
- that `localSettings` writes `.claude/settings.local.json` and suppresses the next prompt;
- that `session` suppresses without a file;
- that ExitPlanMode's `input.plan`/`planFilePath` come from the plan file;
- that `system/status.permissionMode` is `default`/`acceptEdits`/`bypassPermissions` after the three plan approvals.

It is a characterization test of an external dependency. It must fail if a CLI upgrade changes any of these.

D1 (red, then green). The sidecar folds the reported mode.
- `test/unit/claude-sidecar/session-settings.test.ts`: `foldReportedPermissionMode` covers change, no change, an unsupported mode and a missing mode.
- New `test/unit/claude-sidecar/permission-mode-report.test.ts`, running the real `index.mjs` through the `FRESHELL_CLAUDE_SDK_QUERY_MODULE` seam (fixture `fixtures/permission-mode-query-module.mjs`):
  - a scripted `system/status {permissionMode:'acceptEdits'}` gives exactly one `sdk.session.metadata{permissionMode:'acceptEdits'}`;
  - a repeat gives none;
  - a later `system/init{permissionMode:'acceptEdits'}` gives none.
  - Also through the seam: a parked `canUseTool` resolves with the exact `updatedPermissions` sent in `permission.respond`. This pins that suggestions travel both ways.

D2 (red, then green). Rust normalizer unit tests in `claude_permission_update.rs`:
- each known variant is kept byte-for-byte;
- an unknown `type`, a bad destination or a bad mode is dropped;
- extra keys are stripped;
- an empty list gives `None`;
- `validate_decision` accepts a missing list, an empty list and valid lists, and rejects scalars and unknown variants.

D3 (red, then green). Suggestions reach the snapshot. In `claude.rs` tests, next to the existing pending-overlay tests: fold an `sdk.permission.request` with `suggestions` and assert the snapshot's `pendingApprovals[0].suggestions` equals the normalized list. Also `shared/fresh-agent-contract` tests: a snapshot with suggestions parses, and a malformed suggestion fails the strict parse. This pins why the Rust normalizer exists.

D4 (red, then green). Respond validation. Extend `crates/freshell-ws/tests/freshagent_control_reply.rs`:
- A well-formed `updatedPermissions` is written verbatim to the fake sidecar's stdin.
- A malformed one gets `freshAgent.error{code:'INVALID_APPROVAL_DECISION'}`, nothing is written, and the request stays pending (a retry with a valid decision succeeds).

D5 (red, then green). The Rust mode fold. A `claude.rs` test sends the fake stdout line `sdk.session.metadata{permissionMode:'default'}`. Expect:
- `session.configuration.settings.permission_mode == Some("default")`;
- `freshAgent.session.metadata` relayed with that mode;
- the REST snapshot's `settings.permissionMode` is `default`;
- the identity-sink binding records the new mode. The fake sink captures `record_binding`.

D6 (red, then green). Client slice and WS pass-through.
- `freshAgentSlice.test.ts`: metadata with `permissionMode` sets `session.permissionMode`; an absent key keeps it.
- `fresh-agent-ws.test.ts`: the field is passed through.

D7 (red, then green). The pane converges to the live mode. `FreshAgentView.test.tsx`:
- A pane in `plan` receives a metadata event with `permissionMode:'default'`. The pane content becomes `default`, `saveServerSettingsPatch` is not called, and the next `freshAgent.send` carries `settings.permissionMode:'default'`.

D8 (red, then green). Native remember on the card. `FreshAgentApprovalCard.test.tsx`:
- Plain-language lines for addRules in localSettings, addRules in session, setMode acceptEdits and addDirectories.
- The remember click calls `onAllowWithUpdates` with exactly `approval.suggestions`.
- No suggestions means no remember button.
- The client-only button renders only when `onAlwaysAllow` is passed, with the label "Always allow Bash in this pane".
- Plus `test/unit/client/lib/fresh-agent-permission-updates.test.ts` for the describe and label helpers and the decision builders.

D9 (red, then green). Plan card. New `FreshAgentPlanApprovalCard.test.tsx`:
- The markdown heading from `input.plan` renders as a heading, and `planFilePath` is shown.
- Each action produces the exact decision:
  - "Approve plan": `{behavior:'allow'}`;
  - "Approve and auto-accept edits": `updatedPermissions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]`;
  - "Approve and stop asking for permission": `bypassPermissions`;
  - "Keep planning" with feedback text: `{behavior:'deny', message:<text>, interrupt:false}`; without text, the default message.
- An empty input shows the "No plan text was provided" copy.
- Touch targets have at least 44 px classes.

D10 (red, then green). View wiring. `FreshAgentView.test.tsx`:
- A claude approval with suggestions plus a remember click sends `freshAgent.approval.respond` with `decision.updatedPermissions` equal to the suggestions.
- A second claude approval for the same tool is not auto-answered. No respond goes out without a click; this is the regression for removing the client bypass.
- A codex approval plus the pane-scoped "Always allow" auto-answers the second one, so the client-only codex coverage is kept.
- An ExitPlanMode approval renders the plan card, not the generic card.

D11 (refactor). `sendDeckApproval` and `respondToApproval` both use `buildAllowDecision`/`buildDenyDecision`. Delete the claude path through the client-only ref. Deck tests stay green.

D12 (e2e). Edit `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`. The fake fixture changes are in section 7, I-3.
- Rewrite the claude test "Always Allow answers the second raise without a click" (`:884-918`) as "Allow and don't ask again sends the CLI's suggestions and never auto-answers on the client". It asserts that:
  1. the `permission.respond` stdin frame carries `updatedPermissions` equal to the program's suggestions;
  2. a second raise renders a card and produces no respond until clicked.
  This is a deliberate behavior replacement; the old assertion encoded the misleading bypass.
- Add a codex-lane test, "Always allow (pane) auto-answers the second raise", so coverage of the kept codex behavior moves rather than drops.
- Add "plan approval: plan renders, Approve and auto-accept edits sends setMode, pane mode converges to Accept edits". The fake answers a setMode decision with `sdk.session.metadata{permissionMode}`, as the probe verified, and the spec asserts the settings popover now shows "Accept edits".
- Add "a kilroy approval with suggestions" on the `KILROY_ENABLED` gate.

D13 (docs). One sentence in `README.md:126`: "Allow and don't ask again" saves Claude's suggested rule (project rules go to `.claude/settings.local.json`), and plan-mode exits show the plan with approval choices.

### PR-D (G25)

E1 (red, then green). Ledger unit tests in `attention_ledger.rs`:
- `max` semantics for both kinds;
- `clear_waiting` keeps `last_turn_complete_at`;
- `alias` copies marks;
- `forget`;
- LRU eviction at capacity;
- the snapshot shape.

E2 (refactor, then red, then green). The handshake capabilities struct.
- Refactor `build_handshake_with_capabilities` to take `HandshakeCapabilities`. Every existing handshake test, including `crates/freshell-ws/tests/hello_capabilities.rs`, stays green.
- Then, red first, in `hello_capabilities.rs`: with `freshAgentAttentionReplayV1`, `ready.capabilities.freshAgentAttentionReplayV1 === true`; without it, neither the capability nor `freshAgentAttention` appears on the wire. This keeps the frozen client inert.

E3 (red, then green). Claude records its edges. In `claude.rs` tests with an inline fake sidecar:
- A forwarded `sdk.turn.complete{at:T}` gives `attention_marks()` containing the stamp with `lastTurnCompleteAt=T`.
- `sdk.turn.waiting{at:W}` gives `lastWaitingAt=W`, and after the respond removes the last pending entry, `lastWaitingAt` is absent.
- An unrequested death mid-turn gives the death-mint `at` recorded under the stamp, even though the session is evicted.
- `handle_kill` gives no entry.
- A rebind by durable id lists both ids.
- Create and cold resume list the session with no marks.

E4 (red, then green). WS-level replay. New `crates/freshell-ws/tests/freshagent_claude_attention_replay.rs`, with the harness copied from `freshagent_claude_attach.rs` per that file's convention:
1. Socket A (opted in) creates a session and sends; the fake emits `sdk.turn.complete{at}`.
2. Socket A sees the live edge.
3. A new socket B (opted in) gets `ready.freshAgentAttention` containing `{provider:'claude', sessionId, lastTurnCompleteAt: at}` before any other frame.
4. A waiting edge plus a respond means a socket C's ready has no `lastWaitingAt`.

E5 (red, then green). Client baseline and replay semantics.
- `turnCompletionSlice.test.ts`: `advanceCompletionBaseline` never lowers a baseline and never queues an event.
- `turnCompletionThunks` tests (new `turnCompletion.replay.test.ts`):
  - (a) a first-ready fold with marks seeds and queues nothing;
  - (b) a later fold with a higher `lastTurnCompleteAt` queues exactly one fresh-agent event, with the receipt middleware stamping `watched` from focus and active tab;
  - (c) an equal `at` queues none;
  - (d) a waiting mark replays into the `#waiting` namespace;
  - (e) after `resetCompletionDedupeBaselines` the fold seeds again with no replay, which is the restart case;
  - (f) `freshAgent.created` then a fold with an `at` replays, which is the case of a turn ending in a pane created after the last ready;
  - (g) a live edge for a session with no pane advances the baseline, so a later fold does not replay it;
  - (h) a malformed `freshAgentAttention` parses to `undefined` through `ReadyMessageSchema` and folds nothing.

E6 (red, then green). App wiring. Extend the existing App ready tests (the ones that cover `resetCompletionDedupeBaselines`) to drive real `ready` frames through the App handler:
1. First ready with a mark: no event.
2. A reconnect ready with the same `bootId` and a higher mark: one event and `attentionByTab[tab]` set.
3. A ready with a new `bootId`: no event.

E7 (refactor). `completionDedupeKey`/`waitingDedupeKey`. Rewrite the stale comments. Add the AGENTS.md sentence.

E8 (e2e). New `test/e2e-browser/specs/fresh-agent-attention-reconnect-rust.spec.ts`. It uses the claude fake-sidecar lane plus the `routeWebSocket` gate pattern from `recover-my-panes-rust.spec.ts:1921-1960`:
1. Tab A is freshclaude. Send a turn with `delayMs: 4000` and move to tab B.
2. Black-hole the WS: block, then close the live socket.
3. Wait for the fake's wire ledger to show `sdk.turn.complete`. While the socket is down, `turnCompletion.seq` is unchanged.
4. Unblock and wait for the next ready. Expect `turnCompletion.seq` +1 exactly, `attentionByTab[A]` set, and the sidebar row highlighted.
5. Reload the page. Expect `seq === 0` and no attention, which pins the no-replay-on-reload rule.

Cloud-legal: there is no idle-grace timing, and every wait is a poll on observed state.

E9 (client test for part 2, on core's frame). Extend `fresh-agent-ws.test.ts`: `freshAgent.error{code:'TURN_INTERRUPTED_BY_RESTART'}` sets the pane banner and records no `turnCompletion` event. This lands with or after core's server change (I-5).

---

## 5. Test plan

| Layer | New or changed tests | Lane |
|---|---|---|
| Client unit | useNotificationSound (watchdog, pause, abort, unmount); fresh-agent-event-classes; FreshAgentView.hidden-rebind (surface refresh); PaneContainer.createContent (claude, kilroy, levels); session-type-utils (resume); fresh-agent-registry resolver; settings normalizer; model dialog and popover save; tabAttentionSelectors; TabAttentionIndicator; MobileTabStrip; TabSwitcher; turnCompletionAttention thunk; TabItem regression; FreshAgentApprovalCard; FreshAgentPlanApprovalCard; fresh-agent-permission-updates; FreshAgentView (remember, no client bypass for claude, codex bypass kept, plan routing, mode convergence); freshAgentSlice; fresh-agent-ws; turnCompletion slice, thunks and replay; App ready fold | `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`; the full coordinated `pnpm run test` before each PR |
| Sidecar unit and real process | session-settings fold; permission-mode-report through the real `index.mjs` with a fake query module; suggestion round trip | same Vitest lane (`test/unit/claude-sidecar`) |
| Real CLI contract | `test/integration/providers/claude-permission-contract.test.ts` (pinned CLI against a local fake endpoint) | same lane as `claude-checkpoint-uuid-replay.test.ts` |
| Rust unit | claude_permission_update normalizer; attention_ledger; claude.rs (suggestions in snapshot, respond validation, mode fold and persistence, ledger recording, death mint, alias and forget); settings_store round trip | `cargo test -p freshell-freshagent`, `-p freshell-server` |
| Rust integration (WS) | hello_capabilities (opt-in and inertness); freshagent_control_reply (updatedPermissions forwarded or refused); new freshagent_claude_attention_replay | `cargo test -p freshell-ws`; `rust-gate` on the PR |
| Browser e2e | freshagent-default-model-rust; fresh-agent-mobile-attention; fresh-agent-control-rust (rewritten claude remember test, codex pane-scoped bypass, plan approval and mode convergence, kilroy suggestions); fresh-agent-attention-reconnect-rust (replay plus no replay on reload) | `pnpm run test:e2e` on the configured `FRESHELL_E2E_BACKEND`. None of these specs may join `CLOUD_SKIP_SPECS`. Every affected spec must pass on that backend before filing. |

Coverage notes:
- The removed claude client-bypass assertion is replaced by a stronger one: suggestions are sent, and the client does not auto-answer. Coverage of the kept codex bypass moves to the codex lane. Nothing is skipped.
- Every new test drives behavior: DOM roles and names, wire frames, store state, stdin frames or CLI files. None asserts on prose or config text.

---

## 6. Risks and mitigations

1. Strict snapshot schema. A malformed or unknown suggestion would fail the whole snapshot parse and hide every card, which is the AGENT-06 class of bug. Mitigation: Rust normalizes to known variants before the snapshot, the client schema mirrors the Rust normalizer, and D3 pins the failure mode. Client and server ship together, and the build-id reload covers a mismatched client.
2. Writing into the user's project. "Allow and don't ask again" can write `<cwd>/.claude/settings.local.json` when the CLI suggests `localSettings`. Mitigation: the card spells out the destination per suggestion before the click, and the README notes it. Session-scoped suggestions write nothing.
3. Mode-sync races:
   - A metadata event could land between a local popover change and its configure. The sidecar applies configure synchronously before the next status, so the order is preserved.
   - A send in the same frame as a convergence could carry the old mode and re-enter it. The window is one render, the pane converges again on the next report, and the e2e covers the main path.
   - Configure-driven mode changes on device A still do not reach device B. That is a pre-existing gap and is left out of scope.
4. Unsupported modes. The CLI can report `dontAsk` or `auto`, which freshell does not expose. The fold ignores them and logs a warning, so the pane keeps its mode.
5. G25 dedupe-key drift. Claude's envelope id flips from the placeholder to the durable id on a cross-device rebind (G16). A flip during a disconnect can make one edge seed instead of replay, which is a missed ring, never a false one. `alias` narrows this, and G32 (core) removes it by making the durable id the envelope id from the start.
6. G25 pre-load safety. A reload resets and then seeds, the restart path does the same, and E5(a,e), E6 and E8 pin it. Server time is the only clock compared; client clocks are never compared with server `at` values, so device clock skew cannot cause a false replay or a missed one.
7. G25 memory. The ledger is a bounded LRU (4096 entries of about 100 B). Eviction can only lose a replay, never cause a false one.
8. Watchdog overlap. A slow chime that is merely delayed (for example a stalled fetch) can overlap the next ring after 5 s. This is better than permanent silence, and it is logged at `warn`.
9. Extra fetches on reveal. At most one per reveal, and only when an approval or question event arrived while the pane was hidden.
10. Behavior changes outside claude:
    - Codex resume now honors the saved codex default (D2).
    - The codex "Always allow" label changes (D3).
    - The ring watchdog and mobile marks are shared and apply to every provider.
    - Reconnect replay is claude-only until approved for others (D5).

---

## 7. Interfaces needed from the core-runtime workstream

- I-1: one claude edge choke point (touches G14, G24, G07, G05).
  - Every claude `freshAgent.turn.complete` and `freshAgent.turn.waiting` should go through one method: `FreshClaudeState::emit_attention_edge(kind, stamp, sidecar_session_id, session_type, at, source)`. That covers forwarded sidecar edges, the death mint, and the future deadman and crash edges.
  - Core adds logging (G14) and shared-clock seeding (G24) inside it. This workstream adds `attention_ledger.record_*`.
  - Whichever workstream lands first creates the method, and the other extends it.
  - Until the method exists, E3 hooks the two existing sites directly (`claude.rs:8708-8725`, `8832-8859`).
- I-2: envelope id changes (G16, G32).
  - Anywhere `broadcast_id` changes (`try_rebind_to_live`, rollback re-key or materialize), call `attention_ledger.alias(old, new)`.
  - If G32 makes the durable UUID the envelope id from the first frame, `alias` becomes a no-op and can be deleted.
- I-3: fake sidecar fidelity (G04).
  - The e2e needs the fake sidecar's `approval` lane to forward `data.suggestions`, `data.blockedPath` and `data.decisionReason` in `sdk.permission.request`.
  - It also needs a way to emit `sdk.session.metadata{permissionMode}`. Either a `mode` emission kind, or respond-arm behavior that mirrors the CLI as verified in D0: a setMode decision reports its mode, and a plain ExitPlanMode allow reports `default`.
  - If G04 replaces the fake with the real `index.mjs` plus a fake query module or fake endpoint, D12 and E8 run on that instead, which is preferred.
  - The D0 contract test is the source of truth the fake must mirror.
- I-4: busy and status truth (G05, G21, G23). Nothing in this plan depends on them. Their status frames improve G17's Busy and attention display, but the attention edges stay outcome-uniform.
- I-5: restart notice (G25 part 2), proposed for core because it shares the shutdown and ledger code with G05.
  - In `FreshClaudeState::shutdown` (`claude.rs:1828`), before draining, collect sessions where `in_turn` is set and that have a durable id. Persist an `interrupted_by_restart{at}` marker through the identity sink: a new awaited `PaneIdentitySink` method with a short bounded timeout.
  - On the next cold resume of that durable id (`resume_for_attach`, handoff resume), broadcast after the ack: `freshAgent.error{code:'TURN_INTERRUPTED_BY_RESTART', message:'The server restarted while this turn was running. The turn was stopped. Send a message to continue.'}`. Then clear the marker.
  - No turn-complete edge, because a server restart is a requested teardown under AGENTS.md.
  - Client contract: rendered by the existing `sessionError` banner path, pinned by E9.
- I-6: G12 overlap. This plan takes the "plan-mode changes" part of G12: the sidecar `permissionMode` fold and the `sdk.session.metadata` relay. Whoever owns G12 should not duplicate it.

---

## 8. Decisions for the user (PM)

- D1: For Freshclaude/Kilroy, should a new pane fall back to the terminal Claude CLI's model setting (`codingCli.providers.claude.model`, set in Extensions) when no fresh-pane default is saved?
  - Recommendation: no. Use the saved fresh-pane default, then Opus 1M. The fresh panes have their own picker that saves a default, and this keeps new and resumed panes identical.
  - The audit suggested yes, for parity with codex. Codex and opencode keep their current fallback either way.
- D2: Resumed panes start on the saved default model, not the model the conversation last used. This matches `claude --resume`.
  - Side effect: codex resume now also honors the saved codex default, where today it is always GPT-6 Astra.
  - Recommendation: accept.
- D3: Codex's client-only "Always allow" button. Recommendation: keep its behavior and fix the label to "Always allow <Tool> in this pane" with the tooltip "Until this pane reloads". The alternative is to leave it untouched.
- D4: Plan-card choices and wording. Proposed: "Approve plan", "Approve and auto-accept edits", "Approve and stop asking for permission", and "Keep planning" with an optional note. Should the bypass option exist? Freshclaude's default mode is bypass, so recommendation: yes.
- D5: Reconnect replay for Freshcodex/Freshopencode. The ledger and the client are provider-neutral, but this plan populates it for claude only, per the "no new codex/opencode features" scope. Extending it is a small follow-up that needs approval.
- D6: The mobile badge wording, "Needs attention" and "N other tabs need attention".

---

## 9. Observations out of scope (not planned)

- `MobileTabStrip` and `TabSwitcher` titles use `getTabDisplayTitle`, while desktop uses `selectTabDisplayTitles` (unified agent names, `TabBar.tsx:243-266`). Mobile can therefore show a different tab title than desktop for session-owned tabs.
- Sidebar rows ignore `tabAttentionStyle: 'none'` (`Sidebar.tsx:1143`), while every tab surface honors it.
- The OS-level escalation (Web Notification or a title flash while the page is hidden) remains open under kata 1wyr.
- Multi-device convergence of a user-initiated permission-mode change (the configure path) is not broadcast. See risk 3.
