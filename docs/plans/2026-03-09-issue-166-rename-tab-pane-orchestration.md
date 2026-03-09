# Issue 166 Rename Tab and Pane Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Expose deterministic orchestration commands for renaming tabs and panes, including active-target defaults and explicit identifiers, and document them in the Freshell orchestration skill.

**Architecture:** Keep orchestration server-authoritative. Add a symmetric pane rename write path (`PATCH /api/panes/:id`) backed by `LayoutStore`, then broadcast explicit `ui.command` events so every connected UI converges immediately. Extend the CLI rename verbs so one positional argument means “rename the active target” and two positional arguments mean “rename the explicit target,” which satisfies the acceptance criteria without inventing a second orchestration surface.

**Tech Stack:** TypeScript, Express agent API, Freshell CLI (`server/cli`), React/Redux UI command handling, Vitest, supertest, child-process CLI e2e tests.

---

## Strategy Gate

- The missing steady-state capability is not “another skill wrapper”; it is a complete write path for pane titles plus a CLI grammar that can target the active tab/pane without manual UI interaction.
- Do **not** implement pane rename by mutating browser state only. Automation has to work over HTTP against a remote Freshell instance, so the server must own the mutation and broadcast it.
- Keep `rename-tab` and `rename-pane` as separate explicit operations. Do **not** make `pane.rename` implicitly rename the tab, even for single-pane tabs. The orchestration surface should be predictable; agents can call `rename-tab` when they want that outcome.
- Tighten rename semantics while touching them: both rename routes and both CLI verbs should trim input and reject blank names. That matches the existing manual UI behavior, which ignores empty rename submissions instead of writing empty titles.

## Acceptance Mapping

- `rename-tab` remains the tab rename orchestration operation, but its CLI parsing is extended so it can target the active tab without requiring `-t`.
- Add `rename-pane` as a first-class pane rename orchestration operation, with both active-pane and explicit-target forms.
- The server agent API gains a pane rename endpoint and write primitive, so CLI, agents, and future orchestrators all share the same path.
- The Freshell orchestration skill documents both verbs and includes a concrete create/split/rename playbook that does not rely on manual UI interaction.

### Task 1: Lock Down Rename Contracts on the Server

**Files:**
- Modify: `test/server/agent-tabs-write.test.ts`
- Modify: `test/server/agent-panes-write.test.ts`
- Modify: `test/unit/server/agent-layout-store-write.test.ts`

**Step 1: Write failing tests for rename validation and pane rename behavior**

Add tab write tests that prove blank tab names are rejected and trimmed names are forwarded:

```ts
it('rejects blank tab rename payloads', async () => {
  const app = express()
  app.use(express.json())
  const renameTab = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renameTab },
    registry: {} as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))

  const res = await request(app).patch('/api/tabs/tab_1').send({ name: '   ' })

  expect(res.status).toBe(400)
  expect(renameTab).not.toHaveBeenCalled()
})
```

Add pane write tests that prove the new route resolves pane targets and broadcasts the rename:

```ts
it('renames a pane via PATCH /api/panes/:id', async () => {
  const broadcastUiCommand = vi.fn()
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_real' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_real' }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/1.0').send({ name: 'Logs' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('tab_1', 'pane_real', 'Logs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_real', title: 'Logs' },
  })
})
```

Add `LayoutStore` write tests that prove pane rename persists into `snapshot.paneTitles` and can locate the owning tab even if `tabId` is omitted:

```ts
it('renames a pane in the owning tab when tabId is omitted', () => {
  const store = new LayoutStore()
  store.updateFromUi({
    tabs: [{ id: 'tab_a', title: 'Alpha' }],
    activeTabId: 'tab_a',
    layouts: {
      tab_a: { type: 'leaf', id: 'pane_1', content: { kind: 'terminal', terminalId: 'term_1' } },
    },
    activePane: { tab_a: 'pane_1' },
    paneTitles: {},
    timestamp: Date.now(),
  }, 'conn-1')

  expect(store.renamePane(undefined, 'pane_1', 'Logs')).toEqual({ tabId: 'tab_a', paneId: 'pane_1' })
  expect((store as any).snapshot.paneTitles.tab_a.pane_1).toBe('Logs')
})
```

**Step 2: Run the targeted tests and confirm they fail**

Run:

```bash
npm test -- test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts
```

Expected:
- FAIL because `PATCH /api/panes/:id` does not exist yet
- FAIL because `LayoutStore.renamePane()` does not exist yet
- FAIL because blank-name validation is not enforced on rename routes yet

**Step 3: Implement the server rename primitives**

In `server/agent-api/layout-store.ts`, add a dedicated pane rename primitive:

```ts
renamePane(tabId: string | undefined, paneId: string, title: string) {
  if (!this.snapshot) return { message: 'no layout snapshot' as const }
  const target = this.getPaneSnapshot(paneId)
  const targetTabId = tabId && target?.tabId === tabId ? tabId : target?.tabId
  if (!targetTabId) return { message: 'pane not found' as const }

  if (!this.snapshot.paneTitles) this.snapshot.paneTitles = {}
  if (!this.snapshot.paneTitles[targetTabId]) this.snapshot.paneTitles[targetTabId] = {}
  this.snapshot.paneTitles[targetTabId][paneId] = title
  return { tabId: targetTabId, paneId }
}
```

In `server/agent-api/router.ts`, extract a tiny helper used by both rename routes:

```ts
const parseRequiredName = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}
```

Use it in both routes:

```ts
router.patch('/tabs/:id', (req, res) => {
  const name = parseRequiredName(req.body?.name)
  if (!name) return res.status(400).json(fail('name required'))
  const result = layoutStore.renameTab(req.params.id, name)
  wsHandler?.broadcastUiCommand({ command: 'tab.rename', payload: { id: req.params.id, title: name } })
  res.json(ok(result, result.message || 'tab renamed'))
})

router.patch('/panes/:id', (req, res) => {
  const name = parseRequiredName(req.body?.name)
  if (!name) return res.status(400).json(fail('name required'))
  const resolved = resolvePaneTarget(req.params.id)
  const paneId = resolved.paneId || req.params.id
  const tabId = req.body?.tabId || resolved.tabId
  const result = layoutStore.renamePane(tabId, paneId, name)
  if (result?.tabId) {
    wsHandler?.broadcastUiCommand({
      command: 'pane.rename',
      payload: { tabId: result.tabId, paneId, title: name },
    })
  }
  res.json(ok(result, resolved.message || result?.message || 'pane renamed'))
})
```

**Step 4: Re-run the targeted server tests**

Run:

```bash
npm test -- test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts server/agent-api/layout-store.ts server/agent-api/router.ts
git commit -m "feat(agent-api): add pane rename endpoint"
```

### Task 2: Mirror `pane.rename` Into Connected UIs

**Files:**
- Modify: `test/unit/client/ui-commands.test.ts`
- Modify: `src/lib/ui-commands.ts`

**Step 1: Write the failing client test**

```ts
it('handles pane.rename', () => {
  const actions: any[] = []
  const dispatch = (action: any) => {
    actions.push(action)
    return action
  }

  handleUiCommand({
    type: 'ui.command',
    command: 'pane.rename',
    payload: { tabId: 't1', paneId: 'p1', title: 'Logs' },
  }, dispatch)

  expect(actions[0].type).toBe('panes/updatePaneTitle')
  expect(actions[0].payload).toEqual({ tabId: 't1', paneId: 'p1', title: 'Logs' })
})
```

**Step 2: Run the test and confirm failure**

Run:

```bash
npm test -- test/unit/client/ui-commands.test.ts
```

Expected:
- FAIL because `pane.rename` is not handled yet

**Step 3: Implement the minimal broadcast handler**

In `src/lib/ui-commands.ts`, import `updatePaneTitle` and add:

```ts
case 'pane.rename':
  return dispatch(updatePaneTitle({
    tabId: msg.payload.tabId,
    paneId: msg.payload.paneId,
    title: msg.payload.title,
  }))
```

**Step 4: Re-run the client test**

Run:

```bash
npm test -- test/unit/client/ui-commands.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/unit/client/ui-commands.test.ts src/lib/ui-commands.ts
git commit -m "feat(client): apply pane rename ui commands"
```

### Task 3: Extend the CLI Rename Surface to Support Active Targets and Pane Rename

**Files:**
- Modify: `server/cli/index.ts`
- Modify: `test/e2e/agent-cli-flow.test.ts`

**Step 1: Write the failing end-to-end CLI tests**

Add one focused rename flow that covers the acceptance criteria instead of a pile of tiny mocks:

```ts
it('renames the active tab and explicit panes in a create/split flow', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const created = await runCli(server.url, ['new-tab', '-n', 'Workspace'])
    const createdJson = JSON.parse(created.stdout)
    const tabId = createdJson.data.tabId
    const firstPaneId = createdJson.data.paneId

    const split = await runCli(server.url, ['split-pane', '-t', firstPaneId, '--editor', '/tmp/example.txt'])
    const splitJson = JSON.parse(split.stdout)
    const secondPaneId = splitJson.data.paneId

    await runCli(server.url, ['rename-tab', 'Release prep'])
    await runCli(server.url, ['rename-pane', '-t', firstPaneId, '-n', 'Shell'])
    await runCli(server.url, ['rename-pane', secondPaneId, 'Editor'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.tabs.find((tab: any) => tab.id === tabId)?.title).toBe('Release prep')
    expect(snapshot.paneTitles[tabId][firstPaneId]).toBe('Shell')
    expect(snapshot.paneTitles[tabId][secondPaneId]).toBe('Editor')
  } finally {
    await server.close()
  }
})
```

Add a smaller active-pane default test:

```ts
it('renames the active pane when only a new name is provided', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, ['new-tab', '-n', 'Workspace'])
    await runCli(server.url, ['rename-pane', 'Main shell'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.paneTitles[created.data.tabId][created.data.paneId]).toBe('Main shell')
  } finally {
    await server.close()
  }
})
```

**Step 2: Run the CLI e2e file and confirm failure**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- FAIL because `rename-pane` is not implemented
- FAIL because `rename-tab NAME` currently treats `NAME` as a target instead of the active tab rename form

**Step 3: Implement shared rename-argument parsing and the new verb**

In `server/cli/index.ts`, add a small helper near `getFlag()`:

```ts
function resolveRenameArgs(flags: Flags, args: string[]) {
  const explicitTarget = getFlag(flags, 't', 'target', 'tab', 'pane')
  const explicitName = getFlag(flags, 'n', 'name', 'title')

  if (typeof explicitName === 'string') {
    return { target: typeof explicitTarget === 'string' ? explicitTarget : undefined, name: explicitName.trim() }
  }

  if (args.length === 1) return { target: undefined, name: args[0].trim() }
  if (args.length >= 2) return { target: args[0], name: args[1].trim() }
  return { target: typeof explicitTarget === 'string' ? explicitTarget : undefined, name: '' }
}
```

Use it in both rename cases:

```ts
case 'rename-tab': {
  const { target, name } = resolveRenameArgs(flags, args)
  if (!name) { writeError('name required'); process.exitCode = 1; return }
  const { tab, message } = await resolveTabTarget(client, target)
  ...
}

case 'rename-pane': {
  const { target, name } = resolveRenameArgs(flags, args)
  if (!name) { writeError('name required'); process.exitCode = 1; return }
  const resolved = await resolvePaneTarget(client, target)
  if (!resolved.pane?.id) { ... }
  const res = await client.patch(`/api/panes/${encodeURIComponent(resolved.pane.id)}`, {
    tabId: resolved.tab?.id,
    name,
  })
  writeJson(res)
  return
}
```

Important details:
- Keep `-t/-n` working exactly as today for explicit automation.
- One positional arg means active rename for both verbs.
- Two positional args mean explicit target + new name.
- Trim the final name before validating so whitespace-only input fails locally.

**Step 4: Re-run the CLI e2e file**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/cli/index.ts test/e2e/agent-cli-flow.test.ts
git commit -m "feat(cli): add rename-pane and active rename targets"
```

### Task 4: Update the Orchestration Skill to Expose the New Surface

**Files:**
- Modify: `.claude/skills/freshell-orchestration/SKILL.md`

**Step 1: Rewrite the command reference and playbook entries**

Add `rename-pane` beside `rename-tab`, and make the active-target behavior explicit:

```md
Tab commands:
- `rename-tab [TARGET] NEW_NAME`
- `rename-tab -n NEW_NAME`
- `rename-tab -t TARGET -n NEW_NAME`

Pane/layout commands:
- `rename-pane [PANE_TARGET] NEW_NAME`
- `rename-pane -n NEW_NAME`
- `rename-pane -t PANE_TARGET -n NEW_NAME`
```

Add a playbook that proves the acceptance criteria in the docs themselves:

```bash
WS="$($FSH new-tab -n 'Triager' --codex --cwd "$CWD")"
TAB_ID="$(printf '%s' "$WS" | jq -r '.data.tabId')"
P0="$(printf '%s' "$WS" | jq -r '.data.paneId')"
P1="$($FSH split-pane -t "$P0" --editor "$FILE" | jq -r '.data.paneId')"

$FSH rename-tab -t "$TAB_ID" -n "Issue 166 work"
$FSH rename-pane -t "$P0" -n "Codex"
$FSH rename-pane -t "$P1" -n "Editor"
```

Also add one short note under Targets:
- omitted target on `rename-tab`/`rename-pane` means the active tab/pane

**Step 2: Sanity-check the markdown for accuracy**

Run:

```bash
sed -n '1,260p' .claude/skills/freshell-orchestration/SKILL.md
```

Expected:
- Command reference includes `rename-pane`
- Active-target behavior is documented clearly
- Playbook shows create/split plus meaningful names without manual UI interaction

**Step 3: Commit**

```bash
git add .claude/skills/freshell-orchestration/SKILL.md
git commit -m "docs(skill): document tab and pane rename orchestration"
```

### Task 5: Final Verification

**Files:**
- Modify: none

**Step 1: Run the focused regression set**

Run:

```bash
npm test -- test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts test/unit/client/ui-commands.test.ts test/e2e/agent-cli-flow.test.ts
```

Expected:
- PASS

**Step 2: Run the full suite required before landing**

Run:

```bash
npm test
```

Expected:
- PASS

**Step 3: Manual orchestration spot-check against a real dev server if needed**

Run:

```bash
FSH="npx tsx server/cli/index.ts"
TAB_JSON="$($FSH new-tab -n 'Canary Rename' --codex --cwd /absolute/path/to/repo)"
TAB_ID="$(printf '%s' "$TAB_JSON" | jq -r '.data.tabId')"
P0="$(printf '%s' "$TAB_JSON" | jq -r '.data.paneId')"
P1="$($FSH split-pane -t "$P0" --editor /absolute/path/to/repo/README.md | jq -r '.data.paneId')"
$FSH rename-tab -t "$TAB_ID" -n "Canary workspace"
$FSH rename-pane -t "$P0" -n "Agent"
$FSH rename-pane -t "$P1" -n "Docs"
```

Expected:
- Tab title changes to `Canary workspace`
- Pane titles change to `Agent` and `Docs`
- No manual double-click or context-menu rename is required

## Notes for the Executor

- Keep this cycle tight. Do not expand the read surface with new pane-title listing tokens in this issue unless an implementation obstacle makes that unavoidable.
- Reuse existing rename reducers instead of inventing parallel state. The new capability is a server write path and CLI exposure, not a second rename system.
- Preserve the current tmux-style target resolution rules in `resolveTarget`; this issue only needs rename verbs to consume that resolution logic.
