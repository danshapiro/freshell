# Large Client Chunk Reduction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce initial client bundle pressure by deferring optional heavy dependencies (`@xterm/addon-webgl`, `react-markdown`, `remark-gfm`) and set a realistic Vite chunk warning threshold that reflects the app's actual baseline.

**Architecture:** Keep runtime behavior unchanged while moving non-critical code paths behind lazy boundaries. Terminal startup should remain immediate with fit/search addons, while WebGL is attached asynchronously when enabled. Markdown rendering should be split into a lazy renderer used by both editor preview and Claude chat assistant blocks. Build warnings should use an explicit, tested threshold so regressions are still visible without noisy false positives.

**Tech Stack:** React 18, TypeScript, Vite 6, Vitest, Testing Library, xterm v6 (`@xterm/*`), `react-markdown`, `remark-gfm`.

---

## Acceptance Criteria

- `@xterm/addon-webgl` is no longer in the initial entry chunk.
- `react-markdown` and `remark-gfm` are no longer in the initial entry chunk.
- Terminal behavior remains intact (terminal opens, search still works, renderer fallback still works).
- Markdown behavior remains intact (assistant markdown and editor markdown preview still render).
- Vite chunk warning limit is explicitly configured and covered by unit tests.
- Targeted unit and e2e tests pass.
- `npm run build:client` completes without unexpected warnings.

---

### Task 1: Defer WebGL Addon Loading in Terminal Runtime

**Files:**
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Modify: `test/unit/client/components/TerminalView.renderer.test.tsx`
- E2E Regression Run: `test/e2e/terminal-search-flow.test.tsx`

**Step 1: Write failing unit tests for async WebGL attach behavior**

Add/adjust tests in `test/unit/client/components/terminal/terminal-runtime.test.ts` so WebGL activation is asynchronous:

```ts
it('starts with webgl inactive and enables it asynchronously', async () => {
  const terminal = { loadAddon: vi.fn() }
  const runtime = createTerminalRuntime({ terminal: terminal as any, enableWebgl: true })

  runtime.attachAddons()

  expect(runtime.webglActive()).toBe(false)
  await waitFor(() => expect(runtime.webglActive()).toBe(true))
})
```

Also keep/expand tests for:
- load failure fallback (`runtime.attachAddons()` does not throw)
- context-loss fallback still marks runtime inactive and leaves fit/search usable

**Step 2: Run targeted unit test to verify failure**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/client/components/terminal/terminal-runtime.test.ts
```

Expected: FAIL on new asynchronous WebGL expectation.

**Step 3: Implement lazy WebGL import in runtime**

In `src/components/terminal/terminal-runtime.ts`, replace static WebGL import with cached dynamic import:

```ts
let webglAddonModulePromise: Promise<typeof import('@xterm/addon-webgl')> | null = null

function loadWebglAddonModule() {
  if (!webglAddonModulePromise) {
    webglAddonModulePromise = import('@xterm/addon-webgl')
  }
  return webglAddonModulePromise
}
```

Attach fit/search synchronously, then asynchronously attach WebGL when enabled:

```ts
if (enableWebgl) {
  void loadWebglAddonModule()
    .then(({ WebglAddon }) => {
      if (disposed) return
      webglAddon = new WebglAddon()
      terminal.loadAddon(webglAddon)
      isWebglActive = true
      webglLossDisposable = webglAddon.onContextLoss(() => {
        disableWebgl()
      })
    })
    .catch(() => {
      disableWebgl()
    })
}
```

Keep `attachAddons()` callable as before so `TerminalView` does not need API changes.

**Step 4: Adjust renderer-focused unit tests for async attach**

If needed, update `test/unit/client/components/TerminalView.renderer.test.tsx` to use `waitFor` when asserting WebGL status transitions.

**Step 5: Run tests**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/components/TerminalView.renderer.test.tsx
NODE_ENV=test npx vitest run test/e2e/terminal-search-flow.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/terminal/terminal-runtime.ts test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/components/TerminalView.renderer.test.tsx
git commit -m "perf(terminal): lazy-load webgl addon and preserve runtime fallback behavior"
```

---

### Task 2: Split Markdown Tooling Behind a Shared Lazy Renderer

**Files:**
- Create: `src/components/markdown/MarkdownRenderer.tsx`
- Create: `src/components/markdown/LazyMarkdown.tsx`
- Modify: `src/components/panes/MarkdownPreview.tsx`
- Modify: `src/components/claude-chat/MessageBubble.tsx`
- Modify: `test/unit/client/components/panes/MarkdownPreview.test.tsx`
- Modify: `test/unit/client/components/claude-chat/MessageBubble.test.tsx`
- Modify: `test/unit/client/components/panes/EditorPane.test.tsx`
- Modify: `test/e2e/claude-chat-polish-flow.test.tsx`

**Step 1: Write failing tests for lazy markdown rendering timing**

Update unit tests to await rendered markdown rather than expecting it synchronously.

Example updates:

```ts
expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
```

```ts
expect(await screen.findByText('Bold text')).toBeInTheDocument()
```

Add one e2e integration assertion in `test/e2e/claude-chat-polish-flow.test.tsx` that assistant markdown still renders correctly when delivered as markdown-formatted text.

**Step 2: Run tests to verify failure before implementation**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/client/components/panes/MarkdownPreview.test.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/e2e/claude-chat-polish-flow.test.tsx
```

Expected: FAIL (until lazy renderer is implemented and wired).

**Step 3: Create shared markdown renderer modules**

`src/components/markdown/MarkdownRenderer.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownRenderer({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
}
```

`src/components/markdown/LazyMarkdown.tsx`:

```tsx
import { lazy, Suspense } from 'react'

const MarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer }))
)

type LazyMarkdownProps = {
  content: string
  fallback?: React.ReactNode
}

export function LazyMarkdown({ content, fallback = null }: LazyMarkdownProps) {
  return (
    <Suspense fallback={fallback}>
      <MarkdownRenderer content={content} />
    </Suspense>
  )
}
```

**Step 4: Wire lazy markdown in existing components**

- In `src/components/panes/MarkdownPreview.tsx`, remove direct imports of `react-markdown`/`remark-gfm` and render `LazyMarkdown`.
- In `src/components/claude-chat/MessageBubble.tsx`, replace direct assistant markdown render with `LazyMarkdown`; keep user-text, thinking, and tool blocks unchanged.

Example:

```tsx
<div className="prose prose-sm dark:prose-invert max-w-none">
  <LazyMarkdown content={block.text} fallback={<p className="whitespace-pre-wrap">{block.text}</p>} />
</div>
```

**Step 5: Run tests**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/client/components/panes/MarkdownPreview.test.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/e2e/claude-chat-polish-flow.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/markdown/MarkdownRenderer.tsx src/components/markdown/LazyMarkdown.tsx src/components/panes/MarkdownPreview.tsx src/components/claude-chat/MessageBubble.tsx test/unit/client/components/panes/MarkdownPreview.test.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/e2e/claude-chat-polish-flow.test.tsx
git commit -m "perf(markdown): lazy-load markdown renderer for editor preview and claude chat"
```

---

### Task 3: Set and Test a Realistic Vite Chunk Warning Limit

**Files:**
- Modify: `config/vite/vite.config.ts`
- Modify: `test/unit/vite-config.test.ts`

**Step 1: Write failing config test**

In `test/unit/vite-config.test.ts`, add an assertion that production build config sets an explicit chunk warning limit:

```ts
expect(config.build?.chunkSizeWarningLimit).toBe(1400)
```

**Step 2: Run targeted test to verify failure**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/vite-config.test.ts
```

Expected: FAIL (property not set yet).

**Step 3: Implement config change**

Set chunk warning limit in `config/vite/vite.config.ts`:

```ts
build: {
  outDir: 'dist/client',
  sourcemap: mode === 'development',
  chunkSizeWarningLimit: 1400,
},
```

**Step 4: Re-run config test**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/vite-config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add config/vite/vite.config.ts test/unit/vite-config.test.ts
git commit -m "build(vite): set explicit chunk warning limit aligned to current app baseline"
```

---

### Task 4: Verify Bundle Outcome and Guard Against Regressions

**Files:**
- No code changes required unless verification fails.

**Step 1: Build and verify warnings/chunks**

Run:
```bash
npm run build:client
npm run build:client -- --sourcemap --minify=false
```

Expected:
- Build completes.
- No warning about `@xterm/addon-webgl`, `react-markdown`, or `remark-gfm` being in the primary entry chunk.
- Chunk warning is either absent (under 1400 kB minified) or is meaningful regression noise.

**Step 2: Confirm source-map composition of entry chunk**

Run:
```bash
node -e "const fs=require('fs');const path=require('path');const dir='dist/client/assets';const map=fs.readdirSync(dir).filter(f=>/^index-.*\\.js\\.map$/.test(f)).sort((a,b)=>fs.statSync(path.join(dir,b)).size-fs.statSync(path.join(dir,a)).size)[0];const j=JSON.parse(fs.readFileSync(path.join(dir,map),'utf8'));const inEntry=(name)=>j.sources.some(s=>s.includes(name));console.log('webgl in entry',inEntry('@xterm/addon-webgl'));console.log('react-markdown in entry',inEntry('react-markdown'));console.log('remark-gfm in entry',inEntry('remark-gfm'));"
```

Expected output:
- `webgl in entry false`
- `react-markdown in entry false`
- `remark-gfm in entry false`

**Step 3: Run focused regression suite**

Run:
```bash
NODE_ENV=test npx vitest run test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/components/TerminalView.renderer.test.tsx test/unit/client/components/panes/MarkdownPreview.test.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/vite-config.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/claude-chat-polish-flow.test.tsx
```

Expected: PASS.

**Step 4: Final integration check**

Run:
```bash
npm test
```

Expected: PASS. If failures occur, fix before merge.

---

## Notes for Executor

- Keep behavior-first parity: these are performance refactors, not UX changes.
- Avoid `manualChunks` unless verification proves dynamic splits are insufficient.
- Keep all new imports/client code ESM-safe and use existing alias conventions.
- If any lazy boundary introduces UI flicker, add minimal fallback text/skeletons instead of reverting the split.
