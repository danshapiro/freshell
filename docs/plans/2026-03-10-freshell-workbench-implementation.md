# Freshell Workbench Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Freshell client extension that lets you tag sessions with project/type/status dimensions and view them grouped and filtered.

**Architecture:** Standalone Vite+React app that builds to `dist/`, installed into `~/.freshell/extensions/freshell-workbench/`. Reads sessions from Freshell's `GET /api/sessions` (same-origin iframe). Stores tag/dimension data in `localStorage`. No server-side changes needed.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS

**Design doc:** `docs/plans/2026-03-10-freshell-workbench-design.md` (in freshell repo)

---

### Task 1: Scaffold the project

**Files:**
- Create: `~/sw/personal/freshell-workbench/package.json`
- Create: `~/sw/personal/freshell-workbench/tsconfig.json`
- Create: `~/sw/personal/freshell-workbench/vite.config.ts`
- Create: `~/sw/personal/freshell-workbench/tailwind.config.js`
- Create: `~/sw/personal/freshell-workbench/postcss.config.js`
- Create: `~/sw/personal/freshell-workbench/index.html`
- Create: `~/sw/personal/freshell-workbench/src/main.tsx`
- Create: `~/sw/personal/freshell-workbench/src/App.tsx`
- Create: `~/sw/personal/freshell-workbench/src/index.css`
- Create: `~/sw/personal/freshell-workbench/freshell.json`
- Create: `~/sw/personal/freshell-workbench/.gitignore`

**Step 1: Initialize the project**

```bash
mkdir -p ~/sw/personal/freshell-workbench/src
cd ~/sw/personal/freshell-workbench
git init
```

**Step 2: Create package.json**

```json
{
  "name": "freshell-workbench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^3.0.4",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "jsdom": "^25.0.1"
  }
}
```

**Step 3: Create config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

`tailwind.config.js`:
```js
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

`postcss.config.js`:
```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
```

`src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
```

**Step 4: Create entry files**

`index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Workbench</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/App.tsx`:
```tsx
export function App() {
  return <div className="p-4 text-sm">Workbench loading...</div>
}
```

**Step 5: Create extension manifest**

`freshell.json`:
```json
{
  "name": "freshell-workbench",
  "version": "0.1.0",
  "label": "Workbench",
  "description": "Track experiments and projects across repos",
  "category": "client",
  "icon": "layout-dashboard",
  "client": {
    "entry": "dist/index.html"
  },
  "picker": {
    "group": "tools"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
```

**Step 6: Install deps and verify build**

```bash
cd ~/sw/personal/freshell-workbench
npm install
npm run build
```

Expected: `dist/index.html` exists with bundled JS/CSS.

**Step 7: Create GitHub repo and initial commit**

```bash
cd ~/sw/personal/freshell-workbench
git add package.json package-lock.json tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html freshell.json .gitignore src/
git commit -m "feat: scaffold freshell-workbench extension"
gh repo create mattleaverton/freshell-workbench --private --source=. --push
```

---

### Task 2: Data model and storage layer

**Files:**
- Create: `src/types.ts`
- Create: `src/storage.ts`
- Create: `src/storage.test.ts`

**Step 1: Write failing tests for storage**

`src/storage.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { WorkbenchStorage } from './storage'

describe('WorkbenchStorage', () => {
  let storage: WorkbenchStorage

  beforeEach(() => {
    localStorage.clear()
    storage = new WorkbenchStorage()
  })

  it('returns default dimensions when empty', () => {
    const data = storage.load()
    expect(data.dimensions.type).toEqual(['idea', 'experiment', 'investigation'])
    expect(data.dimensions.status).toEqual(['preliminary', 'active', 'abandoned', 'merged'])
    expect(data.dimensions.project).toEqual([])
    expect(data.tags).toEqual({})
  })

  it('persists and loads tags', () => {
    storage.setTag('claude:abc123', 'project', 'auth migration')
    const data = storage.load()
    expect(data.tags['claude:abc123']?.project).toBe('auth migration')
  })

  it('clears a tag value by setting null', () => {
    storage.setTag('claude:abc123', 'project', 'auth migration')
    storage.setTag('claude:abc123', 'project', null)
    const data = storage.load()
    expect(data.tags['claude:abc123']?.project).toBeNull()
  })

  it('adds a dimension value', () => {
    storage.addDimensionValue('project', 'auth migration')
    const data = storage.load()
    expect(data.dimensions.project).toContain('auth migration')
  })

  it('removes a dimension value and clears tags using it', () => {
    storage.addDimensionValue('project', 'auth migration')
    storage.setTag('claude:abc123', 'project', 'auth migration')
    storage.removeDimensionValue('project', 'auth migration')
    const data = storage.load()
    expect(data.dimensions.project).not.toContain('auth migration')
    expect(data.tags['claude:abc123']?.project).toBeNull()
  })

  it('renames a dimension value and updates tags', () => {
    storage.addDimensionValue('project', 'old name')
    storage.setTag('claude:abc123', 'project', 'old name')
    storage.renameDimensionValue('project', 'old name', 'new name')
    const data = storage.load()
    expect(data.dimensions.project).toContain('new name')
    expect(data.dimensions.project).not.toContain('old name')
    expect(data.tags['claude:abc123']?.project).toBe('new name')
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/storage.test.ts
```

Expected: FAIL — `WorkbenchStorage` not found.

**Step 3: Implement types and storage**

`src/types.ts`:
```ts
// Data model for workbench session tagging and dimension management.

export type DimensionName = 'project' | 'type' | 'status'

export interface SessionTags {
  project: string | null
  type: string | null
  status: string | null
}

export interface WorkbenchData {
  dimensions: Record<DimensionName, string[]>
  tags: Record<string, SessionTags>
}
```

`src/storage.ts`:
```ts
// Persistence layer for workbench tag data using localStorage.

import type { WorkbenchData, DimensionName, SessionTags } from './types'

const STORAGE_KEY = 'freshell-workbench:data'

const DEFAULT_DATA: WorkbenchData = {
  dimensions: {
    project: [],
    type: ['idea', 'experiment', 'investigation'],
    status: ['preliminary', 'active', 'abandoned', 'merged'],
  },
  tags: {},
}

function emptyTags(): SessionTags {
  return { project: null, type: null, status: null }
}

export class WorkbenchStorage {
  load(): WorkbenchData {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_DATA)
    try {
      return JSON.parse(raw) as WorkbenchData
    } catch {
      return structuredClone(DEFAULT_DATA)
    }
  }

  private save(data: WorkbenchData): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }

  setTag(sessionKey: string, dimension: DimensionName, value: string | null): void {
    const data = this.load()
    if (!data.tags[sessionKey]) data.tags[sessionKey] = emptyTags()
    data.tags[sessionKey][dimension] = value
    this.save(data)
  }

  addDimensionValue(dimension: DimensionName, value: string): void {
    const data = this.load()
    if (!data.dimensions[dimension].includes(value)) {
      data.dimensions[dimension].push(value)
      this.save(data)
    }
  }

  removeDimensionValue(dimension: DimensionName, value: string): void {
    const data = this.load()
    data.dimensions[dimension] = data.dimensions[dimension].filter((v) => v !== value)
    for (const tags of Object.values(data.tags)) {
      if (tags[dimension] === value) tags[dimension] = null
    }
    this.save(data)
  }

  renameDimensionValue(dimension: DimensionName, oldValue: string, newValue: string): void {
    const data = this.load()
    data.dimensions[dimension] = data.dimensions[dimension].map((v) =>
      v === oldValue ? newValue : v,
    )
    for (const tags of Object.values(data.tags)) {
      if (tags[dimension] === oldValue) tags[dimension] = newValue
    }
    this.save(data)
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/storage.test.ts
```

Expected: all 6 tests PASS.

**Step 5: Commit**

```bash
git add src/types.ts src/storage.ts src/storage.test.ts
git commit -m "feat: add data model and localStorage persistence"
```

---

### Task 3: Session fetching from Freshell API

**Files:**
- Create: `src/api.ts`
- Create: `src/api.test.ts`

**Step 1: Write failing tests**

`src/api.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchSessions, searchSessions } from './api'

describe('fetchSessions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches and flattens project sessions', async () => {
    const mockProjects = [
      {
        projectPath: '/Users/matt/sw/freshell',
        sessions: [
          { provider: 'claude', sessionId: 'abc', projectPath: '/Users/matt/sw/freshell', title: 'Fix bug', updatedAt: 1000 },
        ],
      },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockProjects,
    } as Response)

    const sessions = await fetchSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('abc')
    expect(sessions[0].repo).toBe('freshell')
  })

  it('extracts repo name from projectPath', async () => {
    const mockProjects = [
      {
        projectPath: '/Users/matt/sw/personal/some-repo',
        sessions: [
          { provider: 'claude', sessionId: 'x', projectPath: '/Users/matt/sw/personal/some-repo', title: 'Test', updatedAt: 1 },
        ],
      },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockProjects,
    } as Response)

    const sessions = await fetchSessions()
    expect(sessions[0].repo).toBe('some-repo')
  })
})

describe('searchSessions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls search endpoint with query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], totalCount: 0 }),
    } as Response)

    await searchSessions('auth bug')
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/search?q=auth+bug'),
    )
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.test.ts
```

Expected: FAIL — modules not found.

**Step 3: Implement API layer**

`src/api.ts`:
```ts
// Fetches session data from Freshell's REST API.

export interface SessionInfo {
  provider: string
  sessionId: string
  key: string
  projectPath: string
  repo: string
  title?: string
  summary?: string
  firstUserMessage?: string
  updatedAt: number
  createdAt?: number
  gitBranch?: string
}

interface ProjectGroup {
  projectPath: string
  sessions: Array<{
    provider: string
    sessionId: string
    projectPath: string
    title?: string
    summary?: string
    firstUserMessage?: string
    updatedAt: number
    createdAt?: number
    gitBranch?: string
  }>
}

function repoFromPath(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() || projectPath
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const res = await fetch('/api/sessions')
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
  const projects: ProjectGroup[] = await res.json()

  return projects.flatMap((p) =>
    p.sessions.map((s) => ({
      provider: s.provider,
      sessionId: s.sessionId,
      key: `${s.provider}:${s.sessionId}`,
      projectPath: s.projectPath,
      repo: repoFromPath(s.projectPath),
      title: s.title,
      summary: s.summary,
      firstUserMessage: s.firstUserMessage,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      gitBranch: s.gitBranch,
    })),
  )
}

export async function searchSessions(query: string): Promise<SessionInfo[]> {
  const params = new URLSearchParams({ q: query, tier: 'title' })
  const res = await fetch(`/api/sessions/search?${params}`)
  if (!res.ok) throw new Error(`Search failed: ${res.status}`)
  const data = await res.json()
  const results = data.results || []
  return results.map((s: any) => ({
    provider: s.provider || 'claude',
    sessionId: s.sessionId,
    key: `${s.provider || 'claude'}:${s.sessionId}`,
    projectPath: s.projectPath || '',
    repo: repoFromPath(s.projectPath || ''),
    title: s.title,
    summary: s.summary,
    firstUserMessage: s.firstUserMessage,
    updatedAt: s.updatedAt || 0,
    createdAt: s.createdAt,
    gitBranch: s.gitBranch,
  }))
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/api.test.ts
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat: add session fetching from Freshell API"
```

---

### Task 4: Session list with tag editing

**Files:**
- Create: `src/SessionCard.tsx`
- Create: `src/SessionCard.test.tsx`
- Create: `src/TagDropdown.tsx`

This is the core UI component — a session card that shows title, repo, tags, and lets you edit tags via dropdowns.

**Step 1: Write failing tests**

`src/SessionCard.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionCard } from './SessionCard'
import type { SessionInfo } from './api'
import type { SessionTags } from './types'

const session: SessionInfo = {
  provider: 'claude',
  sessionId: 'abc',
  key: 'claude:abc',
  projectPath: '/Users/matt/sw/freshell',
  repo: 'freshell',
  title: 'Fix authentication bug',
  summary: 'Debugged the auth flow',
  updatedAt: Date.now(),
}

const tags: SessionTags = { project: null, type: 'experiment', status: 'active' }

const dimensions = {
  project: ['auth migration', 'perf work'],
  type: ['idea', 'experiment', 'investigation'],
  status: ['preliminary', 'active', 'abandoned', 'merged'],
}

describe('SessionCard', () => {
  it('renders session title and repo', () => {
    render(
      <SessionCard session={session} tags={tags} dimensions={dimensions} onTagChange={vi.fn()} />,
    )
    expect(screen.getByText('Fix authentication bug')).toBeInTheDocument()
    expect(screen.getByText('freshell')).toBeInTheDocument()
  })

  it('shows tag badges for assigned tags', () => {
    render(
      <SessionCard session={session} tags={tags} dimensions={dimensions} onTagChange={vi.fn()} />,
    )
    expect(screen.getByText('experiment')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('calls onTagChange when a tag is selected', () => {
    const onTagChange = vi.fn()
    render(
      <SessionCard
        session={session}
        tags={tags}
        dimensions={dimensions}
        onTagChange={onTagChange}
      />,
    )
    // Click the project dropdown (should show "—" for unset)
    const projectSelect = screen.getByLabelText('project')
    fireEvent.change(projectSelect, { target: { value: 'auth migration' } })
    expect(onTagChange).toHaveBeenCalledWith('claude:abc', 'project', 'auth migration')
  })

  it('expands to show summary on click', () => {
    render(
      <SessionCard session={session} tags={tags} dimensions={dimensions} onTagChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByText('Fix authentication bug'))
    expect(screen.getByText('Debugged the auth flow')).toBeInTheDocument()
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/SessionCard.test.tsx
```

Expected: FAIL.

**Step 3: Implement components**

`src/TagDropdown.tsx`:
```tsx
// Dropdown for selecting a single tag value within a dimension.

import type { DimensionName } from './types'

interface TagDropdownProps {
  dimension: DimensionName
  value: string | null
  options: string[]
  onChange: (dimension: DimensionName, value: string | null) => void
}

export function TagDropdown({ dimension, value, options, onChange }: TagDropdownProps) {
  return (
    <select
      aria-label={dimension}
      value={value ?? ''}
      onChange={(e) => onChange(dimension, e.target.value || null)}
      className="text-xs border rounded px-1 py-0.5 bg-transparent"
    >
      <option value="">—</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  )
}
```

`src/SessionCard.tsx`:
```tsx
// Displays a session with its tags and expandable detail.

import { useState } from 'react'
import type { SessionInfo } from './api'
import type { SessionTags, DimensionName } from './types'
import { TagDropdown } from './TagDropdown'

interface SessionCardProps {
  session: SessionInfo
  tags: SessionTags
  dimensions: Record<DimensionName, string[]>
  onTagChange: (sessionKey: string, dimension: DimensionName, value: string | null) => void
}

export function SessionCard({ session, tags, dimensions, onTagChange }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false)

  const displayTitle = session.title || session.firstUserMessage?.slice(0, 80) || session.sessionId

  return (
    <div className="border rounded p-2 mb-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <button
          className="font-medium text-left truncate flex-1 hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {displayTitle}
        </button>
        <span className="text-xs text-gray-500 shrink-0">{session.repo}</span>
      </div>

      <div className="flex gap-2 mt-1 flex-wrap items-center">
        {(['project', 'type', 'status'] as DimensionName[]).map((dim) => (
          <TagDropdown
            key={dim}
            dimension={dim}
            value={tags[dim]}
            options={dimensions[dim]}
            onChange={(d, v) => onTagChange(session.key, d, v)}
          />
        ))}
        {tags.type && (
          <span className="text-xs bg-blue-100 text-blue-800 rounded px-1">{tags.type}</span>
        )}
        {tags.status && (
          <span className="text-xs bg-green-100 text-green-800 rounded px-1">{tags.status}</span>
        )}
      </div>

      {expanded && (
        <div className="mt-2 text-xs text-gray-600">
          {session.summary || session.firstUserMessage || 'No summary available'}
        </div>
      )}
    </div>
  )
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/SessionCard.test.tsx
```

Expected: all 4 tests PASS.

**Step 5: Commit**

```bash
git add src/SessionCard.tsx src/SessionCard.test.tsx src/TagDropdown.tsx
git commit -m "feat: add session card with tag editing"
```

---

### Task 5: Group-by and filter view

**Files:**
- Create: `src/WorkbenchView.tsx`
- Create: `src/WorkbenchView.test.tsx`
- Create: `src/useWorkbench.ts`

This is the main view — group by a dimension, filter by others.

**Step 1: Write failing tests**

`src/WorkbenchView.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkbenchView } from './WorkbenchView'
import * as api from './api'

const mockSessions: api.SessionInfo[] = [
  {
    provider: 'claude', sessionId: 'a', key: 'claude:a',
    projectPath: '/sw/freshell', repo: 'freshell',
    title: 'Fix auth', updatedAt: 3000,
  },
  {
    provider: 'claude', sessionId: 'b', key: 'claude:b',
    projectPath: '/sw/kilroy', repo: 'kilroy',
    title: 'Add pipeline', updatedAt: 2000,
  },
  {
    provider: 'claude', sessionId: 'c', key: 'claude:c',
    projectPath: '/sw/freshell', repo: 'freshell',
    title: 'Refactor tabs', updatedAt: 1000,
  },
]

describe('WorkbenchView', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.spyOn(api, 'fetchSessions').mockResolvedValue(mockSessions)
  })

  it('renders sessions grouped by repo by default', async () => {
    render(<WorkbenchView />)
    await waitFor(() => {
      expect(screen.getByText('Fix auth')).toBeInTheDocument()
    })
    expect(screen.getByText('freshell')).toBeInTheDocument()
    expect(screen.getByText('kilroy')).toBeInTheDocument()
  })

  it('switches group-by dimension', async () => {
    render(<WorkbenchView />)
    await waitFor(() => {
      expect(screen.getByText('Fix auth')).toBeInTheDocument()
    })
    const groupBySelect = screen.getByLabelText('Group by')
    fireEvent.change(groupBySelect, { target: { value: 'status' } })
    // With no status tags, sessions should appear under "untagged"
    expect(screen.getByText('untagged')).toBeInTheDocument()
  })

  it('hides untagged sessions when toggled', async () => {
    render(<WorkbenchView />)
    await waitFor(() => {
      expect(screen.getByText('Fix auth')).toBeInTheDocument()
    })
    // Switch to group by status so all are untagged
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'status' } })
    const toggle = screen.getByLabelText('Show untagged')
    fireEvent.click(toggle)
    expect(screen.queryByText('Fix auth')).not.toBeInTheDocument()
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/WorkbenchView.test.tsx
```

Expected: FAIL.

**Step 3: Implement the hook and view**

`src/useWorkbench.ts`:
```ts
// State management hook for workbench — loads sessions, manages tags and grouping.

import { useState, useEffect, useCallback } from 'react'
import { fetchSessions, type SessionInfo } from './api'
import { WorkbenchStorage } from './storage'
import type { WorkbenchData, DimensionName, SessionTags } from './types'

export type GroupByDimension = DimensionName | 'repo'

interface GroupedSessions {
  [columnValue: string]: Array<{ session: SessionInfo; tags: SessionTags }>
}

const storage = new WorkbenchStorage()

function emptyTags(): SessionTags {
  return { project: null, type: null, status: null }
}

export function useWorkbench() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [data, setData] = useState<WorkbenchData>(storage.load())
  const [groupBy, setGroupBy] = useState<GroupByDimension>('repo')
  const [filters, setFilters] = useState<Partial<Record<GroupByDimension, string>>>({})
  const [showUntagged, setShowUntagged] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSessions()
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const tagsFor = useCallback(
    (key: string): SessionTags => data.tags[key] ?? emptyTags(),
    [data],
  )

  const setTag = useCallback(
    (sessionKey: string, dimension: DimensionName, value: string | null) => {
      storage.setTag(sessionKey, dimension, value)
      setData(storage.load())
    },
    [],
  )

  const grouped: GroupedSessions = {}
  for (const session of sessions) {
    const tags = tagsFor(session.key)

    // Apply filters
    let filtered = false
    for (const [dim, val] of Object.entries(filters)) {
      if (!val) continue
      if (dim === 'repo' && session.repo !== val) filtered = true
      else if (dim !== 'repo' && tags[dim as DimensionName] !== val) filtered = true
    }
    if (filtered) continue

    const columnValue =
      groupBy === 'repo' ? session.repo : tags[groupBy] ?? 'untagged'

    if (columnValue === 'untagged' && !showUntagged) continue

    if (!grouped[columnValue]) grouped[columnValue] = []
    grouped[columnValue].push({ session, tags })
  }

  return {
    sessions,
    data,
    grouped,
    groupBy,
    setGroupBy,
    filters,
    setFilters,
    showUntagged,
    setShowUntagged,
    setTag,
    loading,
  }
}
```

`src/WorkbenchView.tsx`:
```tsx
// Main workbench view — group-by columns with filter bar.

import { useWorkbench, type GroupByDimension } from './useWorkbench'
import { SessionCard } from './SessionCard'
import type { DimensionName } from './types'

const ALL_DIMENSIONS: GroupByDimension[] = ['repo', 'project', 'type', 'status']

export function WorkbenchView() {
  const wb = useWorkbench()

  if (wb.loading) return <div className="p-4 text-sm text-gray-500">Loading sessions...</div>

  const filterDimensions = ALL_DIMENSIONS.filter((d) => d !== wb.groupBy)

  return (
    <div className="p-4 text-sm h-full flex flex-col">
      {/* Controls bar */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <label className="flex items-center gap-1">
          <span>Group by</span>
          <select
            aria-label="Group by"
            value={wb.groupBy}
            onChange={(e) => wb.setGroupBy(e.target.value as GroupByDimension)}
            className="border rounded px-2 py-1"
          >
            {ALL_DIMENSIONS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>

        {filterDimensions.map((dim) => (
          <label key={dim} className="flex items-center gap-1">
            <span>{dim}</span>
            <select
              aria-label={`Filter ${dim}`}
              value={wb.filters[dim] ?? ''}
              onChange={(e) =>
                wb.setFilters({ ...wb.filters, [dim]: e.target.value || undefined })
              }
              className="border rounded px-2 py-1"
            >
              <option value="">all</option>
              {dim === 'repo'
                ? [...new Set(wb.sessions.map((s) => s.repo))].sort().map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))
                : wb.data.dimensions[dim as DimensionName]?.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
            </select>
          </label>
        ))}

        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            aria-label="Show untagged"
            checked={wb.showUntagged}
            onChange={() => wb.setShowUntagged(!wb.showUntagged)}
          />
          <span>Show untagged</span>
        </label>
      </div>

      {/* Columns */}
      <div className="flex gap-4 overflow-x-auto flex-1">
        {Object.entries(wb.grouped)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([column, items]) => (
            <div key={column} className="min-w-[280px] max-w-[360px] flex-shrink-0">
              <h3 className="font-semibold mb-2 sticky top-0 bg-white py-1">
                {column}
                <span className="text-gray-400 ml-1 font-normal">({items.length})</span>
              </h3>
              <div className="space-y-1">
                {items
                  .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
                  .map(({ session, tags }) => (
                    <SessionCard
                      key={session.key}
                      session={session}
                      tags={tags}
                      dimensions={wb.data.dimensions}
                      onTagChange={wb.setTag}
                    />
                  ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/WorkbenchView.test.tsx
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add src/useWorkbench.ts src/WorkbenchView.tsx src/WorkbenchView.test.tsx
git commit -m "feat: add group-by/filter workbench view"
```

---

### Task 6: Dimension management UI

**Files:**
- Create: `src/DimensionEditor.tsx`
- Create: `src/DimensionEditor.test.tsx`

**Step 1: Write failing tests**

`src/DimensionEditor.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DimensionEditor } from './DimensionEditor'

describe('DimensionEditor', () => {
  it('renders existing values', () => {
    render(
      <DimensionEditor
        dimension="project"
        values={['auth migration', 'perf work']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onRename={vi.fn()}
      />,
    )
    expect(screen.getByText('auth migration')).toBeInTheDocument()
    expect(screen.getByText('perf work')).toBeInTheDocument()
  })

  it('adds a new value', () => {
    const onAdd = vi.fn()
    render(
      <DimensionEditor dimension="project" values={[]} onAdd={onAdd} onRemove={vi.fn()} onRename={vi.fn()} />,
    )
    const input = screen.getByPlaceholderText('Add project...')
    fireEvent.change(input, { target: { value: 'new project' } })
    fireEvent.submit(input.closest('form')!)
    expect(onAdd).toHaveBeenCalledWith('project', 'new project')
  })

  it('removes a value', () => {
    const onRemove = vi.fn()
    render(
      <DimensionEditor
        dimension="type"
        values={['idea']}
        onAdd={vi.fn()}
        onRemove={onRemove}
        onRename={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByLabelText('Remove idea'))
    expect(onRemove).toHaveBeenCalledWith('type', 'idea')
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/DimensionEditor.test.tsx
```

**Step 3: Implement**

`src/DimensionEditor.tsx`:
```tsx
// Editor for adding, removing, and renaming values within a dimension.

import { useState } from 'react'
import type { DimensionName } from './types'

interface DimensionEditorProps {
  dimension: DimensionName
  values: string[]
  onAdd: (dimension: DimensionName, value: string) => void
  onRemove: (dimension: DimensionName, value: string) => void
  onRename: (dimension: DimensionName, oldValue: string, newValue: string) => void
}

export function DimensionEditor({ dimension, values, onAdd, onRemove, onRename }: DimensionEditorProps) {
  const [newValue, setNewValue] = useState('')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newValue.trim()
    if (trimmed && !values.includes(trimmed)) {
      onAdd(dimension, trimmed)
      setNewValue('')
    }
  }

  return (
    <div className="mb-4">
      <h4 className="font-medium text-xs uppercase text-gray-500 mb-1">{dimension}</h4>
      <ul className="space-y-1 mb-2">
        {values.map((v) => (
          <li key={v} className="flex items-center gap-2 text-sm">
            <span>{v}</span>
            <button
              aria-label={`Remove ${v}`}
              onClick={() => onRemove(dimension, v)}
              className="text-red-400 hover:text-red-600 text-xs"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={handleAdd} className="flex gap-1">
        <input
          type="text"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder={`Add ${dimension}...`}
          className="border rounded px-2 py-0.5 text-sm flex-1"
        />
        <button type="submit" className="text-sm px-2 border rounded">+</button>
      </form>
    </div>
  )
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/DimensionEditor.test.tsx
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add src/DimensionEditor.tsx src/DimensionEditor.test.tsx
git commit -m "feat: add dimension value editor"
```

---

### Task 7: Wire everything into App + settings panel

**Files:**
- Modify: `src/App.tsx`

**Step 1: Update App to use WorkbenchView and include a settings toggle**

`src/App.tsx`:
```tsx
// Root component — renders the workbench view with an optional settings panel.

import { useState } from 'react'
import { WorkbenchView } from './WorkbenchView'
import { DimensionEditor } from './DimensionEditor'
import { WorkbenchStorage } from './storage'
import type { DimensionName } from './types'

const storage = new WorkbenchStorage()

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [data, setData] = useState(storage.load())

  const handleAdd = (dim: DimensionName, value: string) => {
    storage.addDimensionValue(dim, value)
    setData(storage.load())
  }

  const handleRemove = (dim: DimensionName, value: string) => {
    storage.removeDimensionValue(dim, value)
    setData(storage.load())
  }

  const handleRename = (dim: DimensionName, oldValue: string, newValue: string) => {
    storage.renameDimensionValue(dim, oldValue, newValue)
    setData(storage.load())
  }

  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 border-b">
        <h1 className="font-semibold">Workbench</h1>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="text-sm border rounded px-2 py-1"
          aria-label="Toggle settings"
        >
          {showSettings ? 'Close settings' : 'Settings'}
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto">
          <WorkbenchView />
        </div>

        {showSettings && (
          <aside className="w-64 border-l p-4 overflow-auto">
            <h2 className="font-semibold mb-3">Dimensions</h2>
            {(['project', 'type', 'status'] as DimensionName[]).map((dim) => (
              <DimensionEditor
                key={dim}
                dimension={dim}
                values={data.dimensions[dim]}
                onAdd={handleAdd}
                onRemove={handleRemove}
                onRename={handleRename}
              />
            ))}
          </aside>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Run all tests**

```bash
npx vitest run
```

Expected: all tests PASS.

**Step 3: Build and verify**

```bash
npm run build
ls dist/index.html
```

Expected: `dist/index.html` exists.

**Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire up workbench view with settings panel"
```

---

### Task 8: Install extension and verify in Freshell

**Step 1: Symlink into Freshell extensions directory**

```bash
mkdir -p ~/.freshell/extensions
ln -s ~/sw/personal/freshell-workbench ~/.freshell/extensions/freshell-workbench
```

**Step 2: Build the extension**

```bash
cd ~/sw/personal/freshell-workbench && npm run build
```

**Step 3: Verify in Freshell**

Open Freshell in browser, open a new pane, check that "Workbench" appears in the pane picker under "tools". Open it. Verify:
- Sessions load from the API
- Grouped by repo by default
- Can switch group-by dimension
- Can assign tags via dropdowns
- Can toggle untagged visibility
- Settings panel opens and allows adding dimension values

**Step 4: Push**

```bash
cd ~/sw/personal/freshell-workbench
git push
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Scaffold project + manifest | Build verification |
| 2 | Data model + localStorage | 6 unit tests |
| 3 | Session API fetching | 3 unit tests |
| 4 | Session card + tag editing | 4 component tests |
| 5 | Group-by/filter view | 3 component tests |
| 6 | Dimension editor | 3 component tests |
| 7 | Wire into App | Integration build |
| 8 | Install + verify in Freshell | Manual verification |
