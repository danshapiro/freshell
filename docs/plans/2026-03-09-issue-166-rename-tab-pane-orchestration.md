# Issue 166 Rename Tab and Pane Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Expose orchestration operations for renaming tabs and panes, including active-target defaults and explicit identifiers, and document those operations in the Freshell orchestration skill.

**Architecture:** Keep rename orchestration server-authoritative. Normalize names once at the HTTP boundary, trim blanks out of both rename routes, and only broadcast rename `ui.command` events after the layout store confirms the mutation. Add the missing pane rename write path as a pane-targeted mutation in `LayoutStore`, expose it through `PATCH /api/panes/:id`, mirror the resulting `pane.rename` broadcast into Redux, and extend the CLI plus orchestration skill so agents can create or split workspaces and assign stable tab and pane names entirely through the orchestration surface.

**Tech Stack:** TypeScript, Express agent API, Freshell CLI (`server/cli`), React/Redux UI command handling, Vitest, supertest, child-process CLI e2e tests.

---

## Strategy Gate

- The actual missing product capability is not “better docs”; it is a complete pane-title write path that automation can call remotely, plus CLI verbs whose grammar actually supports active-target defaults and explicit targets.
- Keep pane rename pane-centric. A pane ID already identifies its owning tab, so the server route and `LayoutStore` should resolve ownership internally instead of accepting a redundant `tabId` input that can drift or conflict.
- Do **not** route pane rename through terminal/session rename APIs. Those only cover coding-CLI terminals and do not satisfy the issue requirement to rename arbitrary panes in the layout tree.
- Do **not** solve this in Redux only. Orchestration is an HTTP surface for remote agents, so the authoritative mutation must live in the server layout store and then broadcast back to connected clients.
- Keep tab rename and pane rename as distinct explicit operations. Do **not** auto-rename tabs when panes are renamed.
- Rename broadcasts must be success-only. Broadcasting a rename when the authoritative store rejected the target would desynchronize every connected client, so tighten tab rename while adding pane rename instead of copying the existing weakness forward.
- Put active-target defaults in executable CLI behavior, not only in skill prose.
- Prove the requested end state with a single real CLI flow against a real `LayoutStore`: create a workspace, split it, rename the tab, rename panes, and assert the persisted titles. Do not treat separate tab-only and pane-only flows as sufficient proof of the acceptance criteria.
- Normalize rename input the same way across both routes and both CLI commands: trim final names, reject blank results, and let explicit-target positional forms join the remaining tokens into the final name.

## Acceptance Mapping

- `rename-tab` supports `rename-tab NEW_NAME` for the active tab and `rename-tab TARGET NEW_NAME` for an explicit tab.
- `rename-pane` is added as a first-class orchestration operation and supports both active-pane and explicit-pane targets.
- The agent API exposes `PATCH /api/panes/:id` and `LayoutStore.renamePane(paneId, title)` so pane rename shares the same authoritative write path as the rest of layout orchestration.
- Connected UIs converge immediately because successful mutations broadcast `tab.rename` and `pane.rename` `ui.command` events only after the authoritative store returns a resolved target.
- The orchestration skill documents both commands, their target grammar, and a concrete create/split/select/rename flow that uses both explicit targets and active-target defaults without any manual UI interaction.

### Task 1: Harden Tab Rename Validation and Broadcast Semantics

**Files:**
- Modify: `test/server/agent-tabs-write.test.ts`
- Modify: `server/agent-api/router.ts`

**Step 1: Add a failing blank-name tab rename test**

In `test/server/agent-tabs-write.test.ts`, add:

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

**Step 2: Add a failing trim-and-broadcast-successful tab rename test**

In `test/server/agent-tabs-write.test.ts`, add:

```ts
it('trims tab rename payloads before writing and broadcasts only successful renames', async () => {
  const app = express()
  app.use(express.json())
  const renameTab = vi.fn(() => ({ tabId: 'tab_1' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renameTab },
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/tabs/tab_1').send({ name: '  Release prep  ' })

  expect(res.status).toBe(200)
  expect(renameTab).toHaveBeenCalledWith('tab_1', 'Release prep')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'tab.rename',
    payload: { id: 'tab_1', title: 'Release prep' },
  })
})
```

**Step 3: Add a failing rejected-target tab rename test**

In `test/server/agent-tabs-write.test.ts`, add:

```ts
it('does not broadcast tab.rename when the tab does not exist', async () => {
  const app = express()
  app.use(express.json())
  const renameTab = vi.fn(() => ({ message: 'tab not found' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renameTab },
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/tabs/missing').send({ name: 'Ghost' })

  expect(res.status).toBe(200)
  expect(renameTab).toHaveBeenCalledWith('missing', 'Ghost')
  expect(broadcastUiCommand).not.toHaveBeenCalled()
})
```

**Step 4: Run the targeted server tab test and confirm failure**

Run:

```bash
npm test -- test/server/agent-tabs-write.test.ts
```

Expected:
- FAIL because the route currently accepts whitespace-only names, forwards untrimmed values, and broadcasts even when the layout store reports `tab not found`

**Step 5: Implement shared name normalization and success-only broadcasting in `server/agent-api/router.ts`**

Add this helper near `parseOptionalNumber()`:

```ts
const parseRequiredName = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}
```

Update the existing tab rename route to use it:

```ts
router.patch('/tabs/:id', (req, res) => {
  const name = parseRequiredName(req.body?.name)
  if (!name) return res.status(400).json(fail('name required'))

  const result = layoutStore.renameTab(req.params.id, name)
  if (result?.tabId) {
    wsHandler?.broadcastUiCommand({
      command: 'tab.rename',
      payload: { id: req.params.id, title: name },
    })
  }
  res.json(ok(result, result.message || 'tab renamed'))
})
```

Important detail:
- Keep the existing response envelope semantics for missing tabs, but stop emitting `tab.rename` when the mutation did not actually happen.

**Step 6: Re-run the targeted server tab test**

Run:

```bash
npm test -- test/server/agent-tabs-write.test.ts
```

Expected:
- PASS

**Step 7: Commit**

```bash
git add test/server/agent-tabs-write.test.ts server/agent-api/router.ts
git commit -m "test(agent-api): validate tab rename names"
```

### Task 2: Add Authoritative Pane Rename Persistence and Broadcasts

**Files:**
- Modify: `test/server/agent-panes-write.test.ts`
- Modify: `test/unit/server/agent-layout-store-write.test.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `server/agent-api/router.ts`

**Step 1: Add a failing blank-name pane rename route test**

In `test/server/agent-panes-write.test.ts`, add:

```ts
it('rejects blank pane rename payloads', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renamePane },
    registry: {} as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: '   ' })

  expect(res.status).toBe(400)
  expect(renamePane).not.toHaveBeenCalled()
})
```

**Step 2: Add a failing resolved-target pane rename route test**

In `test/server/agent-panes-write.test.ts`, add:

```ts
it('renames a resolved pane via PATCH /api/panes/:id', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_real' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_real' }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/1.0').send({ name: '  Logs  ' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_real', 'Logs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_real', title: 'Logs' },
  })
})
```

**Step 3: Add a failing `LayoutStore.renamePane()` persistence test**

In `test/unit/server/agent-layout-store-write.test.ts`, add:

```ts
it('renames a pane in its owning tab', () => {
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

  expect(store.renamePane('pane_1', 'Logs')).toEqual({ tabId: 'tab_a', paneId: 'pane_1' })
  expect((store as any).snapshot.paneTitles.tab_a.pane_1).toBe('Logs')
})
```

**Step 4: Run the pane/server tests and confirm failure**

Run:

```bash
npm test -- test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts
```

Expected:
- FAIL because `PATCH /api/panes/:id` does not exist yet
- FAIL because `LayoutStore.renamePane()` does not exist yet

**Step 5: Implement `LayoutStore.renamePane()` in `server/agent-api/layout-store.ts`**

Add:

```ts
renamePane(paneId: string, title: string) {
  if (!this.snapshot) return { message: 'no layout snapshot' as const }

  const pane = this.getPaneSnapshot(paneId)
  if (!pane) return { message: 'pane not found' as const }

  if (!this.snapshot.paneTitles) this.snapshot.paneTitles = {}
  if (!this.snapshot.paneTitles[pane.tabId]) this.snapshot.paneTitles[pane.tabId] = {}
  this.snapshot.paneTitles[pane.tabId][paneId] = title
  return { tabId: pane.tabId, paneId }
}
```

**Step 6: Implement the pane rename route in `server/agent-api/router.ts`**

Add this route beside the other pane write routes:

```ts
router.patch('/panes/:id', (req, res) => {
  const name = parseRequiredName(req.body?.name)
  if (!name) return res.status(400).json(fail('name required'))

  const resolved = resolvePaneTarget(req.params.id)
  const paneId = resolved.paneId || req.params.id
  const result = layoutStore.renamePane(paneId, name)

  if (result?.tabId) {
    wsHandler?.broadcastUiCommand({
      command: 'pane.rename',
      payload: { tabId: result.tabId, paneId, title: name },
    })
  }

  res.json(ok(result, resolved.message || result?.message || 'pane renamed'))
})
```

Important details:
- Resolve tmux-style pane targets exactly once at the route boundary.
- Do not accept or depend on `req.body.tabId`; the pane target is the source of truth.
- Broadcast only after a resolved `{ tabId, paneId }` result exists.

**Step 7: Re-run the pane/server tests**

Run:

```bash
npm test -- test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts
```

Expected:
- PASS

**Step 8: Commit**

```bash
git add test/server/agent-panes-write.test.ts test/unit/server/agent-layout-store-write.test.ts server/agent-api/layout-store.ts server/agent-api/router.ts
git commit -m "feat(agent-api): add pane rename orchestration"
```

### Task 3: Mirror `pane.rename` Into Connected UIs

**Files:**
- Modify: `test/unit/client/ui-commands.test.ts`
- Modify: `src/lib/ui-commands.ts`

**Step 1: Add a failing `pane.rename` UI command test**

In `test/unit/client/ui-commands.test.ts`, add:

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

**Step 2: Run the UI command test and confirm failure**

Run:

```bash
npm test -- test/unit/client/ui-commands.test.ts
```

Expected:
- FAIL because `pane.rename` is not handled yet

**Step 3: Implement the missing UI command case in `src/lib/ui-commands.ts`**

Import `updatePaneTitle` from `@/store/panesSlice` and add:

```ts
case 'pane.rename':
  return dispatch(updatePaneTitle({
    tabId: msg.payload.tabId,
    paneId: msg.payload.paneId,
    title: msg.payload.title,
  }))
```

Important detail:
- Do **not** pass `setByUser: false`. Orchestrated rename is an intentional title override and should behave like a manual rename.

**Step 4: Re-run the UI command test**

Run:

```bash
npm test -- test/unit/client/ui-commands.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/unit/client/ui-commands.test.ts src/lib/ui-commands.ts
git commit -m "feat(client): handle pane rename ui commands"
```

### Task 4: Extend CLI Rename Grammar for Active Targets and Explicit Targets

**Files:**
- Modify: `test/e2e/agent-cli-flow.test.ts`
- Modify: `server/cli/index.ts`

**Step 1: Add a real-layout CLI test helper**

In `test/e2e/agent-cli-flow.test.ts`, add:

```ts
import { LayoutStore } from '../../server/agent-api/layout-store'

async function startTestServerWithRealLayoutStore() {
  const layoutStore = new LayoutStore()
  const app = express()
  app.use(express.json())

  let terminalCount = 0
  app.use('/api', createAgentApiRouter({
    layoutStore,
    registry: {
      create: () => ({ terminalId: `term_${++terminalCount}` }),
      get: () => undefined,
      input: () => {},
    },
  }))

  const server = http.createServer(app)
  return await new Promise<{ url: string; layoutStore: LayoutStore; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://localhost:${port}`,
        layoutStore,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function runCliJson<T>(url: string, args: string[]) {
  const output = await runCli(url, args)
  return JSON.parse(output.stdout) as T
}
```

**Step 2: Add a failing active-tab rename CLI flow test**

In `test/e2e/agent-cli-flow.test.ts`, add:

```ts
it('renames the active tab when only a new name is provided', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const first = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Backlog'])
    const second = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Active'])

    await runCli(server.url, ['rename-tab', 'Release prep'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.activeTabId).toBe(second.data.tabId)
    expect(snapshot.tabs.find((tab: any) => tab.id === second.data.tabId)?.title).toBe('Release prep')
    expect(snapshot.tabs.find((tab: any) => tab.id === first.data.tabId)?.title).toBe('Backlog')
  } finally {
    await server.close()
  }
})
```

**Step 3: Add a failing explicit-tab-target CLI flow test**

In `test/e2e/agent-cli-flow.test.ts`, add:

```ts
it('renames a non-active tab when a target id is provided', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const first = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Backlog'])
    const second = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Active'])

    await runCli(server.url, ['rename-tab', first.data.tabId, 'Release', 'board'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.activeTabId).toBe(second.data.tabId)
    expect(snapshot.tabs.find((tab: any) => tab.id === first.data.tabId)?.title).toBe('Release board')
    expect(snapshot.tabs.find((tab: any) => tab.id === second.data.tabId)?.title).toBe('Active')
  } finally {
    await server.close()
  }
})
```

**Step 4: Run the CLI e2e file and confirm failure**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- FAIL because `rename-tab NAME` currently treats the lone positional argument as a target instead of the new name, and explicit-target positional renames only preserve the first name token

**Step 5: Implement shared rename parsing in `server/cli/index.ts`**

Add this helper near `getFlag()`:

```ts
function resolveRenameArgs(
  flags: Flags,
  args: string[],
  targetFlagNames: string[],
) {
  const explicitTarget = getFlag(flags, ...targetFlagNames)
  const explicitName = getFlag(flags, 'n', 'name', 'title')
  const joinName = (parts: string[]) => parts.join(' ').trim()

  if (typeof explicitName === 'string') {
    return {
      target: typeof explicitTarget === 'string' ? explicitTarget : args[0],
      name: explicitName.trim(),
    }
  }

  if (typeof explicitTarget === 'string') {
    return {
      target: explicitTarget,
      name: joinName(args),
    }
  }

  if (args.length === 1) {
    return { target: undefined, name: args[0].trim() }
  }

  if (args.length >= 2) {
    return { target: args[0], name: joinName(args.slice(1)) }
  }

  return { target: undefined, name: '' }
}
```

Update `rename-tab` to use it:

```ts
case 'rename-tab': {
  const { target, name } = resolveRenameArgs(flags, args, ['t', 'target', 'tab'])
  if (!name) {
    writeError('name required')
    process.exitCode = 1
    return
  }

  const { tab, message } = await resolveTabTarget(client, target)
  if (!tab) {
    writeError(message || 'tab not found')
    process.exitCode = 1
    return
  }
  if (message) writeError(message)

  const res = await client.patch(`/api/tabs/${encodeURIComponent(tab.id)}`, { name })
  writeJson(res)
  return
}
```

Important details:
- One positional argument means “rename the active target”.
- Two or more positional arguments mean “rename the explicit target to the remaining joined name”.
- `-t/--target/--tab` wins over positional target inference.
- `-n/--name/--title` wins over positional name inference.
- Trim before validating so whitespace-only names fail locally.

**Step 6: Re-run the CLI e2e file**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- PASS for the new tab-rename coverage

**Step 7: Commit**

```bash
git add test/e2e/agent-cli-flow.test.ts server/cli/index.ts
git commit -m "feat(cli): support active tab rename"
```

### Task 5: Add `rename-pane` to the CLI and Prove the Combined Workspace Flow

**Files:**
- Modify: `test/e2e/agent-cli-flow.test.ts`
- Modify: `server/cli/index.ts`

**Step 1: Add a failing combined tab-and-pane rename flow test**

In `test/e2e/agent-cli-flow.test.ts`, add:

```ts
it('renames the tab and panes in a create split rename flow', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
      'new-tab',
      '-n',
      'Workspace',
      '--codex',
      '--cwd',
      process.cwd(),
    ])
    const tabId = created.data.tabId
    const firstPaneId = created.data.paneId

    const split = await runCliJson<{ data: { paneId: string } }>(server.url, [
      'split-pane',
      '-t',
      firstPaneId,
      '--editor',
      '/tmp/example.txt',
    ])
    const secondPaneId = split.data.paneId

    await runCli(server.url, ['rename-tab', '-t', tabId, '-n', 'Issue 166 work'])
    await runCli(server.url, ['rename-pane', '-t', firstPaneId, '-n', 'Codex'])
    await runCli(server.url, ['rename-pane', secondPaneId, 'Editor'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.tabs.find((tab: any) => tab.id === tabId)?.title).toBe('Issue 166 work')
    expect(snapshot.paneTitles[tabId][firstPaneId]).toBe('Codex')
    expect(snapshot.paneTitles[tabId][secondPaneId]).toBe('Editor')
  } finally {
    await server.close()
  }
})
```

**Step 2: Add a failing active-pane rename flow test**

In `test/e2e/agent-cli-flow.test.ts`, add:

```ts
it('renames the active pane when only a new name is provided', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
      'new-tab',
      '-n',
      'Workspace',
      '--shell',
      'system',
    ])

    await runCli(server.url, ['rename-pane', 'Main shell'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.paneTitles[created.data.tabId][created.data.paneId]).toBe('Main shell')
  } finally {
    await server.close()
  }
})
```

**Step 3: Run the CLI e2e file and confirm failure**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- FAIL because `rename-pane` is not implemented yet, so the requested create/split/rename workspace flow still cannot complete through orchestration alone

**Step 4: Add the `rename-pane` CLI command in `server/cli/index.ts`**

Add this case near the other pane commands:

```ts
case 'rename-pane': {
  const { target, name } = resolveRenameArgs(flags, args, ['t', 'target', 'pane'])
  if (!name) {
    writeError('name required')
    process.exitCode = 1
    return
  }

  const resolved = await resolvePaneTarget(client, target)
  if (!resolved.pane?.id) {
    writeError(resolved.message || 'pane not found')
    process.exitCode = 1
    return
  }
  if (resolved.message) writeError(resolved.message)

  const res = await client.patch(`/api/panes/${encodeURIComponent(resolved.pane.id)}`, { name })
  writeJson(res)
  return
}
```

**Step 5: Re-run the CLI e2e file**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- PASS

**Step 6: Commit**

```bash
git add test/e2e/agent-cli-flow.test.ts server/cli/index.ts
git commit -m "feat(cli): add rename-pane orchestration"
```

### Task 6: Update the Orchestration Skill to Expose the New Surface

**Files:**
- Modify: `.claude/skills/freshell-orchestration/SKILL.md`

**Step 1: Rewrite the rename command reference**

In `.claude/skills/freshell-orchestration/SKILL.md`, change the command reference to:

```md
Tab commands:
- `rename-tab NEW_NAME` - rename the active tab
- `rename-tab TARGET NEW_NAME`
- `rename-tab -t TARGET -n NEW_NAME`

Pane/layout commands:
- `rename-pane NEW_NAME` - rename the active pane
- `rename-pane TARGET NEW_NAME`
- `rename-pane -t TARGET -n NEW_NAME`
```

Under “Targets”, add:

```md
- Omitted target on `rename-tab` means the active tab.
- Omitted target on `rename-pane` means the active pane in the active tab.
- If a target contains spaces, or if you want an active-target rename with an unquoted multi-word name, prefer the flagged `-t/-n` form.
```

Important detail:
- Update the canonical skill at `.claude/skills/freshell-orchestration/SKILL.md`; the plugin directory contains a pointer file at `.claude/plugins/freshell-orchestration/skills/freshell-orchestration` that already resolves back to this skill directory, so do not edit the pointer file for this issue.

**Step 2: Add a concrete create/split/rename playbook**

Append this example:

```bash
FSH="npx tsx server/cli/index.ts"
CWD="/absolute/path/to/repo"
FILE="/absolute/path/to/repo/README.md"

WS="$($FSH new-tab -n 'Triager' --codex --cwd "$CWD")"
TAB_ID="$(printf '%s' "$WS" | jq -r '.data.tabId')"
P0="$(printf '%s' "$WS" | jq -r '.data.paneId')"
P1="$($FSH split-pane -t "$P0" --editor "$FILE" | jq -r '.data.paneId')"

$FSH rename-tab -t "$TAB_ID" -n "Issue 166 work"
$FSH rename-pane -t "$P0" -n "Codex"
$FSH select-pane -t "$P1"
$FSH rename-pane "Editor"
```

**Step 3: Sanity-check the skill markdown**

Run:

```bash
sed -n '1,240p' .claude/skills/freshell-orchestration/SKILL.md
```

Expected:
- `rename-pane` is documented
- Active-target defaults are explicit for both rename commands
- The playbook shows a create/split/rename flow with no UI interaction

**Step 4: Commit**

```bash
git add .claude/skills/freshell-orchestration/SKILL.md
git commit -m "docs(skill): document tab and pane rename orchestration"
```

### Task 7: Final Verification

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

Only do this after the automated suite passes. Run:

```bash
FSH="npx tsx server/cli/index.ts"
TAB_JSON="$($FSH new-tab -n 'Canary Rename' --codex --cwd /absolute/path/to/repo)"
TAB_ID="$(printf '%s' "$TAB_JSON" | jq -r '.data.tabId')"
P0="$(printf '%s' "$TAB_JSON" | jq -r '.data.paneId')"
P1="$($FSH split-pane -t "$P0" --editor /absolute/path/to/repo/README.md | jq -r '.data.paneId')"
$FSH rename-tab -t "$TAB_ID" -n "Canary workspace"
$FSH rename-pane -t "$P0" -n "Agent"
$FSH select-pane -t "$P1"
$FSH rename-pane "Docs"
```

Expected:
- The tab title changes to `Canary workspace`
- The pane titles change to `Agent` and `Docs`
- No manual double-click or context-menu rename is required

## Notes for the Executor

- Use `@trycycle-executing` to carry this out exactly task-by-task.
- Keep the scope tight. Do not expand into session-title unification or unrelated rename cleanup for this issue.
- Reuse the existing reducers and route structure. This issue is about exposing missing orchestration capabilities, not inventing a second rename system.
- Preserve existing response semantics unless implementation proves they block the acceptance criteria. The requested behavior change is new rename capability, not a broad API status-code redesign.
