# Accessibility (A11y) Audit Report

## Status
Worktree created: `feature/a11y-accessibility`
ESLint configured with `eslint-plugin-jsx-a11y`
Current violations: 164 problems (143 errors, 21 warnings)

## A11y-Specific Violations (21 warnings)

These violations break **browser-use automation** and **WCAG compliance**:

### High Priority - Browser-Use Breaking Issues

**1. Non-Static Element Interactions (3 occurrences)**
- `src/components/panes/Pane.tsx:33`
- `src/components/panes/PaneDivider.tsx:82`
- `src/components/ui/confirm-modal.tsx:65`

**Issue**: Div/span with click handlers but no role="button" or semantic HTML
**Impact**: Browser-use can't identify interactive elements; keyboard navigation broken
**Fix**: Use `<button>` or add `role="button"` + keyboard handlers

---

**2. Click Events Without Keyboard Support (1 occurrence)**
- `src/components/ui/confirm-modal.tsx:65`

**Issue**: Click handler without `onKeyDown`
**Impact**: Keyboard-only users can't interact; browser-use can't test keyboard paths
**Fix**: Add `onKeyDown` handler for Enter/Space keys

---

**3. AutoFocus Attribute (1 occurrence)**
- `src/components/panes/BrowserPane.tsx:189`

**Issue**: `autoFocus` prop disrupts focus management
**Impact**: Reduces usability, breaks focus navigation expectations
**Fix**: Remove or manage focus via useEffect + ref only when necessary

---

**4. Label Not Associated with Control (1 occurrence)**
- `src/components/ui/label.tsx:7`

**Issue**: Form label with no `htmlFor` or wrapping control
**Impact**: Screen readers can't link label to form field
**Fix**: Add `htmlFor="controlId"` to label or wrap control

---

**5. Non-Interactive Elements with Event Listeners (1 occurrence)**
- `src/components/ui/confirm-modal.tsx:69`

**Issue**: Non-interactive element (`<div>` etc) with `onClick`/`onKeyDown`
**Impact**: Violates semantic HTML; browser-use can't interact
**Fix**: Convert to `<button>` or add proper role + keyboard support

---

## Architecture Changes Needed

### Pane System
- `Pane.tsx:33` - div with click handler → needs role or convert to button
- `PaneDivider.tsx:82` - div with drag handler → needs role="button" + keyboard
- `PaneContainer.tsx` - review all clickable elements

### Form Components
- `label.tsx:7` - unassociated label → add `htmlFor`
- `confirm-modal.tsx:65,69` - multiple interactive divs → use buttons with keyboard

### Browser Pane
- `BrowserPane.tsx:189` - autoFocus → remove or manage via effect

---

## Component Audit Checklist

### Interactive Elements (Must Use Semantic HTML or Proper Roles)
- [ ] All buttons: `<button>` or `role="button"` with keyboard handlers
- [ ] All links: `<a>` with href, or `role="link"`
- [ ] All clickable divs: `role="button"` + `onKeyDown` for Enter/Space
- [ ] All form inputs: `<input>`, `<textarea>`, `<select>` with associated `<label htmlFor>`

### ARIA Requirements
- [ ] Icon-only buttons: `aria-label`
- [ ] Expandable sections: `aria-expanded`, `aria-controls`
- [ ] Menu items: `role="menuitem"`, `aria-label` if needed
- [ ] Modal dialogs: `role="dialog"`, `aria-labelledby`

### Focus & Keyboard
- [ ] No `autoFocus` on elements
- [ ] Click handlers paired with `onKeyDown` (Enter/Space for buttons)
- [ ] Tab order natural; skip `tabindex` unless necessary
- [ ] Drag handlers support keyboard alternatives

---

## Dispatch Plan

Components are divided into logical sections for parallel agent work:

1. **UI Components** (8 components)
   - label, input, button, select, slider, switch, tooltip, confirm-modal
   - Status: 3 a11y issues to fix

2. **Pane System** (5 components)
   - Pane, PaneContainer, PaneDivider, PaneHeader, PanePicker
   - Status: 2 a11y issues to fix

3. **Form/Display Views** (4 components)
   - SettingsView, HistoryView, OverviewView, BackgroundSessions
   - Status: Initial scan needed

4. **Terminal & Content** (3 components)
   - TerminalView, BrowserPane, TabContent
   - Status: 1 a11y issue in BrowserPane

5. **Session & Context** (3 components)
   - SessionView, ContextMenu, MessageBubble
   - Status: Initial scan needed

---

## ESLint Commands

```bash
# Check violations
npm run lint

# Auto-fix where possible (fixes unused vars, React import, etc)
npm run lint:fix

# Show only a11y warnings
npm run lint 2>&1 | grep "jsx-a11y"
```

## Notes
- ESLint config: `eslint.config.js` (ESLint v9 flat config)
- A11y plugin: `eslint-plugin-jsx-a11y`
- Key rules enabled: anchor-is-valid, click-events-have-key-events, no-static-element-interactions, label-has-associated-control
- Many "errors" are parser/unused-var issues; focus on a11y violations (warnings)
