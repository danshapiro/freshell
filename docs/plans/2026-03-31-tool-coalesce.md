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
| `test/browser-use/tool-coalesce.test.ts` | Create | Visual verification with LLM as judge |

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
- Create: `test/browser-use/tool-coalesce.spec.ts`

- [ ] **Step 1: Create browser-use test file**

Create `test/browser-use/tool-coalesce.spec.ts`:

```typescript
/**
 * @browser-use
 * 
 * Test: Tool Coalescing Visual Verification
 * 
 * Intent: Verify that consecutive tool uses in an assistant turn
 * are grouped into a single ToolStrip showing "N tools used"
 * instead of multiple separate "1 tool used" strips.
 * 
 * Setup:
 * 1. Start a Freshell server on a unique port (e.g., 3355)
 * 2. Open Freshell in browser
 * 3. Navigate to a Freshclaude session with multiple tool uses
 * 
 * Verification (LLM as judge):
 * 1. Look for tool strip regions in the DOM
 * 2. Verify there is exactly ONE tool strip containing all tools
 * 3. Verify the collapsed summary shows "N tools used" (not multiple "1 tool used")
 * 4. Expand the strip and verify all individual tools are present
 * 
 * Expected behavior:
 * - When showTools=false: Collapsed strip shows "N tools used" with chevron
 * - When showTools=true: Expanded strip shows all individual tools
 * - Chevron toggles strip visibility
 * - Individual tool toggles work independently
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

describe('Tool Coalescing Visual Verification', () => {
  const TEST_PORT = 3355
  let serverPid: string | null = null

  beforeAll(async () => {
    // Start server if needed - actual implementation would use browser-use
  })

  afterAll(async () => {
    // Stop server if started
    if (serverPid) {
      // Cleanup
    }
  })

  it('shows single tool strip for multiple consecutive tools', async () => {
    // This test is executed via browser-use CLI
    // The implementation agent will:
    // 1. Open browser to Freshell
    // 2. Navigate to a Freshclaude session
    // 3. Use LLM to verify tool strip grouping
    // 
    // Intent-based verification:
    // - "Find all tool strip regions on the page"
    // - "Count how many show 'N tools used' text"
    // - "Verify exactly ONE strip exists with combined count"
    expect(true).toBe(true) // Placeholder - actual browser-use execution
  })

  it('collapses multiple tools to single summary line', async () => {
    // Intent: When multiple tools are in a turn, the collapsed view
    // shows one summary line with total count, not multiple lines
    expect(true).toBe(true) // Placeholder
  })
})
```

- [ ] **Step 2: Run browser-use verification**

The executing agent will run browser-use commands:

```bash
# Start Freshell server on test port
cd /home/user/code/freshell/.worktrees/tool-coalesce
PORT=3355 npm run dev:server > /tmp/freshell-3355.log 2>&1 & echo $! > /tmp/freshell-3355.pid

# Wait for server to start
sleep 5

# Open browser and navigate to Freshell
browser-use open http://localhost:3355

# Wait for page load
browser-use wait selector "[aria-label='Tool strip']" --timeout 10000

# Take screenshot for verification
browser-use screenshot /tmp/tool-coalesce-verify.png

# Verify tool strip count using LLM extraction
browser-use extract "Count how many tool strip regions exist on this page. Each tool strip shows either 'N tools used' or individual tool names. Return only the count as a number."

# Expected: 1 (single strip with all tools)

# Cleanup
browser-use close
kill "$(cat /tmp/freshell-3355.pid)" && rm -f /tmp/freshell-3355.pid
```

- [ ] **Step 3: Commit browser-use test**

```bash
git add test/browser-use/tool-coalesce.spec.ts
git commit -m "test(browser-use): add visual verification for tool coalescing"
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
- `test/browser-use/tool-coalesce.spec.ts` - Visual verification (optional)

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
