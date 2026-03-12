# Issue 156 FreshClaude Density Test Plan

## Scope

Validate that FreshClaude shows more chat content per viewport by using tighter spacing in the shared message and tool layout layers.

## Targeted Red-Green Checks

1. `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/ToolBlock.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`
   - Red: fails before the compact spacing changes land.
   - Green: passes after the shared chat components adopt the denser spacing.
2. `npx vitest run test/e2e/agent-chat-polish-flow.test.tsx`
   - Red: fails before the integrated FreshClaude view uses the new spacing.
   - Green: passes after the full view renders the denser layout.

## Regression Verification

1. `npx vitest run test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/ToolBlock.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/e2e/agent-chat-polish-flow.test.tsx`
   - Confirms the focused shared-component and integration coverage together.
2. `CI=true npm test`
   - Confirms the broader client/server suite still passes.

## Notes

- This is a FreshClaude presentation-density change only; no README update is expected.
