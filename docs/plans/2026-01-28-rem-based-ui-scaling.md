# Replace CSS Zoom with Rem-Based UI Scaling

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace non-standard CSS `zoom` with standards-compliant rem-based font scaling to fix xterm.js mouse coordinate issues while preserving UI scaling functionality.

**Architecture:** Set the root `font-size` on `<html>` to control UI scale (e.g., 125% = `font-size: 1.25rem` or `20px` base). Tailwind's spacing/sizing classes are already rem-based, so they'll scale automatically. Custom font sizes in Tailwind config must be converted from px to rem. Terminal font size remains in absolute pixels since xterm.js requires pixel values.

**Tech Stack:** CSS, Tailwind CSS, React hooks, xterm.js

---

## Background

### Why Zoom Breaks xterm.js

CSS `zoom` is a non-standard property (originally IE-only) that scales visual rendering without transforming the DOM coordinate system. When JavaScript queries mouse positions via `getBoundingClientRect()` or event coordinates, it gets un-zoomed values. xterm.js uses these APIs to calculate which cell the mouse is over, causing the selection offset bug.

### Why Rem-Based Scaling Works

Setting `html { font-size: 125%; }` makes `1rem = 20px` instead of `16px`. All Tailwind classes like `h-8` (which compiles to `height: 2rem`) automatically become 25% larger. The DOM coordinate system remains 1:1 with visual rendering, so xterm.js mouse calculations work correctly.

### What Stays in Pixels

- **Terminal font size**: xterm.js requires pixel values; users adjust this separately in settings
- **Borders**: 1px borders should remain crisp at any scale
- **Icons**: Lucide icons use currentColor and scale with text

---

## Task 1: Convert Tailwind fontSize from px to rem

**Files:**
- Modify: `tailwind.config.js:36-43`

**Context:** The custom fontSize definitions use hardcoded pixels. Convert them to rem based on 16px = 1rem (the browser default before we scale it).

**Step 1: Update fontSize definitions**

Replace the fontSize object in `tailwind.config.js`:

```javascript
fontSize: {
  '2xs': ['0.625rem', '0.875rem'],   // 10px/14px at 1rem=16px
  'xs': ['0.6875rem', '1rem'],        // 11px/16px
  'sm': ['0.8125rem', '1.25rem'],     // 13px/20px
  'base': ['0.875rem', '1.375rem'],   // 14px/22px
  'lg': ['1rem', '1.5rem'],           // 16px/24px
  'xl': ['1.125rem', '1.75rem'],      // 18px/28px
},
```

**Step 2: Verify no visual change at default scale**

Run: `npm run dev`
Expected: UI looks identical (default scale is 1.25, so 0.875rem * 1.25 = 1.09375rem ≈ 17.5px for base text)

**Step 3: Commit**

```bash
git add tailwind.config.js
git commit -m "refactor: convert Tailwind fontSize from px to rem

Preparation for rem-based UI scaling. Using rem allows font sizes
to scale with the root font-size instead of requiring CSS zoom."
```

---

## Task 2: Replace CSS zoom with font-size scaling

**Files:**
- Modify: `src/index.css:62-88`

**Context:** Remove the `zoom` property and Firefox fallback. Replace with `font-size` on `html` element.

**Step 1: Update the CSS**

Replace lines 62-88 in `src/index.css`:

```css
html {
  /* UI scale applied via font-size. Default 125% makes 1rem = 20px.
     All Tailwind spacing/sizing uses rem, so the entire UI scales. */
  font-size: calc(100% * var(--ui-scale, 1.25));
}
```

Remove the `#root { zoom: ... }` block and the entire `@supports not (zoom: 1)` block.

The full replacement (lines 62-88 become):

```css
html {
  /* UI scale applied via font-size. Default 125% makes 1rem = 20px.
     All Tailwind spacing/sizing uses rem, so the entire UI scales. */
  font-size: calc(100% * var(--ui-scale, 1.25));
}

body {
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

**Step 2: Test UI scaling**

Run: `npm run dev`
1. Open browser, verify UI renders correctly
2. Open Settings, adjust UI scale slider
3. Verify entire UI scales smoothly from 75% to 200%
4. Verify terminal mouse selection now tracks cursor correctly

**Step 3: Commit**

```bash
git add src/index.css
git commit -m "refactor: replace CSS zoom with rem-based font scaling

CSS zoom is non-standard and breaks xterm.js mouse coordinate
calculations. Using font-size on html element with rem-based
Tailwind classes achieves the same visual scaling while keeping
the DOM coordinate system 1:1 with visual rendering.

Fixes terminal text selection being offset from mouse cursor."
```

---

## Task 3: Verify useTheme hook still works

**Files:**
- Read: `src/hooks/useTheme.ts`

**Context:** The useTheme hook sets `--ui-scale` CSS variable. Verify it still works with the new approach (it should, since we still use the same CSS variable).

**Step 1: Review the hook**

Read `src/hooks/useTheme.ts` and verify it sets `--ui-scale`:

```typescript
useEffect(() => {
  document.documentElement.style.setProperty('--ui-scale', String(uiScale))
}, [uiScale])
```

This should continue to work since the CSS now uses `var(--ui-scale, 1.25)` in the font-size calculation.

**Step 2: Test dynamic scaling**

1. Open the app
2. Go to Settings
3. Move the UI scale slider
4. Verify the UI scales in real-time
5. Refresh the page and verify the setting persists

**Step 3: Commit (if any changes needed)**

If no changes needed, skip this commit.

---

## Task 4: Fix borderRadius calculations

**Files:**
- Modify: `tailwind.config.js:26-30`
- Modify: `src/index.css:24`

**Context:** The borderRadius uses `calc(var(--radius) - 2px)` which mixes rem and px. Convert to pure rem.

**Step 1: Update --radius CSS variable**

In `src/index.css`, line 24, change:
```css
--radius: 0.5rem;
```

This is already rem, so no change needed here.

**Step 2: Update borderRadius calculations in Tailwind**

In `tailwind.config.js`, the borderRadius uses pixel subtraction:
```javascript
borderRadius: {
  lg: 'var(--radius)',
  md: 'calc(var(--radius) - 2px)',
  sm: 'calc(var(--radius) - 4px)',
},
```

Convert to rem (2px ≈ 0.125rem, 4px ≈ 0.25rem):
```javascript
borderRadius: {
  lg: 'var(--radius)',
  md: 'calc(var(--radius) - 0.125rem)',
  sm: 'calc(var(--radius) - 0.25rem)',
},
```

**Step 3: Visual verification**

Run: `npm run dev`
Verify buttons and cards have correctly rounded corners at various UI scales.

**Step 4: Commit**

```bash
git add tailwind.config.js
git commit -m "refactor: convert borderRadius from px to rem

Ensures border radius scales proportionally with UI scale."
```

---

## Task 5: Ensure terminal copy/paste works

**Files:**
- Read: `src/components/TerminalView.tsx`

**Context:** We previously added Ctrl+Shift+C/V handling. Verify it's still in place and working.

**Step 1: Verify the code exists**

Read `src/components/TerminalView.tsx` and confirm the `attachCustomKeyEventHandler` block exists with copy/paste handling.

**Step 2: Test copy/paste**

1. Open a terminal
2. Run a command that produces output (e.g., `ls` or `dir`)
3. Click and drag to select text - verify selection tracks mouse correctly
4. Press Ctrl+Shift+C - verify text is copied (paste elsewhere to confirm)
5. Click in terminal, press Ctrl+Shift+V - verify clipboard contents are pasted

**Step 3: Commit (if any changes needed)**

If no changes needed, skip this commit.

---

## Task 6: Test edge cases

**Files:** None (testing only)

**Step 1: Test minimum scale (75%)**

1. Set UI scale to 0.75 (75%)
2. Verify all UI elements are readable
3. Verify terminal selection works
4. Verify no layout overflow issues

**Step 2: Test maximum scale (200%)**

1. Set UI scale to 2.0 (200%)
2. Verify all UI elements render correctly
3. Verify terminal selection works
4. Verify scrolling works in all views

**Step 3: Test Firefox**

1. Open the app in Firefox
2. Verify UI scales correctly (previously used transform fallback)
3. Verify terminal selection works

**Step 4: Test terminal font size independence**

1. Set UI scale to 150%
2. Open Settings, change terminal font size
3. Verify terminal font changes independently of UI scale
4. Verify terminal selection still works at various font sizes

---

## Task 7: Clean up any remaining px values

**Files:**
- Search all `src/**/*.tsx` and `src/**/*.css` for hardcoded px values

**Step 1: Search for hardcoded pixels**

```bash
grep -r "px" src/ --include="*.tsx" --include="*.css" | grep -v node_modules | grep -v ".map"
```

Review results. Acceptable px usage:
- `1px` borders (should stay crisp)
- CSS imports like `xterm/css/xterm.css`
- Comments

**Step 2: Fix any problematic px values**

If any sizing (width, height, padding, margin, gap) uses hardcoded px, convert to rem or Tailwind classes.

**Step 3: Final commit**

```bash
git add -A
git commit -m "refactor: complete rem-based UI scaling migration

- Replaced CSS zoom with font-size scaling on html element
- Converted Tailwind fontSize and borderRadius to rem
- Terminal coordinates now work correctly at all UI scales
- Maintains full 75%-200% UI scaling range"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `tailwind.config.js` | fontSize: px → rem, borderRadius: px → rem |
| `src/index.css` | Remove zoom/transform, add font-size scaling |
| `src/hooks/useTheme.ts` | No changes needed (uses same CSS variable) |
| `src/components/TerminalView.tsx` | No changes needed (copy/paste already added) |

## Verification Checklist

- [ ] UI scales from 75% to 200%
- [ ] Terminal text selection tracks mouse cursor exactly
- [ ] Ctrl+Shift+C copies selected terminal text
- [ ] Ctrl+Shift+V pastes into terminal
- [ ] Works in Chrome, Firefox, Safari, Edge
- [ ] Terminal font size adjusts independently of UI scale
- [ ] No visual regressions at default 125% scale
