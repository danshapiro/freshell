# Tool Strip UI Test Plan

## Harness Requirements

No new test harnesses need to be built. All tests use the existing project harness:

- **Vitest + Testing Library** for component rendering, user interaction simulation, and DOM assertions
- **`@testing-library/user-event`** for click/keyboard interactions
- **jsdom localStorage** (built into the test environment) for persistence testing
- **Vitest mocks** for `LazyMarkdown` (already mocked in `MessageBubble.test.tsx` to avoid React.lazy timing issues)

All tests are writable before implementation exists because they assert against planned public interfaces (`getToolPreview` signature, `SlotReel` props, `ToolStrip` props, `MessageBubble` content block grouping behavior) rather than internal state.

---

## Test Plan

### Scenario Tests

#### 1. User sees a collapsed tool strip after an assistant turn with multiple tools

- **Type:** scenario
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `role="assistant"`, content array containing: `[text, tool_use(t1), tool_result(t1), tool_use(t2), tool_result(t2), text]`, `isLastMessage=false`
- **Actions:** Render the component with default props (no localStorage preference set).
- **Expected outcome:** A single element with `role="region"` and `aria-label="Tool strip"` is present. The text "2 tools used" is visible. Both text blocks ("Here is some text", "More text") are rendered as separate text elements outside the strip. No individual `ToolBlock` buttons (e.g. `aria-label="Bash tool call"`) are visible.
- **Source of truth:** User spec: "after a user message, there are assistant replies and a tool strip. When it's done, it says 'N tools used'." Implementation plan Task 4 grouping rules.
- **Interactions:** MessageBubble grouping logic, ToolStrip collapsed rendering, SlotReel settled state.

#### 2. User expands tool strip and sees individual tool blocks, then collapses it

- **Type:** scenario
- **Harness:** Vitest + Testing Library (MessageBubble + userEvent)
- **Preconditions:** MessageBubble rendered with assistant content containing 2 completed tool_use/tool_result pairs. localStorage has no `freshell:toolStripExpanded` key.
- **Actions:**
  1. Render the component.
  2. Click the button with `aria-label="Toggle tool details"`.
  3. Verify expanded view.
  4. Click the toggle button again.
  5. Verify collapsed view.
- **Expected outcome:**
  - After step 2: Individual `ToolBlock` buttons appear (e.g. `aria-label="Bash tool call"`). `localStorage.getItem('freshell:toolStripExpanded')` returns `'true'`.
  - After step 4: "2 tools used" text is visible again. No individual ToolBlock buttons. `localStorage.getItem('freshell:toolStripExpanded')` returns `'false'`.
- **Source of truth:** User spec: "it has a '>' icon on the right. If you click it, that's sticky (browser storage) and it expands to show something more like today: each tool use, itself with an expando." Implementation plan Task 3.
- **Interactions:** ToolStrip toggle state, localStorage persistence, ToolBlock rendering within ToolStrip.

#### 3. User sees streaming tool activity in collapsed strip, then settled summary

- **Type:** scenario
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** ToolStrip rendered with `pairs` containing one completed tool and one running tool, `isStreaming=true`.
- **Actions:**
  1. Render with streaming state.
  2. Verify the running tool's name badge and preview are visible.
  3. Re-render with all tools complete and `isStreaming=false`.
  4. Verify settled state.
- **Expected outcome:**
  - Step 2: The running tool's name (e.g. "Read") appears in a badge. The preview text (e.g. "/path/to/file.ts") appears beside it.
  - Step 4: The text "2 tools used" is visible. No tool name badge.
- **Source of truth:** User spec: "The tool strip streams each line of tool updates, but it's only one line. When it's done, it says 'N tools used'." Implementation plan Task 3 `isSettled` logic.
- **Interactions:** SlotReel rendering, ToolStrip `currentTool` computation, `isSettled` derivation.

#### 4. Expanded tool strip shows auto-expanded recent tools in AgentChatView context

- **Type:** scenario
- **Harness:** Vitest + Testing Library (AgentChatView with Redux store)
- **Preconditions:** Redux store with one turn containing 5 completed tools. `localStorage.setItem('freshell:toolStripExpanded', 'true')`.
- **Actions:** Render `AgentChatView` with the preloaded store.
- **Expected outcome:** 5 `ToolBlock` buttons present. First 2 have `aria-expanded="false"`. Last 3 have `aria-expanded="true"` (matching `RECENT_TOOLS_EXPANDED=3`).
- **Source of truth:** Implementation plan Task 5: auto-expand logic passes through ToolStrip to ToolBlock. Existing `AgentChatView` `RECENT_TOOLS_EXPANDED=3` constant.
- **Interactions:** AgentChatView `completedToolOffsets` and `autoExpandAbove` computation, ToolStrip prop forwarding, ToolBlock `initialExpanded`.

#### 5. System-reminder tags are stripped from tool results viewed through expanded strip

- **Type:** scenario
- **Harness:** Vitest + Testing Library (MessageBubble + userEvent)
- **Preconditions:** MessageBubble rendered with a `tool_use(Read)` + `tool_result` pair where the result contains `<system-reminder>...</system-reminder>` tags.
- **Actions:**
  1. Click the strip toggle button (`aria-label="Toggle tool details"`) to expand.
  2. Click the individual tool block button (`aria-label="Read tool call"`) to expand the tool.
- **Expected outcome:** The tool output shows the real content but not the system-reminder text. This matches existing behavior, just through the new ToolStrip wrapper.
- **Source of truth:** Existing `stripSystemReminders` function behavior. Implementation plan Task 4 preserves this in the grouping logic.
- **Interactions:** MessageBubble grouping, ToolStrip expanded view, ToolBlock content rendering.

#### 6. Non-contiguous tool groups produce separate strips with text between them

- **Type:** scenario
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with content: `[tool_use(t1), tool_result(t1), text("Middle text"), tool_use(t2), tool_result(t2)]`.
- **Actions:** Render the component.
- **Expected outcome:** Two elements with `aria-label="Tool strip"` are present. The text "Middle text" appears between them. Each strip shows "1 tool used".
- **Source of truth:** User spec: "There's one strip per group of tools and results." Implementation plan Task 4 grouping rules: non-tool blocks break contiguous runs.
- **Interactions:** MessageBubble grouping pass, multiple ToolStrip instances.

#### 7. CollapsedTurn with tool blocks renders tool strip when expanded

- **Type:** scenario
- **Harness:** Vitest + Testing Library (CollapsedTurn + userEvent)
- **Preconditions:** CollapsedTurn rendered with a user message and an assistant message containing 2 tool_use/tool_result pairs. No localStorage preference.
- **Actions:**
  1. Click "Expand turn" button.
  2. Verify tool strip is present in the expanded view.
- **Expected outcome:** After expanding the turn, the assistant `MessageBubble` contains a ToolStrip region showing "2 tools used" in collapsed mode. The summary line still shows "2 tools".
- **Source of truth:** Implementation plan Scope Notes: "CollapsedTurn uses MessageBubble which uses ToolStrip, so collapsed turns get tool strips automatically."
- **Interactions:** CollapsedTurn expand, MessageBubble grouping, ToolStrip rendering.

---

### Integration Tests

#### 8. ToolStrip renders ToolBlock components correctly in expanded mode

- **Type:** integration
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** localStorage has `freshell:toolStripExpanded` set to `'true'`. ToolStrip rendered with 3 pairs, all complete.
- **Actions:** Render the component.
- **Expected outcome:** Three buttons with `aria-label` matching `/<name> tool call/i` are present. Each has `aria-expanded` attribute. The toggle button shows a rotated chevron.
- **Source of truth:** Implementation plan Task 3: expanded mode "renders existing ToolBlock components".
- **Interactions:** ToolStrip -> ToolBlock props forwarding (name, input, output, isError, status, initialExpanded).

#### 9. ToolStrip renders SlotReel correctly in collapsed mode with streaming data

- **Type:** integration
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** ToolStrip rendered with 2 pairs (1 complete, 1 running), `isStreaming=true`. No localStorage preference.
- **Actions:** Render the component.
- **Expected outcome:** A `role="status"` element is present. The running tool's name appears in a badge span. The preview text (from `getToolPreview`) is visible.
- **Source of truth:** Implementation plan Task 3 collapsed mode rendering.
- **Interactions:** ToolStrip -> SlotReel props, `getToolPreview` utility.

#### 10. MessageBubble grouping correctly pairs tool_use with tool_result via resultMap

- **Type:** integration
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[tool_use(id=t1, Bash), tool_use(id=t2, Read), tool_result(tool_use_id=t1), tool_result(tool_use_id=t2)]` -- results in different order than uses.
- **Actions:** Render the component.
- **Expected outcome:** A single ToolStrip region is present (all 4 blocks are contiguous tool blocks). Expanding the strip shows 2 ToolBlock buttons. Both show "complete" status (matched results).
- **Source of truth:** Implementation plan Task 4: resultMap pairs by `tool_use_id`, grouping pass treats contiguous tool_use and tool_result as one group.
- **Interactions:** MessageBubble resultMap, grouping pass, ToolStrip, ToolBlock.

#### 11. ToolStrip chevron toggle persists across component remounts via localStorage

- **Type:** integration
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** No localStorage preference. ToolStrip rendered with 1 completed pair.
- **Actions:**
  1. Render, click toggle to expand. Verify `localStorage.getItem('freshell:toolStripExpanded') === 'true'`.
  2. Unmount.
  3. Render a new ToolStrip instance.
- **Expected outcome:** The new instance starts in expanded mode (reads from localStorage).
- **Source of truth:** User spec: "If you click it, that's sticky (browser storage)." Implementation plan Task 3 `useSyncExternalStore`.
- **Interactions:** localStorage, `useSyncExternalStore`, ToolStrip mount behavior.

#### 12. showTools=false on MessageBubble hides all tool strips

- **Type:** integration
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[text("Hello"), tool_use(t1), tool_result(t1)]`, `showTools=false`.
- **Actions:** Render the component.
- **Expected outcome:** No `aria-label="Tool strip"` elements present. The text "Hello" is still visible.
- **Source of truth:** Implementation plan Scope Notes: "`showTools=false` hides the entire tool strip (same as today's behavior)."
- **Interactions:** MessageBubble `hasVisibleContent` check, grouping pass `showTools` filter.

---

### Boundary and Edge-Case Tests

#### 13. Single tool renders as a strip (not bare ToolBlock)

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[tool_use(t1, Bash), tool_result(t1)]` only.
- **Actions:** Render the component.
- **Expected outcome:** A ToolStrip region is present showing "1 tool used". No bare `ToolBlock` button visible outside a strip.
- **Source of truth:** Implementation plan Task 4: any contiguous tool_use/tool_result run produces a ToolStrip, even if it's just one tool.
- **Interactions:** MessageBubble grouping, ToolStrip with single pair.

#### 14. Running tool_use without result is included in the strip

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[tool_use(t1, complete result), tool_use(t2, no result)]`, `isLastMessage=true`.
- **Actions:** Render the component.
- **Expected outcome:** A single ToolStrip region is present. It contains 2 pairs -- one complete, one running. The strip is not in "settled" state since `isStreaming` will be true (last message has a running tool).
- **Source of truth:** Implementation plan Task 4: "A tool_use without a paired tool_result (still running) is included in the group."
- **Interactions:** MessageBubble grouping, ToolStrip `isStreaming` derivation.

#### 15. Orphaned tool_result (no matching tool_use) renders as standalone strip

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[tool_result(tool_use_id=orphan, content="data")]` only.
- **Actions:** Render the component.
- **Expected outcome:** A ToolStrip region is present. Expanding it shows a ToolBlock named "Result" with the output data.
- **Source of truth:** Implementation plan Task 4: orphaned results get rendered as standalone tool strips.
- **Interactions:** MessageBubble orphan handling, ToolStrip with single "Result" pair.

#### 16. Thinking block between text and tools does not merge into tool group

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[thinking("Let me think..."), text("Answer"), tool_use(t1), tool_result(t1)]`.
- **Actions:** Render the component.
- **Expected outcome:** The thinking block renders as a collapsible `<details>` element. The text renders normally. The tool pair renders as a ToolStrip. All three groups are separate; the thinking block does not get absorbed into the tool strip.
- **Source of truth:** Implementation plan Task 4 grouping rules: only `tool_use` and `tool_result` blocks are grouped into tool runs; `thinking` blocks break the run.
- **Interactions:** MessageBubble grouping pass type checking.

#### 17. Empty content array renders nothing

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `content=[]`.
- **Actions:** Render the component.
- **Expected outcome:** No `role="article"` element present (component returns null).
- **Source of truth:** Implementation plan `hasVisibleContent` returns false for empty groups.
- **Interactions:** MessageBubble `hasVisibleContent` check.

#### 18. ToolStrip with errored tools shows error indication in collapsed mode

- **Type:** boundary
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** ToolStrip rendered with 2 pairs, one of which has `isError=true`.
- **Actions:** Render the component in collapsed mode.
- **Expected outcome:** The ToolStrip region is present. The collapsed row has the error border color class (`border-l-[hsl(var(--claude-error))]`) instead of the normal tool color.
- **Source of truth:** Implementation plan Task 3: `hasErrors` determines border color.
- **Interactions:** ToolStrip `hasErrors` derivation, CSS class application.

#### 19. Message with only tools and showTools=false renders nothing (null return)

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[tool_use(t1), tool_result(t1)]`, `showTools=false`.
- **Actions:** Render the component.
- **Expected outcome:** No `role="article"` element present.
- **Source of truth:** Implementation plan Task 4 `hasVisibleContent` check updated for tool groups.
- **Interactions:** MessageBubble `hasVisibleContent`, group-level visibility filtering.

#### 20. Message with text alongside hidden tools still shows text

- **Type:** boundary
- **Harness:** Vitest + Testing Library (MessageBubble)
- **Preconditions:** MessageBubble rendered with `[text("Here is some text"), tool_use(t1), tool_result(t1)]`, `showTools=false`.
- **Actions:** Render the component.
- **Expected outcome:** The `role="article"` element is present. The text "Here is some text" is visible. No tool strip is rendered.
- **Source of truth:** Existing behavior preserved: text is always visible regardless of `showTools`.
- **Interactions:** MessageBubble `hasVisibleContent`, group filtering.

#### 21. SlotReel renders empty state gracefully

- **Type:** boundary
- **Harness:** Vitest + Testing Library (SlotReel)
- **Preconditions:** SlotReel rendered with `toolName={null}`, `previewText={null}`, no `settledText`.
- **Actions:** Render the component.
- **Expected outcome:** A `role="status"` element is present but contains no tool badge and no meaningful text.
- **Source of truth:** Implementation plan Task 2: graceful empty rendering.
- **Interactions:** SlotReel internal state.

#### 22. SlotReel renders tool name in badge and preview text

- **Type:** boundary
- **Harness:** Vitest + Testing Library (SlotReel)
- **Preconditions:** SlotReel rendered with `toolName="Bash"`, `previewText="$ ls -la"`.
- **Actions:** Render the component.
- **Expected outcome:** "Bash" appears in a `<span>` element within a `[data-slot="name"]` container. "$ ls -la" appears as text content.
- **Source of truth:** Implementation plan Task 2 component structure.
- **Interactions:** SlotReel rendering.

#### 23. SlotReel shows settled text when tool is null

- **Type:** boundary
- **Harness:** Vitest + Testing Library (SlotReel)
- **Preconditions:** SlotReel rendered with `toolName={null}`, `previewText={null}`, `settledText="5 tools used"`.
- **Actions:** Render the component.
- **Expected outcome:** "5 tools used" is visible. No tool badge element.
- **Source of truth:** Implementation plan Task 2: settled state shows count.
- **Interactions:** SlotReel `isSettled` logic.

#### 24. SlotReel updates content on prop change (tool name transition)

- **Type:** boundary
- **Harness:** Vitest + Testing Library (SlotReel)
- **Preconditions:** SlotReel initially rendered with `toolName="Bash"`, `previewText="$ echo hi"`.
- **Actions:** Rerender with `toolName="Read"`, `previewText="/file.ts"`.
- **Expected outcome:** "Read" appears in the badge. "/file.ts" appears as preview text. The `[data-slot="name"]` container is present.
- **Source of truth:** User spec: "if the tool changes, then the part to the left rolls over too, sort of like a slot machine reel." Implementation plan Task 2 `useReelSlot` hook.
- **Interactions:** SlotReel `useReelSlot` state transitions.

---

### Unit Tests

#### 25. getToolPreview returns empty string for missing input

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Bash')` with no input argument.
- **Expected outcome:** Returns `''`.
- **Source of truth:** Implementation plan Task 1: `if (!input) return ''`.
- **Interactions:** None (pure function).

#### 26. getToolPreview returns Bash description when available

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Bash', { command: 'npm test', description: 'Run tests' })`.
- **Expected outcome:** Returns `'Run tests'`.
- **Source of truth:** Existing `getToolPreview` behavior in ToolBlock.tsx (being extracted). Description takes priority over command.
- **Interactions:** None.

#### 27. getToolPreview returns Bash command with $ prefix when no description

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Bash', { command: 'ls -la' })`.
- **Expected outcome:** Returns `'$ ls -la'`.
- **Source of truth:** Existing `getToolPreview` behavior.
- **Interactions:** None.

#### 28. getToolPreview returns Grep pattern and path

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Grep', { pattern: 'useState', path: 'src/' })`.
- **Expected outcome:** Returns `'useState in src/'`.
- **Source of truth:** Existing `getToolPreview` behavior.
- **Interactions:** None.

#### 29. getToolPreview returns Read file_path

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Read', { file_path: '/home/user/file.ts' })`.
- **Expected outcome:** Returns `'/home/user/file.ts'`.
- **Source of truth:** Existing `getToolPreview` behavior.
- **Interactions:** None.

#### 30. getToolPreview returns Edit file_path

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Edit', { file_path: 'src/App.tsx', old_string: 'a', new_string: 'b' })`.
- **Expected outcome:** Returns `'src/App.tsx'`.
- **Source of truth:** Existing `getToolPreview` behavior.
- **Interactions:** None.

#### 31. getToolPreview returns Glob pattern

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Glob', { pattern: '**/*.ts' })`.
- **Expected outcome:** Returns `'**/*.ts'`.
- **Source of truth:** Existing `getToolPreview` behavior.
- **Interactions:** None.

#### 32. getToolPreview returns JSON fallback for unknown tools

- **Type:** unit
- **Harness:** Vitest (tool-preview.ts)
- **Preconditions:** None.
- **Actions:** Call `getToolPreview('Unknown', { key: 'value' })`.
- **Expected outcome:** Returns `'{"key":"value"}'`.
- **Source of truth:** Existing `getToolPreview` behavior (JSON.stringify fallback).
- **Interactions:** None.

---

### Regression Tests

#### 33. Existing ToolBlock tests pass with getToolPreview extracted to shared utility

- **Type:** regression
- **Harness:** Vitest + Testing Library (existing ToolBlock.test.tsx, ToolBlock.autocollapse.test.tsx)
- **Preconditions:** `getToolPreview` has been moved from ToolBlock.tsx to tool-preview.ts. ToolBlock.tsx imports from the new location.
- **Actions:** Run existing test suites: `ToolBlock.test.tsx`, `ToolBlock.autocollapse.test.tsx`.
- **Expected outcome:** All existing tests pass without modification. The ToolBlock component behavior is unchanged.
- **Source of truth:** Refactoring preserves behavior; no functional change to ToolBlock.
- **Interactions:** ToolBlock -> tool-preview import path.

#### 34. Existing MessageBubble tests for text, thinking, timestamps, XSS still pass

- **Type:** regression
- **Harness:** Vitest + Testing Library (existing MessageBubble.test.tsx)
- **Preconditions:** MessageBubble has been updated with grouping logic and ToolStrip rendering.
- **Actions:** Run the existing MessageBubble test suite.
- **Expected outcome:** Tests for text rendering, thinking blocks, timestamps, and XSS sanitization all pass. Tests that referenced individual ToolBlock DOM queries (e.g. `screen.getByText('Bash:')`) are updated to match the new ToolStrip structure (e.g. `screen.getByText('1 tool used')` or expanding via toggle first).
- **Source of truth:** Non-tool rendering paths are unchanged. Tool rendering is now wrapped in ToolStrip but functionally equivalent.
- **Interactions:** MessageBubble grouping pass.

#### 35. CollapsedTurn summary still shows correct tool count

- **Type:** regression
- **Harness:** Vitest + Testing Library (existing CollapsedTurn.test.tsx)
- **Preconditions:** CollapsedTurn uses MessageBubble which now renders ToolStrip instead of bare ToolBlocks.
- **Actions:** Run existing CollapsedTurn test suite.
- **Expected outcome:** The summary line still shows "2 tools" (counted from `tool_use` blocks in the assistant message content). Expanding the turn shows MessageBubble content with tool strips.
- **Source of truth:** CollapsedTurn `makeSummary` counts `tool_use` blocks directly from the message content array, independent of rendering.
- **Interactions:** CollapsedTurn -> MessageBubble -> ToolStrip chain.

#### 36. Context menu copy helpers still work with ToolBlock DOM inside ToolStrip

- **Type:** regression
- **Harness:** Vitest (existing agent-chat-actions.test.ts)
- **Preconditions:** ToolBlock is now rendered inside ToolStrip's expanded view. ToolBlock's `data-tool-input`, `data-tool-output`, and DiffView DOM structure are unchanged.
- **Actions:** Run existing agent-chat-actions test suite.
- **Expected outcome:** All copy helper tests pass. These tests construct DOM elements directly and don't depend on ToolStrip wrapping.
- **Source of truth:** ToolBlock's internal DOM structure (data attributes, DiffView) is not modified by the ToolStrip integration.
- **Interactions:** agent-chat-copy utilities, ToolBlock DOM attributes.

---

### Invariant Tests

#### 37. ToolStrip always renders an accessible region with aria-label

- **Type:** invariant
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** Any valid `pairs` array and `isStreaming` value.
- **Actions:** Render ToolStrip in both collapsed and expanded modes.
- **Expected outcome:** In both modes, a `role="region"` element with `aria-label="Tool strip"` is present.
- **Source of truth:** AGENTS.md A11y requirements: all components must have appropriate ARIA roles and labels.
- **Interactions:** ToolStrip wrapper `<div>`.

#### 38. SlotReel always renders with role="status"

- **Type:** invariant
- **Harness:** Vitest + Testing Library (SlotReel)
- **Preconditions:** Any combination of props.
- **Actions:** Render SlotReel with various prop combinations.
- **Expected outcome:** A `role="status"` element is always present.
- **Source of truth:** AGENTS.md A11y requirements. Implementation plan Task 2: `<span role="status">`.
- **Interactions:** SlotReel wrapper `<span>`.

#### 39. Toggle button always has aria-label="Toggle tool details"

- **Type:** invariant
- **Harness:** Vitest + Testing Library (ToolStrip)
- **Preconditions:** Any valid props.
- **Actions:** Render ToolStrip in both collapsed and expanded modes.
- **Expected outcome:** A `<button>` with `aria-label="Toggle tool details"` is present in both modes.
- **Source of truth:** AGENTS.md A11y: icon-only buttons must have `aria-label`. User spec: "The chevron is always visible."
- **Interactions:** ToolStrip toggle button.

---

## Coverage Summary

### Covered

| Area | Tests | Coverage |
|------|-------|----------|
| Content block grouping (contiguous/non-contiguous) | 1, 6, 10, 13, 14, 16 | Full |
| Collapsed mode (settled, streaming, error) | 1, 3, 9, 18 | Full |
| Expanded mode (ToolBlock rendering, auto-expand) | 2, 4, 8 | Full |
| Toggle persistence (localStorage read/write, remount) | 2, 11 | Full |
| showTools=false hiding | 12, 19, 20 | Full |
| System-reminder stripping through ToolStrip | 5 | Full |
| Orphaned tool_result handling | 15 | Full |
| SlotReel rendering states | 21, 22, 23, 24 | Full |
| getToolPreview utility (all tool types) | 25-32 | Full |
| Accessibility (ARIA roles, labels) | 37, 38, 39 | Full |
| Regression (existing ToolBlock, MessageBubble, CollapsedTurn, context menu tests) | 33, 34, 35, 36 | Full |
| CollapsedTurn integration | 7 | Covered |
| AgentChatView auto-expand with strips | 4 | Covered |
| Edge cases (empty content, single tool, running tool, thinking blocks) | 13, 14, 16, 17 | Full |
| Error tool indication | 18 | Covered |

### Explicitly Excluded (per agreed strategy)

| Area | Reason | Risk |
|------|--------|------|
| Pixel-perfect animation timing | CSS `translateY` transition, ~150ms ease-out. Manual visual review suffices. No Playwright. | Low -- animation is simple CSS, broken animation is immediately visually obvious |
| Cross-browser CSS rendering | Standard Tailwind utilities (`translateY`, `overflow-hidden`, `transition-transform`). Testing in jsdom verifies class presence, not rendering. | Low -- using well-tested Tailwind primitives |
| Performance benchmarks | No complex computation added; grouping is O(n) over content blocks, memoized. | Very low |
| Server/WebSocket changes | None in scope (plan confirms no backend changes). | None |
