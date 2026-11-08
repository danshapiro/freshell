# Content Spec — what every fresh-agent redesign comp must render

This is a **comparative study**: all 6 designs render the SAME session content so the differences are pure design. Use the copy below verbatim (trim only where noted). This is an "Operate" surface: a developer's daily coding-agent console.

## Product background (context, do not copy into the comp)

Freshell is a self-hosted, browser-based terminal multiplexer. Its **fresh-agent panes** embed coding agents directly (no terminal): **freshclaude** (Claude), **kilroy** (also Claude runtime, playful hidden flag), **freshcodex** (Codex), **freshopencode** (OpenCode). The pane shows a chat-like transcript of turns; tools render inline; approvals/questions arrive as cards; messages are snapshot-driven. The redesign shows the full intended feature set — some features don't exist yet and are marked **soon**.

Provider identity cues (may be restyled per design, keep the hue families):
- freshclaude — Claude coral/clay (`#c15a3c` neighborhood)
- kilroy — same coral family, quirky mascot wink (the "Kilroy was here" peeker)
- freshcodex — near-black/graphite
- freshopencode — teal/spruce

---

## The shared session

- Agent: **freshclaude** · model **Claude Opus 4.6** · effort **High** · permission mode **Ask** (default)
- Title (auto-derived): **"Trace dropped messages on background tabs"**
- cwd `~/code/freshell` · branch `fix/ws-reconnect` · 2 files modified
- Context: **118,200 / 200,000 (59%)** · Session cost **$1.38** · burn **$3.45/h** · 24m elapsed · 84.2k in / 9.6k out tokens
- Session id `01JRV6…KQ3M` · started 14:02 · live (busy when indicated)

## Structure to render

### A. Page masthead (top of the comp page itself)
The design's NAME + one-line thesis, typeset IN the design language (this doubles as its display-type sample). Below it, a utility strip (plain, small): "Design N of 6 · fresh-agent UX study · Freshell" and a link "← all designs" to `/`.

### B. Desktop app frame (~1440px wide)
A browser-window-ish frame containing the Freshell shell:

1. **Tab strip** (top): active tab "⚡ Trace dropped messa…" with busy indicator; second tab "⌨ npm run dev" (terminal); third tab "◉ Scrollback parser" with GREEN needs-attention dot; "+" affordance. Show the design's tab morphology.
2. **Pane header**: provider chip (icon + "freshclaude"), session title, live state ("Working…" while busy),cost chip "$1.38", icon buttons: Diffs (with badge "3"); Settings (gear); Refresh; Fullscreen; Close. Identity and actions must be visually distinct groups.
3. **Status line** (NEW affordance — typical coding-CLI status bar, in your design's language): `~/code/freshell` · `fix/ws-reconnect+2` · Opus 4.6 · effort High · Ask · context meter 59% (some visual gauge) · $1.38.
4. **Body split (wide desktop)**: transcript column + right rail **≈300px** with these sections (each compact):
   - **Diffs**: `server/ws-handler.ts +12 −4`, `test/unit/ws-heartbeat.test.ts +9 −0`, `docs/AGENTS.md +2 −2`, each with a "view" affordance and hint of per-line comment affordance.
   - **Checkpoints**: timeline `b1 14:07 · b2 14:19 · b3 14:31` each with Rewind affordance.
   - **Usage**: cost $1.38, tokens 84.2k↑ / 9.6k↓, burn $3.45/h, context bar 59% (warn state >80% exists).
   - **Threads**: 1 worktree `ws-reconnect·b`, 2 child threads ("heartbeat probe", "docs pass").
   - On <900px (or in the mobile frame), this rail collapses — show how (drawer / above-transcript strip / your call).
5. **Transcript** (the heart — scroll column) with these entries in order:
   1. **User turn**: "the reconnect loop is still dropping messages when the tab's in the background. can you trace where the heartbeat dies?" — user label ("You"), timecode 14:07, hover/⋯ affordances (copy / fork / rewind).
   2. **Agent turn**: label "Claude · Opus 4.6" · 14:07. Content: 2 short paragraphs (paraphrase: found the heartbeat is 15s; background tabs throttle timers to ≥60s, so pings gap out and the server closes the socket; proposes 5s interval + pong watchdog). Then:
      - **Thinking block**, collapsed: "Thought for 12s" (expandable).
      - **Tool group** with individual entries — each expandable, each with status icon:
        - `Read` — `server/ws-handler.ts` (1,204 lines)
        - `Grep` — `"heartbeat" in server/` (7 matches)
        - `Bash` — `npm run test:vitest -- run test/unit/ws-heartbeat.test.ts` → output "14 passed (2.1s)"
        - `Edit` — `server/ws-handler.ts` **+12 −4**, shown EXPANDED with a real small diff:
          ```
          - const HEARTBEAT_INTERVAL = 15_000;
          + const HEARTBEAT_INTERVAL = 5_000;
          + // background-tab timers throttle to ~60s; beat fast enough to survive
          + let lastPongAt = 0;
          ```
          with a per-line "comment to agent" affordance on the changed lines.
      - **Settled activity summary**: "thought 12s · 4 tools used · 2 files changed".
   3. **User turn** with **attachments**: chips `screenshot.png` (image thumb) and `logs.txt`, text "here's what the console shows when it dies".
   4. **Agent turn, streaming**: visibly mid-generation — partial sentence ("So the watchdog needs to live in the server, and the client should—"), streaming cursor, **live activity strip**: "Running Edit — server/ws-handler.ts" with spinner; Stop available.
   5. **Approval card** (interrupts flow, high prominence): tool **Bash** wants `rm -rf .worktrees/refresh-*` — reason "Deletes 3 stale worktrees", warning "This command permanently deletes files." Buttons: **Allow once** · **Always allow Bash this session** · **Deny**. This is an alert — design its hierarchy accordingly.
   6. **Question banner**: AskUserQuestion — "How should the client catch up after reconnect?" options `Replay buffer only` / `Full snapshot if gap > 5s` / `Always resync` (single-select shown selected state on option 2) + "Other…" free text + Submit.
   7. **Compaction card**: "Context compacted · 41,203 → 12,850 tokens · full transcript preserved".
   8. **Queued messages strip** (while busy): 2 queued — "also bump the client backoff cap" and "then update AGENTS.md", each with remove affordance.
   9. (Anywhere sensible) a **web search card**: "browser background tab timer throttling" → sources MDN, Chrome for Developers.
   10. Scroll affordances: "3 new ↓" pill (bottom) and a jump-back chip (top).
6. **Composer** (bottom, sticky): auto-growing textarea containing "make the interval configurable in settings, default 5s —"; one attachment chip `heartbeat.md`; buttons: attach (📎), slash commands, Stop (busy state), Send. State hint under/inside: "⏎ send · ⇧⏎ newline · esc interrupt · ↑ history · @ files · ! shell".
7. **Slash-command menu** (shown OPEN above composer in an inset beside the main frame, AND as a bottom-sheet variant on the phone): grouped, every item with a one-line description; keyboard `↵` hint; filter field showing "re" typed:
   - **Session**: `/new` fresh session (aliases /reset, /restart) · `/fork` branch this conversation from a turn · `/compact` summarize context now · `/rename` retitle session *(soon)* · `/export` save transcript *(soon)*
   - **Inspect**: `/status` session health & config · `/cost` usage breakdown · `/diff` open changed files · `/context` token map *(soon)* · `/review` request code review *(soon)*
   - **Configure**: `/model` switch model · `/effort` thinking effort · `/permissions` permission mode · `/hooks` event hooks *(soon)* · `/mcp` MCP servers *(soon)* · `/agents` subagents *(soon)* · `/notify` completion alerts *(soon)* · `/theme` pane theme *(soon)*
   With filter "re" typed, shows matches: /rename, /review, /permissions (tag soon where marked).
8. **@ file-mention dropdown** (small desktop inset): query `@ws-` → `server/ws-handler.ts` · `src/lib/fresh-agent-ws.ts` · `test/unit/ws-heartbeat.test.ts`.
9. **Settings popover** (desktop inset, anchored near a gear): Style Sans/Serif/Mono; Model list ("Claude Opus 4.6" selected; "Sonnet 4.6 *(soon)*"); Effort Low/Medium/High; Permission mode segmented Ask/Accept edits/Bypass/Plan; toggles Show thinking · Show tools · Timecodes · Sound on done · Desktop notifications *(soon tag on last two if you like; they're partial)*; section "Advanced *(soon)*": Hooks, MCP servers, Agents, Status-line layout.

### C. Phone frame (390×844, beside/below desktop)
Same session adapted — this is where the design proves its mobile grammar:
1. Compact header (provider + title + state + overflow), tab strip above (3 tabs, scrollable), safe-area aware.
2. Status line collapsed into a horizontally scrollable chips row (cwd/branch, model, 59%, $1.38).
3. Transcript: condensed spacing, the Edit diff readable (horizontal code scroll or wrap strategy), timecodes simplified.
4. **Approval card** with full-width stacked buttons ≥44px (thumb-friendly).
5. Composer stacked: textarea row; action row (attach / slash / send) ≥44px; safe-area bottom pad.
6. **Turn actions as bottom sheet** (shown open in a second phone inset): Copy turn text · Fork conversation from here · Rewind code to here (destructive styling) · Cancel.
7. **Settings as full-screen sheet** (small inset): same contents as desktop popover, sheet-ified.
8. **Slash menu as bottom sheet** (small inset): grouped list, large rows.

### D. Alternate-mode swatch (small inset)
One agent turn + approval card rendered in the design's OTHER mode (if primary is dark, show light, and vice versa) — enough to prove the palette maps. ~400px wide tile each, side by side where possible.

---

## Uniform rules across all 6 comps

- **soon tags**: every feature marked *(soon)* above gets a small tag rendered in the design's language (pill/stamp/annotation — your call) but ALWAYS legible and consistent within the design.
- All data uses `tabular-nums`. All times are 24h.
- Left-to-right reading; semantic headings inside the comp page (the masthead is an `<h1>`, frames use `<h2>`/aria-labels).
- Each frame gets a small caption (plain utility type, NOT design display type): e.g. "Desktop · 1440px", "Phone · 390px", "Settings · popover".
- No placeholder lorem — real content builds trust.
- Do not render a Freshell logo/wordmark — the tab strip + identity chips are enough.
- Do not include any working JS interactions; CSS affordances only (details/summary ok).
- Footer of page: the direction contract rendered READABLY (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM+FINISH, ≤150 words) — this is part of the deliverable.
