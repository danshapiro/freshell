# Freshell Comprehensive Smoke Test

This smoke test validates all major user-facing features of Freshell. Each test follows the browser-use-testing skill: explain feature purpose and what success looks like in user terms, not implementation details.

## Setup

Navigate to http://localhost:5173. The app should authenticate automatically if you have a valid auth token configured. You should see the main Freshell interface with:
- A tab bar at the top showing available terminals/sessions
- A sidebar on the left with navigation options
- A main content area for the currently selected terminal
- Settings and controls accessible from the interface

---

## 1. Multi-Tab Terminal Sessions (Core Feature)

**Purpose:** Users need to run multiple terminals in parallel—shell, Claude Code, Codex, etc.—and switch between them quickly.

**What to test:**
1. Create a new shell terminal tab. It should open and be ready to accept commands.
2. Create a second terminal (either shell or Claude Code if available). You should now have two tabs.
3. Switch between the tabs by clicking on each. The active tab should show its content, and switching should be instantaneous.
4. Type a command in the first tab (e.g., `echo "test"` or just a simple command), then switch to the second tab and type something there.
5. Switch back to the first tab—your command history should still be there.

**Success criteria:**
- Multiple tabs coexist without interfering
- Tab switching is smooth and content is preserved
- Each tab maintains its own terminal state independently

---

## 2. Flexible Workspaces with Split Panes

**Purpose:** Users often need to see multiple terminals or content side by side (e.g., one terminal running a dev server, another for commands, or a terminal next to a browser view).

**What to test:**
1. In an active tab, find the option to split the pane (usually a split icon or right-click menu).
2. Split a pane horizontally or vertically. You should now see two content areas in the same tab.
3. The split panes should be able to show different content (different terminal panes or a terminal + browser).
4. Resize the split by dragging the divider to ensure both panes remain usable.
5. Close one pane and verify the remaining pane expands to fill the space.

**Success criteria:**
- Panes can be split and arranged
- Content in split panes is independent
- Resizing works smoothly
- Closing panes doesn't crash the app

---

## 3. Detach & Reattach (Session Persistence)

**Purpose:** Users want terminals to keep running even if they close the browser or switch devices. A background terminal should persist across sessions.

**What to test:**
1. Start a long-running command in a terminal (e.g., `sleep 30` or any command that takes a few seconds).
2. While it's running, close the tab or refresh the browser (closing the WebSocket connection).
3. After refreshing or reconnecting, the terminal should still be in the list of available sessions.
4. Click/attach to that terminal. It should reconnect to the running process.
5. You should see the output or status of the command that was running while you were away.

**Success criteria:**
- Detaching doesn't kill the terminal process
- Terminal is recoverable after disconnect
- Reconnecting shows the terminal state as it was left
- Output from the background session is available

---

## 4. Search & Browse Coding CLI Sessions

**Purpose:** Users accumulate many Claude Code and Codex sessions. They need to search across session titles, messages, and transcripts to find past work.

**What to test:**
1. Look for a "Search" or "Sessions" view in the sidebar or main interface.
2. You should see a list of available coding CLI sessions (if any exist locally).
3. Search for a session by typing a keyword or phrase (e.g., search in session titles or recent activity).
4. Verify that search results match the query—either by session name, user messages, or transcript content.
5. Click on a search result to open that session.

**Success criteria:**
- Session list is visible and populated (if sessions exist)
- Search functionality works and filters appropriately
- Clicking a result opens the correct session
- Search results are relevant to the query

---

## 5. AI-Powered Terminal Summaries and Session Management

**Purpose:** After a long session, users want to understand what happened without reading the entire log. AI summaries help. Users also want to organize sessions with custom titles and colors.

**What to test:**
1. In the session list or details view, look for summary information (this requires GOOGLE_GENERATIVE_AI_API_KEY to be set).
2. A summary (if available) should briefly describe what happened in the session.
3. Find the option to edit a session title. Set a custom, meaningful title.
4. Look for color-coding or project tagging options. Assign a color or tag to a session.
5. Verify that the custom title and color are saved and visible in the session list.

**Success criteria:**
- Summaries display correctly (if API key is configured)
- Custom titles can be set and persist
- Color-coding/tagging works and is visible
- Changes are saved without losing session data

---

## 6. Overview Dashboard

**Purpose:** Users need a dashboard to see all terminals at a glance—which are running, which have exited, idle time, and summaries.

**What to test:**
1. Find a "Dashboard," "Overview," or "All Sessions" view.
2. You should see a list or grid of all running and exited terminals with status indicators.
3. Verify that each entry shows relevant info: terminal name, status (running/exited), idle time, and summary (if available).
4. Click on an entry to open or attach to that terminal.
5. The dashboard should update in real-time as terminals finish or new ones are created.

**Success criteria:**
- Dashboard displays all terminals with status
- Information is accurate and up-to-date
- Clicking entries works correctly
- Visual indicators (colors, icons) clearly show terminal state

---

## 7. Theme Support (Dark/Light)

**Purpose:** Users work at different times of day and in different lighting conditions. They need to switch between light and dark themes easily.

**What to test:**
1. Open the Settings or preferences menu.
2. Look for a "Theme" or "Appearance" option.
3. Switch between available themes (system default, light, dark, or specific terminal themes).
4. Verify that the UI updates immediately to reflect the theme change.
5. Close and reopen the app—the theme should persist.
6. If available, test specific terminal themes (Dracula, One Dark, Solarized, GitHub, etc.) and verify colors apply correctly.

**Success criteria:**
- Multiple themes are available and switch smoothly
- Theme changes apply to the entire UI immediately
- Theme preference persists across sessions
- Terminal themes affect terminal display correctly

---

## 8. Drag-and-Drop Tab Reordering

**Purpose:** Users want to organize their tabs in a logical order. Dragging tabs should feel natural.

**What to test:**
1. With multiple tabs open, drag one tab to a new position (e.g., drag the third tab to be first).
2. Verify that the tab moves smoothly without closing or affecting its content.
3. Perform a few reorders to ensure the feature is reliable.
4. Close the app and reopen it—tab order should be preserved.

**Success criteria:**
- Drag-and-drop reordering works smoothly
- Tab content is not lost or changed
- Tab order persists after closing and reopening the app
- The interaction feels responsive (no lag or janky movement)

---

## 9. Context Menus (Right-Click Actions)

**Purpose:** The README mentions 40+ context menu actions across tabs, terminals, sessions, and projects. Users need quick access to common operations without navigating menus.

**What to test:**
1. Right-click on a tab. A context menu should appear with options (e.g., "Close Tab," "Rename," "Archive," etc.).
2. Select an action and verify it works (e.g., renaming updates the tab title, closing removes the tab).
3. Right-click on a session in the list. The context menu should have different options relevant to sessions.
4. Try a few different right-click locations (terminal area, sidebar, session entries) and verify menus appear with context-appropriate actions.

**Success criteria:**
- Context menus appear on right-click
- Menu options are relevant to the context
- Actions from the menu execute correctly
- Menus don't interfere with normal clicking

---

## 10. Mobile Responsiveness

**Purpose:** Users access Freshell from phones and tablets. The UI should collapse the sidebar and adapt to small screens.

**What to test:**
1. Open the browser's developer tools and toggle device emulation (e.g., simulate iPhone or tablet).
2. The sidebar should collapse (or hide) automatically on smaller screens.
3. Navigation should still be accessible (e.g., hamburger menu or slide-out drawer).
4. Terminals should be readable and usable on the smaller viewport.
5. Tabs should remain accessible and functional.
6. Try interacting with the terminal (typing, scrolling) on the mobile view.

**Success criteria:**
- Sidebar collapses or hides on small screens
- Navigation is still accessible
- Layout adapts without breaking content
- Terminal is readable and functional on mobile
- Interactions (typing, scrolling) work smoothly

---

## 11. Keyboard Shortcuts

**Purpose:** Power users rely on keyboard shortcuts for speed. The README lists essential shortcuts for tab navigation, tab movement, and copy/paste.

**What to test:**
1. With multiple tabs open, use `Ctrl+Shift+[` to navigate to the previous tab.
2. Use `Ctrl+Shift+]` to navigate to the next tab.
3. Use `Ctrl+Shift+ArrowLeft` to move a tab left in the tab bar.
4. Use `Ctrl+Shift+ArrowRight` to move a tab right.
5. In a terminal, test `Ctrl+Shift+C` to copy selected text.
6. Test `Ctrl+V` and `Ctrl+Shift+V` to paste.
7. Use `Right-click` / `Shift+F10` to open a context menu without a mouse.

**Success criteria:**
- All listed shortcuts work as documented
- Tab navigation is instant and reliable
- Copy/paste shortcuts work correctly in terminal context
- Keyboard-only users can navigate and operate the app

---

## 12. Activity Notifications

**Purpose:** Users often run long-running tasks and want to know when they finish, even if Freshell is in the background or minimized.

**What to test:**
1. Start a terminal task in Freshell.
2. Minimize the browser window or switch to another application.
3. Let the task finish (or wait for any detectable completion signal).
4. Verify that an audio alert or visual notification appears (browser may prompt for notification permission).
5. The notification should indicate which terminal finished.

**Success criteria:**
- Notifications trigger when appropriate
- Audio alert is audible (if speaker volume is on)
- Notification clearly indicates which terminal/task finished
- Notifications don't interfere with the app's normal operation

---

## 13. Settings and Configuration

**Purpose:** Users need to configure Freshell: enable/disable providers, set defaults, customize appearance, and manage security tokens.

**What to test:**
1. Open Settings (usually a gear icon or menu).
2. You should see toggles or options for enabling/disabling providers (Claude Code, Codex, OpenCode, Gemini, Kimi).
3. Look for a default provider selection.
4. Check theme and appearance settings (we tested theme switching earlier, but verify it's in Settings).
5. Look for security/token management options (if exposed in the UI).
6. Change a setting and verify it persists after closing and reopening the app.

**Success criteria:**
- Settings menu is accessible
- All major settings can be configured
- Changes are saved and persist
- Provider toggles work correctly

---

## 14. Terminal Input/Output (Basic PTY Test)

**Purpose:** At the core, Freshell runs terminals. Basic stdin/stdout must work.

**What to test:**
1. Create or open a shell terminal.
2. Type a simple command like `echo "Hello, Freshell"` and press Enter.
3. Verify that the output appears below your command.
4. Type another command (e.g., `date` or `pwd`) and verify output.
5. Run a multi-line command or command with piping (e.g., `echo "test" | cat`).
6. Verify that command input and output work correctly.

**Success criteria:**
- Commands execute and produce output
- Output displays correctly in the terminal
- Multiple commands can be run in sequence
- Terminal state is maintained

---

## 15. Tab Closure and Cleanup

**Purpose:** Users need to close terminals when done. The app should handle closure gracefully.

**What to test:**
1. Create a terminal tab (if you don't already have extras).
2. Close the tab (usually a close button on the tab or via context menu).
3. Verify the tab is removed from the tab bar.
4. Other tabs should remain unaffected.
5. If the terminal was running a process, that process should be terminated.

**Success criteria:**
- Tabs close cleanly
- Other tabs are not affected
- The app doesn't crash on tab closure
- No stray processes remain after closure

---

## End-to-End Flow (Summary)

A user should be able to:
1. Open Freshell
2. Create multiple terminals in different tabs
3. Switch between tabs smoothly
4. Split panes within a tab
5. Run commands and see output
6. Search for past sessions
7. Organize with custom titles and colors
8. Switch themes to match their preference
9. Reorder tabs by dragging
10. Use keyboard shortcuts for efficiency
11. Close the browser, come back later, and reattach to running terminals
12. Access all features on mobile and desktop

---

## Notes

- This test assumes a development or local instance of Freshell running at http://localhost:5173.
- Some features (AI summaries, Gemini integration) require API keys and external services; they can be skipped if not configured.
- The test focuses on user value, not implementation. Trust that if a feature is accessible and works, the implementation is sound.
- Use the app naturally—the goal is to verify that the product behaves as described in the README and meets user expectations.
