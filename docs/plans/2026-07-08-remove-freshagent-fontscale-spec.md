# SPEC: Remove deprecated `freshAgent.fontScale` setting entirely

- **Date:** 2026-07-08
- **Worktree:** `.worktrees/fontscale-cleanup` (branch `chore/remove-freshagent-fontscale`, based on `origin/main` @ `b5daeea4`)
- **Scope:** delete the inert `freshAgent.fontScale` setting from all production code; convert its migration/clamp behavior into "unknown key, silently dropped"; keep a small set of regression tests proving legacy persisted data can never break rehydration.
- **Method:** strict Red-Green-Refactor TDD. Adapt/write tests first (RED), then remove production code (GREEN), then verify with grep gates and the full suite (REFACTOR/verify).

All line numbers below were verified against the worktree at `b5daeea4` on 2026-07-08.

---

## 1. Background and confirmed facts

`freshAgent.fontScale` is deprecated and inert:

- Fresh-agent panes size their transcript from `terminal.fontSize` via the `--fresh-transcript-font-size` CSS var. `--fresh-font-scale` and `.fresh-agent-scaled-content` no longer exist in production code (only a test pins their absence).
- No UI control writes fontScale. Persistence deliberately excludes it: `src/store/browserPreferencesPersistence.ts:130-136` (`buildLocalSettingsPatch`) only handles `showThinking`/`showTools`/`showTimecodes`.
- `FRESH_AGENT_FONT_SCALE_OPTIONS` has **zero** consumers anywhere in the repo.
- Every production reference to `fontScale|FONT_SCALE|fresh-font-scale` lives in `shared/settings.ts` (18 hits, enumerated in §3). `src/`, `server/`, `electron/` have none.

What still *works* today (and is the behavior being removed): legacy persisted records (browser localStorage `settings.freshAgent.fontScale`, or the older `settings.agentChat.fontScale` alias) are normalized/clamped into `[1, 2]` with default `1.5` and carried into resolved local settings. After this change any `fontScale` in any input is **silently dropped**, like any other unknown key.

### 1.1 Design decision — ingestion (question 1)

**Passive dropping. No active migration/cleanup of stored records.** Rationale:

- Every ingestion path for freshAgent local settings funnels through one of two sanitizers in `shared/settings.ts`, both of which build a **fresh output object from an explicit allow-list of keys** (they never spread raw input):
  - `sanitizeFreshAgentLocalSettingsPatchInput` (`shared/settings.ts:897-919`) — used by `resolveLocalSettings` (:1280), `mergeLocalSettings` (:1342-1343), and (via `sanitizeFreshAgentSettingsPatchInput` :975-985) by `migrateLegacyFreshAgentSettingsInput` (:997) and `stripLocalSettings` (:1482/:1484).
  - `normalizeExtractedLocalSeed` (`shared/settings.ts:491-647`) — used by `extractLegacyLocalSettingsSeed` (:1440).
  Removing the fontScale branches from these two functions therefore drops fontScale from **all** inputs (canonical `freshAgent.*`, legacy `agentChat.*` alias, localStorage seeds, server config load) with no other code changes. Unknown keys are already tolerated everywhere.
- Stored localStorage records self-heal: `loadBrowserPreferencesRecord` normalizes through `extractLegacyLocalSettingsSeed` on every read (`src/lib/browser-preferences.ts:39`), and the next persistence write rebuilds the record from `buildLocalSettingsPatch` (which never emits fontScale). Stale on-disk `fontScale` is inert until then.

### 1.2 Design decision — `agentChat` legacy migration (question 3)

**The `agentChat` → `freshAgent` migration machinery stays.** It is *not* fontScale-specific: `readLegacyFreshAgentSettingsInput` (:321-325), `mergeFreshAgentAliasObjects` (:327-382), and `migrateLegacyFreshAgentSettingsInput` (:987-999) migrate the whole alias object — `showThinking`/`showTools`/`showTimecodes` (local) plus `enabled`/`defaultPlugins`/`providers` (server). They merge raw records generically and rely on the downstream sanitizers for key filtering, so once the sanitizers stop emitting fontScale, a legacy `agentChat.fontScale` is dropped automatically. **No code inside the migration helpers mentions fontScale; do not touch them.** The only fontScale-specific "migration" behavior is the clamp/default inside the two sanitizers plus `normalizeFreshAgentFontScale`/`normalizeLocalFreshAgent`, all removed in §3.

### 1.3 Non-goals

- No renaming/refactoring of the alias-migration helpers, `stripLocalSettings`, or `FRESH_AGENT_LOCAL_KEYS` beyond deleting the `'fontScale'` entry.
- No edits to historical docs that mention fontScale (`docs/plans/2026-07-08-terminal-font-size-400-spec.md`, `docs/superpowers/plans/2026-06-12-settings-ui-refactor.md`, `docs/superpowers/plans/2026-06-15-centralize-fresh-agent-and-remove-agent-chat.md`). They are records of past work.
- No server config-file rewrite migration (server settings never stored fontScale as a server key; `sanitizeFreshAgentServerSettingsPatchInput` :921-973 never handled it).

---

## 2. Interfaces / type changes

All in `shared/settings.ts`; every other type is derived and updates automatically.

**`LocalSettings['freshAgent']`** (shared/settings.ts:220-225) — remove `fontScale`:

```ts
// BEFORE                                   // AFTER
freshAgent: {                               freshAgent: {
  showThinking: boolean                       showThinking: boolean
  showTools: boolean                          showTools: boolean
  showTimecodes: boolean                      showTimecodes: boolean
  fontScale: number                         }
}
```

Automatic ripple (verify, no edits needed):

- `LocalSettingsPatch = DeepPartial<LocalSettings>` (:231).
- `LegacyFreshAgentSettingsInput` (:307-309) and `FreshAgentSettingsPatchInput` (:311-313) are `Partial<ServerSettings['freshAgent'] & LocalSettings['freshAgent']> …`.
- `ResolvedSettings['freshAgent']` composes `server.freshAgent & local.freshAgent` — `composeResolvedSettings` (:1389-1394) spreads objects, no key list.
- Redux `state.settings.localSettings` uses `LocalSettings` directly (`src/store/settingsSlice.ts`); no fixture in `src/` constructs `fontScale` (grep-verified).

**Observable behavior change:** `resolveLocalSettings(...).freshAgent` previously always contained `fontScale` (default `1.5`); after the change the key never exists. No production consumer reads it (grep-verified), so the only affected code is tests (§4).

---

## 3. Exact production removals (`shared/settings.ts` — the only production file touched)

Perform as one edit set; they are only coherent together. 8 edits covering all 18 grep hits.

| # | Location (line @ b5daeea4) | Removal |
|---|---|---|
| R1 | :60-64 | Delete `const FRESH_AGENT_FONT_SCALE_MIN = 1`, `const FRESH_AGENT_FONT_SCALE_MAX = 2`, the comment `// Fresh-agent panes render 50% larger…` (:62), `export const FRESH_AGENT_FONT_SCALE_DEFAULT = 1.5`, `export const FRESH_AGENT_FONT_SCALE_OPTIONS = [1, 1.25, 1.5, 1.75, 2] as const`. Keep :65 (`FRESH_AGENT_STYLE_VALUES`) intact. Both exports have zero importers (grep-verified). |
| R2 | :95 | Delete `'fontScale',` from `FRESH_AGENT_LOCAL_KEYS` (:91-96), leaving the three `show*` keys. Consumers of this list: `extractLegacyLocalSettingsSeed` `pickKeys` (:1433) — stops *picking* fontScale into local seeds; `stripLocalSettings` `omitKeys` (:1487) — safe because its input is already sanitized by `sanitizeFreshAgentSettingsPatchInput` (via :997 or :1484), which will no longer emit fontScale (see risk N1). |
| R3 | :224 | Delete `fontScale: number` from the `LocalSettings` freshAgent block (§2). |
| R4 | :470-475 | Delete `normalizeFreshAgentFontScale` entirely (sole caller is R5). |
| R5 | :487-489 + :1294 | Delete `normalizeLocalFreshAgent` entirely; at :1294 change `freshAgent: normalizeLocalFreshAgent(mergeDefined(defaultLocalSettings.freshAgent, freshAgentPatch)),` → `freshAgent: mergeDefined(defaultLocalSettings.freshAgent, freshAgentPatch),`. |
| R6 | :623-630 | In `normalizeExtractedLocalSeed`, delete the fontScale block (`const normalizedFontScale = normalizeClampedNumber(patch.freshAgent.fontScale, …)` through `freshAgent.fontScale = normalizedFontScale }`). Keep `normalizeClampedNumber` itself — it has other consumers (uiScale :497, terminal :507ff, sidebar). |
| R7 | :886 | Delete `fontScale: FRESH_AGENT_FONT_SCALE_DEFAULT,` from `defaultLocalSettings.freshAgent` (:882-887). |
| R8 | :910-917 | In `sanitizeFreshAgentLocalSettingsPatchInput`, delete the fontScale block (`const normalizedFontScale = normalizeClampedNumber(rawFreshAgent.fontScale, …)` through `freshAgent.fontScale = normalizedFontScale }`). |

**Explicitly do NOT touch** (architecture-test-pinned lines, byte-for-byte — see risk N2):

- :322-323 `return isRecord(candidate.agentChat)` / `? candidate.agentChat as LegacyFreshAgentSettingsInput`
- :1451 `const next = omitKeys(raw, ['theme', 'uiScale', 'notifications', 'agentChat'])`

No edits in `src/store/browserPreferencesPersistence.ts` (already excludes fontScale), `src/lib/browser-preferences.ts`, `src/store/settingsSlice.ts`, `src/store/settingsThunks.ts`, `server/config-store.ts` (all consume the shared sanitizers).

---

## 4. Test strategy — full inventory (question 2)

Every test file referencing `fontScale|FONT_SCALE|fresh-font-scale` (grep-verified complete; `config-store` and server tests have zero hits):

| File : lines | Current behavior pinned | Verdict | New behavior pinned |
|---|---|---|---|
| `test/unit/shared/settings.test.ts:155-164` | `resolveLocalSettings({ agentChat: {showTools, showThinking, fontScale: 1.25} } as never)` → `fontScale` resolves to `1.25` | **ADAPT** | Keep the same legacy input (input tolerance!). Assert `showTools`/`showThinking` still migrate to `freshAgent`, and `'fontScale' in resolved.freshAgent === false`. |
| `test/unit/shared/settings.test.ts:607-651` (describe `legacy fresh-agent font scale settings`) | default 1.5; carry 1.75; agentChat alias 1.25; clamp 5→2 / 0.1→1; non-finite→1.5; composed carry 2; seed clamp agentChat 9→2 | **ADAPT (rewrite block)** | Rename describe to e.g. `deprecated fresh-agent font scale is dropped`. Replace the 7 tests with 5 (see §4.1): T1 default shape, T2 canonical drop, T3 agentChat-alias drop, T4 composed drop, T5 seed drop. Delete the clamp and non-finite-fallback tests as separate cases — "dropped regardless of value" subsumes them (T2 exercises `1.75`, `5`, `'big'`). |
| `test/unit/client/store/browserPreferencesPersistence.test.ts:229-241` | dispatching `{freshAgent:{fontScale:1.75}}` persists nothing | **ADAPT (keep, cast only)** | Same behavior — still persists nothing. Payload no longer typechecks; cast the patch (see §4.2 casting rule). Optionally rename to "ignores removed freshAgent.fontScale values" — keep the persistence assertion identical. |
| `test/unit/client/store/browserPreferencesPersistence.test.ts:243-259` | legacy record with `fontScale: 1.75` **rehydrates** to `1.75` | **ADAPT (invert)** | Rename to `drops legacy freshAgent.fontScale records when rehydrating old preferences`. Same setup; assert `rehydrated.freshAgent.showTools === true`, `'fontScale' in rehydrated.freshAgent === false`, `'agentChat' in rehydrated === false`. This is the key "old persisted data can never break rehydration" regression test. |
| `test/unit/client/browser-preferences.fresh-agent-settings.test.ts:15-41` | localStorage seeded with `agentChat:{…, fontScale:1.25}` loads as `freshAgent` **including** `fontScale` | **ADAPT** | Keep seeding fontScale in raw localStorage (legacy-data tolerance). Assert `record.settings` equals `{ freshAgent: { showTools: true, showThinking: true } }` (fontScale dropped at load via `extractLegacyLocalSettingsSeed`), `resolved.freshAgent.showTools/showThinking` true, `'fontScale' in resolved.freshAgent === false`. |
| `test/unit/client/browser-preferences.fresh-agent-settings.test.ts:43-62` | patching with `agentChat:{showTools, fontScale:1.25}` saves `freshAgent` **including** `fontScale` | **ADAPT** | Same input (already cast `as never`). Assert `raw.settings` equals `{ freshAgent: { showTools: true } }` and `raw.settings.agentChat` undefined. |
| `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:5330-5335` | `--fresh-font-scale` empty, `.fresh-agent-scaled-content` absent, `--fresh-transcript-font-size` = 16px | **KEEP unchanged** | Already pins the post-removal world (asserts absence). No production code references these names; no edit needed. |
| `test/e2e-browser/specs/fresh-agent.spec.ts:879-892` | dispatches `{terminal:{fontSize:20}, freshAgent:{fontScale:2}}`; asserts transcript follows fontSize (ratio ≈ 20/16) and fontScale is inert | **KEEP unchanged** | Payload is runtime JS inside `page.evaluate` (not typechecked), and the assertion — stray fontScale in a dispatched patch does nothing — remains a valuable regression. Optionally reword the comment at :879-880 from "legacy … no longer drives" to "removed … is ignored". No functional change. |
| `test/unit/architecture/fresh-agent-only-runtime.test.ts` (allowances :49-56) | regex-pins exact `agentChat` boundary lines incl. :54 `omitKeys(raw, ['theme', 'uiScale', 'notifications', 'agentChat'])` | **KEEP unchanged** | No fontScale references. This change does not modify any pinned line (§3 "do NOT touch"). Must stay green with zero allowance edits. |
| `test/unit/client/components/settings-view-test-utils.tsx:29,88`, `SettingsView.editor.test.tsx:17,62` | call `stripLocalSettings` (no fontScale) | **KEEP unchanged** | Sanity: must remain green (behavior of `stripLocalSettings` for non-fontScale keys is unchanged). |

### 4.1 New/rewritten shared-settings tests (replaces settings.test.ts:607-651)

All inputs that set `fontScale` must be cast per §4.2 so the file compiles both before (RED) and after (GREEN) the type change.

- **T1 — default shape has no fontScale:** `resolveLocalSettings(undefined).freshAgent` `toEqual({ showThinking: false, showTools: false, showTimecodes: false })`. (`toEqual` on the whole object also proves absence.)
- **T2 — canonical fontScale dropped regardless of value:** for each of `1.75`, `5`, `'big'`: `resolveLocalSettings({ freshAgent: { fontScale: v } } as never).freshAgent` `toEqual` the default trio (no `fontScale` key, no clamping, no NaN leakage).
- **T3 — legacy agentChat alias fontScale dropped, siblings survive:** `resolveLocalSettings({ agentChat: { showTools: true, fontScale: 1.25 } } as never)` → `freshAgent.showTools === true`, `'fontScale' in freshAgent === false`, `'agentChat' in resolved === false`.
- **T4 — composed settings carry no fontScale:** `composeResolvedSettings(createDefaultServerSettings({ loggingDebug: false }), resolveLocalSettings({ freshAgent: { fontScale: 2 } } as never))` → `'fontScale' in resolved.freshAgent === false`.
- **T5 — seed extraction drops fontScale:** `extractLegacyLocalSettingsSeed({ agentChat: { fontScale: 9 } } as Record<string, unknown>)` `toEqual(undefined)` (fontScale was the only key ⇒ empty seed collapses to `undefined`); and `extractLegacyLocalSettingsSeed({ agentChat: { showTools: true, fontScale: 9 } } as Record<string, unknown>)` `toEqual({ freshAgent: { showTools: true } })`.

### 4.2 Casting rule for adapted tests

Tests constructing `fontScale` inputs must not reference it through the typed `LocalSettingsPatch` shape, or they will fail typecheck **after** removal (`fontScale` no longer a known key). Use `as never` on the whole patch argument (existing repo convention, cf. settings.test.ts:158, :620) or `as Record<string, unknown>` for seed-extraction inputs. These casts compile identically before and after the production change, which is what makes the RED phase runnable.

---

## 5. TDD plan (Red-Green-Refactor)

Builder runs from the worktree root. Suggested commands per step; use the repo's standard runner (`npx vitest run <path>`).

### Phase RED — adapt regression tests first; watch them fail for the *right* reason

1. Rewrite `test/unit/shared/settings.test.ts`: adapt :155-164 and replace the :607-651 describe block with T1-T5 (§4.1), applying §4.2 casts. Remove no other tests.
   - Run `test/unit/shared/settings.test.ts` → **RED**: T1/T2/T3/T4 fail because current code still injects/clamps `fontScale` (e.g. T1 gets `fontScale: 1.5` in the object); T5 fails because the seed currently clamps 9→2. The :155-164 adaptation fails on the `'fontScale' in resolved.freshAgent` assertion.
2. Adapt `test/unit/client/store/browserPreferencesPersistence.test.ts:229-259` (§4 table: cast at :232-234; invert :243-259).
   - Run it → **RED**: rehydration test fails (`fontScale` still resolves to `1.75`). The :229-241 test stays green (persistence already skips fontScale) — that is expected; it is a keep-green pin, not a driver.
3. Adapt `test/unit/client/browser-preferences.fresh-agent-settings.test.ts` (§4 table).
   - Run it → **RED**: both tests fail (`record.settings`/`raw.settings` still contain `fontScale: 1.25`).
4. Optionally reword the e2e comment (`test/e2e-browser/specs/fresh-agent.spec.ts:879-880`); no assertion changes.

Commit checkpoint: `test: pin freshAgent.fontScale as dropped legacy input (red)`.

### Phase GREEN — remove production code

5. Apply R1-R8 to `shared/settings.ts` exactly as specified in §3. Do not modify :322-323 or :1451.
6. Run the RED files from steps 1-3 → all green.
7. Typecheck the whole repo (`npx tsc -p . --noEmit` or the repo's `typecheck` script) → green. Any residual error here means a missed fixture constructing `fontScale` through typed shapes; fix with §4.2 casts (tests) — production code must need **no** further edits.

Commit checkpoint: `chore(settings): remove deprecated freshAgent.fontScale (green)`.

### Phase REFACTOR / verify

8. Grep gate (must print nothing):
   `grep -rn "fontScale\|FONT_SCALE\|fresh-font-scale" src server shared electron`
9. Full unit suite, explicitly including:
   - `test/unit/architecture/fresh-agent-only-runtime.test.ts` (must pass with zero allowance edits — see N2),
   - `test/unit/shared/settings.test.ts`, both browser-preferences test files, `FreshAgentView.test.tsx`,
   - `test/unit/client/components/settings-view-test-utils.tsx` consumers (`SettingsView.*.test.tsx`).
10. Lint (`npx eslint .` or repo script) — R1/R4/R5 deletions must leave no unused identifiers (e.g. confirm `normalizeClampedNumber` still has consumers — it does: :497, :507ff, :596ff).
11. If the e2e runner is available, run `test/e2e-browser/specs/fresh-agent.spec.ts` (the :879-892 assertions must stay green: fontSize drives transcript; stray fontScale dispatch ignored).

No further refactor is in scope; the diff should be pure deletion plus the one-line R5 call-site simplification.

---

## 6. Risk notes

- **N1 — `stripLocalSettings` leak of fontScale into server-bound patches after R2.** Removing `'fontScale'` from `FRESH_AGENT_LOCAL_KEYS` means the `omitKeys(migratedFreshAgent, FRESH_AGENT_LOCAL_KEYS)` at :1487 no longer strips it. This is safe **only because** both branches feeding `migratedFreshAgent` (:1481-1485) pass raw input through `sanitizeFreshAgentSettingsPatchInput` first (via `migrateLegacyFreshAgentSettingsInput` :997, or directly :1484), and after R8 that sanitizer never emits fontScale. R2 and R8 must therefore land in the same commit. T5 plus the existing `stripLocalSettings` test (settings.test.ts:547-562) cover the composed behavior; the adapted browser-preferences tests cover the seed path.
- **N2 — architecture regex pins.** `test/unit/architecture/fresh-agent-only-runtime.test.ts:52-54` pins :322-323 and :1451 of `shared/settings.ts` byte-for-byte (leading whitespace included). None of R1-R8 touches those lines, but R1-R8 shift line numbers above/below them — the pins are content-regex based, not line-number based, so that is fine. The builder must not "tidy" `omitKeys(raw, ['theme', 'uiScale', 'notifications', 'agentChat'])` (e.g. must not remove `'agentChat'` or reformat), or the architecture test fails.
- **N3 — old persisted browser records.** localStorage records written before this change may contain `settings.freshAgent.fontScale` (or ancient `settings.agentChat.fontScale`). Post-change these are dropped on load by `extractLegacyLocalSettingsSeed` (`src/lib/browser-preferences.ts:39`, :150, :193) and re-dropped defensively by `resolveLocalSettings`; the stored record self-heals on next persistence write. The adapted rehydration tests (§4, browserPreferencesPersistence :243-259 and browser-preferences.fresh-agent-settings :15-41) are the permanent guards.
- **N4 — resolved-shape change.** `resolveLocalSettings().freshAgent` loses the always-present `fontScale: 1.5`. Grep confirms no production reader; T1's `toEqual` pins the new exact shape so any future accidental reintroduction is caught.
- **N5 — RED-phase compilability.** If adapted tests reference `fontScale` through typed patches without §4.2 casts, the RED phase typechecks but the GREEN phase breaks (or vice-versa). The casting rule makes test code type-stable across the transition.
- **N6 — line drift.** Line numbers in §3/§4 are exact at `b5daeea4`. If the branch is rebased, re-verify with `grep -n "fontScale\|FONT_SCALE" shared/settings.ts` before editing; the 8 removal sites are uniquely identifiable by content.

---

## 7. Success criteria

1. `grep -rn "fontScale\|FONT_SCALE\|fresh-font-scale" src server shared electron` → **zero hits**. (Test dirs retain only the adapted legacy-tolerance references; `docs/` historical mentions are out of scope.)
2. `shared/settings.ts` no longer exports `FRESH_AGENT_FONT_SCALE_DEFAULT` / `FRESH_AGENT_FONT_SCALE_OPTIONS`; `LocalSettings['freshAgent']` is exactly `{ showThinking; showTools; showTimecodes }` (all boolean).
3. Repo typecheck green; lint green; full unit suite green, including `test/unit/architecture/fresh-agent-only-runtime.test.ts` **without any allowance-list edits**.
4. Adapted regression tests green and asserting drop semantics: T1-T5 in `test/unit/shared/settings.test.ts`; inverted rehydration test in `test/unit/client/store/browserPreferencesPersistence.test.ts`; both tests in `test/unit/client/browser-preferences.fresh-agent-settings.test.ts`.
5. `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` and (if run) `test/e2e-browser/specs/fresh-agent.spec.ts:842-893` pass unmodified (comment reword excepted).
6. `shared/settings.ts:322-323` and `:1451` byte-identical to `b5daeea4`.
7. Diff touches exactly: `shared/settings.ts`, `test/unit/shared/settings.test.ts`, `test/unit/client/store/browserPreferencesPersistence.test.ts`, `test/unit/client/browser-preferences.fresh-agent-settings.test.ts`, optionally the e2e comment, plus this spec file.
