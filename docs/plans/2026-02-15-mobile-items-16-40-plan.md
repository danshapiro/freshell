# Mobile Audit Items 16-40 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete all remaining mobile audit items (#16-#40) with production implementation, unit/e2e coverage, and full verification.

**Architecture:** Build a dedicated mobile UX layer around existing `useMobile()` detection and xterm terminal lifecycle, add safe-area/PWA platform support in the client shell, and introduce server-assisted mobile output batching for terminal streams. Keep behavior mobile-first with `md:` desktop overrides and avoid regressions in desktop flows.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS, xterm.js, @use-gesture/react, Vite, Node/Express WebSocket server, Vitest + Testing Library.

---

### Task 1: Viewport, orientation, fullscreen, haptics infrastructure

**Files:**
- Create: `src/hooks/useOrientation.ts`
- Create: `src/hooks/useFullscreen.ts`
- Create: `src/lib/mobile-haptics.ts`
- Test: `test/unit/client/hooks/useOrientation.test.tsx`
- Test: `test/unit/client/hooks/useFullscreen.test.tsx`

**Step 1: Write failing hook tests**
- Add tests for orientation subscription and fullscreen enter/exit state transitions.
- Add tests for no-op behavior when APIs are unavailable.

**Step 2: Run targeted tests (expect fail)**
- Run: `npm test -- test/unit/client/hooks/useOrientation.test.tsx test/unit/client/hooks/useFullscreen.test.tsx`

**Step 3: Implement hooks + haptic helper**
- `useOrientation`: `useSyncExternalStore` over `(orientation: landscape)` media query.
- `useFullscreen`: wrapper around Fullscreen API with safe guards.
- `mobile-haptics`: helper around `navigator.vibrate(10)` with try/catch and availability checks.

**Step 4: Run targeted tests (expect pass)**
- Re-run hook tests.

**Step 5: Commit**
- Commit infra changes and tests.

---

### Task 2: Mobile shell metadata, manifest, Apple tags, service worker registration

**Files:**
- Modify: `index.html`
- Modify: `src/main.tsx`
- Modify: `src/index.css`
- Create: `public/manifest.webmanifest`
- Create: `public/sw.js`
- Create: `public/icon-192.png`
- Create: `public/icon-512.png`
- Create: `public/apple-touch-icon.png`
- Test: `test/unit/client/pwa-shell.test.ts`

**Step 1: Write failing tests for PWA shell registration/meta assumptions**
- Assert service worker registration call path and safety guards.

**Step 2: Run targeted tests (expect fail)**
- Run: `npm test -- test/unit/client/pwa-shell.test.ts`

**Step 3: Implement platform shell updates**
- `index.html`: viewport `user-scalable=no,maximum-scale=1,viewport-fit=cover`; Apple meta tags; manifest link.
- `src/index.css`: `overscroll-behavior-y: contain`; safe-area CSS vars and root padding utilities.
- `public/manifest.webmanifest`: standalone display, theme/background colors, icons.
- `public/sw.js`: cache static shell assets and provide offline fallback response.
- `src/main.tsx`: register service worker in production with safe guards.

**Step 4: Run targeted tests (expect pass)**
- Re-run PWA shell tests.

**Step 5: Commit**
- Commit shell/PWA changes.

---

### Task 3: Terminal mobile key toolbar + keyboard safe-area anchoring (#16, #26, #37)

**Files:**
- Create: `src/components/terminal/MobileTerminalToolbar.tsx`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.mobile-toolbar.test.tsx`
- Test: `test/e2e/terminal-mobile-toolbar-flow.test.tsx`

**Step 1: Add failing tests**
- Verify toolbar is mobile-only, horizontally scrollable, and sends Tab/Ctrl/Esc/arrows/F-keys.
- Verify toolbar bottom offset uses safe-area inset and keyboard inset behavior.

**Step 2: Run targeted tests (expect fail)**
- Run toolbar unit/e2e tests.

**Step 3: Implement toolbar integration**
- Render toolbar in `TerminalView` on mobile.
- Keep it above keyboard using visual viewport + safe-area bottom padding.
- Implement modifier behavior for Ctrl + next key.

**Step 4: Run targeted tests (expect pass)**
- Re-run toolbar tests.

**Step 5: Commit**
- Commit toolbar feature.

---

### Task 4: Terminal gesture/input hardening (#18, #31, #32)

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.mobile-gestures.test.tsx`
- Test: `test/e2e/terminal-mobile-gestures-flow.test.tsx`

**Step 1: Write failing tests**
- One-finger vertical swipes scroll xterm scrollback.
- Double-tap selects nearest word; triple-tap selects line.
- Pull-to-refresh prevention is active through root overscroll containment.

**Step 2: Run targeted tests (expect fail)**
- Run terminal mobile gesture tests.

**Step 3: Implement gesture handling**
- Add touch gesture logic on terminal container for scrollback (`scrollLines`).
- Add tap-count timing logic for word/line selection using xterm API.
- Ensure long-press still permits selection behavior.

**Step 4: Run targeted tests (expect pass)**
- Re-run gesture tests.

**Step 5: Commit**
- Commit gesture hardening.

---

### Task 5: Responsive settings/search/forms updates (#19, #20, #21, #22)

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/components/terminal/TerminalSearchBar.tsx`
- Test: `test/unit/client/components/SettingsView.responsive.test.tsx`
- Test: `test/unit/client/components/TerminalSearchBar.responsive.test.tsx`

**Step 1: Add failing tests**
- Settings container padding/input widths become mobile-friendly.
- Rows stack labels above controls on mobile.
- Terminal search bar avoids overflow on narrow viewports.

**Step 2: Run targeted tests (expect fail)**
- Run new responsive tests.

**Step 3: Implement responsive layout**
- Apply mobile-first layout updates (`px-3 md:px-6`, `w-full md:max-w-*`, stacked row structure).
- Make preview width responsive (`min(100%, 40ch)` behavior).
- Update search bar to wrap/stack controls on mobile.

**Step 4: Run targeted tests (expect pass)**
- Re-run responsive tests.

**Step 5: Commit**
- Commit responsive forms/search changes.

---

### Task 6: Claude settings mobile sheet + history mobile action ergonomics (#23, #34, #35)

**Files:**
- Modify: `src/components/claude-chat/FreshclaudeSettings.tsx`
- Modify: `src/components/HistoryView.tsx`
- Test: `test/unit/client/components/claude-chat/FreshclaudeSettings.mobile.test.tsx`
- Test: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Test: `test/e2e/history-mobile-details-sheet-flow.test.tsx`

**Step 1: Add failing tests**
- Claude settings opens full-width/bottom-sheet style on mobile.
- Session action buttons are >=44px and spaced on mobile.
- Session details open in a bottom sheet on mobile instead of navigation.

**Step 2: Run targeted tests (expect fail)**
- Run claude/history mobile tests.

**Step 3: Implement mobile sheets and touch targets**
- Convert claude popover to mobile bottom sheet while preserving desktop popover.
- Enlarge history action buttons and spacing with `md:` overrides.
- Add mobile session detail sheet and wire open/edit/delete actions.

**Step 4: Run targeted tests (expect pass)**
- Re-run claude/history tests.

**Step 5: Commit**
- Commit mobile sheet/action updates.

---

### Task 7: Landscape optimization, fullscreen mode, tab/sidebar behavior (#29, #36, #38)

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Test: `test/unit/client/components/App.mobile-landscape.test.tsx`
- Test: `test/e2e/mobile-landscape-fullscreen-flow.test.tsx`

**Step 1: Add failing tests**
- Mobile landscape auto-hides full chrome and maximizes terminal area.
- Fullscreen button toggles state and works with mobile tab reveal logic.
- Split-screen/viewport changes keep layout stable across resize/orientation transitions.

**Step 2: Run targeted tests (expect fail)**
- Run landscape/fullscreen tests.

**Step 3: Implement orientation-aware shell**
- Use orientation hook in `App` to apply landscape compact mode.
- Add fullscreen control in terminal/mobile chrome.
- Keep portrait stacked structure: tab strip top, terminal middle, toolbar bottom.

**Step 4: Run targeted tests (expect pass)**
- Re-run landscape/fullscreen tests.

**Step 5: Commit**
- Commit orientation/fullscreen changes.

---

### Task 8: Mobile haptic feedback integration (#33)

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/TabBar.tsx`
- Test: `test/unit/client/mobile-haptics.integration.test.tsx`

**Step 1: Add failing tests**
- Haptic feedback on tab switch, sidebar open/close, and long-press context menu.

**Step 2: Run targeted tests (expect fail)**
- Run haptics integration tests.

**Step 3: Implement haptic hooks**
- Invoke helper only on mobile and only on user-triggered interactions.

**Step 4: Run targeted tests (expect pass)**
- Re-run haptics tests.

**Step 5: Commit**
- Commit haptics integration.

---

### Task 9: Mobile terminal output batching + lazy-loaded non-terminal views (#39, #40)

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/App.tsx`
- Test: `test/server/ws-mobile-output-batching.test.ts`
- Test: `test/unit/client/components/App.lazy-views.test.tsx`

**Step 1: Add failing tests**
- Verify mobile-tagged clients receive coalesced terminal output frames.
- Verify settings/history views are lazily loaded and still render correctly.

**Step 2: Run targeted tests (expect fail)**
- Run batching and lazy-view tests.

**Step 3: Implement batching and lazy loading**
- Detect mobile clients on WS connect (UA heuristic) and coalesce output flush cadence.
- Convert `SettingsView` and `HistoryView` to `React.lazy` + `Suspense` fallback.

**Step 4: Run targeted tests (expect pass)**
- Re-run tests.

**Step 5: Commit**
- Commit backend batching + lazy loading.

---

### Task 10: Docs sync + full verification

**Files:**
- Modify: `docs/index.html`
- Optionally modify: `docs/plans/2026-02-14-mobile-responsive-audit.md` (status annotations only)

**Step 1: Update docs mock for major new mobile features**
- Add references to toolbar/fullscreen/landscape/PWA behavior where relevant.

**Step 2: Run full project validation**
- Run: `npm test`
- Run: `npm run verify`

**Step 3: Fix all regressions**
- Iterate until both commands are green.

**Step 4: Final commit**
- Commit docs + final fixes.

---

### Task 11: Independent fresheyes review and remediation

**Files:**
- Review scope: entire branch delta from `main...HEAD`

**Step 1: Ensure all changes are committed**
- `git status --short` must be empty.

**Step 2: Run fresheyes review**
- Run: `bash /home/user/code/fresheyes/skills/fresheyes/fresheyes.sh --claude "Review the changes between main and this branch using git diff main...HEAD."`

**Step 3: Apply all requested fixes**
- Implement fixes with tests.

**Step 4: Re-run full validation**
- `npm test`
- `npm run verify`

**Step 5: Commit fresheyes fixes**
- Commit remediation changes.
