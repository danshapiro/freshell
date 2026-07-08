# SPEC: Terminal font size to 64px (400%) with SteppedRangeInput

Branch: `feat/font-size-400` (worktree `.worktrees/font-size-400`, based on origin/main @ 1ad3a4ee).
Mirrors PR #509 (UI scale 400%): raised max, dual-rate stepped slider, numeric input.

**Scope guard (do NOT touch):** line height stays a plain `RangeSlider` (fractional; no precision
modes added to `SteppedRangeInput`); `freshAgent.fontScale` is deprecated/inert; EditorPane's
hard-coded 14px (`src/components/panes/EditorPane.tsx:1033`) is out of scope.

---

## 1. Design decisions

### D1. Allowed-values list (33 stops)

```
12..32 by 1   → 21 stops (indices 0–20)   — every currently-reachable value preserved
34..48 by 2   →  8 stops (indices 21–28)  — ~6–8% relative change per stop
52..64 by 4   →  4 stops (indices 29–32)  — ~8% relative change per stop
```

Full list: `12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,34,36,38,40,42,44,46,48,52,56,60,64`

Rationale:
- 1px below 32 preserves backward compatibility: every persisted value 12–32 stays on-list.
- 2px (32→48) then 4px (48→64) keeps *relative* step size roughly constant (~6–8%), analogous to
  UI scale's 5%-then-25% split; above 32px users are choosing accessibility zoom, not fine-tuning.
- 33 total stops ≈ UI scale's 34 (`shared/settings.ts:39-43`) — same slider feel.
- Landmarks 32/48/64 = 200%/300%/400% are all on-list.
- Rejected uniform 2px 32–64 (37 stops): crowds the coarse range with stops nobody needs.

### D2. Percent annotation: minimal additive `annotation` prop on SteppedRangeInput

Chosen: **(b) minimal extension** — optional presentational formatter, not a precision mode.

- The percent is genuinely informative: fontSize multiplies into global `--ui-scale`
  (`src/hooks/useTheme.ts:12`, `(fontSize/16) × uiScale`), and this change quadruples the range
  where that matters. Dropping it (option a) would degrade both visible UX and aria-valuetext
  richness at exactly the moment the mapping becomes most important.
- Cost is ~6 additive lines with zero behavior change when the prop is absent (UI scale row
  untouched). Commit semantics, rounding, index-stepping all unchanged.

New prop contract (`src/components/settings/settings-controls.tsx:226-323`):

```ts
annotation?: (value: number) => string   // e.g. (v) => `(${Math.round((v / 16) * 100)}%)`
```

Behavior when provided:
1. `aria-valuetext` becomes `` `${displayValue}${unit} ${annotation(displayValue)}` ``
   → `"16px (100%)"` (currently `` `${displayValue}${unit}` `` at :277).
2. A visible suffix span renders **after** the existing unit span (:316-320), same styling
   (`aria-hidden="true"`, `text-sm text-muted-foreground`, plus `tabular-nums whitespace-nowrap`),
   showing `annotation(displayValue)` → live-updates during pointer drag (uses `displayValue`
   from :247, which tracks `pendingIndex`).

When absent: rendering is byte-identical to today (assert via existing UI-scale tests staying green).

### D3. `TERMINAL_FONT_SIZE_PX_OPTIONS` lives in `shared/settings.ts`

Exported literal `readonly number[]` adjacent to the min/max constants (:44-45), mirroring
`UI_SCALE_PERCENT_OPTIONS` (:39-43). `TERMINAL_FONT_SIZE_MIN`/`MAX` stay module-private (nothing
else needs them; the component derives min/max from the list ends, :245-246). Invariant tests pin
the list and tie its ends to clamp behavior.

### D4. docs/index.html mock: include the two-attribute consistency fix

AGENTS.md:26 asks for mock updates on significant UI changes; quadrupling two ranges qualifies and
the fix is two attribute edits with zero risk (no tests cover the mock). Do **not** rebuild the
mock as an index-based slider + number input — it's a nonfunctional illustration.

- `docs/index.html:922` (font size): `max="32"` → `max="64"`. The `px-percent` formatter (:1728-1729)
  and preview hook (:1746-1748) already compute generically.
- `docs/index.html:883` (UI scale, stale from PR #509): `max="1.5"` → `max="4"`. Keep fractional
  value + `data-format="percent"` (:1726-1727) so the existing mock JS keeps working.

### D5. Consumers: confirmed NO changes needed

- `src/components/TerminalView.tsx:1727` (xterm init) and `:2638` (live update) — pass px through.
- `src/hooks/useTheme.ts:12` — max effective zoom becomes (64/16)×4 = 16×; intentional, user's choice.
- `src/components/fresh-agent/FreshAgentView.tsx:512-514,1819` — passes `${px}px` through.
- `src/components/settings/AppearanceSettings.tsx:272` — font preview reads the setting directly.
- `src/store/browserPreferencesPersistence.ts:94` — value-agnostic scalar diff.
- Server: `stripLocalSettings` still rejects fontSize (config-store.test.ts:324,333 unchanged);
  legacy-seed migration (`server/config-store.ts:333-342`) clamps via
  `extractLegacyLocalSettingsSeed` → `normalizeExtractedLocalSeed` (`shared/settings.ts:496-503`)
  → shared constants, so the constant change propagates automatically.
- Client reducer clamp is the **same** shared path (`src/store/settingsSlice.ts:7,49`) — also automatic.

---

## 2. Files to modify

| File | Location | Change |
|---|---|---|
| `shared/settings.ts` | :45 | `TERMINAL_FONT_SIZE_MAX = 32` → `64` |
| `shared/settings.ts` | after :45 | add exported `TERMINAL_FONT_SIZE_PX_OPTIONS` literal + comment (mirror :37-43) |
| `src/components/settings/settings-controls.tsx` | :226-240 (props), :277 (aria-valuetext), :316-320 (suffix spans) | add optional `annotation` prop per D2 |
| `src/components/settings/AppearanceSettings.tsx` | :360-372 | replace `RangeSlider` with `SteppedRangeInput` (see below); add `TERMINAL_FONT_SIZE_PX_OPTIONS` to the existing `@shared/settings` import |
| `docs/index.html` | :883, :922 | mock max attrs per D4 |

New Font size row (interface, not literal code):

```tsx
<SettingsRow label="Font size">
  <SteppedRangeInput
    value={settings.terminal.fontSize}
    values={TERMINAL_FONT_SIZE_PX_OPTIONS}
    unit="px"
    annotation={(v) => `(${Math.round((v / 16) * 100)}%)`}
    aria-label="Font size"
    onChange={(v) => applyLocalSetting({ terminal: { fontSize: v } })}
  />
</SettingsRow>
```

Keep `RangeSlider` for Line height (:374-386) untouched. `RangeSlider` itself is unmodified.

**Index-vs-px hazard for the builder:** the new slider is index-based with `min="0" max="32"`
(33 stops → indices 0–32). The string `'32'` as the slider's max attribute is now an *index* that
maps to **64px** — a coincidental echo of the old px max. Never fire px values at the slider;
use `TERMINAL_FONT_SIZE_PX_OPTIONS.indexOf(px)` in tests. Key mappings: 18px→idx 6, 20px→idx 8,
32px→idx 20, 34px→idx 21, 64px→idx 32.

---

## 3. TDD plan (Red-Green-Refactor, 4 stages)

Run per-stage with targeted vitest invocations; full `npm test` (coordinated) at the end.

### Stage 1 — shared constant + options list

**RED** (update pins / add tests; all must fail against current code):

1. `test/unit/shared/settings.test.ts:434` — legacy-seed clamp expectation `fontSize: 32` → `64`
   (input `1_000_000` at :422 unchanged).
2. `test/unit/shared/settings.test.ts` — new pin test next to the UI-scale pin (:454-459):
   `TERMINAL_FONT_SIZE_PX_OPTIONS` equals the exact D1 list (import it alongside
   `UI_SCALE_PERCENT_OPTIONS`).
3. New invariant tests (same file): strictly ascending; all integers; contains every integer
   12..32 inclusive; first element 12; last element 64; last element equals the legacy-seed clamp
   of `1_000_000` (ties list max to clamp max).
4. New boundary tests: `extractLegacyLocalSettingsSeed({ terminal: { fontSize: 64 } })` → 64;
   `fontSize: 65` → 64; `fontSize: 63.5` → 64 (round-after-clamp via
   `normalizeRoundedClampedNumber`, `shared/settings.ts:454-460`).
5. `test/unit/client/store/state-edge-cases.test.ts:753` — loop 1..100 (:749-751) now expects `64`.
6. `test/unit/client/store/state-edge-cases.test.ts:930` — `MAX_SAFE_INTEGER` (:925) now expects `64`.
7. `test/unit/server/config-store.test.ts:363` and `:375` — seed clamp `fontSize: 32` → `64`
   (input `1_000_000` at :344 unchanged).

**No change needed** (verify still green): state-edge-cases `:895-901` (-1→12... actually -10→12),
`:1060-1061` (inputs are 10..29 at :1034, so `>=12`/`<30` still holds), `:1113-1118` (min clamp,
-1→12); config-store `:200/:250` (18), `:303-333` (22), `:1080-1094` (20) — all in-range.

**GREEN:** edit `shared/settings.ts:45` to 64; add exported `TERMINAL_FONT_SIZE_PX_OPTIONS`.
No other production code. Client reducer and server seed tests go green via the shared path (D5).

### Stage 2 — `SteppedRangeInput.annotation`

**RED** — add to `test/unit/client/components/SteppedRangeInput.test.tsx` (fixture at :6-23;
add a variant render with `annotation={(v) => `(${v * 2})`}` or a percent-style formatter):

1. With `annotation`: `aria-valuetext` is `` `${value}${unit} ${annotation(value)}` ``.
2. With `annotation`: a visible `aria-hidden` span shows `annotation(value)`.
3. Drag live-preview: `pointerDown` + change to another index updates the annotation span and
   aria-valuetext from `displayValue` **before** commit (mirror :68-82); commit still fires once
   with the stop value on `pointerUp`.
4. Without `annotation`: aria-valuetext remains `` `${value}${unit}` `` and no annotation span
   renders (regression guard; existing tests :31-39 etc. must stay green untouched).

**GREEN:** implement D2 in `settings-controls.tsx` (:226-240, :277, :316-320). No behavior change
to values/commit logic; `nearestIndex` (:214-220) untouched.

### Stage 3 — AppearanceSettings wiring

**RED** (rewrite pinned tests + add behavior tests):

1. `test/unit/client/components/SettingsView.core.test.tsx:32-38` — delete `getFontSizeSlider`
   (min/max attribute matching breaks by design); use
   `screen.getByRole('slider', { name: 'Font size' })` and
   `screen.getByRole('spinbutton', { name: 'Font size' })`. (Names are new — the old RangeSlider
   had no accessible name; the "Font size" row label span is unassociated, no collision.)
2. `:200-205` — replace `getByText('16px (100%)')` (single-node text no longer exists) with:
   spinbutton value `'16'`, slider `aria-valuetext === '16px (100%)'`, and annotation text
   `'(100%)'` present.
3. `:360-369` — fire slider change with `'6'` (index of 18), keep/drop `pointerUp` (keyboard-path
   commits immediately per :86-93 of the component tests); expect store fontSize `18`.
4. `:371-377` — fire slider change `'8'` (index of 20); expect aria-valuetext `'20px (125%)'` and
   annotation `'(125%)'`.
5. `:379-392` — same index rewrite (`'6'`); still asserts `api.patch` not called (local-only).
6. `test/unit/client/components/SettingsView.behavior.test.tsx` — new font-size block mirroring
   UI scale at :62-131:
   - slider max index commits 64: change to `'32'` (index) → store `64`, spinbutton `'64'`
     (mirror :62-74).
   - **keyboard boundary crossing at 32px**: store fontSize 32 preloaded, keyboard change to
     index `'21'` commits `34` immediately, no pointer events (mirror :76-86).
   - numeric input clamps: type `999` + blur → 64; type `8` + Enter → 12; `api.patch` never
     called (mirror :88-107).
   - typed off-list in-range value: type `33` + blur → store `33` exactly, no snapping; slider
     renders nearest stop (tie 32 vs 34 resolves to the lower index, 20 — component behavior
     pinned at SteppedRangeInput.test.tsx:48-53); aria-valuetext `'33px (206%)'` (mirror :109-119).
   - invalid input ignored: `'abc'` + blur → unchanged (mirror :121-132).
7. `test/unit/client/components/component-edge-cases.test.tsx:1027-1046` — select via
   `getAllByRole('slider').find((s) => s.getAttribute('aria-label') === 'Font size')` (or
   `within` the row); sweep indices 0..32 and back down; assert final fontSize defined and within
   12..64.

**GREEN:** swap the row in `AppearanceSettings.tsx:360-372` per §2; extend the shared import.

**Confirm untouched & green:** `FreshAgentView.test.tsx:5330-5360` (16px/20px transcript vars —
in-range, pass-through), all existing UI-scale tests, line-height tests (:216-221 core).

### Stage 4 — Refactor / periphery (no unit-RED; correctness + consistency)

1. `test/e2e-browser/specs/settings.spec.ts:35-61` — `fill('20')` on the range input (:53) is now
   an *index* (→26px) and would pass a broken assertion path; rewrite value-based via the numeric
   input: `page.getByRole('spinbutton', { name: 'Font size' })`, `fill('20')`, press `Enter`,
   assert `settingsAfter.terminal.fontSize === 20` (keep :58-60 shape). Optionally also assert the
   slider's `aria-valuetext` is `'20px (125%)'`. Note: e2e-browser is **not** in the coordinated
   `npm test` (no playwright in `scripts/testing/test-coordinator.ts`); update for correctness,
   run `npm run test:e2e:chromium -- specs/settings.spec.ts` locally if the environment allows.
2. `docs/index.html:883,:922` — mock attr fixes per D4.
3. Grep sweep: no remaining `'16px (100%)'` / `'20px (125%)'` single-node `getByText`, no
   `min === '12' && max === '32'` slider selectors, no `getFontSizeSlider` references.

---

## 4. Edge cases (must be covered by the tests above)

| Input | Expected |
|---|---|
| Type `8` in px input | commit clamps to 12 (component clamp, :264) |
| Type `999` | clamps to 64 |
| Type `33` | commits **33** — off-list but in-range is legal (matches UI-scale 137% precedent, behavior.test :109-119); slider shows nearest stop (index 20, tie→lower); store/xterm get 33 |
| Type `abc` / empty / Escape | no commit; draft reverts (component tests :127-149 already pin) |
| Keyboard at 32px (index 20) → ArrowRight | one stop to 34, committed immediately |
| Drag 12→64 | annotation live-previews `(75%)`→`(400%)`; single commit on pointer-up |
| Persisted 12–32 (all current users) | on-list; exact rendering, zero migration |
| Persisted/legacy fontSize 1e6, 65, 63.5, MAX_SAFE_INTEGER | clamp to 64 (shared path: reducer + server seed) |
| Persisted -1 / -10 | clamp to 12 (unchanged) |
| fontSize 64 + uiScale 4 | `--ui-scale` = 16 — intentional, no guard added |

---

## 5. Success criteria

1. Coordinated suite green: `npm test` (client + server) in the worktree; `npm run typecheck` /
   lint clean.
2. `shared/settings.ts` exports `TERMINAL_FONT_SIZE_PX_OPTIONS` (33 stops, 12..64 per D1);
   `TERMINAL_FONT_SIZE_MAX === 64`; both pinned by tests.
3. Font size row renders `SteppedRangeInput`: index-based slider (0–32), px spinbutton, `px` unit,
   live `(N%)` annotation; aria-valuetext `"{px}px ({pct}%)"`.
4. UI scale row and line height row byte-identical in behavior (existing tests untouched and green).
5. fontSize remains local-only: no `/api/settings` PATCH from font-size interactions;
   `stripLocalSettings` tests unchanged.
6. Server legacy-seed migration clamps to 64 with **zero** server code changes.
7. e2e spec is value-based (spinbutton), no index/px confusion.
8. docs mock rows :883/:922 reflect max 4 / max 64.
9. No changes to: `RangeSlider`, line-height row, `freshAgent.fontScale`, EditorPane,
   TerminalView, useTheme, FreshAgentView.
