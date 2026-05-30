# OpenCode Local Permission Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Freshell defer OpenCode permission policy to the OS user's OpenCode configuration instead of setting Freshell-specific OpenCode permission overrides.

**Architecture:** Freshell keeps launching OpenCode and Freshopencode, but stops advertising OpenCode permission controls and stops passing OpenCode permission overrides. Terminal OpenCode panes rely on the OpenCode CLI's resolved config, while Freshopencode `opencode run` calls no longer use `--dangerously-skip-permissions`. Claude and Codex permission behavior stays unchanged.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Node/Express, Vitest, Testing Library, Freshell extension manifests, OpenCode CLI.

---

## Scope Check

This is one cohesive product change with three surfaces:

- OpenCode terminal panes from the CLI extension manifest.
- Freshopencode panes from the fresh-agent runtime.
- User-facing documentation in `README.md`.

Do not edit the user's `~/.config/opencode` or project `.opencode` files in this product change. Machine/user OpenCode policy is configured outside the repo.

## File Structure

- Modify `extensions/opencode/freshell.json`: remove OpenCode permission support metadata so the built-in CLI extension no longer advertises a Freshell permission control or `OPENCODE_PERMISSION` mapping.
- Modify `server/terminal-registry.ts`: remove the fallback OpenCode `OPENCODE_PERMISSION` mapping used before extension bootstrap so all terminal-launch paths share the same "no Freshell OpenCode policy" contract.
- Modify `test/unit/server/terminal-registry.test.ts`: replace OpenCode permission-env expectations with regression coverage that permission settings do not affect OpenCode terminal launch specs.
- Modify `test/integration/extension-system.test.ts`: add built-in manifest coverage proving OpenCode does not expose permission mode support through the extension registry.
- Modify `src/lib/fresh-agent-registry.ts`: mark Freshopencode permission controls hidden and set its inert default to `default`.
- Modify `src/components/panes/PaneContainer.tsx`: avoid writing `permissionMode` into newly created Freshopencode pane content.
- Modify `src/lib/session-type-utils.ts`: avoid writing `permissionMode` into resumed Freshopencode pane content.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: avoid sending stale Freshopencode `permissionMode` values in `freshAgent.create` or `freshAgent.send` messages.
- Modify `test/unit/client/components/panes/PaneContainer.test.tsx`: prove Freshopencode picker-created panes do not carry Freshell permission policy.
- Modify `test/unit/client/lib/session-type-utils.test.ts`: prove resumed Freshopencode panes do not carry Freshell permission policy.
- Modify `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`: prove stale Freshopencode permission fields are not transmitted.
- Modify `server/fresh-agent/adapters/opencode/adapter.ts`: remove `--dangerously-skip-permissions` from `opencode run`.
- Modify `test/unit/server/fresh-agent/opencode-adapter.test.ts`: update command expectations to prove Freshopencode does not bypass local OpenCode policy.
- Modify `README.md`: document that OpenCode permissions are controlled by OpenCode's local config and OS permissions.

## Behavioral Contract

After this change:

- Freshell terminal OpenCode panes must not set `OPENCODE_PERMISSION`.
- Freshell terminal OpenCode panes must not add a permission-mode CLI arg.
- Freshopencode must not pass `--dangerously-skip-permissions`.
- Freshopencode panes must not include or transmit `permissionMode`.
- OpenCode model, resume, server endpoint, renderer, scroll-input, session discovery, and MCP behavior must continue to work.
- Claude and Codex permission controls must continue to work.

### Task 1: Terminal OpenCode Defers Permission Policy

**Files:**
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/integration/extension-system.test.ts`
- Modify: `extensions/opencode/freshell.json`
- Modify: `server/terminal-registry.ts`

- [ ] **Step 1: Replace the OpenCode permission-env unit tests with failing no-policy tests**

In `test/unit/server/terminal-registry.test.ts`, replace the two tests named `maps OpenCode plan permission mode to OPENCODE_PERMISSION env` and `maps OpenCode acceptEdits permission mode to OPENCODE_PERMISSION env` with:

```ts
    it('does not set OPENCODE_PERMISSION for OpenCode when permission mode is provided', () => {
      delete process.env.OPENCODE_CMD

      const spec = buildSpawnSpec('opencode', '/Users/john/project', 'system', undefined, {
        permissionMode: 'bypassPermissions',
        opencodeServer: TEST_OPENCODE_SERVER,
      })

      expect(spec.env).not.toHaveProperty('OPENCODE_PERMISSION')
      expect(spec.args).not.toContain('--permission-mode')
      expect(spec.args).toContain('--hostname')
      expect(spec.args).toContain('127.0.0.1')
      expect(spec.args).toContain('--port')
      expect(spec.args).toContain(String(TEST_OPENCODE_SERVER.port))
    })

    it('keeps OpenCode model and resume behavior while ignoring permission mode', () => {
      delete process.env.OPENCODE_CMD

      const spec = buildSpawnSpec('opencode', '/Users/john/project', 'system', 'ses_existing', {
        permissionMode: 'plan',
        model: 'openai/gpt-5-mini',
        opencodeServer: TEST_OPENCODE_SERVER,
      })

      expect(spec.env).not.toHaveProperty('OPENCODE_PERMISSION')
      expect(spec.args).toContain('--session')
      expect(spec.args).toContain('ses_existing')
      expect(spec.args).not.toContain('--model')
      expect(spec.args).not.toContain('openai/gpt-5-mini')
    })
```

- [ ] **Step 2: Add built-in manifest registry coverage**

In `test/integration/extension-system.test.ts`, add this test near the existing CLI manifest tests:

```ts
  it('builtin OpenCode extension does not expose Freshell permission controls', () => {
    const builtinDir = path.resolve(process.cwd(), 'extensions')
    mgr.scan([builtinDir])

    const opencode = mgr.toClientRegistry().find((entry) => entry.name === 'opencode')

    expect(opencode).toBeDefined()
    expect(opencode?.label).toBe('OpenCode')
    expect(opencode?.category).toBe('cli')
    expect(opencode?.cli?.supportsResume).toBe(true)
    expect(opencode?.cli?.supportsModel).toBe(true)
    expect(opencode?.cli?.supportsPermissionMode).toBeFalsy()
  })
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/integration/extension-system.test.ts --run
```

Expected: FAIL. The terminal-registry test still sees `OPENCODE_PERMISSION`, and the built-in manifest still exposes `supportsPermissionMode`.

- [ ] **Step 4: Remove OpenCode permission metadata from the built-in manifest**

Replace `extensions/opencode/freshell.json` with:

```json
{
  "name": "opencode",
  "version": "1.0.0",
  "label": "OpenCode",
  "description": "OpenCode CLI agent",
  "category": "cli",
  "cli": {
    "command": "opencode",
    "envVar": "OPENCODE_CMD",
    "resumeArgs": ["--session", "{{sessionId}}"],
    "modelArgs": ["--model", "{{model}}"],
    "supportsModel": true,
    "terminalBehavior": {
      "preferredRenderer": "canvas",
      "scrollInputPolicy": "native"
    }
  },
  "picker": {
    "group": "agents"
  }
}
```

- [ ] **Step 5: Remove OpenCode permission metadata from the fallback registry seed**

In `server/terminal-registry.ts`, change the OpenCode fallback entry from:

```ts
  ['opencode', {
    label: 'OpenCode',
    envVar: 'OPENCODE_CMD',
    defaultCommand: 'opencode',
    resumeArgs: (sessionId: string) => ['--session', sessionId],
    modelArgs: (model: string) => ['--model', model],
    permissionModeEnvVar: 'OPENCODE_PERMISSION',
    permissionModeEnvValues: {
      plan: '{"edit":"ask","bash":"ask"}',
      acceptEdits: '{"edit":"allow","bash":"ask"}',
      bypassPermissions: '{"edit":"allow","bash":"allow"}',
    },
  }],
```

to:

```ts
  ['opencode', {
    label: 'OpenCode',
    envVar: 'OPENCODE_CMD',
    defaultCommand: 'opencode',
    resumeArgs: (sessionId: string) => ['--session', sessionId],
    modelArgs: (model: string) => ['--model', model],
  }],
```

- [ ] **Step 6: Run the focused tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/integration/extension-system.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add extensions/opencode/freshell.json server/terminal-registry.ts test/unit/server/terminal-registry.test.ts test/integration/extension-system.test.ts
git commit -m "fix: defer opencode terminal permissions to local config"
```

### Task 2: Freshopencode Pane State Does Not Carry Freshell Permission Policy

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/lib/session-type-utils.test.ts`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Modify: `src/lib/fresh-agent-registry.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/lib/session-type-utils.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`

- [ ] **Step 1: Add a picker-created Freshopencode pane-state assertion**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, inside the existing test named `enables Freshopencode from the picker with OpenCode defaults`, add this assertion after the `effort` assertion:

```ts
          expect(paneContent.permissionMode).toBeUndefined()
```

- [ ] **Step 2: Add resumed Freshopencode content coverage**

In `test/unit/client/lib/session-type-utils.test.ts`, add this test in the `buildResumeContent` describe block:

```ts
  it('returns freshopencode resume content without a Freshell permission mode', () => {
    const content = buildResumeContent({
      sessionType: 'freshopencode',
      sessionId: 'ses_opencode_123',
      cwd: '/home/user/project',
      agentChatProviderSettings: {
        defaultPermissionMode: 'bypassPermissions',
      },
    })

    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('freshopencode')
    expect(content.provider).toBe('opencode')
    expect(content.resumeSessionId).toBe('ses_opencode_123')
    expect(content.sessionRef).toEqual({
      provider: 'opencode',
      sessionId: 'ses_opencode_123',
    })
    expect(content.initialCwd).toBe('/home/user/project')
    expect(content.permissionMode).toBeUndefined()
  })
```

- [ ] **Step 3: Add stale Freshopencode transmission coverage**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, add this test in the `FreshAgentView` describe block:

```tsx
  it('does not transmit stale Freshopencode permissionMode on create or send', async () => {
    const creatingStore = createStore()
    creatingStore.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-policy',
        status: 'creating',
        initialCwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
        permissionMode: 'bypassPermissions',
      },
    }))

    render(
      <Provider store={creatingStore}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const createMessage = wsMock.send.mock.calls
      .map(([message]) => message)
      .find((message) => message?.type === 'freshAgent.create')
    expect(createMessage).toBeDefined()
    expect(createMessage).not.toHaveProperty('permissionMode')

    cleanup()
    wsMock.send.mockClear()

    const sendingStore = createStore()
    sendingStore.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-send-policy',
        sessionId: 'freshopencode-req-opencode-send-policy',
        status: 'idle',
        initialCwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
        permissionMode: 'bypassPermissions',
      },
    }))

    render(
      <Provider store={sendingStore}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Use local OpenCode policy' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.send',
      sessionId: 'freshopencode-req-opencode-send-policy',
      sessionType: 'freshopencode',
      provider: 'opencode',
      text: 'Use local OpenCode policy',
      settings: {
        cwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      },
    })
  })
```

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/session-type-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: FAIL. New Freshopencode pane content and outgoing messages still include `permissionMode`.

- [ ] **Step 5: Hide Freshopencode permission controls in the registry**

In `src/lib/fresh-agent-registry.ts`, replace the Freshopencode entry with:

```ts
  {
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    label: 'Freshopencode',
    icon: OpencodeIcon,
    defaultModel: FRESHOPENCODE_DEFAULT_MODEL,
    defaultPermissionMode: 'default',
    defaultEffort: FRESHOPENCODE_DEFAULT_EFFORT,
    settingsVisibility: {
      model: true,
      permissionMode: false,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'O',
    pickerAfterCli: true,
  },
```

- [ ] **Step 6: Omit permissionMode when creating Freshopencode pane content**

In `src/components/panes/PaneContainer.tsx`, inside the `if (freshAgentType)` branch, introduce a local `permissionMode` before the `return`:

```ts
      const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
        ? undefined
        : providerSettings?.defaultPermissionMode
          ?? (freshAgentType.runtimeProvider === 'codex'
            ? settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.permissionMode
            : undefined)
          ?? providerConfig?.defaultPermissionMode
          ?? freshAgentType.defaultPermissionMode
```

Then replace the current `permissionMode: ...` property in the returned object with:

```ts
        ...(permissionMode ? { permissionMode } : {}),
```

- [ ] **Step 7: Omit permissionMode when building Freshopencode resume content**

In `src/lib/session-type-utils.ts`, inside the `if (freshAgentType)` branch of `buildResumeContent`, add:

```ts
    const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
      ? undefined
      : ps?.defaultPermissionMode ?? agentConfig?.defaultPermissionMode ?? freshAgentType.defaultPermissionMode
```

Then replace:

```ts
      permissionMode: ps?.defaultPermissionMode ?? agentConfig?.defaultPermissionMode ?? freshAgentType.defaultPermissionMode,
```

with:

```ts
      ...(permissionMode ? { permissionMode } : {}),
```

- [ ] **Step 8: Do not transmit Freshopencode permissionMode from FreshAgentView**

In `src/components/fresh-agent/FreshAgentView.tsx`, add this helper near `getEffectiveFreshAgentEffort`:

```ts
function getEffectiveFreshAgentPermissionMode(content: FreshAgentPaneContent): string | undefined {
  return content.provider === 'opencode' ? undefined : content.permissionMode
}
```

Then update `buildCreateMessage` from:

```ts
    permissionMode: content.permissionMode,
```

to:

```ts
    ...(getEffectiveFreshAgentPermissionMode(content) ? { permissionMode: getEffectiveFreshAgentPermissionMode(content) } : {}),
```

And update the `freshAgent.send` settings object from:

```ts
                    ...(paneContent.permissionMode ? { permissionMode: paneContent.permissionMode } : {}),
```

to:

```ts
                    ...(getEffectiveFreshAgentPermissionMode(paneContent) ? { permissionMode: getEffectiveFreshAgentPermissionMode(paneContent) } : {}),
```

- [ ] **Step 9: Run the focused tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/session-type-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add src/lib/fresh-agent-registry.ts src/components/panes/PaneContainer.tsx src/lib/session-type-utils.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/session-type-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix: remove freshell permission state from freshopencode"
```

### Task 3: Freshopencode Runs Do Not Bypass OpenCode Local Policy

**Files:**
- Modify: `test/unit/server/fresh-agent/opencode-adapter.test.ts`
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`

- [ ] **Step 1: Update OpenCode adapter command expectations**

In `test/unit/server/fresh-agent/opencode-adapter.test.ts`, replace every expected command key and expected argument list that includes `--dangerously-skip-permissions`.

Use these replacements:

```ts
'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant max'
'run first --format json --model opencode-go/glm-5.1 --variant high'
'run second --format json --session ses_real_2 --model opencode-go/glm-5.1 --variant high'
'run reply ok --format json --session ses_restored_1'
'run /compact keep decisions --format json --session ses_restored_1'
'run reply ok --format json --model opencode-go/deepseek-v4-flash --variant high'
```

In the first test's `expect(calls[0]).toEqual(...)`, change the expected list to:

```ts
    expect(calls[0]).toEqual([
      'run',
      'reply ok',
      '--format',
      'json',
      '--model',
      'opencode-go/deepseek-v4-flash',
      '--variant',
      'max',
    ])
```

For the resume/compact test assertions, remove the expected `--dangerously-skip-permissions` entries and keep `--session` expectations intact:

```ts
    expect(calls[0]).toEqual([
      'run',
      'reply ok',
      '--format',
      'json',
      '--session',
      'ses_restored_1',
    ])
    expect(calls[1]).toEqual([
      'run',
      '/compact keep decisions',
      '--format',
      'json',
      '--session',
      'ses_restored_1',
    ])
```

- [ ] **Step 2: Run the focused adapter test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/server/fresh-agent/opencode-adapter.test.ts --run
```

Expected: FAIL. The adapter still passes `--dangerously-skip-permissions`.

- [ ] **Step 3: Remove the bypass flag from Freshopencode run args**

In `server/fresh-agent/adapters/opencode/adapter.ts`, change:

```ts
    const args = [
      'run',
      text,
      '--format',
      'json',
      '--dangerously-skip-permissions',
      ...(state.realSessionId ? ['--session', state.realSessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--variant', effort] : []),
    ]
```

to:

```ts
    const args = [
      'run',
      text,
      '--format',
      'json',
      ...(state.realSessionId ? ['--session', state.realSessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--variant', effort] : []),
    ]
```

- [ ] **Step 4: Run the focused adapter test and verify it passes**

Run:

```bash
npm run test:vitest -- test/unit/server/fresh-agent/opencode-adapter.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add server/fresh-agent/adapters/opencode/adapter.ts test/unit/server/fresh-agent/opencode-adapter.test.ts
git commit -m "fix: defer freshopencode run permissions to opencode"
```

### Task 4: Document the Product Contract

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README documentation**

In `README.md`, after the paragraph:

```md
OpenCode sessions are discovered directly from OpenCode's local session database, so existing OpenCode work can be resumed from freshell without importing anything manually.
```

add:

```md
OpenCode permissions are controlled by the OpenCode configuration for the OS user running freshell. Freshell does not set `OPENCODE_PERMISSION` or pass `--dangerously-skip-permissions` for OpenCode sessions; OS filesystem permissions remain the hard boundary.
```

- [ ] **Step 2: Verify the README wording is present**

Run:

```bash
rg -n "OpenCode permissions are controlled" README.md
```

Expected: one matching line.

- [ ] **Step 3: Commit Task 4**

```bash
git add README.md
git commit -m "docs: document opencode permission ownership"
```

### Task 5: Final Verification

**Files:**
- Verify: all files changed by Tasks 1-4

- [ ] **Step 1: Confirm no product OpenCode permission override remains**

Run:

```bash
rg -n -e "OPENCODE_PERMISSION" -e "--dangerously-skip-permissions" extensions server src test/unit test/integration README.md
```

Expected: no matches in `extensions/`, `server/`, `src/`, `test/unit/`, or `test/integration/`. Matches in `test/integration/real/coding-cli-session-contract.test.ts` are acceptable only if the command above is expanded later to include `test/integration/real`, because that file probes the upstream OpenCode CLI directly rather than Freshell's product launch path.

- [ ] **Step 2: Run all focused tests from this plan**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/integration/extension-system.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/session-type-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/server/fresh-agent/opencode-adapter.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run the repo-supported final verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="opencode local permission policy final verification" npm run check
```

Expected: PASS for typecheck and coordinated full suite.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: changed files match this plan, and `git diff --check` prints no whitespace errors.

- [ ] **Step 5: Confirm the working tree is clean**

Run:

```bash
git status --short
```

Expected: clean working tree.

## Self-Review Notes

- Spec coverage: Terminal OpenCode no longer receives Freshell permission env, Freshopencode no longer receives permission state or bypass flags, and README states the product contract.
- Placeholder scan: This plan contains concrete paths, commands, expected outcomes, and code snippets for every code-changing step.
- Type consistency: `permissionMode` remains optional in existing pane/message types; the plan omits it for OpenCode instead of introducing a new type variant.
