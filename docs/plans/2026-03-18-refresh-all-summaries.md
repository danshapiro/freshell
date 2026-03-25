# Refresh All Summaries Implementation Plan

> **For agentic workers:** REQUIRED: Use trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Refresh All" button to the Overview page that regenerates AI summaries for all terminals in parallel, using user-only messages for coding CLI terminals (claude, codex, opencode, etc.) and scrollback for plain shell terminals, skipping terminals unchanged since their last summary refresh.

**Architecture:** Three layers of changes: (1) a new pure utility `extractUserMessages()` that reads a coding CLI session's JSONL file and extracts only user message text with `...` placeholders for assistant responses, (2) an enhanced AI router with a new batch endpoint and per-terminal smart input selection (user-messages for coding CLIs, scrollback for shells), with a new coding-CLI-aware prompt, and (3) client-side "Refresh All" button in OverviewView that dispatches parallel requests only for changed terminals and tracks per-terminal refresh timestamps.

**Tech Stack:** TypeScript, Express, React 18, Vitest, Testing Library, supertest

---

## Design Decisions

### D1: User-message extraction lives server-side, not in the provider parsers

The user's request is specifically about AI summary generation. The existing provider parsers (`claude.ts`, `codex.ts`, `opencode.ts`) already know how to identify user messages -- `extractUserMessageText()` in Claude, `role === 'user'` in Codex -- but they parse for *metadata* (title, first user message, etc.), not for bulk text extraction. We create a new focused utility `server/ai-user-message-extractor.ts` that:

- Takes a session file path and provider name
- Reads the JSONL content
- Walks each line, extracting user message text using the same patterns the existing providers use
- Returns the last 20,000 characters of user messages, joined with `\n...\n` between them (the `...` represents omitted assistant responses)
- Biases towards recency by taking the *last* 20K chars (truncating from the front)

**Justification:** The existing providers parse for metadata extraction and are not designed for bulk text aggregation. A separate utility is cleaner, more testable, and avoids coupling summary generation to session indexing. It reuses the same JSONL parsing knowledge but serves a different purpose.

### D2: The summary endpoint gains an optional `mode` + `sessionFilePath` parameter, not a separate batch endpoint

Rather than creating a separate `/api/ai/terminals/summary-all` batch endpoint, we enhance the existing single-terminal summary endpoint to accept optional body parameters `{ mode, sessionFilePath }` that the AI router uses to decide its input strategy. The client calls the single endpoint N times in parallel (using `Promise.allSettled`). This keeps the API simple and incremental -- each call is independently retriable, and partial failures are natural.

The AI router's logic becomes:
1. If `mode !== 'shell'` and the terminal has a bound session: read the session's JSONL file, extract user messages, and use the coding-CLI prompt.
2. Otherwise: fall back to the existing scrollback-based summary (existing behavior, unchanged).

**Justification:** A batch endpoint adds complexity (partial failure semantics, progress tracking) without clear benefit. Parallel individual requests give the same throughput, are simpler, and let the client handle each result independently. The existing per-terminal endpoint already has the right error semantics.

### D3: Change detection uses `lastActivityAt` vs stored `summaryGeneratedAtActivity` timestamp

Each time a summary is generated, the client stores `{ terminalId: lastActivityAtWhenGenerated }` in component-local state (a `Map<string, number>`). When "Refresh All" is clicked, a terminal is skipped if `terminal.lastActivityAt <= summaryGeneratedAtActivity`. This is simpler and more reliable than storing the generation timestamp itself, because it directly captures "has the terminal produced new output since we last summarized it?"

We also persist this map in `localStorage` under `freshell:summaryActivityMap` so it survives page refreshes. The map is pruned to only include terminals that still exist whenever it's loaded.

**Justification:** Using `lastActivityAt` from the server as the change signal is exact -- if `lastActivityAt` hasn't changed, the terminal has produced no new output, and the summary would be identical. Storing in component state + localStorage is appropriate because this is a UI convenience feature, not critical server state.

### D4: The coding-CLI prompt is a separate prompt template in `ai-prompts.ts`

We add `PROMPTS.codingCliSummary` alongside the existing `PROMPTS.terminalSummary`:

```typescript
codingCliSummary: {
  model: AI_CONFIG.model,
  maxOutputTokens: 120,
  build: (userMessages: string) => [
    'This is a coding agent session with only the user messages; the assistant replies are removed.',
    'Summarize it in under 250 characters.',
    'If multiple things happen, bias towards recency (the end of the messages).',
    'No markdown. No quotes.',
    '',
    'User messages:',
    userMessages,
  ].join('\n'),
},
```

The 250-character instruction in the prompt is slightly larger than the 240-char slice in the code to give the model room. The code enforces the hard 240-char cap on the response.

**Justification:** Separate prompts for the two input types produce better results. A scrollback dump needs "summarize this terminal session" framing; user-only messages need "this is a coding agent session with only user messages" framing as the user specified.

### D5: Session file resolution goes through the existing `codingCliIndexer.getFilePathForSession()`

The AI router needs to find the JSONL file for a coding CLI terminal. The terminal registry already stores `mode` and `resumeSessionId`. The `codingCliIndexer` already maintains a `sessionKeyToFilePath` map. We wire the indexer into the AI router's deps so it can call `getFilePathForSession(sessionId, provider)` to get the file path.

For terminals that don't have a `resumeSessionId` yet (e.g., very new sessions), we fall back to the scrollback-based summary. This is correct because if no session file is discoverable, there are no user messages to extract.

**Justification:** Reuses existing infrastructure. The indexer already watches and caches session file locations; duplicating that logic would be wasteful and error-prone.

### D6: The `TerminalOverview` client type and the server list response both already include `mode`

The server's `TerminalDirectoryItem` already includes `mode: TerminalMode` and `resumeSessionId?: string`. However, the client-side `TerminalOverview` type in `OverviewView.tsx` is missing `mode`. We add `mode` and `resumeSessionId` to the client type. This information is needed so the client can pass it to the summary endpoint (the server uses it to decide the input strategy).

## File Structure

### Files to create:
- `server/ai-user-message-extractor.ts` — Pure utility: reads a JSONL file and extracts user-only message text with `...` placeholders
- `test/server/ai-user-message-extractor.test.ts` — Unit tests for the extractor
- `test/unit/components/OverviewView.test.tsx` — Component tests for OverviewView "Refresh All" behavior

### Files to modify:
- `server/ai-prompts.ts` — Add `codingCliSummary` prompt template
- `server/ai-router.ts` — Enhance `AiRouterDeps` with `codingCliIndexer` and `registry` mode access; add coding-CLI-aware summary logic
- `server/index.ts` — Wire `codingCliIndexer` and enhanced registry type into `createAiRouter` deps
- `src/components/OverviewView.tsx` — Add `mode`/`resumeSessionId` to `TerminalOverview`; add "Refresh All" button; add change detection logic
- `test/server/ai-api.test.ts` — Add tests for coding-CLI-aware summary path and batch behavior

---

### Task 1: Create `extractUserMessages()` utility with tests

**Files:**
- Create: `server/ai-user-message-extractor.ts`
- Create: `test/server/ai-user-message-extractor.test.ts`

- [ ] **Step 1: Write failing tests for `extractUserMessages()`**

Create `test/server/ai-user-message-extractor.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { extractUserMessages } from '../../server/ai-user-message-extractor.js'

describe('extractUserMessages', () => {
  it('extracts user messages from Claude JSONL and joins with ... placeholders', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/user', sessionId: 'abc' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix bug 123.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will fix that.' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Now fix bug 456.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('Fix bug 123.')
    expect(result).toContain('...')
    expect(result).toContain('Now fix bug 456.')
    expect(result).not.toContain('I will fix that.')
    expect(result).not.toContain('Done.')
  })

  it('extracts user messages from Codex JSONL', () => {
    const jsonl = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Refactor the auth module.' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Refactoring...' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests for it.' }] } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'codex')
    expect(result).toContain('Refactor the auth module.')
    expect(result).toContain('...')
    expect(result).toContain('Add tests for it.')
    expect(result).not.toContain('Refactoring...')
  })

  it('returns empty string for content with no user messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/user' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(extractUserMessages('', 'claude')).toBe('')
  })

  it('truncates from the front to keep last 20000 chars, biasing recency', () => {
    const longMessage = 'A'.repeat(15000)
    const recentMessage = 'B'.repeat(10000)
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: longMessage } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: recentMessage } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result.length).toBeLessThanOrEqual(20000)
    // Recent message should be fully preserved
    expect(result).toContain(recentMessage)
  })

  it('strips ANSI codes from user messages', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: '\x1b[32mFix the\x1b[0m bug.' } })
    const result = extractUserMessages(jsonl, 'claude')
    expect(result).not.toContain('\x1b[')
    expect(result).toContain('Fix the bug.')
  })

  it('handles malformed JSON lines gracefully', () => {
    const jsonl = [
      'not valid json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Valid message.' } }),
      '{ broken',
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('Valid message.')
  })

  it('handles user messages with array content blocks (Claude format)', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First part.' },
          { type: 'text', text: 'Second part.' },
        ],
      },
    })

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('First part.')
    expect(result).toContain('Second part.')
  })

  it('handles role: "user" at top level (alternative Claude format)', () => {
    const jsonl = JSON.stringify({ role: 'user', content: 'Direct user content.' })
    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('Direct user content.')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/server/ai-user-message-extractor.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `extractUserMessages()`**

Create `server/ai-user-message-extractor.ts`:

```typescript
/**
 * Extract user-only messages from a coding CLI session's JSONL content.
 * Returns the last MAX_CHARS characters of user messages joined with
 * "..." placeholders representing omitted assistant responses.
 * Biases towards recency by truncating from the front.
 */

import { stripAnsi } from './ai-prompts.js'

const MAX_CHARS = 20_000
const PLACEHOLDER = '...'

/**
 * Extract text content from a user message object.
 * Handles both Claude and Codex JSONL formats:
 * - Claude: { type: 'user', message: { role: 'user', content: string | ContentBlock[] } }
 *           or { role: 'user', content: string | ContentBlock[] }
 * - Codex: { type: 'response_item', payload: { type: 'message', role: 'user', content: ContentBlock[] } }
 */
function extractUserText(obj: any, provider: string): string | undefined {
  // Claude format: { type: 'user', message: { role: 'user', content: ... } }
  if (obj?.message?.role === 'user') {
    return resolveContent(obj.message.content)
  }

  // Claude format: { role: 'user', content: ... }
  if (obj?.role === 'user') {
    return resolveContent(obj.content)
  }

  // Codex format: { type: 'response_item', payload: { type: 'message', role: 'user', content: ... } }
  if (
    provider === 'codex' &&
    obj?.type === 'response_item' &&
    obj?.payload?.type === 'message' &&
    obj?.payload?.role === 'user'
  ) {
    return resolveContent(obj.payload.content)
  }

  return undefined
}

function resolveContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined
  }

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return undefined
}

export function extractUserMessages(jsonlContent: string, provider: string): string {
  if (!jsonlContent.trim()) return ''

  const lines = jsonlContent.split(/\r?\n/).filter(Boolean)
  const userMessages: string[] = []

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const text = extractUserText(obj, provider)
    if (text) {
      const cleaned = stripAnsi(text).trim()
      if (cleaned) {
        userMessages.push(cleaned)
      }
    }
  }

  if (userMessages.length === 0) return ''

  // Join with placeholder separators
  const joined = userMessages.join(`\n${PLACEHOLDER}\n`)

  // Truncate from the front to keep the last MAX_CHARS, biasing recency
  if (joined.length <= MAX_CHARS) return joined
  return joined.slice(-MAX_CHARS)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/server/ai-user-message-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/refresh-all-summaries
git add server/ai-user-message-extractor.ts test/server/ai-user-message-extractor.test.ts
git commit -m "feat: add extractUserMessages utility for coding CLI JSONL parsing"
```

---

### Task 2: Add coding-CLI summary prompt to `ai-prompts.ts`

**Files:**
- Modify: `server/ai-prompts.ts`

- [ ] **Step 1: Write failing test for the new prompt**

Add to `test/server/ai-api.test.ts`:

```typescript
import { PROMPTS } from '../../server/ai-prompts.js'

describe('AI prompts', () => {
  it('codingCliSummary prompt includes the user messages and correct framing', () => {
    const userMessages = 'Fix bug 123.\n...\nNow fix bug 456.'
    const prompt = PROMPTS.codingCliSummary.build(userMessages)
    expect(prompt).toContain('coding agent session')
    expect(prompt).toContain('user messages')
    expect(prompt).toContain('assistant replies are removed')
    expect(prompt).toContain('250 characters')
    expect(prompt).toContain('bias towards recency')
    expect(prompt).toContain(userMessages)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/server/ai-api.test.ts`
Expected: FAIL — `PROMPTS.codingCliSummary` does not exist

- [ ] **Step 3: Add `codingCliSummary` prompt to `ai-prompts.ts`**

Add to the `PROMPTS` object in `server/ai-prompts.ts`:

```typescript
codingCliSummary: {
  model: AI_CONFIG.model,
  maxOutputTokens: 120,
  build: (userMessages: string) => {
    return [
      'This is a coding agent session with only the user messages; the assistant replies are removed.',
      'Summarize it in under 250 characters.',
      'If multiple things happen, bias towards recency (the end of the messages).',
      'No markdown. No quotes.',
      '',
      'User messages:',
      userMessages,
    ].join('\n')
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/server/ai-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/refresh-all-summaries
git add server/ai-prompts.ts test/server/ai-api.test.ts
git commit -m "feat: add codingCliSummary prompt template for user-only message summaries"
```

---

### Task 3: Enhance AI router with coding-CLI-aware summary generation

**Files:**
- Modify: `server/ai-router.ts`
- Modify: `server/index.ts`
- Modify: `test/server/ai-api.test.ts`

- [ ] **Step 1: Write failing tests for enhanced AI router**

Add to `test/server/ai-api.test.ts`:

```typescript
import { extractUserMessages } from '../../server/ai-user-message-extractor.js'

// ... inside the existing describe('AI API', () => { ... })

it('uses coding-CLI path for non-shell terminal with session file', async () => {
  const sessionContent = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the login bug.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Now add tests.' } }),
  ].join('\n')

  mockRegistry.get.mockReturnValue({
    buffer: { snapshot: () => 'some scrollback output' },
    mode: 'claude',
    resumeSessionId: 'session-abc',
  })

  // Mock the session file reader
  mockSessionFileReader.mockResolvedValue(sessionContent)

  const res = await request(app)
    .post('/api/ai/terminals/term-cli/summary')

  expect(res.status).toBe(200)
  expect(res.body.source).toBe('heuristic') // No AI key configured
  // Verify the heuristic still works even in coding-CLI mode
  expect(res.body.description).toBeTruthy()
})

it('falls back to scrollback for shell-mode terminals', async () => {
  mockRegistry.get.mockReturnValue({
    buffer: { snapshot: () => 'npm install\nDone in 2.3s' },
    mode: 'shell',
  })

  const res = await request(app)
    .post('/api/ai/terminals/term-shell/summary')

  expect(res.status).toBe(200)
  expect(res.body.description).toContain('npm install')
})

it('falls back to scrollback when no session file is found', async () => {
  mockRegistry.get.mockReturnValue({
    buffer: { snapshot: () => 'claude running\nAssistant output' },
    mode: 'claude',
    resumeSessionId: 'session-xyz',
  })

  mockSessionFileReader.mockResolvedValue(null)

  const res = await request(app)
    .post('/api/ai/terminals/term-no-session/summary')

  expect(res.status).toBe(200)
  expect(res.body.description).toContain('claude running')
})
```

The `mockSessionFileReader` needs to be set up in `beforeEach`, reflecting the new `AiRouterDeps` shape that includes a `readSessionContent` function.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/server/ai-api.test.ts`
Expected: FAIL

- [ ] **Step 3: Enhance `AiRouterDeps` and implement coding-CLI-aware summary logic**

Update `server/ai-router.ts` to:
1. Expand `AiRouterDeps.registry.get` return type to include `mode` and `resumeSessionId`
2. Add `readSessionContent?: (sessionId: string, provider: string) => Promise<string | null>` to deps
3. In the summary endpoint handler, check if `mode !== 'shell'` and `resumeSessionId` exists. If so, try to read session content and extract user messages. If user messages are found, use `PROMPTS.codingCliSummary`; otherwise fall back to scrollback with `PROMPTS.terminalSummary`.

```typescript
export interface AiRouterDeps {
  registry: {
    get: (id: string) => {
      buffer: { snapshot: () => string }
      mode?: string
      resumeSessionId?: string
    } | undefined
  }
  perfConfig: { slowAiSummaryMs: number }
  readSessionContent?: (sessionId: string, provider: string) => Promise<string | null>
}
```

The route handler logic:

```typescript
// Determine input strategy
let summaryInput: string
let promptConfig: typeof PROMPTS.terminalSummary | typeof PROMPTS.codingCliSummary

const isCodingCli = term.mode && term.mode !== 'shell'
let userMessages: string | null = null

if (isCodingCli && term.resumeSessionId && deps.readSessionContent) {
  try {
    const sessionContent = await deps.readSessionContent(term.resumeSessionId, term.mode!)
    if (sessionContent) {
      const extracted = extractUserMessages(sessionContent, term.mode!)
      if (extracted) {
        userMessages = extracted
      }
    }
  } catch (err) {
    log.warn({ err, terminalId }, 'Failed to read session content for coding CLI summary')
  }
}

if (userMessages) {
  summaryInput = userMessages
  promptConfig = PROMPTS.codingCliSummary
} else {
  summaryInput = snapshot
  promptConfig = PROMPTS.terminalSummary
}
```

- [ ] **Step 4: Wire `readSessionContent` in `server/index.ts`**

In the `createAiRouter` call in `server/index.ts`, add:

```typescript
app.use('/api/ai', createAiRouter({
  registry,
  perfConfig,
  readSessionContent: async (sessionId, provider) => {
    const filePath = codingCliIndexer.getFilePathForSession(sessionId, provider as CodingCliProviderName)
    if (!filePath) return null
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      return content
    } catch {
      return null
    }
  },
}))
```

Add `import fsp from 'fs/promises'` at the top of `index.ts` if not already present.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/server/ai-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/refresh-all-summaries
git add server/ai-router.ts server/index.ts test/server/ai-api.test.ts
git commit -m "feat: coding-CLI-aware summary uses user-only messages from session JSONL"
```

---

### Task 4: Add "Refresh All" button with change detection to OverviewView

**Files:**
- Modify: `src/components/OverviewView.tsx`
- Create: `test/unit/components/OverviewView.test.tsx`

- [ ] **Step 1: Write failing tests for "Refresh All" UI behavior**

Create `test/unit/components/OverviewView.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../../src/store/tabsSlice'

// Mock api module
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

// Mock ws-client
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    onMessage: () => () => {},
  }),
}))

import { api } from '@/lib/api'
import OverviewView from '../../../src/components/OverviewView'

function renderWithStore(ui: React.ReactElement) {
  const store = configureStore({
    reducer: { tabs: tabsReducer },
  })
  return render(<Provider store={store}>{ui}</Provider>)
}

describe('OverviewView Refresh All', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        terminalId: 't1',
        title: 'Shell',
        mode: 'shell',
        createdAt: 1000,
        lastActivityAt: 2000,
        status: 'running',
        hasClients: false,
      },
      {
        terminalId: 't2',
        title: 'Claude',
        mode: 'claude',
        resumeSessionId: 'sess-1',
        createdAt: 1000,
        lastActivityAt: 3000,
        status: 'running',
        hasClients: true,
      },
    ])
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ description: 'AI summary', source: 'heuristic' })
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
  })

  it('renders a "Refresh all summaries" button', async () => {
    renderWithStore(<OverviewView />)
    await waitFor(() => {
      expect(screen.getByLabelText('Refresh all summaries')).toBeInTheDocument()
    })
  })

  it('dispatches summary requests for all terminals on first click', async () => {
    renderWithStore(<OverviewView />)
    await waitFor(() => screen.getByLabelText('Refresh all summaries'))

    fireEvent.click(screen.getByLabelText('Refresh all summaries'))

    await waitFor(() => {
      // Should have called POST for each terminal's summary
      const postCalls = (api.post as ReturnType<typeof vi.fn>).mock.calls
      const summaryCalls = postCalls.filter((c: any[]) => c[0].includes('/summary'))
      expect(summaryCalls.length).toBe(2)
    })
  })

  it('skips terminals that have not changed since last refresh', async () => {
    renderWithStore(<OverviewView />)
    await waitFor(() => screen.getByLabelText('Refresh all summaries'))

    // First refresh
    fireEvent.click(screen.getByLabelText('Refresh all summaries'))
    await waitFor(() => {
      const postCalls = (api.post as ReturnType<typeof vi.fn>).mock.calls
      const summaryCalls = postCalls.filter((c: any[]) => c[0].includes('/summary'))
      expect(summaryCalls.length).toBe(2)
    })

    vi.clearAllMocks()
    // Re-fetch returns same lastActivityAt
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      { terminalId: 't1', title: 'Shell', mode: 'shell', createdAt: 1000, lastActivityAt: 2000, status: 'running', hasClients: false },
      { terminalId: 't2', title: 'Claude', mode: 'claude', resumeSessionId: 'sess-1', createdAt: 1000, lastActivityAt: 3000, status: 'running', hasClients: true },
    ])
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ description: 'AI summary', source: 'heuristic' })
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})

    // Second refresh -- should skip both since lastActivityAt unchanged
    fireEvent.click(screen.getByLabelText('Refresh all summaries'))
    await waitFor(() => {
      const postCalls = (api.post as ReturnType<typeof vi.fn>).mock.calls
      const summaryCalls = postCalls.filter((c: any[]) => c[0].includes('/summary'))
      expect(summaryCalls.length).toBe(0)
    })
  })

  it('handles partial failures gracefully', async () => {
    ;(api.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ description: 'Summary 1', source: 'ai' })
      .mockRejectedValueOnce(new Error('AI failed'))

    renderWithStore(<OverviewView />)
    await waitFor(() => screen.getByLabelText('Refresh all summaries'))

    fireEvent.click(screen.getByLabelText('Refresh all summaries'))

    // Should not crash; one succeeded, one failed
    await waitFor(() => {
      const patchCalls = (api.patch as ReturnType<typeof vi.fn>).mock.calls
      // Only the successful one gets patched
      expect(patchCalls.length).toBe(1)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/unit/components/OverviewView.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement "Refresh All" in OverviewView**

Modify `src/components/OverviewView.tsx`:

1. Add `mode` and `resumeSessionId` to the `TerminalOverview` type:
```typescript
type TerminalOverview = {
  terminalId: string
  title: string
  description?: string
  mode?: string
  resumeSessionId?: string
  createdAt: number
  lastActivityAt: number
  status: 'running' | 'exited'
  hasClients: boolean
  cwd?: string
}
```

2. Add state for refresh-all tracking:
```typescript
const STORAGE_KEY = 'freshell:summaryActivityMap'

function loadSummaryActivityMap(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return new Map(JSON.parse(raw))
  } catch { /* ignore */ }
  return new Map()
}

function saveSummaryActivityMap(map: Map<string, number>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(map.entries())))
  } catch { /* ignore */ }
}
```

3. Inside the `OverviewView` component:
```typescript
const [summaryActivityMap, setSummaryActivityMap] = useState(() => loadSummaryActivityMap())
const [refreshingAll, setRefreshingAll] = useState(false)

const handleRefreshAll = async () => {
  setRefreshingAll(true)
  try {
    const toRefresh = items.filter((t) => {
      const lastGenAt = summaryActivityMap.get(t.terminalId)
      return lastGenAt === undefined || t.lastActivityAt > lastGenAt
    })

    if (toRefresh.length === 0) {
      setRefreshingAll(false)
      return
    }

    const results = await Promise.allSettled(
      toRefresh.map(async (t) => {
        const res = await api.post(
          `/api/ai/terminals/${encodeURIComponent(t.terminalId)}/summary`,
          {},
        )
        if (res?.description) {
          await api.patch(`/api/terminals/${encodeURIComponent(t.terminalId)}`, {
            descriptionOverride: res.description,
          })
        }
        return { terminalId: t.terminalId, lastActivityAt: t.lastActivityAt }
      }),
    )

    const nextMap = new Map(summaryActivityMap)
    for (const result of results) {
      if (result.status === 'fulfilled') {
        nextMap.set(result.value.terminalId, result.value.lastActivityAt)
      }
    }
    setSummaryActivityMap(nextMap)
    saveSummaryActivityMap(nextMap)
    await refresh()
  } finally {
    setRefreshingAll(false)
  }
}
```

4. Add the button in the header, next to the existing refresh button:
```tsx
<button
  onClick={handleRefreshAll}
  disabled={refreshingAll || loading}
  aria-label={refreshingAll ? 'Refreshing all summaries...' : 'Refresh all summaries'}
  className={cn(
    'p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
    refreshingAll && 'animate-pulse'
  )}
>
  <Sparkles className="h-4 w-4" aria-hidden="true" />
</button>
```

5. Also update the per-terminal `onGenerateSummary` to record in the activity map, so "Refresh All" skips that terminal if nothing else changed:

In both the running and exited terminal map callbacks, update `onGenerateSummary`:
```typescript
onGenerateSummary={async () => {
  const res = await api.post(`/api/ai/terminals/${encodeURIComponent(t.terminalId)}/summary`, {})
  if (res?.description) {
    await api.patch(`/api/terminals/${encodeURIComponent(t.terminalId)}`, {
      descriptionOverride: res.description,
    })
  }
  const nextMap = new Map(summaryActivityMap)
  nextMap.set(t.terminalId, t.lastActivityAt)
  setSummaryActivityMap(nextMap)
  saveSummaryActivityMap(nextMap)
  await refresh()
}}
```

6. Prune the activity map on load to only include IDs from the current terminal list (in the `useEffect` that calls `refresh`, after items load):

```typescript
useEffect(() => {
  if (items.length === 0) return
  const currentIds = new Set(items.map((t) => t.terminalId))
  const map = loadSummaryActivityMap()
  let pruned = false
  for (const id of map.keys()) {
    if (!currentIds.has(id)) {
      map.delete(id)
      pruned = true
    }
  }
  if (pruned) {
    saveSummaryActivityMap(map)
    setSummaryActivityMap(map)
  }
}, [items])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run test:vitest -- --run test/unit/components/OverviewView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/refresh-all-summaries
git add src/components/OverviewView.tsx test/unit/components/OverviewView.test.tsx
git commit -m "feat: add Refresh All summaries button with change detection to Overview"
```

---

### Task 5: Add "Refresh all summaries" to context menu

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`

- [ ] **Step 1: Verify context menu structure**

Read `src/components/context-menu/menu-defs.ts` to understand the existing `overview-terminal` context menu and the `actions` interface.

- [ ] **Step 2: Add "Refresh all summaries" item to the overview context menu**

This is a small addition. In the `overview-terminal` section of `menu-defs.ts`, add a new item after the existing "Generate summary" entry (or in the general overview header context):

Actually, the "Refresh All" is a page-level action, not per-terminal. It's better as a button in the header. The context menu already has per-terminal "Generate summary". No context menu change needed.

- [ ] **Step 3: Skip -- no context menu change needed**

The "Refresh All" button in the header is the correct UX. The per-terminal context menu "Generate summary" already exists. No changes to `menu-defs.ts` are required.

- [ ] **Step 4: Commit (skip -- no changes)**

---

### Task 6: Run full test suite and fix any integration issues

**Files:**
- All modified files

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm test`
Expected: All tests PASS

- [ ] **Step 2: Run lint check**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run lint`
Expected: No a11y or other violations

- [ ] **Step 3: Run type check**

Run: `cd /home/user/code/freshell/.worktrees/refresh-all-summaries && npm run check`
Expected: No type errors

- [ ] **Step 4: Fix any failures, commit**

```bash
cd /home/user/code/freshell/.worktrees/refresh-all-summaries
git add -A
git commit -m "fix: resolve integration issues from refresh-all-summaries feature"
```

---

### Task 7: Update docs mock if needed

**Files:**
- Modify: `docs/index.html` (if the Overview section exists in the mock)

- [ ] **Step 1: Check if `docs/index.html` includes an Overview/Panes section**

Read `docs/index.html` and search for "Overview" or "Panes" section.

- [ ] **Step 2: If present, add a Sparkles button to the header area of the mock**

This is a minor visual addition to the nonfunctional mock. Only add it if there's already an Overview section that would look incomplete without it.

- [ ] **Step 3: Commit if changed**

```bash
cd /home/user/code/freshell/.worktrees/refresh-all-summaries
git add docs/index.html
git commit -m "docs: add refresh all summaries button to Overview mock"
```
