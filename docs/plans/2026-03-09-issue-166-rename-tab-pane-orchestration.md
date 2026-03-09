# Issue 166 Rename Tab and Pane Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Expose orchestration operations for renaming tabs and panes, including active-target defaults and explicit identifiers, and document those operations in the Freshell orchestration skill.

**Architecture:** Keep orchestration server-authoritative. Tab rename already has a write path; tighten it so rename requests are trimmed and blank names are rejected, then add the missing symmetric pane rename write path in `LayoutStore` and `createAgentApiRouter()`. Keep the CLI as the single orchestration surface that agents call: extend `rename-tab` so one positional argument renames the active tab, add `rename-pane` with the same grammar for panes, broadcast `ui.command` events for both rename types, and update the orchestration skill to document the exact commands and a complete create/split/rename flow.

**Tech Stack:** TypeScript, Express agent API, Freshell CLI (`server/cli`), React/Redux UI command handling, Vitest, supertest, child-process CLI e2e tests.

---

## Strategy Gate

- The actual missing capability is not “more skill prose”; it is a complete pane-title write path plus CLI verbs that can target either the active item or an explicit tab/pane identifier without manual UI interaction.
- Do **not** reuse terminal/session rename APIs for this issue. Those rename override metadata for coding CLI terminals, but they do not cover editor/browser/shell panes and therefore do not satisfy “rename pane” as a layout-level orchestration primitive.
- Do **not** solve pane rename by mutating Redux only. Orchestration must work against a remote Freshell server over HTTP, so the mutation has to be persisted in `LayoutStore` and broadcast back to connected clients.
- Keep `rename-tab` and `rename-pane` as separate explicit operations. Do **not** auto-rename a tab when renaming a pane, even in a single-pane tab; the caller can invoke both operations when it wants both outcomes.
- Put active-target defaults in the CLI parser, not only in docs. The skill should describe a capability that already exists in the executable surface.
- Use a real `LayoutStore` in the CLI e2e tests for the create/split/rename flow. That is the only way to prove the plan lands the requested end state directly instead of only testing route mocks in isolation.
- While touching rename semantics, normalize both rename routes and both CLI verbs the same way: trim incoming names and reject blank results. That matches the existing inline UI behavior and avoids storing empty titles.

## Acceptance Mapping

- `rename-tab` remains the tab rename orchestration operation, but the CLI grammar is extended so `rename-tab NEW_NAME` renames the active tab, `rename-tab TARGET NEW_NAME` renames a specific tab, and flagged forms still work when the caller needs to disambiguate target or name.
- Add `rename-pane` as a first-class pane rename orchestration operation, with active-pane and explicit-target forms.
- The server agent API gains a pane rename endpoint and a `LayoutStore.renamePane()` primitive so CLI, agents, and future automation all share the same authoritative write path.
- Connected UIs converge immediately because the server broadcasts `tab.rename` and `pane.rename` `ui.command` events after successful mutations.
- The CLI test suite proves both active-target rename and explicit identifier rename, including a non-active tab target so the “specific tab or pane identifier” requirement is verified rather than inferred.
- The Freshell orchestration skill documents both rename verbs and includes a concrete new-tab/split-pane/rename flow that assigns meaningful tab and pane names without any manual UI interaction.

### Task 1: Lock Down Rename Contracts on the Server

**Files:**
- Modify: `test/server/agent-tabs-write.test.ts`
- Modify: `test/server/agent-panes-write.test.ts`
- Modify: `test/unit/server/agent-layout-store-write.test.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `server/agent-api/router.ts`

**Step 1: Write the failing server tests**

In `test/server/agent-tabs-write.test.ts`, add one validation test and one trimming test:

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

it('trims tab rename payloads before writing and broadcasting', async () => {
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

In `test/server/agent-panes-write.test.ts`, add blank-name validation plus the new pane route:

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

it('renames a pane via PATCH /api/panes/:id', async () => {
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
  expect(renamePane).toHaveBeenCalledWith('tab_1', 'pane_real', 'Logs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_real', title: 'Logs' },
  })
})
```

In `test/unit/server/agent-layout-store-write.test.ts`, add the missing layout-level persistence coverage:

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
- FAIL because rename routes currently accept whitespace-only names

**Step 3: Implement the server rename primitives**

In `server/agent-api/router.ts`, add a shared helper near `parseOptionalNumber()`:

```ts
const parseRequiredName = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}
```

Use that helper in the existing tab route so the route rejects blank names and broadcasts the trimmed title:

```ts
router.patch('/tabs/:id', (req, res) => {
  const name = parseRequiredName(req.body?.name)
  if (!name) return res.status(400).json(fail('name required'))

  const result = layoutStore.renameTab(req.params.id, name)
  wsHandler?.broadcastUiCommand({ command: 'tab.rename', payload: { id: req.params.id, title: name } })
  res.json(ok(result, result.message || 'tab renamed'))
})
```

In `server/agent-api/layout-store.ts`, add a pane rename primitive that writes to `snapshot.paneTitles` and can recover the owning tab from the pane ID when the caller omits `tabId`:

```ts
renamePane(tabId: string | undefined, paneId: string, title: string) {
  if (!this.snapshot) return { message: 'no layout snapshot' as const }

  const pane = this.getPaneSnapshot(paneId)
  if (!pane) return { message: 'pane not found' as const }

  const targetTabId = tabId && tabId === pane.tabId ? tabId : pane.tabId
  if (!this.snapshot.paneTitles) this.snapshot.paneTitles = {}
  if (!this.snapshot.paneTitles[targetTabId]) this.snapshot.paneTitles[targetTabId] = {}
  this.snapshot.paneTitles[targetTabId][paneId] = title
  return { tabId: targetTabId, paneId }
}
```

Still in `server/agent-api/router.ts`, add the pane rename route next to the other `/panes/:id/*` write routes:

```ts
router.patch('/panes/:id', (req, res) => {
  const name = parseRequiredName(req.body?.name)
  if (!name) return res.status(400).json(fail('name required'))

  const resolved = resolvePaneTarget(req.params.id)
  const paneId = resolved.paneId || req.params.id
  const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId : resolved.tabId
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

Important details:
- Keep target resolution behavior consistent with existing pane endpoints by reusing `resolvePaneTarget()`.
- Broadcast only after a resolved tab/pane result exists.
- Leave `LayoutStore.renameTab()` simple; the route is responsible for validation and trimming, which keeps existing call sites stable.

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

**Step 2: Run the client test and confirm failure**

Run:

```bash
npm test -- test/unit/client/ui-commands.test.ts
```

Expected:
- FAIL because `pane.rename` is not handled yet

**Step 3: Implement the minimal broadcast handler**

In `src/lib/ui-commands.ts`, import `updatePaneTitle` from `@/store/panesSlice` and add the missing case:

```ts
case 'pane.rename':
  return dispatch(updatePaneTitle({
    tabId: msg.payload.tabId,
    paneId: msg.payload.paneId,
    title: msg.payload.title,
  }))
```

Important detail:
- Do **not** pass `setByUser: false` here. A rename coming from orchestration is an intentional title override and should be treated the same as an in-app manual rename so later automatic terminal-title updates do not clobber it.

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

### Task 3: Extend the CLI Rename Surface to Support Active Targets, Explicit Targets, and Pane Rename

**Files:**
- Modify: `test/e2e/agent-cli-flow.test.ts`
- Modify: `server/cli/index.ts`

**Step 1: Write the failing CLI end-to-end tests**

In `test/e2e/agent-cli-flow.test.ts`, add a real-layout helper near `startTestServer()` so these tests exercise the actual `LayoutStore` mutation path instead of a bag of route mocks:

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

Then add three focused rename tests:

```ts
it('renames a non-active tab when a target id is provided', async () => {
  const server = await startTestServerWithRealLayoutStore()
  try {
    const first = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Backlog'])
    const second = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Active'])

    await runCli(server.url, ['rename-tab', first.data.tabId, 'Release board'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.activeTabId).toBe(second.data.tabId)
    expect(snapshot.tabs.find((tab: any) => tab.id === first.data.tabId)?.title).toBe('Release board')
    expect(snapshot.tabs.find((tab: any) => tab.id === second.data.tabId)?.title).toBe('Active')
  } finally {
    await server.close()
  }
})

it('renames the active tab and explicit panes in a create split rename flow', async () => {
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

    await runCli(server.url, ['rename-tab', 'Release prep'])
    await runCli(server.url, ['rename-pane', '-t', firstPaneId, '-n', 'Codex'])
    await runCli(server.url, ['rename-pane', secondPaneId, 'Editor'])

    const snapshot = (server.layoutStore as any).snapshot
    expect(snapshot.tabs.find((tab: any) => tab.id === tabId)?.title).toBe('Release prep')
    expect(snapshot.paneTitles[tabId][firstPaneId]).toBe('Codex')
    expect(snapshot.paneTitles[tabId][secondPaneId]).toBe('Editor')
  } finally {
    await server.close()
  }
})

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

**Step 2: Run the CLI e2e file and confirm failure**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- FAIL because `rename-pane` is not implemented
- FAIL because `rename-tab NAME` currently treats the lone positional argument as a target instead of the new name for the active tab
- FAIL because there is no code path that preserves an explicit `-t/--target` when the new name is supplied positionally

**Step 3: Implement shared rename parsing and the new `rename-pane` verb**

In `server/cli/index.ts`, add a small helper near `getFlag()` so both rename commands share identical grammar:

```ts
function resolveRenameArgs(flags: Flags, args: string[]) {
  const explicitTarget = getFlag(flags, 't', 'target', 'tab', 'pane')
  const explicitName = getFlag(flags, 'n', 'name', 'title')

  if (typeof explicitName === 'string') {
    return {
      target: typeof explicitTarget === 'string' ? explicitTarget : args[0],
      name: explicitName.trim(),
    }
  }

  if (typeof explicitTarget === 'string') {
    return {
      target: explicitTarget,
      name: (args[0] || '').trim(),
    }
  }

  if (args.length === 1) {
    return { target: undefined, name: args[0].trim() }
  }

  if (args.length >= 2) {
    return { target: args[0], name: args[1].trim() }
  }

  return {
    target: typeof explicitTarget === 'string' ? explicitTarget : undefined,
    name: '',
  }
}
```

Update `rename-tab` to use that helper:

```ts
case 'rename-tab': {
  const { target, name } = resolveRenameArgs(flags, args)
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

Add a new `rename-pane` case right after the other pane-management commands:

```ts
case 'rename-pane': {
  const { target, name } = resolveRenameArgs(flags, args)
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

  const res = await client.patch(`/api/panes/${encodeURIComponent(resolved.pane.id)}`, {
    tabId: resolved.tab?.id,
    name,
  })
  writeJson(res)
  return
}
```

Important details:
- Preserve all of these forms for both tab and pane rename:
  - `rename-<kind> NEW_NAME`
  - `rename-<kind> TARGET NEW_NAME`
  - `rename-<kind> -t TARGET -n NEW_NAME`
  - `rename-<kind> -t TARGET NEW_NAME`
  - `rename-<kind> TARGET -n NEW_NAME`
- One positional argument means “rename the active target”.
- A target flag wins over positional target inference; a name flag wins over positional name inference.
- Two positional arguments mean “rename the explicit target to the provided name”.
- Trim the final name before validating so whitespace-only input fails locally before the HTTP request is sent.

**Step 4: Re-run the CLI e2e file**

Run:

```bash
npm test -- test/e2e/agent-cli-flow.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/e2e/agent-cli-flow.test.ts server/cli/index.ts
git commit -m "feat(cli): add rename-pane and explicit rename targets"
```

### Task 4: Update the Orchestration Skill to Expose the New Surface

**Files:**
- Modify: `.claude/skills/freshell-orchestration/SKILL.md`

**Step 1: Rewrite the rename command reference**

In the “Command reference” section, replace the ambiguous rename syntax with explicit active-target and targeted forms:

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

Under “Targets”, add a short note so agents do not have to infer the grammar:

```md
- Omitted target on `rename-tab` means the active tab.
- Omitted target on `rename-pane` means the active pane in the active tab.
- If the target or new name contains spaces, prefer the flagged `-t/-n` form.
```

Add a concrete end-to-end playbook that proves the acceptance criteria in the skill itself:

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
$FSH rename-pane -t "$P1" -n "Editor"
```

**Step 2: Sanity-check the markdown for accuracy**

Run:

```bash
sed -n '1,260p' .claude/skills/freshell-orchestration/SKILL.md
```

Expected:
- Command reference includes `rename-pane`
- Active-target behavior is explicit for both rename commands
- The playbook shows a create/split/rename flow with no UI interaction

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

Only do this after the automated suite passes. Run:

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

- Keep this cycle tight. Do not expand the read surface with new pane-title listing tokens or unrelated rename unification work unless implementation proves that unavoidable.
- Reuse existing reducers (`updateTab`, `updatePaneTitle`) instead of inventing parallel client state. This issue is about adding the missing server write path and exposing it through orchestration, not building a second rename system.
- Preserve the existing tmux-style target resolution rules in `resolveTarget()`. This issue only needs rename verbs to consume those rules.
- Be strict about rename-argument precedence in the CLI helper. This is the main place a superficially working implementation can still violate the acceptance criteria by renaming the wrong target.
- The CLI e2e file already has mock-based smoke coverage; the new tests should sit beside that, not replace it, because both levels are useful.
