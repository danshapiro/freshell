# Tool Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coalesce consecutive tool-only assistant messages into a single message so that multiple tool uses appear in ONE ToolStrip showing "N tools used" instead of multiple separate "1 tool used" strips.

**Architecture:** The SDK sends separate `assistant` messages (one per tool_use block). The fix intercepts at two points: (1) the Redux `addAssistantMessage` reducer for live messages, and (2) the `extractChatMessagesFromJsonl` function for restored sessions. Both locations check if the previous message is also a tool-only assistant message, and if so, append content blocks instead of creating a new message.

**Tech Stack:** Redux Toolkit, TypeScript, Vitest, Testing Library, browser-use (Python)

---

## Root Cause Analysis

The Claude SDK sends multiple `assistant` messages (one per `tool_use` block). The server's `sdk-bridge.ts` creates a **new Redux message** for each SDK message. Each message becomes a separate `MessageBubble`, each with its own `ToolStrip` showing "1 tool used".

The `MessageBubble` grouping logic correctly groups consecutive `tool_use` blocks **within a single message's content array**, but cannot merge across separate messages.

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
| `test/browser_use/tool_coalesce.py` | Create | Automated browser-use test with LLM judge |
| `test/browser_use/tool_coalesce_test.py` | Create | Unit tests for parsing logic |

---

## Task 1: Implement Coalescing in addAssistantMessage Reducer

**Files:**
- Modify: `src/store/agentChatSlice.ts` (add helper after imports, modify reducer)

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

First, add helper function after the imports in `src/store/agentChatSlice.ts` (after line 9, before `initialState`):

```typescript
/** Check if content blocks contain only tool_use and tool_result blocks (no text or thinking). */
function isToolOnlyContent(blocks: ChatContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every(
    (b) => b.type === 'tool_use' || b.type === 'tool_result'
  )
}
```

Then modify the `addAssistantMessage` reducer:

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

## Task 2: Implement Coalescing in Session History Loader

**Files:**
- Modify: `server/session-history-loader.ts`
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

## Task 3: Run Full Test Suite

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

## Task 4: Create Automated Browser-Use Test

**Files:**
- Create: `test/browser_use/tool_coalesce.py`
- Create: `test/browser_use/tool_coalesce_test.py`

This task creates an **automated** browser-use test following the repo's established pattern (`smoke_freshell.py`). The test uses an LLM as judge to verify tool strip coalescing.

- [ ] **Step 1: Create the test parsing utilities**

Create `test/browser_use/tool_coalesce_test.py` with unit tests for result parsing:

```python
import unittest
from tool_coalesce import _parse_result


class ToolCoalesceParseTest(unittest.TestCase):
  def test_pass_requires_exact_single_line(self) -> None:
    ok, err = _parse_result("TOOL_COALESCE_RESULT: PASS")
    self.assertTrue(ok)
    self.assertIsNone(err)

  def test_pass_with_extra_text_is_invalid(self) -> None:
    ok, err = _parse_result("TOOL_COALESCE_RESULT: PASS. extra")
    self.assertFalse(ok)
    self.assertEqual(err, "final_result_invalid_format")

  def test_fail_requires_reason(self) -> None:
    ok, err = _parse_result("TOOL_COALESCE_RESULT: FAIL - multiple strips found")
    self.assertFalse(ok)
    self.assertIsNone(err)

  def test_empty_is_invalid(self) -> None:
    ok, err = _parse_result("")
    self.assertFalse(ok)
    self.assertEqual(err, "missing_final_result")

  def test_multiple_lines_is_invalid(self) -> None:
    ok, err = _parse_result("TOOL_COALESCE_RESULT: PASS\nmore")
    self.assertFalse(ok)
    self.assertEqual(err, "final_result_not_single_line")


if __name__ == "__main__":
  raise SystemExit(unittest.main())
```

- [ ] **Step 2: Run parsing tests to verify they fail (module not created yet)**

```bash
cd /home/user/code/freshell/.worktrees/tool-coalesce/test/browser_use
python -m pytest tool_coalesce_test.py -v 2>&1 || echo "Expected to fail - module not created"
```

Expected: Import error (module not created yet)

- [ ] **Step 3: Create the main browser-use test script**

Create `test/browser_use/tool_coalesce.py`:

```python
#!/usr/bin/env python3
"""
Browser-use test for tool strip coalescing in Freshclaude.

Verifies that consecutive tool uses in an assistant turn appear as ONE
strip showing "N tools used" instead of multiple separate "1 tool used" strips.
Uses an LLM as judge to evaluate the visual result.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import logging
import urllib.request
from pathlib import Path

# Add parent directory for shared utilities
sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke_utils import (
  JsonLogger,
  build_target_url,
  default_base_url,
  env_or,
  find_upwards,
  load_dotenv,
  monotonic_timer,
  redact_url,
  redact_text,
  require,
  token_fingerprint,
)


def _parse_result(final_text: str) -> tuple[bool, str | None]:
  """
  Enforce strict output contract:
  - Exactly one line
  - Exactly "TOOL_COALESCE_RESULT: PASS"
    or "TOOL_COALESCE_RESULT: FAIL - <short reason>"
  """
  text = (final_text or "").strip()
  if not text:
    return False, "missing_final_result"

  lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
  if len(lines) != 1:
    return False, "final_result_not_single_line"

  line = lines[0]
  if line == "TOOL_COALESCE_RESULT: PASS":
    return True, None
  if line.startswith("TOOL_COALESCE_RESULT: FAIL - ") and len(line) > len("TOOL_COALESCE_RESULT: FAIL - "):
    return False, None
  return False, "final_result_invalid_format"


def _build_task(*, base_url: str) -> str:
  return f"""
You are testing the tool strip coalescing feature in a Freshell Freshclaude session.

The app is already opened and authenticated at {base_url}.

Your goal: Verify that when an assistant turn uses multiple tools, they appear grouped in ONE tool strip showing "N tools used" instead of multiple separate "1 tool used" strips.

Steps:

1. Open the sidebar if it's collapsed. Look for Freshclaude sessions (they have a different icon than shell tabs).

2. Find and click on a Freshclaude session that has assistant messages with tool uses. Look for sessions that show tool indicators or message counts.

3. If no session with multiple tool uses exists, skip to step 7 and report what you found.

4. Once in a session, look at the assistant messages that contain tool uses. Find a message where the assistant used 2 or more tools in a single turn.

5. Examine the tool strip display for that message:
   - A tool strip should be visible showing either "N tools used" (collapsed) or individual tool blocks (expanded)
   - Count how many separate tool-related text lines are visible (e.g., "1 tool used", "2 tools used", etc.)

6. Judge the result:
   - PASS: You see ONE tool strip per assistant turn, showing the combined count (e.g., "2 tools used" or "3 tools used")
   - FAIL: You see MULTIPLE separate lines each showing "1 tool used" for tools that should be grouped

7. Report your findings as exactly one line:
   - If tool strips are correctly coalesced: TOOL_COALESCE_RESULT: PASS
   - If you see multiple separate "1 tool used" strips: TOOL_COALESCE_RESULT: FAIL - multiple strips found
   - If no suitable session found: TOOL_COALESCE_RESULT: FAIL - no session with tools

Non-negotiable constraints:
- Do not create or write any files
- Stay in ONE browser tab
- Output exactly one result line at the end
"""


async def _run(args: argparse.Namespace) -> int:
  repo_root = Path(__file__).resolve().parents[2]
  dotenv_path = find_upwards(repo_root, ".env")
  dotenv = load_dotenv(dotenv_path) if dotenv_path else {}

  log = JsonLogger(min_level=("debug" if args.debug else "info"))

  if args.require_api_key and not os.environ.get("BROWSER_USE_API_KEY"):
    log.error("Missing BROWSER_USE_API_KEY", event="missing_browser_use_api_key")
    return 2

  base_url = args.base_url or default_base_url(dotenv)
  token = env_or(args.token, "AUTH_TOKEN") or dotenv.get("AUTH_TOKEN")
  try:
    token = require("AUTH_TOKEN", token)
  except ValueError as e:
    log.error(str(e), event="missing_auth_token")
    return 2

  model = env_or(args.model, "BROWSER_USE_MODEL") or "bu-latest"
  target_url = build_target_url(base_url, token)
  redacted_target_url = redact_url(target_url)

  log.info(
    "Tool coalesce test start",
    event="test_start",
    baseUrl=base_url,
    tokenFp=token_fingerprint(token),
    model=model,
    headless=args.headless,
  )

  if args.preflight:
    health_url = f"{base_url.rstrip('/')}/api/health"
    try:
      with urllib.request.urlopen(health_url, timeout=3) as resp:
        log.info("Preflight ok", event="preflight_ok", url=health_url)
    except Exception as e:
      log.error("Preflight failed", event="preflight_failed", url=health_url, error=str(e))
      return 1

  from browser_use import Agent, Browser, ChatBrowserUse  # type: ignore

  llm = ChatBrowserUse(model=model)
  browser = Browser(
    headless=args.headless,
    window_size={"width": args.width, "height": args.height},
    viewport={"width": args.width, "height": args.height},
    no_viewport=False,
  )
  browser_started = False

  try:
    log.info("Pre-opening target URL", event="preopen_target", targetUrl=redacted_target_url)
    await browser.start()
    browser_started = True

    # Navigate to authenticated URL
    page = await browser.new_page(target_url)

    log.info("Target URL opened", event="preopen_target_ok")
  except Exception as e:
    log.error("Failed to pre-open target URL", event="preopen_target_failed", error=str(e))
    if browser_started:
      try:
        await browser.stop()
      except Exception:
        pass
    return 1

  task = _build_task(base_url=base_url)

  agent = Agent(
    task=task.strip(),
    llm=llm,
    browser=browser,
    use_vision=True,
    max_actions_per_step=2,
    directly_open_url=False,
  )

  _start, elapsed_s = monotonic_timer()
  try:
    log.info("Agent run start", event="agent_run_start", maxSteps=args.max_steps)
    history = await agent.run(max_steps=args.max_steps)
  finally:
    if browser_started:
      try:
        await browser.stop()
      except Exception:
        pass

  log.info("Agent finished", event="agent_finished", elapsedS=round(elapsed_s(), 2))

  final_result_fn = getattr(history, "final_result", None)
  final = final_result_fn() if callable(final_result_fn) else None
  final_text = str(final or "").strip()

  ok, parse_err = _parse_result(final_text)
  if parse_err:
    log.error("Invalid final_result format", event="invalid_final_result", error=parse_err, text=final_text[:500])
    return 1
  if ok:
    log.info("TOOL_COALESCE_RESULT: PASS", event="test_pass")
    return 0
  log.error("TOOL_COALESCE_RESULT: FAIL", event="test_fail", reason=final_text[:500])
  return 1


def main(argv: list[str]) -> int:
  p = argparse.ArgumentParser(description="Browser-use test for tool strip coalescing.")
  p.add_argument("--base-url", default=None, help="Base URL")
  p.add_argument("--token", default=None, help="Auth token")
  p.add_argument("--model", default=None, help="Browser Use model")
  p.add_argument("--headless", action="store_true", help="Run headless")
  p.add_argument("--width", type=int, default=1024)
  p.add_argument("--height", type=int, default=768)
  p.add_argument("--max-steps", type=int, default=30)
  p.add_argument("--preflight", action="store_true", help="Check /api/health first")
  p.add_argument("--debug", action="store_true")
  p.add_argument("--no-require-api-key", dest="require_api_key", action="store_false")
  p.set_defaults(require_api_key=True)
  args = p.parse_args(argv)
  try:
    return asyncio.run(_run(args))
  except KeyboardInterrupt:
    return 130
  except Exception:
    sys.stderr.write(__import__("traceback").format_exc())
    return 1


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run parsing tests to verify they pass**

```bash
cd /home/user/code/freshell/.worktrees/tool-coalesce/test/browser_use
python -m pytest tool_coalesce_test.py -v
```

Expected: All parsing tests pass

- [ ] **Step 5: Make the test script executable and verify syntax**

```bash
chmod +x /home/user/code/freshell/.worktrees/tool-coalesce/test/browser_use/tool_coalesce.py
python -m py_compile /home/user/code/freshell/.worktrees/tool-coalesce/test/browser_use/tool_coalesce.py
```

Expected: No syntax errors

- [ ] **Step 6: Commit**

```bash
git add test/browser_use/tool_coalesce.py test/browser_use/tool_coalesce_test.py
git commit -m "test(browser-use): add automated tool coalescing verification with LLM judge"
```

---

## Task 5: Final Verification and Integration

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
- `src/store/agentChatSlice.ts` - Coalescing in `addAssistantMessage` + helper function
- `server/session-history-loader.ts` - Coalescing in `extractChatMessagesFromJsonl`
- `test/unit/client/agentChatSlice.test.ts` - Unit tests for Redux coalescing
- `test/unit/server/session-history-loader.test.ts` - Unit tests for loader coalescing
- `test/browser_use/tool_coalesce.py` - Automated browser-use test with LLM judge
- `test/browser_use/tool_coalesce_test.py` - Unit tests for parsing logic

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

1. Revert the implementation commits
2. The coalescing logic is isolated to two functions - easy to disable by removing the `if` check
3. No database migrations or schema changes involved

---

## References

- `server/sdk-bridge.ts` - Where SDK assistant messages are created
- `src/lib/sdk-message-handler.ts` - Where `sdk.assistant` dispatches `addAssistantMessage`
- `src/components/agent-chat/MessageBubble.tsx` - Tool grouping logic within single message
- `test/unit/client/components/agent-chat/MessageBubble.test.tsx` - Existing grouping tests
- `test/browser_use/smoke_freshell.py` - Pattern for browser-use tests in this repo
