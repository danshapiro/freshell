# Issue 156 FreshClaude Density Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Decrease FreshClaude's vertical whitespace so more useful chat content is visible in the same viewport without hurting readability.

**Architecture:** Tighten spacing at the shared layout layers instead of one-off margins: the chat scroll container, message bubbles, collapsed turns, tool strips/blocks, thinking indicator, and composer chrome. Keep the behavior unchanged; only reduce excess vertical padding/gaps and markdown block spacing.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library

---

### Task 1: Capture the current density regression in unit and integration tests

**Files:**
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`
- Modify: `test/unit/client/components/agent-chat/ToolBlock.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing tests**

Add assertions that the FreshClaude scroll container uses tighter spacing classes, message bubbles use more compact padding, and tool strips/blocks use reduced vertical gaps. Extend the existing integration-style FreshClaude polish flow to assert that the rendered chat surface uses the denser spacing end-to-end.

**Step 2: Run targeted tests to verify they fail**

Run: `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/ToolBlock.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

Expected: FAIL because the current FreshClaude layout still uses the looser spacing classes.

Run: `npx vitest run test/e2e/agent-chat-polish-flow.test.tsx`

Expected: FAIL because the integrated FreshClaude chat view still renders the old vertical spacing.

### Task 2: Tighten FreshClaude layout spacing at the shared UI layers

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/MessageBubble.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Modify: `src/components/agent-chat/ToolStrip.tsx`
- Modify: `src/components/agent-chat/ToolBlock.tsx`
- Modify: `src/components/agent-chat/ThinkingIndicator.tsx`
- Modify: `src/components/agent-chat/ChatComposer.tsx`

**Step 1: Write the minimal implementation**

Reduce the large wrapper gaps and padding, trim markdown block margins, and make the tool chrome denser while preserving the existing left-border visual language and interaction behavior.

**Step 2: Run targeted tests**

Run: `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/ToolBlock.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

Expected: PASS

Run: `npx vitest run test/e2e/agent-chat-polish-flow.test.tsx`

Expected: PASS

### Task 3: Refactor and verify the combined surface

**Files:**
- Modify only files already touched for this issue

**Step 1: Keep density changes centralized**

Refactor only as needed so the denser spacing is expressed in the shared chat components rather than repeated in one-off wrappers.

**Step 2: Run broader verification**

Run: `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/ToolBlock.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/e2e/agent-chat-polish-flow.test.tsx`

Expected: PASS

Run: `CI=true npm test`

Expected: PASS

### Task 4: Commit the issue fix

**Files:**
- Stage the plan, component, and test changes from this issue only

**Step 1: Commit**

Run:

```bash
git add docs/plans/2026-03-09-issue-156-freshclaude-density.md \
  docs/plans/2026-03-09-issue-156-freshclaude-density-test-plan.md \
  src/components/agent-chat/AgentChatView.tsx \
  src/components/agent-chat/MessageBubble.tsx \
  src/components/agent-chat/CollapsedTurn.tsx \
  src/components/agent-chat/ToolStrip.tsx \
  src/components/agent-chat/ToolBlock.tsx \
  src/components/agent-chat/ThinkingIndicator.tsx \
  src/components/agent-chat/ChatComposer.tsx \
  test/unit/client/components/agent-chat/MessageBubble.test.tsx \
  test/unit/client/components/agent-chat/ToolStrip.test.tsx \
  test/unit/client/components/agent-chat/ToolBlock.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx \
  test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "style(agent-chat): tighten freshclaude spacing"
```

Expected: commit created with only the issue `#156` changes.
