# Tool Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coalesce consecutive tool-only assistant messages into a single message so that multiple tool uses appear in ONE ToolStrip showing "N tools used" instead of multiple separate "1 tool used" strips.

**Architecture:** The SDK sends separate `assistant` messages (one per tool_use block). The fix intercepts at two points: (1) the Redux `addAssistantMessage` reducer for live messages, and (2) the `extractChatMessagesFromJsonl` function for restored sessions. Both locations check if the previous message is also a tool-only assistant message, and if so, append content blocks instead of creating a new message.

**Tech Stack:** Redux Toolkit, TypeScript, Vitest, Testing Library, browser-use CLI

---

## Root Cause Analysis

The Claude SDK sends multiple `assistant` messages (one per `tool_use` block). The server's `sdk-bridge.ts` (lines 273-296) creates a **new Redux message** for each SDK message via `state.messages.push(...)`. Each message becomes a separate `MessageBubble`, each with its own `ToolStrip` showing "1 tool used".

The `MessageBubble` grouping logic (lines 50-126) correctly groups consecutive `tool_use` blocks **within a single message's content array**, but cannot merge across separate messages.

## Strategy

Fix at the message creation boundary, not the rendering boundary. This is cleaner because:
1. **Single source of truth**: Messages in Redux state are already coalesced
2. **Consistent behavior**: Both live sessions and restored sessions behave identically
3. **Simpler testing**: Unit tests verify the Redux slice and loader, not UI rendering

---

## Files to Modify/Create

| File | Action | Purpose |
|------|--------|---------|
| `src/store/agentChatSlice.ts` | Modify | Add coalescing logic to `addAssistantMessage` |
| `server/session-history-loader.ts` | Modify | Add coalescing logic to `extractChatMessagesFromJsonl` |
| `test/unit/client/agentChatSlice.test.ts` | Modify | Add tests for coalescing |
| `test/unit/server/session-history-loader.test.ts` | Modify | Add tests for coalescing |
| `test/browser-use/tool-coalesce.md` | Create | Browser-use test procedure documentation |

---

## Task 1: Add Helper Function to Identify Tool-Only Content

**Files:**
- Modify: `src/store/agentChatSlice.ts:1-10`

- [ ] **Step 1: Identify or write the failing test**

First, verify the existing tests pass (no existing check for coalescing - this is the gap):

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts --run
```

Expected: All tests pass

- [ ] **Step 2: Run test to verify it fails**

No failing test yet - we're adding new functionality. Proceed to implementation.

- [ ] **Step 3: Write minimal implementation**

Add a helper function at the top of `agentChatSlice.ts` to identify if content blocks are tool-only:

```typescript
import type {
  AgentChatState,
  AgentTimelineItem,
  ChatContentBlock,
  ChatMessage,
  ChatSessionState,
  QuestionDefinition,
} from './agentChatTypes'

/** Check if content blocks contain only tool_use and tool_result blocks (no text or thinking). */
function isToolOnlyContent(blocks: ChatContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every(
    (b) => b.type === 'tool_use' || b.type === 'tool_result'
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts --run
```

Expected: All tests pass

- [ ] **Step 5: Refactor and verify**

The helper is minimal. Run typecheck:

```bash
npx tsc --noEmit -p src/tsconfig.json
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/store/agentChatSlice.ts
git commit -m "feat(agent-chat): add isToolOnlyContent helper for message coalescing"
```

---

## Task 2: Implement Coalescing in addAssistantMessage Reducer

**Files:**
- Modify: `src/store/agentChatSlice.ts:109-123`

- [ ] **Step 1: Write the failing test**

Add test to `test/unit/client/agentChatSlice.test.ts`:

```typescript
describe('tool message coalescing', () => {
  it('coalesces consecutive tool-only assistant messages', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    
    // First tool-only message
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    
    // Second tool-only message - should coalesce
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } },
      ],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].content).toHaveLength(3)
    expect(state.sessions['s1'].messages[0].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
    expect(state.sessions['s1'].messages[0].content[1]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'output' })
    expect(state.sessions['s1'].messages[0].content[2]).toEqual({ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } })
  })

  it('does not coalesce when previous message has text content', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    
    // Message with text
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'text', text: 'Hello' }],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    
    // Tool-only message - should NOT coalesce (previous has text)
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(2)
  })

  it('does not coalesce when new message has text content', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    
    // Tool-only message
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    
    // Message with text - should NOT coalesce (new has text)
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'text', text: 'Done' }],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(2)
  })

  it('coalesces multiple consecutive tool-only messages', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    }))
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file1' }],
    }))
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } }],
    }))
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_result', tool_use_id: 't2', content: 'content' }],
    }))
    
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].content).toHaveLength(4)
  })

  it('does not coalesce across user messages', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    }))
    state = agentChatReducer(state, addUserMessage({ sessionId: 's1', text: 'Thanks' }))
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } }],
    }))
    
    expect(state.sessions['s1'].messages).toHaveLength(3) // assistant, user, assistant
  })
})
```

Run to verify it fails:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts --run -t "tool message coalescing"
```

Expected: FAIL - "expected 1 to equal 2" (messages not coalescing)

- [ ] **Step 2: Run test to verify it fails**

(Already confirmed above)

- [ ] **Step 3: Write minimal implementation**

Modify `addAssistantMessage` reducer in `src/store/agentChatSlice.ts`:

```typescript
addAssistantMessage(state, action: PayloadAction<{
  sessionId: string
  content: ChatContentBlock[]
  model?: string
}>) {
  const session = state.sessions[action.payload.sessionId]
  if (!session) return
  
  const newContent = action.payload.content
  const prevMessage = session.messages[session.messages.length - 1]
  
  // Coalesce consecutive tool-only assistant messages
  if (
    prevMessage?.role === 'assistant' &&
    isToolOnlyContent(prevMessage.content) &&
    isToolOnlyContent(newContent)
  ) {
    // Append content blocks to previous message instead of creating new one
    prevMessage.content = [...prevMessage.content, ...newContent]
  } else {
    session.messages.push({
      role: 'assistant',
      content: newContent,
      timestamp: new Date().toISOString(),
      model: action.payload.model,
    })
  }
  session.status = 'running'
},
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts --run -t "tool message coalescing"
```

Expected: All 5 coalescing tests pass

- [ ] **Step 5: Refactor and verify**

Run full agentChatSlice test suite and typecheck:

```bash
npm run test:vitest -- test/unit/client/agentChatSlice.test.ts --run
npx tsc --noEmit -p src/tsconfig.json
```

Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/store/agentChatSlice.ts test/unit/client/agentChatSlice.test.ts
git commit -m "feat(agent-chat): coalesce consecutive tool-only assistant messages"
```

---

## Task 3: Implement Coalescing in Session History Loader

**Files:**
- Modify: `server/session-history-loader.ts:30-68`
- Modify: `test/unit/server/session-history-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Add test to `test/unit/server/session-history-loader.test.ts`:

```typescript
describe('tool message coalescing', () => {
  it('coalesces consecutive tool-only assistant messages from JSONL', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"t1","content":"file1\\nfile2"}]},"timestamp":"2026-01-01T00:00:02Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"f.ts"}}]},"timestamp":"2026-01-01T00:00:03Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toHaveLength(3)
    expect(messages[0].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
    expect(messages[0].content[1]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' })
    expect(messages[0].content[2]).toEqual({ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } })
  })

  it('does not coalesce when assistant message has text content', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
  })

  it('does not coalesce across user messages', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Thanks"}]},"timestamp":"2026-01-01T00:00:02Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"f.ts"}}]},"timestamp":"2026-01-01T00:00:03Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(3)
  })

  it('preserves timestamp from first message in coalesced group', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0].timestamp).toBe('2026-01-01T00:00:01Z')
  })
})
```

Run to verify it fails:

```bash
npm run test:vitest -- test/unit/server/session-history-loader.test.ts --run -t "tool message coalescing"
```

Expected: FAIL - messages not coalescing

- [ ] **Step 2: Run test to verify it fails**

(Already confirmed above)

- [ ] **Step 3: Write minimal implementation**

Modify `extractChatMessagesFromJsonl` in `server/session-history-loader.ts`:

```typescript
export function extractChatMessagesFromJsonl(content: string): ChatMessage[] {
  const lines = content.split(/\r?\n/).filter(Boolean)
  const messages: ChatMessage[] = []

  /** Check if content blocks contain only tool_use and tool_result blocks. */
  const isToolOnly = (blocks: ContentBlock[]): boolean =>
    blocks.length > 0 && blocks.every(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    )

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue

    const role = obj.type as 'user' | 'assistant'
    const timestamp = obj.timestamp as string | undefined
    const msg = obj.message

    let newContent: ContentBlock[]
    let newMessage: ChatMessage

    if (typeof msg === 'string') {
      newContent = [{ type: 'text', text: msg }]
      newMessage = {
        role,
        content: newContent,
        ...(timestamp ? { timestamp } : {}),
      }
    } else if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      newContent = msg.content as ContentBlock[]
      newMessage = {
        role: msg.role || role,
        content: newContent,
        ...(timestamp ? { timestamp } : {}),
        ...(msg.model ? { model: msg.model } : {}),
      }
    } else {
      continue
    }

    // Coalesce consecutive tool-only assistant messages
    const prevMessage = messages[messages.length - 1]
    if (
      prevMessage?.role === 'assistant' &&
      newMessage.role === 'assistant' &&
      isToolOnly(prevMessage.content) &&
      isToolOnly(newMessage.content)
    ) {
      // Append content blocks to previous message
      prevMessage.content = [...prevMessage.content, ...newMessage.content]
    } else {
      messages.push(newMessage)
    }
  }

  return messages
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:vitest -- test/unit/server/session-history-loader.test.ts --run -t "tool message coalescing"
```

Expected: All 4 coalescing tests pass

- [ ] **Step 5: Refactor and verify**

Run full test suite and typecheck:

```bash
npm run test:vitest -- test/unit/server/session-history-loader.test.ts --run
npx tsc --noEmit -p server/tsconfig.json
```

Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add server/session-history-loader.ts test/unit/server/session-history-loader.test.ts
git commit -m "feat(server): coalesce consecutive tool-only assistant messages in JSONL loader"
```

---

## Task 4: Run Full Test Suite

**Files:**
- None (verification only)

- [ ] **Step 1: Run full unit test suite**

```bash
npm run test:vitest -- test/unit --run
```

Expected: All tests pass

- [ ] **Step 2: Run typecheck**

```bash
npm run check
```

Expected: All checks pass

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: No errors

- [ ] **Step 4: Commit if any fixes were needed**

(Only if fixes were made)

```bash
git add -A
git commit -m "fix: address test/typecheck/lint issues from tool coalescing"
```

---

## Task 5: Browser-Use Visual Verification

**Files:**
- Create: `test/browser_use/tool-coalesce.md` (test instructions, not code)

**Prerequisites:**
- `browser-use` CLI installed: `uvx "browser-use[cli]" --help` (or `pip install "browser-use[cli]"`)
- Chromium installed: `browser-use install`
- API key: `BROWSER_USE_API_KEY` environment variable (for Browser Use's hosted LLM gateway)

- [ ] **Step 1: Ensure browser-use is available**

```bash
# Check if browser-use is installed
browser-use --version || uvx "browser-use[cli]" --help

# Install Chromium if needed
browser-use install
```

Expected: browser-use CLI available, Chromium installed

- [ ] **Step 2: Start Freshell server on test port**

```bash
cd /home/user/code/freshell/.worktrees/tool-coalesce
PORT=3355 npm run dev:server > /tmp/freshell-3355.log 2>&1 & echo $! > /tmp/freshell-3355.pid
sleep 5
curl -s http://localhost:3355/api/health > /dev/null && echo "Server ready"
```

Expected: "Server ready"

- [ ] **Step 3: Navigate to Freshell and find a session with tools**

```bash
browser-use open http://localhost:3355
browser-use state
```

Expected: Page loads, shows Freshell UI

- [ ] **Step 4: Navigate to Freshclaude session**

Using browser-use, find and click on a Freshclaude session in the sidebar that has tool uses. If no session exists with multiple tools, create a test scenario by sending a message that triggers multiple tool calls.

```bash
# Get page state to find Freshclaude sessions
browser-use state

# Click on a session that shows tool indicators (look for "tools" or tool count)
# Example: browser-use click 3  # where 3 is the index of a Freshclaude session
```

- [ ] **Step 5: Verify tool strip coalescing with LLM as judge**

Use browser-use's `extract` command with LLM to verify the tool strip behavior:

```bash
# Extract tool strip information using LLM
browser-use extract "Find all tool strip regions on this page. For each strip, report: 1) The text shown (e.g., '2 tools used' or individual tool names), 2) Whether it's collapsed or expanded. Return as a JSON array."
```

Expected output: Single tool strip showing combined count like "2 tools used" or "3 tools used" - NOT multiple strips each showing "1 tool used"

- [ ] **Step 6: Take screenshot for evidence**

```bash
browser-use screenshot /tmp/tool-coalesce-verify.png
```

- [ ] **Step 7: Verify collapsed state shows single summary**

When the tool strip is collapsed, verify it shows one summary line:

```bash
browser-use extract "Count how many separate lines contain the text 'tool' or 'tools used'. Return only the number."
```

Expected: 1 (single summary line, not multiple "1 tool used" lines)

- [ ] **Step 8: Verify expand/collapse toggle works**

```bash
# Find and click the chevron to expand
browser-use state
# Look for chevron/expand button in the state output
# browser-use click <index>  # click the chevron

# Verify tools are now visible individually
browser-use extract "List all tool names visible on the page. Return as a comma-separated list."
```

Expected: Individual tool names visible after expansion

- [ ] **Step 9: Cleanup**

```bash
browser-use close
kill "$(cat /tmp/freshell-3355.pid)" && rm -f /tmp/freshell-3355.pid
```

- [ ] **Step 10: Create test documentation file**

Create `test/browser_use/tool-coalesce.md` documenting the test procedure:

```markdown
# Tool Coalescing Browser-Use Test

## Purpose
Verify that consecutive tool uses in an assistant turn are grouped into a single ToolStrip showing "N tools used" instead of multiple separate "1 tool used" strips.

## Prerequisites
- browser-use CLI installed
- Chromium installed (`browser-use install`)
- API key: `BROWSER_USE_API_KEY` environment variable

## Test Steps

1. Start Freshell server: `PORT=3355 npm run dev:server`
2. Navigate to Freshell: `browser-use open http://localhost:3355`
3. Open a Freshclaude session with multiple tool uses
4. Verify single tool strip with combined count using: `browser-use extract "Find all tool strip regions..."`
5. Verify collapsed state shows one summary line, not multiple
6. Verify expand/collapse chevron works

## Expected Results
- Single tool strip per assistant turn showing "N tools used"
- Chevron toggles strip visibility
- No multiple "1 tool used" strips for consecutive tools in same turn

## LLM Judge Criteria
Pass if LLM extraction returns single strip with combined count.
Fail if multiple strips each showing "1 tool used" for tools in same turn.
```

```bash
git add test/browser_use/tool-coalesce.md
git commit -m "test(browser-use): add tool coalescing visual verification procedure"
```

---

## Task 6: Final Verification and Integration

**Files:**
- None (verification only)

- [ ] **Step 1: Run coordinated full test suite**

```bash
FRESHELL_TEST_SUMMARY="tool-coalesce final verification" npm test
```

Expected: All tests pass

- [ ] **Step 2: Verify git status**

```bash
git status
git log --oneline -5
```

Expected: Clean working tree, all commits present

- [ ] **Step 3: Summary of changes**

Files changed:
- `src/store/agentChatSlice.ts` - Coalescing in `addAssistantMessage`
- `server/session-history-loader.ts` - Coalescing in `extractChatMessagesFromJsonl`
- `test/unit/client/agentChatSlice.test.ts` - Unit tests for Redux coalescing
- `test/unit/server/session-history-loader.test.ts` - Unit tests for loader coalescing
- `test/browser_use/tool-coalesce.md` - Browser-use test procedure

---

## Edge Cases and Invariants

### Invariants Preserved

1. **Message order is preserved** - Coalescing only appends content, never reorders
2. **User messages break coalescing** - Tool-only assistant messages on opposite sides of a user message stay separate
3. **Text content breaks coalescing** - Any text or thinking block prevents coalescing
4. **Timestamp from first message** - Coalesced message keeps timestamp of first message in group

### Edge Cases Handled

1. **Empty content array** - `isToolOnlyContent` returns false for empty arrays (no coalescing)
2. **Mixed content** - Text + tool_use in same message prevents coalescing with next
3. **Session not found** - Reducer returns early without modification
4. **Malformed JSONL** - Parser skips bad lines (existing behavior preserved)

### Regression Risks

1. **Timeline body hydration** - Uses same `ChatMessage` type, but `turnBodyReceived` stores separately (not affected)
2. **Message count in UI** - Count may decrease due to coalescing (expected behavior)
3. **Timestamp display** - First timestamp preserved (may differ from last tool's timestamp)

---

## Rollback Plan

If issues arise after merge:

1. Revert the two implementation commits
2. The coalescing logic is isolated to two functions - easy to disable by removing the `if` check
3. No database migrations or schema changes involved

---

## References

- `server/sdk-bridge.ts:273-296` - Where SDK assistant messages are created
- `src/lib/sdk-message-handler.ts:82-88` - Where `sdk.assistant` dispatches `addAssistantMessage`
- `src/components/agent-chat/MessageBubble.tsx:50-126` - Tool grouping logic within single message
- `test/unit/client/components/agent-chat/MessageBubble.test.tsx` - Existing grouping tests
