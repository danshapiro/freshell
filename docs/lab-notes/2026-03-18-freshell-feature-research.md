# Freshell Feature Research & Bug Investigation
## 2026-03-18

Research session covering seven topics Matt raised. This doc captures findings,
surprises, and next steps.

---

## 1. Move Tab Hotkeys Not Working

**Current state:** A plan exists at `docs/plans/2026-03-14-fix-tab-rotation-after-reorder.md` describing a double-dispatch bug where both TerminalView and App.tsx handle Ctrl+Shift+[/] on the same keypress.

**Surprise:** The fix described in the plan (add `e.defaultPrevented` check in App.tsx, extract shared utility) appears to **already be implemented**:
- `App.tsx:922` already has `if (e.defaultPrevented || e.repeat) return`
- `src/lib/tab-switch-shortcuts.ts` already exists as the shared utility
- `TerminalView.tsx:1102-1107` already uses the shared helper and calls `event.preventDefault()`

**Tab reorder hotkeys** (Ctrl+Shift+Arrow) are in `TabBar.tsx:349-364`. These move the active tab left/right in the tab bar. Potential issue: when xterm is focused, xterm returns `true` for arrow keys (meaning it processes them), which may interfere. The window listener should still fire since DOM events bubble regardless, but xterm may call `preventDefault()` after processing.

**Upstream:** PR #173 (open) fixes tab-switch shortcuts not propagating from FreshClaude/agent-chat panes — different issue from the double-dispatch bug.

**Next step:** Use Chrome automation to test both Ctrl+Shift+[/] (switch) and Ctrl+Shift+Arrow (reorder) from a focused terminal to see what actually happens.

---

## 2. New Tab / Close Tab Hotkeys

**Status:** Not implemented. No keyboard shortcuts exist for creating or closing tabs. Available only via UI buttons and context menus.

**Natural bindings:** Ctrl+T (new) and Ctrl+W (close) — but these conflict with browser defaults. Options:
- Ctrl+Shift+T / Ctrl+Shift+W (less conflict but Ctrl+Shift+T is "reopen closed tab" in browsers)
- Only intercept when terminal pane is focused (xterm custom key handler can block browser defaults)
- Some other combo

**Key files for implementation:**
- `src/lib/tab-switch-shortcuts.ts` — extend or create sibling for new shortcuts
- `src/App.tsx` — global handler
- `src/components/TerminalView.tsx` — xterm custom key handler
- `src/store/tabsSlice.ts` — `addTab`, `closeTab` actions already exist

---

## 3. Copy/Share Session Link with Key

**Status:** Already fully implemented, multiple ways:
- Context menu: "Copy freshell token link" (fetches LAN IP, builds URL with `?token=...`)
- Settings share panel: QR code + copy button
- Setup Wizard: QR code + URL + copy
- Server startup banner prints full URL
- `/api/network/status` returns `accessUrl` with embedded token

**Auth flow:** Token stored in localStorage (`freshell.auth-token`) and cookie (`freshell-auth`). URL `?token=` param extracted on load, stored, then removed from URL history.

**If discoverability is the issue:** Could add a hotkey or toolbar affordance.

---

## 4. Tab Renaming / Auto-Titling

**Renaming:** Works. Double-click tab to rename inline. Also via CLI (`rename-tab`) and agent API (`PATCH /api/tabs/:id`). `titleSetByUser` flag prevents auto-updates from overwriting.

**Auto-titling:** Heuristic, not AI-powered. Priority:
1. First user message from Claude session JSONL → title
2. Provider label (Claude, Codex, etc.)
3. Browser pane hostname
4. Shell terminal directory name
5. Fallback: "Tab"

**No AI-powered titling exists.** Gemini integration exists for session summaries but is not used for tab titles. Could be extended.

---

## 5. tmux Interface

**Status:** Comprehensive tmux-inspired CLI exists at `server/cli/index.ts` with `freshell` binary.

Commands: `new-tab`, `list-tabs`, `select-tab`, `kill-tab`, `rename-tab`, `split-pane`, `send-keys`, `capture-pane`, `wait-for`, etc. Has tmux aliases (`new-window` → `new-tab`, etc.).

**Design spec:** `TMUX-SEMANTICS-PROPOSAL.md` (775 lines). Transport is HTTP+token, not Unix sockets.

**Orchestration surface:** the `freshell` MCP tool in `server/mcp/freshell-tool.ts` provides the canonical automation guidance and action reference.

---

## 6. Freshell Website Extension for Tracking

**Status:** `docs/index.html` is a nonfunctional UI mock. Does NOT mention extensions or tracking. If a tracking extension was discussed, it was in conversation, not the website.

---

## 7. Extension Distribution & Management

**Current architecture:** Three categories (client, server, CLI). Discovery scans `~/.freshell/extensions/` and `.freshell/extensions/` at startup. Manual install only (copy/symlink, pre-built). Four example extensions in `examples/extensions/`.

**Gaps:**
- No `freshell install <url>` command
- No hot reload (restart required)
- No marketplace/registry
- Must be pre-built (no auto `npm install`)
- Docker port forwarding limitations

**Recent work:** Commit `1a2ce26c` added example extensions, fixed cookie auth for iframes, documented in README.

**Extension installer skill:** `.claude/skills/extension-installer/SKILL.md` has comprehensive manifest reference, templates, and validation checklist.

**Path forward for repo-based distribution:** A CLI command that clones a repo, optionally runs a declared build step, validates manifest, and triggers runtime re-scan.

---

## Proposed Priority Order

1. Fix move tab hotkeys (investigate what's actually broken)
2. Add new tab / close tab hotkeys
3. AI-powered tab auto-titling
4. Extension install CLI (`freshell extension install <url>`)
5. Hot reload for extensions
6. Update website with extensions
7. Share link discoverability improvements
