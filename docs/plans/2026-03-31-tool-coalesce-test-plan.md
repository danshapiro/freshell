# Test Plan: Tool Coalescing

appendum
> **Feature:** Coalesce consecutive tool-only assistant messages into a single message so that multiple tool uses appear in ONE ToolStrip showing "N tools used" instead of multiple separate "1 tool used" strips.
> **Implementation Plan:** `docs/plans/2026-03-31-tool-coalesce.md`
> 
> ---
> 
> ## Strategy Reconciliation
> 
> The testing strategy from the conversation aligns with the implementation plan:
> 
> | Strategy Element | Implementation Plan Coverage | Status |
> |-----------------|------------------------------|--------|
> | Unit tests for Redux coalescing | Task 1: 5 tests in `agentChatSlice.test.ts` | Aligned |
> | Unit tests for JSONL loader coalescing | Task 2: 4 tests in `session-history-loader.test.ts` | Aligned |
> | Browser-use test with LLM judge | Task 4: `tool_coalesce.py` + `tool_coalesce_test.py` | Aligned |
> 
> **No strategy changes requiring user approval.** The implementation plan already includes the browser-use tests with LLM as judge that the user explicitly requested.
> 
> ---
> 
> ## Action Space
> 
> ### User-Visible Actions Affected
> 
> 1. **Freshclaude session viewing** - When a user opens a Freshclaude session in the sidebar, the assistant messages should show coalesced tool strips
> 2. **Session history loading** - When resuming a session, JSONL history should show coalesced tool strips
> 3. **Live message streaming** - When an assistant uses multiple tools in sequence during a live session, they should coalesce into one strip
> 
> ### Internal Actions
> 
> 1. `addAssistantMessage` Redux action - Coalesces when previous message is tool-only assistant
> 2. `extractChatMessagesFromJsonl` function - Coalesces when parsing JSONL history
> 
> ---
> 
> ## Test Plan
> 
> ### Priority 1: Problem-Statement Red Checks (Acceptance Gates)
> 
> These tests directly address the reported bug: seeing "1 tool used" twice instead of "2 tools used".
> 
> #### Test 1.1: Coalesces consecutive tool-only assistant messages
> - **Name:** Coalesces consecutive tool-only assistant messages
> - **Type:** regression
> - **Disposition:** new
> - **Harness:** Redux slice unit test (direct reducer calls)
> - **Source of Truth:** User's reported bug - seeing "1 tool used" twice instead of "2 tools used"
> - **Preconditions:** Session 's1' exists with no messages
> - **Actions:**
>   1. Dispatch `addAssistantMessage({ sessionId: 's1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] })`
>   2. Dispatch `addAssistantMessage({ sessionId: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } }] })`
> - **Expected outcome:** Session has exactly 1 message with exactly 3 content blocks (tool_use, tool_result, tool_use)
> - **Interactions:** None
> 
> #### Test 1.2: Does not coalesce when previous message has text content
> - **Name:** Does not coalesce when previous message has text content
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - text content breaks coalescing
> - **Preconditions:** Session 's1' exists with no messages
> - **Actions:**
>   1. Dispatch `addAssistantMessage({ sessionId: 's1', content: [{ type: 'text', text: 'Hello' }] })`
>   2. Dispatch `addAssistantMessage({ sessionId: 's1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] })`
> - **Expected outcome:** Session has exactly 2 messages
> - **Interactions:** None
> 
> #### Test 1.3: Does not coalesce when new message has text content
> - **Name:** Does not coalesce when new message has text content
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - text content breaks coalescing
> - **Preconditions:** Session 's1' exists with no messages
> - **Actions:**
>   1. Dispatch `addAssistantMessage({ sessionId: 's1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] })`
>   2. Dispatch `addAssistantMessage({ sessionId: 's1', content: [{ type: 'text', text: 'Done' }] })`
> - **Expected outcome:** Session has exactly 2 messages
> - **Interactions:** None
> 
> #### Test 1.4: Coalesces multiple consecutive tool-only messages
> - **Name:** Coalesces multiple consecutive tool-only messages
> - **Type:** regression
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** User's reported bug - multiple tools should all coalesce
> - **Preconditions:** Session 's1' exists with no messages
> - **Actions:**
>   1. Dispatch `addAssistantMessage` with tool_use t1
>   2. Dispatch `addAssistantMessage` with tool_result for t1
>   3. Dispatch `addAssistantMessage` with tool_use t2
>   4. Dispatch `addAssistantMessage` with tool_result for t2
> - **Expected outcome:** Session has exactly 1 message with exactly 4 content blocks
> - **Interactions:** None
> 
> #### Test 1.5: Does not coalesce across user messages
> - **Name:** Does not coalesce across user messages
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - user messages break coalescing
> - **Preconditions:** Session 's1' exists with no messages
> - **Actions:**
>   1. Dispatch `addAssistantMessage` with tool_use t1
>   2. Dispatch `addUserMessage` with text
>   3. Dispatch `addAssistantMessage` with tool_use t2
> - **Expected outcome:** Session has exactly 3 messages (assistant, user, assistant)
> - **Interactions:** None
> 
> #### Test 1.6: JSONL loader coalesces consecutive tool-only assistant messages
> - **Name:** JSONL loader coalesces consecutive tool-only assistant messages
> - **Type:** regression
> - **Disposition:** new
> - **Harness:** JSONL parser unit test (direct function calls)
> - **Source of Truth:** User's reported bug - restored sessions also show separate "1 tool used"
> - **Preconditions:** None
> - **Actions:**
>   1. Call `extractChatMessagesFromJsonl` with JSONL containing 3 consecutive tool-only assistant messages
> - **Expected outcome:** Returns 1 message with 3 content blocks
> - **Interactions:** None
> 
> #### Test 1.7: JSONL loader does not coalesce when assistant message has text content
> - **Name:** JSONL loader does not coalesce when assistant message has text content
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** JSONL parser unit test
> - **Source of Truth:** Implementation plan - text content breaks coalescing
> - **Preconditions:** None
> - **Actions:**
>   1. Call `extractChatMessagesFromJsonl` with JSONL containing text message followed by tool_use message
> - **Expected outcome:** Returns 2 messages
> - **Interactions:** None
> 
> #### Test 1.8: JSONL loader does not coalesce across user messages
> - **Name:** JSONL loader does not coalesce across user messages
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** JSONL parser unit test
> - **Source of Truth:** Implementation plan - user messages break coalescing
> - **Preconditions:** None
> - **Actions:**
>   1. Call `extractChatMessagesFromJsonl` with JSONL containing tool_use, user, tool_use
> - **Expected outcome:** Returns 3 messages
> - **Interactions:** None
> 
> #### Test 1.9: JSONL loader preserves timestamp from first message in coalesced group
> - **Name:** JSONL loader preserves timestamp from first message in coalesced group
> - **Type:** invariant
> - **Disposition:** new
> - **Harness:** JSONL parser unit test
> - **Source of Truth:** Implementation plan - timestamp from first message preserved
> - **Preconditions:** None
> - **Actions:**
>   1. Call `extractChatMessagesFromJsonl` with JSONL containing 2 tool-only messages with different timestamps
> - **Expected outcome:** Coalesced message has timestamp of first message
> - **Interactions:** None
> 
> ---
> 
> ### Priority 2: High-Value Existing Integration Tests
> 
> The existing `MessageBubble.test.tsx` already verifies tool grouping within a single message. These tests remain unchanged and provide confidence that the rendering layer still works correctly after the Redux/JSONL changes.
> 
> **Existing tests to keep passing (no modifications needed):**
> - `groups contiguous tool blocks into a single ToolStrip` - verifies rendering of coalesced content
> - `creates separate strips for non-contiguous tool groups` - verifies text breaks tool groups
> - `renders collapsed strip with summary text when showTools is false` - verifies "N tools used" display
> 
> ---
> 
> ### Priority 3: New Integration Tests
> 
> #### Test 3.1: End-to-end tool strip rendering with coalesced messages
> - **Name:** End-to-end tool strip rendering with coalesced messages
> - **Type:** integration
> - **Disposition:** new
> - **Harness:** React Testing Library with Redux store
> - **Source of Truth:** User-visible behavior - one strip showing "N tools used"
> - **Preconditions:** Redux store with session 's1'
> - **Actions:**
>   1. Dispatch `sessionCreated` for 's1'
>   2. Dispatch `addAssistantMessage` with tool_use t1
>   3. Dispatch `addAssistantMessage` with tool_result t1 + tool_use t2
>   4. Render `MessageBubble` with the resulting message content
> - **Expected outcome:** One ToolStrip showing "2 tools used" (collapsed) or 2 tool blocks (expanded)
> - **Interactions:** Redux store -> MessageBubble component
> 
> #### Test 3.2: Session history loading produces coalesced messages
> - **Name:** Session history loading produces coalesced messages
> - **Type:** integration
> - **Disposition:** new
> - **Harness:** JSONL file I/O + Redux store
> - **Source of Truth:** User-visible behavior - restored sessions show coalesced tools
> - **Preconditions:** Temporary JSONL file with 3 tool-only assistant messages
> - **Actions:**
>   1. Call `loadSessionHistory` with the temp file
>   2. Dispatch messages to Redux store
>   3. Render `MessageBubble` with the resulting messages
> - **Expected outcome:** One ToolStrip showing "3 tools used"
> - **Interactions:** File system -> JSONL loader -> Redux store -> MessageBubble
> 
> ---
> 
> ### Priority 4: Boundary and Edge Cases
> 
> #### Test 4.1: Empty content array does not trigger coalescing
> - **Name:** Empty content array does not trigger coalescing
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - `isToolOnlyContent([])` returns false
> - **Preconditions:** Session 's1' exists with one tool-only message
> - **Actions:**
>   1. Dispatch `addAssistantMessage` with empty content array
> - **Expected outcome:** Empty message is added (not coalesced) - 2 messages total
> - **Interactions:** None
> 
> #### Test 4.2: Thinking block breaks coalescing
> - **Name:** Thinking block breaks coalescing
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - only tool_use/tool_result are tool-only
> - **Preconditions:** Session 's1' exists with one tool-only message
> - **Actions:**
>   1. Dispatch `addAssistantMessage` with thinking block
> - **Expected outcome:** New message is added (not coalesced) - 2 messages total
> - **Interactions:** None
> 
> #### Test 4.3: Session not found returns early without modification
> - **Name:** Session not found returns early without modification
> - **Type:** boundary
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Existing reducer behavior - early return for unknown session
> - **Preconditions:** No session 'nonexistent'
> - **Actions:**
>   1. Dispatch `addAssistantMessage` with sessionId 'nonexistent'
> - **Expected outcome:** State unchanged
> - **Interactions:** None
> 
> #### Test 4.4: Malformed JSONL skips bad lines gracefully
> - **Name:** Malformed JSONL skips bad lines gracefully
> - **Type:** boundary
> - **Disposition:** extend
> - **Harness:** JSONL parser unit test
> - **Source of Truth:** Existing behavior - malformed JSON skipped
> - **Preconditions:** None
> - **Actions:**
>   1. Call `extractChatMessagesFromJsonl` with JSONL containing malformed JSON between valid messages
> - **Expected outcome:** Valid messages parsed, malformed lines skipped, coalescing works on valid messages
> - **Interactions:** None
> 
> ---
> 
> ### Priority 5: Invariant Tests
> 
> #### Test 5.1: Message order preserved after coalescing
> - **Name:** Message order preserved after coalescing
> - **Type:** invariant
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - coalescing appends content, never reorders
> - **Preconditions:** Session exists with tool-only message
> - **Actions:**
>   1. Add tool_use t1
>   2. Add tool_result t1
>   3. Add tool_use t2
> - **Expected outcome:** Content blocks in order: t1 tool_use, t1 tool_result, t2 tool_use
> - **Interactions:** None
> 
> #### Test 5.2: Model preserved from first message in coalesced group
> - **Name:** Model preserved from first message in coalesced group
> - **Type:** invariant
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Implementation plan - first message's metadata preserved
> - **Preconditions:** Session exists
> - **Actions:**
>   1. Add tool_use with model 'claude-opus'
>   2. Add tool_result (no model specified)
> - **Expected outcome:** Coalesced message has model 'claude-opus'
> - **Interactions:** None
> 
> #### Test 5.3: Status updated to 'running' after coalescing
> - **Name:** Status updated to 'running' after coalescing
> - **Type:** invariant
> - **Disposition:** new
> - **Harness:** Redux slice unit test
> - **Source of Truth:** Existing reducer behavior - status set to 'running' on addAssistantMessage
> - **Preconditions:** Session with status 'idle'
> - **Actions:**
>   1. Add tool_use message
>   2. Add tool_result message
> - **Expected outcome:** Session status is 'running'
> - **Interactions:** None
> 
> ---
> 
> ### Priority 6: Browser-Use Scenario Test (LLM Judge)
> 
> #### Test 6.1: Browser-use verifies tool strip coalescing in live UI
> - **Name:** Browser-use verifies tool strip coalescing in live UI
> - **Type:** scenario
> - **Disposition:** new
> - **Harness:** Browser-use with ChatBrowserUse LLM
> - **Source of Truth:** User's explicit request for browser-use tests with LLM as judge
> - **Preconditions:** Freshell server running, Freshclaude session exists with multiple tool uses
> - **Actions:**
>   1. Open Freshell in browser
>   2. Navigate to Freshclaude session with tool uses
>   3. Examine tool strip display for assistant messages
>   4. Judge whether strips are coalesced
> - **Expected outcome:** Output line `TOOL_COALESCE_RESULT: PASS` if one strip per turn, `TOOL_COALESCE_RESULT: FAIL - <reason>` otherwise
> - **Interactions:** Browser automation, LLM judgment,> 
> #### Test 6.2: Browser-use parsing utilities unit tests
> - **Name:** Browser-use parsing utilities unit tests
> - **Type:** unit
> - **Disposition:** new
> - **Harness:** Python pytest
> - **Source of Truth:** Browser-use test contract enforcement
> - **Preconditions:** None
> - **Actions:**
>   1. Test `_parse_result("TOOL_COALESCE_RESULT: PASS")` returns (True, None)
>   2. Test `_parse_result("TOOL_COALESCE_RESULT: FAIL - reason")` returns (False, None)
>   3. Test `_parse_result("")` returns (False, "missing_final_result")
>   4. Test `_parse_result("PASS\nextra")` returns (False, "final_result_not_single_line")
> - **Expected outcome:** All parsing tests pass
> - **Interactions:** None
> 
> ---
> 
> ## Coverage Summary
> 
> | Area | Coverage | Priority |
> |------|---------|----------|
> | Redux coalescing logic | Tests 1.1-1.5, 4.1-4.3, 5.1-5.3 | 1, 4, 5 |
> | JSONL loader coalescing | Tests 1.6-1.9, 4.4 | 1, 4 |
> | Component rendering with coalesced data | Tests 3.1-3.2 | 3 |
> | End-to-end browser verification | Tests 6.1-6.2 | 6 |
> | Existing MessageBubble tests | Unchanged | 2 |
> 
> ### Explicitly Excluded
> 
> | Area | Reason | Risk |
> |------|--------|------|
> | Server-side WebSocket message handling | Not in scope - fix is client-side Redux | Low - WebSocket sends individual messages, coalescing happens after |
> | `sdk-bridge.ts` changes | Not modified - coalescing happens at Redux layer | None |
> | `turnBodyReceived` timeline hydration | Uses separate `timelineBodies` storage, not live messages | Low - timeline is read-only view |
> | Performance testing | Low risk - coalescing is O(1) per message, no loops | None |
> 
> ### Test Count by Type
> 
> | Type | Count |
> |------|-------|
> | regression | 3 |
> | boundary | 7 |
> | invariant | 3 |
> | integration | 2 |
> | scenario | 1 |
> | unit | 1 |
> | **Total** | **17** |
> 
> ---
> 
> ## Execution Order
> 
> 1. **Phase 1: Red checks** (Tests 1.1-1.9) - Verify the fix works for the reported bug
> 2. **Phase 2: Run existing tests** - Verify no regressions in MessageBubble rendering
> 3. **Phase 3: Integration tests** (Tests 3.1-3.2) - Verify end-to-end flow
> 4. **Phase 4: Boundary cases** (Tests 4.1-4.4) - Verify edge cases
> 5. **Phase 5: Invariant tests** (Tests 5.1-5.3) - Verify properties preserved
> 6. **Phase 6: Browser-use** (Tests 6.1-6.2) - Verify in real UI with LLM judge
