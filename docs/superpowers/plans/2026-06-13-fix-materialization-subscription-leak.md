# Fix Fresh-Agent Materialization Subscription Leak

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an OpenCode fresh-agent placeholder session materializes into a durable session, cancel the old placeholder subscription and clean up stale entries so events are delivered exactly once.

**Architecture:** Two layers need fixes. (1) The WS handler's `freshAgent.send` case must cancel the old placeholder subscription before creating the new one. (2) The runtime manager's `send()` must delete the old placeholder key from its sessions Map after adding the new one, and `kill()` must clean up both keys. Both fixes are small, surgical changes to existing methods.

**Tech Stack:** Node.js/Express, WebSocket (ws), Vitest, supertest

---

### Task 1: WS handler — cancel old subscription on materialization

The core bug. In `server/ws-handler.ts`, the `freshAgent.send` handler creates a new subscription for the materialized session ID but never cancels the old placeholder subscription. Both listen on the same EventEmitter, so every event is sent to the client twice.

**Files:**
- Modify: `server/ws-handler.ts:3677` (the materialization branch inside the `freshAgent.send` case)
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test after the existing `'emits freshAgent.session.materialized when send returns a new session id'` test (currently ending at line 548):

```typescript
it('cancels the old placeholder subscription after materialization', async () => {
  const unsubscribePlaceholder = vi.fn()
  const unsubscribeReal = vi.fn()
  const runtimeManager = {
    create: vi.fn().mockResolvedValue({
      sessionId: 'freshopencode-req-1',
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
    }),
    subscribe: vi.fn()
      .mockResolvedValueOnce(unsubscribePlaceholder)
      .mockResolvedValueOnce(unsubscribeReal),
    send: vi.fn().mockResolvedValue({
      sessionId: 'ses_real_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    }),
  }
  const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

  try {
    const ws = await connectAndAuth(server)
    const seenMessages: any[] = []
    ws.on('message', (data) => {
      seenMessages.push(JSON.parse(data.toString()))
    })

    ws.send(JSON.stringify({
      type: 'freshAgent.create',
      requestId: 'req-unsub',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }))

    await vi.waitFor(() => {
      expect(seenMessages).toContainEqual(expect.objectContaining({
        type: 'freshAgent.created',
        sessionId: 'freshopencode-req-1',
      }))
    })

    // First subscribe call is for the placeholder
    expect(runtimeManager.subscribe).toHaveBeenCalledWith(
      { sessionId: 'freshopencode-req-1', sessionType: 'freshopencode', provider: 'opencode' },
      expect.any(Function),
    )

    ws.send(JSON.stringify({
      type: 'freshAgent.send',
      sessionId: 'freshopencode-req-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      text: 'hello',
    }))

    await vi.waitFor(() => {
      expect(seenMessages).toContainEqual(expect.objectContaining({
        type: 'freshAgent.session.materialized',
        sessionId: 'ses_real_1',
      }))
    })

    // The old placeholder unsubscribe function must have been called
    expect(unsubscribePlaceholder).toHaveBeenCalled()

    // The new real-session subscription must have been created
    expect(runtimeManager.subscribe).toHaveBeenCalledWith(
      { sessionId: 'ses_real_1', sessionType: 'freshopencode', provider: 'opencode' },
      expect.any(Function),
    )
  } finally {
    handler.close()
    registry.shutdown()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-fresh-agent.test.ts -t "cancels the old placeholder subscription after materialization"`

Expected: FAIL — `unsubscribePlaceholder` is never called because the current code doesn't cancel the old subscription.

- [ ] **Step 3: Implement the fix**

In `server/ws-handler.ts`, find the `freshAgent.send` case (line 3668). Inside the materialization branch (line 3677), add one line to cancel the old subscription before creating the new one:

```typescript
      case 'freshAgent.send': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.send) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        try {
          const result = await manager.send(locator, { text: m.text, images: m.images, settings: m.settings })
          if (result?.sessionId && result.sessionId !== m.sessionId) {
            this.cancelFreshAgentSubscription(state, locator)
            this.ensureFreshAgentSubscription(ws, state, {
              sessionId: result.sessionId,
              sessionType: m.sessionType,
              provider: m.provider,
            })
            this.send(ws, {
              type: 'freshAgent.session.materialized',
              previousSessionId: m.sessionId,
              sessionId: result.sessionId,
              sessionType: m.sessionType,
              provider: m.provider,
              sessionRef: result.sessionRef ?? { provider: m.provider, sessionId: result.sessionId },
            })
          }
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }
```

The only change is the addition of `this.cancelFreshAgentSubscription(state, locator)` on the line before `this.ensureFreshAgentSubscription(...)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-fresh-agent.test.ts -t "cancels the old placeholder subscription after materialization"`

Expected: PASS

- [ ] **Step 5: Run the full fresh-agent WS handler test file**

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-fresh-agent.test.ts`

Expected: All tests PASS (existing materialization test still passes since it doesn't assert on unsubscribe)

- [ ] **Step 6: Commit**

```bash
git add server/ws-handler.ts test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "fix: cancel old placeholder subscription after fresh-agent materialization

When an OpenCode fresh-agent placeholder session materialized into a
durable session (freshopencode-* -> ses_*), the WS handler created a
new subscription for the real session ID but never cancelled the old
placeholder subscription. Both subscriptions listened on the same
EventEmitter, causing every event to be delivered twice to the client.

Cancel the old subscription before creating the new one."
```

---

### Task 2: Runtime manager — clean up placeholder key after materialization

The runtime manager's `send()` method adds the new materialized session ID to its `sessions` Map but never removes the old placeholder key. This is a secondary leak: after `kill()` is called with the new ID, the old placeholder entry remains dangling.

**Files:**
- Modify: `server/fresh-agent/runtime-manager.ts:156-162` (the `send()` method's alias branch)
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test after the existing `'registers adapter send aliases while keeping the original placeholder routable'` test (currently ending at line 244):

```typescript
it('cleans up the old placeholder key from sessions after kill via the materialized id', async () => {
  const opencodeAdapter = {
    create: vi.fn().mockResolvedValue({
      sessionId: 'freshopencode-req-cleanup',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-cleanup' },
    }),
    send: vi.fn().mockResolvedValue({
      sessionId: 'ses_real_cleanup',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_cleanup' },
    }),
    kill: vi.fn().mockResolvedValue(true),
  }
  const registry = createFreshAgentProviderRegistry([
    {
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      adapter: opencodeAdapter as any,
    },
  ])
  const manager = new FreshAgentRuntimeManager({ registry })
  await manager.create({ requestId: 'req-cleanup', sessionType: 'freshopencode' })

  // Materialize: send returns a new session id, manager registers alias
  await manager.send({
    sessionId: 'freshopencode-req-cleanup',
    sessionType: 'freshopencode',
    provider: 'opencode',
  }, { text: 'materialize' })

  // Kill via the real id
  await manager.kill({
    sessionId: 'ses_real_cleanup',
    sessionType: 'freshopencode',
    provider: 'opencode',
  })

  // The old placeholder key must also be gone — interacting via it should throw
  await expect(manager.send({
    sessionId: 'freshopencode-req-cleanup',
    sessionType: 'freshopencode',
    provider: 'opencode',
  }, { text: 'should fail' })).rejects.toThrow(/not tracked/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/runtime-manager.test.ts -t "cleans up the old placeholder key"`

Expected: FAIL — the placeholder key still exists after `kill()`, so `send()` succeeds instead of throwing.

- [ ] **Step 3: Implement the fix**

In `server/fresh-agent/runtime-manager.ts`, modify the `send()` method. When a new session ID is returned (materialization), replace the old key rather than just adding a new one:

```typescript
  async send(
    locator: FreshAgentSessionLocator,
    input: { text: string; images?: FreshAgentInputImage[]; settings?: FreshAgentCreateRequest },
  ): Promise<FreshAgentSendResult> {
    const record = this.requireSession(locator)
    if (!record.adapter.send) {
      throw new FreshAgentUnsupportedCapabilityError(`Send is not supported for ${record.sessionType}`)
    }
    const result = await record.adapter.send(locator.sessionId, input)
    if (result?.sessionId && result.sessionId !== locator.sessionId) {
      this.sessions.delete(this.key(locator))
      this.sessions.set(this.key({
        sessionType: locator.sessionType,
        provider: record.runtimeProvider,
        sessionId: result.sessionId,
      }), record)
    }
    return result
  }
```

The only change is adding `this.sessions.delete(this.key(locator))` before the `this.sessions.set(...)` call.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/runtime-manager.test.ts -t "cleans up the old placeholder key"`

Expected: PASS

- [ ] **Step 5: Update the existing aliasing test**

The existing test `'registers adapter send aliases while keeping the original placeholder routable'` (line 185) asserts that the placeholder key remains routable after materialization. With our fix, the placeholder key is deleted. This test needs to be updated to reflect the new correct behavior: after materialization, subsequent sends via the placeholder should throw, and sends via the real ID should succeed.

Replace the body of the test at line 185 with:

```typescript
it('replaces placeholder key with materialized key after send', async () => {
  const opencodeAdapter = {
    create: vi.fn().mockResolvedValue({
      sessionId: 'freshopencode-req-alias',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-alias' },
    }),
    send: vi.fn()
      .mockResolvedValueOnce({
        sessionId: 'ses_real_1',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
      })
      .mockResolvedValueOnce({
        sessionId: 'ses_real_1',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
      }),
  }
  const registry = createFreshAgentProviderRegistry([
    {
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      adapter: opencodeAdapter as any,
    },
  ])
  const manager = new FreshAgentRuntimeManager({ registry })
  await manager.create({ requestId: 'req-alias', sessionType: 'freshopencode' })

  // First send materializes — returns a new session id
  await expect(manager.send({
    sessionId: 'freshopencode-req-alias',
    sessionType: 'freshopencode',
    provider: 'opencode',
  }, { text: 'first' })).resolves.toEqual({
    sessionId: 'ses_real_1',
    sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
  })

  // Placeholder key is no longer routable
  await expect(manager.send({
    sessionId: 'freshopencode-req-alias',
    sessionType: 'freshopencode',
    provider: 'opencode',
  }, { text: 'via placeholder' })).rejects.toThrow(/not tracked/)

  // Real id is routable
  await expect(manager.send({
    sessionId: 'ses_real_1',
    sessionType: 'freshopencode',
    provider: 'opencode',
  }, { text: 'via real id' })).resolves.toEqual({
    sessionId: 'ses_real_1',
    sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
  })

  expect(opencodeAdapter.send).toHaveBeenNthCalledWith(1, 'freshopencode-req-alias', { text: 'first' })
  expect(opencodeAdapter.send).toHaveBeenNthCalledWith(2, 'ses_real_1', { text: 'via real id' })
})
```

- [ ] **Step 6: Verify the WS handler materialization flow still works end-to-end**

The WS handler's `freshAgent.send` case builds a locator with `sessionId: m.sessionId` (the placeholder). After `manager.send()` returns, the manager has already deleted the placeholder key and added the real key. Verify that subsequent WS messages from the client use the real session ID (which they do — the client updates its pane content to the new ID after receiving `freshAgent.session.materialized`).

Check: does any WS handler code reference the old placeholder locator after `manager.send()` returns? Read `server/ws-handler.ts:3677-3695`:

- `this.cancelFreshAgentSubscription(state, locator)` — uses the placeholder locator to cancel the WS subscription. This operates on the WS handler's own `freshAgentSubscriptions` map, not the runtime manager's sessions map. Safe.
- `this.ensureFreshAgentSubscription(ws, state, { sessionId: result.sessionId, ... })` — uses the new real session ID. The runtime manager's `subscribe()` will find the session via the real key. Safe.
- `this.send(ws, { type: 'freshAgent.session.materialized', ... })` — just sends a message. No manager interaction. Safe.

No issues.

- [ ] **Step 7: Run the full runtime manager test file**

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/runtime-manager.test.ts`

Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add server/fresh-agent/runtime-manager.ts test/unit/server/fresh-agent/runtime-manager.test.ts
git commit -m "fix: clean up placeholder key in runtime manager after materialization

FreshAgentRuntimeManager.send() added the new materialized session ID
to its sessions Map but never removed the old placeholder key. After
kill() was called with the new ID, the placeholder entry remained
dangling.

Delete the old key when replacing it with the materialized one."
```

---

### Task 3: Run the full test suite

- [ ] **Step 1: Run the coordinated full test suite**

Run: `npm run check`

Expected: Typecheck passes, all tests pass.

- [ ] **Step 2: If any failures, investigate and fix**

The two changes are isolated:
- `ws-handler.ts`: one added line (`this.cancelFreshAgentSubscription(state, locator)`)
- `runtime-manager.ts`: one added line (`this.sessions.delete(this.key(locator))`)

If any test outside the modified test files fails, it likely relied on the placeholder key remaining routable after materialization in the runtime manager. Search for test files that call `manager.send` with a placeholder ID after a prior send already materialized, and update them to use the real session ID instead.

- [ ] **Step 3: Commit any test fixes if needed**

```bash
git add -A
git commit -m "test: fix tests for materialization cleanup behavior"
```
