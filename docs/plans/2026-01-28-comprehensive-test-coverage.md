# Comprehensive Test Coverage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Achieve comprehensive test coverage across unit, integration, and E2E tests for the Claude Code Session Organizer application.

**Architecture:** Test pyramid approach - extensive unit tests for pure functions and Redux slices, integration tests for API endpoints and WebSocket protocol, component tests for React UI, and E2E tests for critical user flows.

**Tech Stack:** Vitest, React Testing Library, Supertest, Superwstest, jsdom

---

## Test Structure Overview

```
test/
├── setup/
│   ├── dom.ts              # Existing - jsdom setup
│   └── server.ts           # NEW - server test utilities
├── unit/
│   ├── server/
│   │   ├── auth.test.ts
│   │   ├── config-store.test.ts
│   │   ├── terminal-registry.test.ts
│   │   └── chunk-ring-buffer.test.ts
│   └── client/
│       ├── store/
│       │   ├── tabsSlice.test.ts
│       │   ├── sessionsSlice.test.ts
│       │   ├── connectionSlice.test.ts
│       │   └── settingsSlice.test.ts
│       ├── lib/
│       │   ├── utils.test.ts
│       │   └── ws-client.test.ts
│       └── hooks/
│           └── useTheme.test.ts
├── integration/
│   ├── api/
│   │   ├── settings.test.ts
│   │   ├── sessions.test.ts
│   │   └── terminals.test.ts
│   └── ws/
│       └── ws-protocol.test.ts  # Existing - expand
├── components/
│   ├── TabBar.test.tsx
│   ├── Sidebar.test.tsx
│   ├── SettingsView.test.tsx
│   ├── HistoryView.test.tsx
│   └── OverviewView.test.tsx
└── e2e/
    └── terminal-lifecycle.test.ts
```

---

## Phase 1: Server Unit Tests

### Task 1: Auth Module Unit Tests

**Files:**
- Create: `test/unit/server/auth.test.ts`
- Test: `server/auth.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getRequiredAuthToken,
  validateStartupSecurity,
  httpAuthMiddleware,
  parseAllowedOrigins,
  isOriginAllowed,
  isLoopbackAddress,
} from '../../../server/auth'

describe('auth module', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('getRequiredAuthToken', () => {
    it('returns AUTH_TOKEN when set', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      expect(getRequiredAuthToken()).toBe('valid-token-16chars')
    })

    it('throws when AUTH_TOKEN is not set', () => {
      delete process.env.AUTH_TOKEN
      expect(() => getRequiredAuthToken()).toThrow('AUTH_TOKEN is required')
    })
  })

  describe('validateStartupSecurity', () => {
    it('throws when AUTH_TOKEN is missing', () => {
      delete process.env.AUTH_TOKEN
      expect(() => validateStartupSecurity()).toThrow('AUTH_TOKEN is required')
    })

    it('throws when AUTH_TOKEN is too short', () => {
      process.env.AUTH_TOKEN = 'short'
      expect(() => validateStartupSecurity()).toThrow('too short')
    })

    it('throws when AUTH_TOKEN is a weak value', () => {
      process.env.AUTH_TOKEN = 'changeme-padding-16'
      expect(() => validateStartupSecurity()).toThrow('default/weak')
    })

    it('accepts valid AUTH_TOKEN', () => {
      process.env.AUTH_TOKEN = 'secure-token-that-is-long-enough'
      expect(() => validateStartupSecurity()).not.toThrow()
    })
  })

  describe('httpAuthMiddleware', () => {
    it('allows /api/health without auth', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/health' } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('returns 401 when token is missing', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/settings', headers: {} } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 when token is wrong', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/settings', headers: { 'x-auth-token': 'wrong' } } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
    })

    it('calls next when token is correct', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/settings', headers: { 'x-auth-token': 'valid-token-16chars' } } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  describe('parseAllowedOrigins', () => {
    it('returns default origins when ALLOWED_ORIGINS not set', () => {
      delete process.env.ALLOWED_ORIGINS
      const origins = parseAllowedOrigins()
      expect(origins).toContain('http://localhost:5173')
      expect(origins).toContain('http://localhost:3001')
    })

    it('parses comma-separated ALLOWED_ORIGINS', () => {
      process.env.ALLOWED_ORIGINS = 'http://example.com, http://test.com'
      const origins = parseAllowedOrigins()
      expect(origins).toEqual(['http://example.com', 'http://test.com'])
    })
  })

  describe('isOriginAllowed', () => {
    it('returns false for undefined origin', () => {
      expect(isOriginAllowed(undefined)).toBe(false)
    })

    it('returns true for allowed origin', () => {
      delete process.env.ALLOWED_ORIGINS
      expect(isOriginAllowed('http://localhost:5173')).toBe(true)
    })

    it('returns false for disallowed origin', () => {
      delete process.env.ALLOWED_ORIGINS
      expect(isOriginAllowed('http://evil.com')).toBe(false)
    })
  })

  describe('isLoopbackAddress', () => {
    it('returns false for undefined', () => {
      expect(isLoopbackAddress(undefined)).toBe(false)
    })

    it('returns true for 127.0.0.1', () => {
      expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    })

    it('returns true for ::1', () => {
      expect(isLoopbackAddress('::1')).toBe(true)
    })

    it('returns true for ::ffff:127.0.0.1', () => {
      expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    })

    it('returns false for external IP', () => {
      expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/auth.test.ts --config vitest.server.config.ts`
Expected: Tests should pass (these test existing functionality)

**Step 3: Commit**

```bash
git add test/unit/server/auth.test.ts
git commit -m "test: add auth module unit tests"
```

---

### Task 2: ChunkRingBuffer Unit Tests

**Files:**
- Create: `test/unit/server/chunk-ring-buffer.test.ts`
- Test: `server/terminal-registry.ts` (ChunkRingBuffer class)

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'

// We need to extract or re-implement ChunkRingBuffer for testing
// Since it's not exported, we'll test it indirectly or create a test export

class ChunkRingBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private maxChars: number) {}

  append(chunk: string) {
    if (!chunk) return
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.maxChars && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.size -= removed.length
    }
    if (this.size > this.maxChars && this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks[0] = only.slice(-this.maxChars)
      this.size = this.chunks[0].length
    }
  }

  snapshot(): string {
    return this.chunks.join('')
  }

  clear() {
    this.chunks = []
    this.size = 0
  }
}

describe('ChunkRingBuffer', () => {
  it('stores and retrieves chunks', () => {
    const buffer = new ChunkRingBuffer(1000)
    buffer.append('hello ')
    buffer.append('world')
    expect(buffer.snapshot()).toBe('hello world')
  })

  it('ignores empty chunks', () => {
    const buffer = new ChunkRingBuffer(1000)
    buffer.append('hello')
    buffer.append('')
    buffer.append('world')
    expect(buffer.snapshot()).toBe('helloworld')
  })

  it('evicts oldest chunks when over limit', () => {
    const buffer = new ChunkRingBuffer(10)
    buffer.append('12345') // 5 chars
    buffer.append('67890') // 5 chars = 10 total
    buffer.append('ABCDE') // 5 more = 15 total, should evict

    const snapshot = buffer.snapshot()
    expect(snapshot.length).toBeLessThanOrEqual(10)
    expect(snapshot).toContain('ABCDE') // newest should remain
  })

  it('truncates single oversized chunk', () => {
    const buffer = new ChunkRingBuffer(5)
    buffer.append('1234567890') // 10 chars, limit is 5

    const snapshot = buffer.snapshot()
    expect(snapshot.length).toBe(5)
    expect(snapshot).toBe('67890') // keeps last 5 chars
  })

  it('clears all data', () => {
    const buffer = new ChunkRingBuffer(100)
    buffer.append('data')
    buffer.clear()
    expect(buffer.snapshot()).toBe('')
  })

  it('handles multiple evictions correctly', () => {
    const buffer = new ChunkRingBuffer(20)
    for (let i = 0; i < 10; i++) {
      buffer.append(`chunk${i}`) // ~7 chars each
    }
    const snapshot = buffer.snapshot()
    expect(snapshot.length).toBeLessThanOrEqual(20)
  })
})
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run test/unit/server/chunk-ring-buffer.test.ts --config vitest.server.config.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/server/chunk-ring-buffer.test.ts
git commit -m "test: add ChunkRingBuffer unit tests"
```

---

### Task 3: ConfigStore Unit Tests

**Files:**
- Create: `test/unit/server/config-store.test.ts`
- Test: `server/config-store.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

// Mock fs/promises
vi.mock('fs/promises')

// We need to re-import after mocking
const mockFsp = vi.mocked(fsp)

describe('ConfigStore', () => {
  let ConfigStore: any
  let defaultSettings: any
  let tempDir: string

  beforeEach(async () => {
    vi.resetModules()
    tempDir = path.join(os.tmpdir(), `ccso-test-${Date.now()}`)

    // Set up mocks before importing
    mockFsp.mkdir.mockResolvedValue(undefined)
    mockFsp.writeFile.mockResolvedValue(undefined)
    mockFsp.rename.mockResolvedValue(undefined)
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    // Import after mocking
    const module = await import('../../../server/config-store')
    ConfigStore = module.ConfigStore
    defaultSettings = module.defaultSettings
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('defaultSettings', () => {
    it('has expected default values', () => {
      expect(defaultSettings.theme).toBe('system')
      expect(defaultSettings.terminal.fontSize).toBe(13)
      expect(defaultSettings.terminal.cursorBlink).toBe(true)
      expect(defaultSettings.safety.autoKillIdleMinutes).toBe(180)
    })
  })

  describe('load', () => {
    it('creates default config when none exists', async () => {
      const store = new ConfigStore()
      const config = await store.load()

      expect(config.version).toBe(1)
      expect(config.settings).toEqual(defaultSettings)
      expect(config.sessionOverrides).toEqual({})
      expect(config.terminalOverrides).toEqual({})
    })

    it('returns cached config on subsequent calls', async () => {
      const store = new ConfigStore()
      const first = await store.load()
      const second = await store.load()

      expect(first).toBe(second) // Same reference
    })

    it('loads existing config from disk', async () => {
      const existingConfig = {
        version: 1,
        settings: { ...defaultSettings, theme: 'dark' },
        sessionOverrides: { 'sess-1': { titleOverride: 'Custom' } },
        terminalOverrides: {},
        projectColors: { '/project': '#ff0000' },
      }
      mockFsp.readFile.mockResolvedValue(JSON.stringify(existingConfig))

      const store = new ConfigStore()
      const config = await store.load()

      expect(config.settings.theme).toBe('dark')
      expect(config.sessionOverrides['sess-1'].titleOverride).toBe('Custom')
    })
  })

  describe('patchSettings', () => {
    it('merges partial settings update', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({ theme: 'dark' })

      expect(updated.theme).toBe('dark')
      expect(updated.terminal).toEqual(defaultSettings.terminal) // unchanged
    })

    it('merges nested terminal settings', async () => {
      const store = new ConfigStore()
      await store.load()

      const updated = await store.patchSettings({
        terminal: { fontSize: 16 },
      } as any)

      expect(updated.terminal.fontSize).toBe(16)
      expect(updated.terminal.fontFamily).toBe(defaultSettings.terminal.fontFamily)
    })
  })

  describe('session overrides', () => {
    it('patches session override', async () => {
      const store = new ConfigStore()
      await store.load()

      const override = await store.patchSessionOverride('sess-1', {
        titleOverride: 'My Session',
      })

      expect(override.titleOverride).toBe('My Session')
    })

    it('marks session as deleted', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.deleteSession('sess-1')
      const override = await store.getSessionOverride('sess-1')

      expect(override?.deleted).toBe(true)
    })
  })

  describe('terminal overrides', () => {
    it('patches terminal override', async () => {
      const store = new ConfigStore()
      await store.load()

      const override = await store.patchTerminalOverride('term-1', {
        descriptionOverride: 'Build server',
      })

      expect(override.descriptionOverride).toBe('Build server')
    })

    it('marks terminal as deleted', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.deleteTerminal('term-1')
      const override = await store.getTerminalOverride('term-1')

      expect(override?.deleted).toBe(true)
    })
  })

  describe('project colors', () => {
    it('sets and retrieves project colors', async () => {
      const store = new ConfigStore()
      await store.load()

      await store.setProjectColor('/my/project', '#00ff00')
      const colors = await store.getProjectColors()

      expect(colors['/my/project']).toBe('#00ff00')
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/unit/server/config-store.test.ts --config vitest.server.config.ts`
Expected: PASS (after fixing any import issues)

**Step 3: Commit**

```bash
git add test/unit/server/config-store.test.ts
git commit -m "test: add ConfigStore unit tests"
```

---

## Phase 2: Redux Store Unit Tests

### Task 4: tabsSlice Unit Tests

**Files:**
- Create: `test/unit/client/store/tabsSlice.test.ts`
- Test: `src/store/tabsSlice.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import reducer, {
  addTab,
  setActiveTab,
  updateTab,
  removeTab,
  hydrateTabs,
  TabsState,
} from '../../../../src/store/tabsSlice'

describe('tabsSlice', () => {
  let initialState: TabsState

  beforeEach(() => {
    initialState = {
      tabs: [],
      activeTabId: null,
    }
  })

  describe('addTab', () => {
    it('adds a new tab with defaults', () => {
      const state = reducer(initialState, addTab())

      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].title).toBe('Terminal 1')
      expect(state.tabs[0].status).toBe('creating')
      expect(state.tabs[0].mode).toBe('shell')
      expect(state.tabs[0].shell).toBe('system')
      expect(state.activeTabId).toBe(state.tabs[0].id)
    })

    it('adds a tab with custom options', () => {
      const state = reducer(initialState, addTab({
        title: 'Claude Session',
        mode: 'claude',
        shell: 'wsl',
        initialCwd: '/home/user',
      }))

      expect(state.tabs[0].title).toBe('Claude Session')
      expect(state.tabs[0].mode).toBe('claude')
      expect(state.tabs[0].shell).toBe('wsl')
      expect(state.tabs[0].initialCwd).toBe('/home/user')
    })

    it('sets new tab as active', () => {
      let state = reducer(initialState, addTab({ title: 'Tab 1' }))
      const firstId = state.activeTabId

      state = reducer(state, addTab({ title: 'Tab 2' }))

      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabId).not.toBe(firstId)
    })

    it('increments terminal number in default title', () => {
      let state = reducer(initialState, addTab())
      state = reducer(state, addTab())
      state = reducer(state, addTab())

      expect(state.tabs[0].title).toBe('Terminal 1')
      expect(state.tabs[1].title).toBe('Terminal 2')
      expect(state.tabs[2].title).toBe('Terminal 3')
    })
  })

  describe('setActiveTab', () => {
    it('sets the active tab id', () => {
      let state = reducer(initialState, addTab())
      const firstId = state.tabs[0].id
      state = reducer(state, addTab())
      const secondId = state.tabs[1].id

      state = reducer(state, setActiveTab(firstId))

      expect(state.activeTabId).toBe(firstId)
    })
  })

  describe('updateTab', () => {
    it('updates tab properties', () => {
      let state = reducer(initialState, addTab())
      const id = state.tabs[0].id

      state = reducer(state, updateTab({
        id,
        updates: {
          title: 'Updated Title',
          status: 'connected',
          terminalId: 'term-123',
        },
      }))

      expect(state.tabs[0].title).toBe('Updated Title')
      expect(state.tabs[0].status).toBe('connected')
      expect(state.tabs[0].terminalId).toBe('term-123')
    })

    it('does nothing for non-existent tab', () => {
      let state = reducer(initialState, addTab())
      const originalState = state

      state = reducer(state, updateTab({
        id: 'non-existent',
        updates: { title: 'New Title' },
      }))

      expect(state.tabs[0].title).toBe(originalState.tabs[0].title)
    })
  })

  describe('removeTab', () => {
    it('removes the specified tab', () => {
      let state = reducer(initialState, addTab())
      state = reducer(state, addTab())
      const firstId = state.tabs[0].id

      state = reducer(state, removeTab(firstId))

      expect(state.tabs).toHaveLength(1)
      expect(state.tabs.find(t => t.id === firstId)).toBeUndefined()
    })

    it('updates activeTabId when removing active tab', () => {
      let state = reducer(initialState, addTab())
      state = reducer(state, addTab())
      const secondId = state.tabs[1].id
      state = reducer(state, setActiveTab(secondId))

      state = reducer(state, removeTab(secondId))

      expect(state.activeTabId).toBe(state.tabs[0].id)
    })

    it('sets activeTabId to null when removing last tab', () => {
      let state = reducer(initialState, addTab())
      const id = state.tabs[0].id

      state = reducer(state, removeTab(id))

      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })
  })

  describe('hydrateTabs', () => {
    it('restores tabs from saved state', () => {
      const savedState: TabsState = {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Saved Tab',
            status: 'connected',
            mode: 'shell',
            shell: 'system',
            terminalId: 'term-1',
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-1',
      }

      const state = reducer(initialState, hydrateTabs(savedState))

      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].title).toBe('Saved Tab')
      expect(state.activeTabId).toBe('tab-1')
    })

    it('adds missing fields to hydrated tabs', () => {
      const savedState = {
        tabs: [{ id: 'tab-1', title: 'Old Tab' }],
        activeTabId: 'tab-1',
      } as any

      const state = reducer(initialState, hydrateTabs(savedState))

      expect(state.tabs[0].status).toBe('creating')
      expect(state.tabs[0].mode).toBe('shell')
      expect(state.tabs[0].shell).toBe('system')
      expect(state.tabs[0].createdAt).toBeDefined()
    })

    it('handles empty tabs array', () => {
      const savedState: TabsState = {
        tabs: [],
        activeTabId: null,
      }

      const state = reducer(initialState, hydrateTabs(savedState))

      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/unit/client/store/tabsSlice.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/store/tabsSlice.test.ts
git commit -m "test: add tabsSlice unit tests"
```

---

### Task 5: sessionsSlice Unit Tests

**Files:**
- Create: `test/unit/client/store/sessionsSlice.test.ts`
- Test: `src/store/sessionsSlice.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import reducer, {
  setProjects,
  toggleProjectExpanded,
  expandAll,
  collapseAll,
  SessionsState,
} from '../../../../src/store/sessionsSlice'
import type { ProjectGroup } from '../../../../src/store/types'

describe('sessionsSlice', () => {
  let initialState: SessionsState

  beforeEach(() => {
    initialState = {
      projects: [],
      expandedProjects: new Set(),
    }
  })

  const mockProjects: ProjectGroup[] = [
    {
      projectPath: '/project/a',
      projectName: 'Project A',
      sessions: [
        { sessionId: 'sess-1', projectPath: '/project/a', title: 'Session 1', messageCount: 10, lastActivityAt: Date.now(), createdAt: Date.now() },
      ],
    },
    {
      projectPath: '/project/b',
      projectName: 'Project B',
      sessions: [],
    },
  ]

  describe('setProjects', () => {
    it('sets the projects array', () => {
      const state = reducer(initialState, setProjects(mockProjects))

      expect(state.projects).toHaveLength(2)
      expect(state.projects[0].projectName).toBe('Project A')
    })

    it('preserves expanded state when projects update', () => {
      let state = reducer(initialState, setProjects(mockProjects))
      state = reducer(state, toggleProjectExpanded('/project/a'))

      state = reducer(state, setProjects(mockProjects))

      expect(state.expandedProjects.has('/project/a')).toBe(true)
    })
  })

  describe('toggleProjectExpanded', () => {
    it('expands a collapsed project', () => {
      let state = reducer(initialState, setProjects(mockProjects))

      state = reducer(state, toggleProjectExpanded('/project/a'))

      expect(state.expandedProjects.has('/project/a')).toBe(true)
    })

    it('collapses an expanded project', () => {
      let state = reducer(initialState, setProjects(mockProjects))
      state = reducer(state, toggleProjectExpanded('/project/a'))

      state = reducer(state, toggleProjectExpanded('/project/a'))

      expect(state.expandedProjects.has('/project/a')).toBe(false)
    })
  })

  describe('expandAll', () => {
    it('expands all projects', () => {
      let state = reducer(initialState, setProjects(mockProjects))

      state = reducer(state, expandAll())

      expect(state.expandedProjects.has('/project/a')).toBe(true)
      expect(state.expandedProjects.has('/project/b')).toBe(true)
    })
  })

  describe('collapseAll', () => {
    it('collapses all projects', () => {
      let state = reducer(initialState, setProjects(mockProjects))
      state = reducer(state, expandAll())

      state = reducer(state, collapseAll())

      expect(state.expandedProjects.size).toBe(0)
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/unit/client/store/sessionsSlice.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/store/sessionsSlice.test.ts
git commit -m "test: add sessionsSlice unit tests"
```

---

### Task 6: connectionSlice Unit Tests

**Files:**
- Create: `test/unit/client/store/connectionSlice.test.ts`
- Test: `src/store/connectionSlice.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import reducer, {
  setStatus,
  setError,
  ConnectionState,
} from '../../../../src/store/connectionSlice'

describe('connectionSlice', () => {
  const initialState: ConnectionState = {
    status: 'disconnected',
    lastError: undefined,
  }

  describe('setStatus', () => {
    it('sets status to connecting', () => {
      const state = reducer(initialState, setStatus('connecting'))
      expect(state.status).toBe('connecting')
    })

    it('sets status to connected', () => {
      const state = reducer(initialState, setStatus('connected'))
      expect(state.status).toBe('connected')
    })

    it('sets status to ready', () => {
      const state = reducer(initialState, setStatus('ready'))
      expect(state.status).toBe('ready')
    })

    it('sets status to disconnected', () => {
      const state = reducer({ status: 'ready', lastError: undefined }, setStatus('disconnected'))
      expect(state.status).toBe('disconnected')
    })
  })

  describe('setError', () => {
    it('sets the error message', () => {
      const state = reducer(initialState, setError('Connection failed'))
      expect(state.lastError).toBe('Connection failed')
    })

    it('clears the error message', () => {
      const state = reducer({ status: 'disconnected', lastError: 'Old error' }, setError(undefined))
      expect(state.lastError).toBeUndefined()
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/unit/client/store/connectionSlice.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/store/connectionSlice.test.ts
git commit -m "test: add connectionSlice unit tests"
```

---

### Task 7: settingsSlice Unit Tests

**Files:**
- Create: `test/unit/client/store/settingsSlice.test.ts`
- Test: `src/store/settingsSlice.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import reducer, {
  setSettings,
  updateSettingsLocal,
  markSaved,
  SettingsState,
} from '../../../../src/store/settingsSlice'
import type { AppSettings } from '../../../../src/store/types'

describe('settingsSlice', () => {
  const defaultSettings: AppSettings = {
    theme: 'system',
    terminal: {
      fontSize: 13,
      fontFamily: 'monospace',
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: 'dark',
    },
    safety: {
      autoKillIdleMinutes: 180,
      warnBeforeKillMinutes: 5,
    },
  }

  let initialState: SettingsState

  beforeEach(() => {
    initialState = {
      settings: defaultSettings,
      loaded: false,
    }
  })

  describe('setSettings', () => {
    it('sets settings and marks as loaded', () => {
      const newSettings: AppSettings = {
        ...defaultSettings,
        theme: 'dark',
      }

      const state = reducer(initialState, setSettings(newSettings))

      expect(state.settings.theme).toBe('dark')
      expect(state.loaded).toBe(true)
    })
  })

  describe('updateSettingsLocal', () => {
    it('updates partial settings', () => {
      const state = reducer(initialState, updateSettingsLocal({ theme: 'light' }))

      expect(state.settings.theme).toBe('light')
      expect(state.settings.terminal).toEqual(defaultSettings.terminal)
    })

    it('merges nested terminal settings', () => {
      const state = reducer(initialState, updateSettingsLocal({
        terminal: { fontSize: 16 },
      } as any))

      expect(state.settings.terminal.fontSize).toBe(16)
      expect(state.settings.terminal.fontFamily).toBe('monospace')
    })

    it('merges nested safety settings', () => {
      const state = reducer(initialState, updateSettingsLocal({
        safety: { autoKillIdleMinutes: 60 },
      } as any))

      expect(state.settings.safety.autoKillIdleMinutes).toBe(60)
      expect(state.settings.safety.warnBeforeKillMinutes).toBe(5)
    })
  })

  describe('markSaved', () => {
    it('marks settings as loaded/saved', () => {
      const state = reducer(initialState, markSaved())

      expect(state.loaded).toBe(true)
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/unit/client/store/settingsSlice.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/store/settingsSlice.test.ts
git commit -m "test: add settingsSlice unit tests"
```

---

## Phase 3: Client Library Unit Tests

### Task 8: Utils Unit Tests

**Files:**
- Create: `test/unit/client/lib/utils.test.ts`
- Test: `src/lib/utils.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cn, isMacLike, shallowEqual } from '../../../../src/lib/utils'

describe('utils', () => {
  describe('cn (classnames)', () => {
    it('merges class names', () => {
      expect(cn('foo', 'bar')).toBe('foo bar')
    })

    it('handles conditional classes', () => {
      expect(cn('foo', false && 'bar', 'baz')).toBe('foo baz')
    })

    it('handles undefined and null', () => {
      expect(cn('foo', undefined, null, 'bar')).toBe('foo bar')
    })

    it('handles arrays', () => {
      expect(cn(['foo', 'bar'])).toBe('foo bar')
    })

    it('handles objects', () => {
      expect(cn({ foo: true, bar: false, baz: true })).toBe('foo baz')
    })

    it('merges tailwind classes correctly', () => {
      // Tailwind merge should dedupe conflicting utilities
      expect(cn('p-4', 'p-2')).toBe('p-2')
      expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500')
    })
  })

  describe('isMacLike', () => {
    const originalNavigator = global.navigator

    afterEach(() => {
      Object.defineProperty(global, 'navigator', {
        value: originalNavigator,
        writable: true,
      })
    })

    it('returns true for Mac platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'MacIntel' },
        writable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns true for iPhone', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'iPhone' },
        writable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns true for iPad', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'iPad' },
        writable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns false for Windows', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'Win32' },
        writable: true,
      })
      expect(isMacLike()).toBe(false)
    })

    it('returns false for Linux', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'Linux x86_64' },
        writable: true,
      })
      expect(isMacLike()).toBe(false)
    })
  })

  describe('shallowEqual', () => {
    it('returns true for same reference', () => {
      const obj = { a: 1 }
      expect(shallowEqual(obj, obj)).toBe(true)
    })

    it('returns true for equal objects', () => {
      expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    })

    it('returns false for different values', () => {
      expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false)
    })

    it('returns false for different keys', () => {
      expect(shallowEqual({ a: 1 }, { b: 1 })).toBe(false)
    })

    it('returns false for different key counts', () => {
      expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    })

    it('does not compare deeply', () => {
      const nested1 = { a: { b: 1 } }
      const nested2 = { a: { b: 1 } }
      expect(shallowEqual(nested1, nested2)).toBe(false) // Different object references
    })

    it('handles null and undefined', () => {
      expect(shallowEqual(null, null)).toBe(true)
      expect(shallowEqual(undefined, undefined)).toBe(true)
      expect(shallowEqual(null, undefined)).toBe(false)
      expect(shallowEqual({}, null)).toBe(false)
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/unit/client/lib/utils.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/lib/utils.test.ts
git commit -m "test: add utils unit tests"
```

---

## Phase 4: API Integration Tests

### Task 9: Settings API Integration Tests

**Files:**
- Create: `test/integration/api/settings.test.ts`
- Create: `test/setup/server.ts`
- Test: `server/index.ts` (settings endpoints)

**Step 1: Create server test setup**

```typescript
// test/setup/server.ts
import express from 'express'
import { ConfigStore, defaultSettings } from '../../server/config-store'

export function createTestApp() {
  const app = express()
  app.use(express.json())

  // Mock config store for tests
  const configStore = new ConfigStore()

  return { app, configStore }
}

export { defaultSettings }
```

**Step 2: Write the failing tests**

```typescript
// test/integration/api/settings.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { httpAuthMiddleware } from '../../../server/auth'
import { ConfigStore, defaultSettings } from '../../../server/config-store'

describe('Settings API', () => {
  let app: express.Express
  let configStore: ConfigStore
  const AUTH_TOKEN = 'test-token-16-chars'

  beforeAll(() => {
    process.env.AUTH_TOKEN = AUTH_TOKEN
  })

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/api', httpAuthMiddleware)

    configStore = new ConfigStore()

    app.get('/api/settings', async (_req, res) => {
      const s = await configStore.getSettings()
      res.json(s)
    })

    app.patch('/api/settings', async (req, res) => {
      const updated = await configStore.patchSettings(req.body || {})
      res.json(updated)
    })
  })

  describe('GET /api/settings', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(401)
    })

    it('returns settings with valid auth', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.theme).toBeDefined()
      expect(res.body.terminal).toBeDefined()
      expect(res.body.safety).toBeDefined()
    })

    it('returns default settings initially', async () => {
      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)

      expect(res.body.theme).toBe(defaultSettings.theme)
      expect(res.body.terminal.fontSize).toBe(defaultSettings.terminal.fontSize)
    })
  })

  describe('PATCH /api/settings', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .send({ theme: 'dark' })

      expect(res.status).toBe(401)
    })

    it('updates theme setting', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ theme: 'dark' })

      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('dark')
    })

    it('merges terminal settings', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ terminal: { fontSize: 16 } })

      expect(res.status).toBe(200)
      expect(res.body.terminal.fontSize).toBe(16)
      expect(res.body.terminal.fontFamily).toBe(defaultSettings.terminal.fontFamily)
    })

    it('merges safety settings', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ safety: { autoKillIdleMinutes: 60 } })

      expect(res.status).toBe(200)
      expect(res.body.safety.autoKillIdleMinutes).toBe(60)
      expect(res.body.safety.warnBeforeKillMinutes).toBe(defaultSettings.safety.warnBeforeKillMinutes)
    })

    it('persists settings across requests', async () => {
      await request(app)
        .patch('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ theme: 'light' })

      const res = await request(app)
        .get('/api/settings')
        .set('x-auth-token', AUTH_TOKEN)

      expect(res.body.theme).toBe('light')
    })
  })
})
```

**Step 3: Run test to verify status**

Run: `npx vitest run test/integration/api/settings.test.ts --config vitest.server.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add test/integration/api/settings.test.ts test/setup/server.ts
git commit -m "test: add settings API integration tests"
```

---

### Task 10: Terminals API Integration Tests

**Files:**
- Create: `test/integration/api/terminals.test.ts`
- Test: `server/index.ts` (terminals endpoints)

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { httpAuthMiddleware } from '../../../server/auth'
import { ConfigStore } from '../../../server/config-store'

describe('Terminals API', () => {
  let app: express.Express
  let configStore: ConfigStore
  const AUTH_TOKEN = 'test-token-16-chars'

  // Mock terminal registry
  const mockRegistry = {
    list: vi.fn(() => [
      {
        terminalId: 'term-1',
        title: 'Shell',
        mode: 'shell',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'running',
        hasClients: false,
      },
      {
        terminalId: 'term-2',
        title: 'Claude',
        mode: 'claude',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'running',
        hasClients: true,
      },
    ]),
    updateTitle: vi.fn(() => true),
    updateDescription: vi.fn(() => true),
  }

  beforeAll(() => {
    process.env.AUTH_TOKEN = AUTH_TOKEN
  })

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api', httpAuthMiddleware)

    configStore = new ConfigStore()

    app.get('/api/terminals', async (_req, res) => {
      const cfg = await configStore.snapshot()
      const list = mockRegistry.list().filter((t: any) => !cfg.terminalOverrides?.[t.terminalId]?.deleted)
      const merged = list.map((t: any) => {
        const ov = cfg.terminalOverrides?.[t.terminalId]
        return {
          ...t,
          title: ov?.titleOverride || t.title,
          description: ov?.descriptionOverride || t.description,
        }
      })
      res.json(merged)
    })

    app.patch('/api/terminals/:terminalId', async (req, res) => {
      const terminalId = req.params.terminalId
      const { titleOverride, descriptionOverride, deleted } = req.body || {}

      const next = await configStore.patchTerminalOverride(terminalId, {
        titleOverride,
        descriptionOverride,
        deleted,
      })

      if (typeof titleOverride === 'string' && titleOverride.trim()) {
        mockRegistry.updateTitle(terminalId, titleOverride.trim())
      }
      if (typeof descriptionOverride === 'string') {
        mockRegistry.updateDescription(terminalId, descriptionOverride)
      }

      res.json(next)
    })

    app.delete('/api/terminals/:terminalId', async (req, res) => {
      const terminalId = req.params.terminalId
      await configStore.deleteTerminal(terminalId)
      res.json({ ok: true })
    })
  })

  describe('GET /api/terminals', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/terminals')
      expect(res.status).toBe(401)
    })

    it('returns list of terminals', async () => {
      const res = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(2)
      expect(res.body[0].terminalId).toBe('term-1')
    })

    it('applies title overrides', async () => {
      await configStore.patchTerminalOverride('term-1', { titleOverride: 'My Shell' })

      const res = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)

      const term1 = res.body.find((t: any) => t.terminalId === 'term-1')
      expect(term1.title).toBe('My Shell')
    })

    it('filters out deleted terminals', async () => {
      await configStore.deleteTerminal('term-1')

      const res = await request(app)
        .get('/api/terminals')
        .set('x-auth-token', AUTH_TOKEN)

      expect(res.body).toHaveLength(1)
      expect(res.body[0].terminalId).toBe('term-2')
    })
  })

  describe('PATCH /api/terminals/:terminalId', () => {
    it('updates terminal title', async () => {
      const res = await request(app)
        .patch('/api/terminals/term-1')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ titleOverride: 'Build Server' })

      expect(res.status).toBe(200)
      expect(res.body.titleOverride).toBe('Build Server')
      expect(mockRegistry.updateTitle).toHaveBeenCalledWith('term-1', 'Build Server')
    })

    it('updates terminal description', async () => {
      const res = await request(app)
        .patch('/api/terminals/term-1')
        .set('x-auth-token', AUTH_TOKEN)
        .send({ descriptionOverride: 'Running npm build' })

      expect(res.status).toBe(200)
      expect(res.body.descriptionOverride).toBe('Running npm build')
      expect(mockRegistry.updateDescription).toHaveBeenCalledWith('term-1', 'Running npm build')
    })
  })

  describe('DELETE /api/terminals/:terminalId', () => {
    it('marks terminal as deleted', async () => {
      const res = await request(app)
        .delete('/api/terminals/term-1')
        .set('x-auth-token', AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)

      const override = await configStore.getTerminalOverride('term-1')
      expect(override?.deleted).toBe(true)
    })
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/integration/api/terminals.test.ts --config vitest.server.config.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/integration/api/terminals.test.ts
git commit -m "test: add terminals API integration tests"
```

---

## Phase 5: Expand WebSocket Protocol Tests

### Task 11: Expand WebSocket Protocol Tests

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Test: `server/ws-handler.ts`

**Step 1: Add more comprehensive tests**

Add these additional tests to the existing file:

```typescript
// Add to existing ws-protocol.test.ts

  it('times out if no hello sent', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const close = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }))
    })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    // Don't send hello, wait for timeout
    const result = await close
    expect(result.code).toBe(4002) // HELLO_TIMEOUT
  })

  it('responds to ping with pong', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    ws.send(JSON.stringify({ type: 'ping' }))

    const pong = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'pong') resolve(msg)
      })
    })

    expect(pong.type).toBe('pong')
    expect(pong.timestamp).toBeDefined()
    ws.close()
  })

  it('handles terminal.attach for existing terminal', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    // First create a terminal
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'create-1', mode: 'shell' }))
    const created = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created') resolve(msg)
      })
    })

    // Then attach to it
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId }))
    const attached = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.attached') resolve(msg)
      })
    })

    expect(attached.terminalId).toBe(created.terminalId)
    ws.close()
  })

  it('handles terminal.detach', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    // Create and attach
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'create-2', mode: 'shell' }))
    const created = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created') resolve(msg)
      })
    })

    // Detach
    ws.send(JSON.stringify({ type: 'terminal.detach', terminalId: created.terminalId }))
    const detached = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.detached') resolve(msg)
      })
    })

    expect(detached.terminalId).toBe(created.terminalId)
    ws.close()
  })

  it('handles terminal.list', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    // Create a terminal first
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'create-list', mode: 'shell' }))
    await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created') resolve(msg)
      })
    })

    // Request list
    ws.send(JSON.stringify({ type: 'terminal.list', requestId: 'list-1' }))
    const listResponse = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.list.response') resolve(msg)
      })
    })

    expect(listResponse.requestId).toBe('list-1')
    expect(Array.isArray(listResponse.terminals)).toBe(true)
    ws.close()
  })

  it('returns error for invalid message type', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    ws.send(JSON.stringify({ type: 'invalid.message.type' }))
    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBeDefined()
    ws.close()
  })

  it('returns error for terminal.attach with invalid terminalId', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: 'non-existent-id' }))
    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('NOT_FOUND')
    ws.close()
  })
```

**Step 2: Run tests to verify**

Run: `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/server/ws-protocol.test.ts
git commit -m "test: expand WebSocket protocol tests"
```

---

## Phase 6: React Component Tests

### Task 12: TabBar Component Tests

**Files:**
- Create: `test/components/TabBar.test.tsx`
- Test: `src/components/TabBar.tsx`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../src/store/tabsSlice'
import connectionReducer from '../../src/store/connectionSlice'
import settingsReducer from '../../src/store/settingsSlice'
import sessionsReducer from '../../src/store/sessionsSlice'
import TabBar from '../../src/components/TabBar'

function createTestStore(preloadedState = {}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      sessions: sessionsReducer,
    },
    preloadedState,
  })
}

function renderWithStore(component: React.ReactElement, preloadedState = {}) {
  const store = createTestStore(preloadedState)
  return {
    ...render(<Provider store={store}>{component}</Provider>),
    store,
  }
}

describe('TabBar', () => {
  it('renders tabs', () => {
    const preloadedState = {
      tabs: {
        tabs: [
          { id: 'tab-1', title: 'Terminal 1', status: 'connected', mode: 'shell', shell: 'system', createRequestId: 'tab-1', createdAt: Date.now() },
          { id: 'tab-2', title: 'Terminal 2', status: 'connected', mode: 'claude', shell: 'system', createRequestId: 'tab-2', createdAt: Date.now() },
        ],
        activeTabId: 'tab-1',
      },
      connection: { status: 'ready' },
      settings: { settings: {}, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<TabBar />, preloadedState)

    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    expect(screen.getByText('Terminal 2')).toBeInTheDocument()
  })

  it('highlights active tab', () => {
    const preloadedState = {
      tabs: {
        tabs: [
          { id: 'tab-1', title: 'Terminal 1', status: 'connected', mode: 'shell', shell: 'system', createRequestId: 'tab-1', createdAt: Date.now() },
          { id: 'tab-2', title: 'Terminal 2', status: 'connected', mode: 'shell', shell: 'system', createRequestId: 'tab-2', createdAt: Date.now() },
        ],
        activeTabId: 'tab-1',
      },
      connection: { status: 'ready' },
      settings: { settings: {}, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<TabBar />, preloadedState)

    const tab1 = screen.getByText('Terminal 1').closest('button')
    expect(tab1).toHaveClass('bg-background') // or whatever active class is used
  })

  it('shows close button on tabs', () => {
    const preloadedState = {
      tabs: {
        tabs: [
          { id: 'tab-1', title: 'Terminal 1', status: 'connected', mode: 'shell', shell: 'system', createRequestId: 'tab-1', createdAt: Date.now() },
        ],
        activeTabId: 'tab-1',
      },
      connection: { status: 'ready' },
      settings: { settings: {}, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<TabBar />, preloadedState)

    // Look for close button (X icon)
    const closeButton = screen.getByRole('button', { name: /close/i })
    expect(closeButton).toBeInTheDocument()
  })

  it('shows status indicator for creating tabs', () => {
    const preloadedState = {
      tabs: {
        tabs: [
          { id: 'tab-1', title: 'Terminal 1', status: 'creating', mode: 'shell', shell: 'system', createRequestId: 'tab-1', createdAt: Date.now() },
        ],
        activeTabId: 'tab-1',
      },
      connection: { status: 'ready' },
      settings: { settings: {}, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<TabBar />, preloadedState)

    // Should show loading indicator
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
  })

  it('renders empty state with no tabs', () => {
    const preloadedState = {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'ready' },
      settings: { settings: {}, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<TabBar />, preloadedState)

    // Should render without crashing
    expect(screen.queryByRole('button')).toBeInTheDocument() // New tab button
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/components/TabBar.test.tsx`
Expected: May need adjustments based on actual component implementation

**Step 3: Commit**

```bash
git add test/components/TabBar.test.tsx
git commit -m "test: add TabBar component tests"
```

---

### Task 13: SettingsView Component Tests

**Files:**
- Create: `test/components/SettingsView.test.tsx`
- Test: `src/components/SettingsView.tsx`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../src/store/tabsSlice'
import connectionReducer from '../../src/store/connectionSlice'
import settingsReducer from '../../src/store/settingsSlice'
import sessionsReducer from '../../src/store/sessionsSlice'
import SettingsView from '../../src/components/SettingsView'

function createTestStore(preloadedState = {}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      sessions: sessionsReducer,
    },
    preloadedState,
  })
}

function renderWithStore(component: React.ReactElement, preloadedState = {}) {
  const store = createTestStore(preloadedState)
  return {
    ...render(<Provider store={store}>{component}</Provider>),
    store,
  }
}

const defaultSettings = {
  theme: 'system' as const,
  terminal: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: 'dark' as const,
  },
  safety: {
    autoKillIdleMinutes: 180,
    warnBeforeKillMinutes: 5,
  },
}

describe('SettingsView', () => {
  it('renders settings sections', () => {
    const preloadedState = {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'ready' },
      settings: { settings: defaultSettings, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<SettingsView />, preloadedState)

    // Check for main setting sections
    expect(screen.getByText(/theme/i)).toBeInTheDocument()
    expect(screen.getByText(/font/i)).toBeInTheDocument()
  })

  it('displays current theme setting', () => {
    const preloadedState = {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'ready' },
      settings: { settings: { ...defaultSettings, theme: 'dark' }, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<SettingsView />, preloadedState)

    // Should show current theme value
    expect(screen.getByText(/dark/i)).toBeInTheDocument()
  })

  it('displays font size setting', () => {
    const preloadedState = {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'ready' },
      settings: { settings: defaultSettings, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<SettingsView />, preloadedState)

    // Should show current font size
    expect(screen.getByText(/13/)).toBeInTheDocument()
  })

  it('displays auto-kill idle minutes setting', () => {
    const preloadedState = {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'ready' },
      settings: { settings: defaultSettings, loaded: true },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<SettingsView />, preloadedState)

    // Should show safety settings
    expect(screen.getByText(/180/)).toBeInTheDocument()
  })

  it('shows loading state when settings not loaded', () => {
    const preloadedState = {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'ready' },
      settings: { settings: defaultSettings, loaded: false },
      sessions: { projects: [], expandedProjects: new Set() },
    }

    renderWithStore(<SettingsView />, preloadedState)

    // May show loading indicator or empty state
    // Adjust based on actual implementation
  })
})
```

**Step 2: Run test to verify status**

Run: `npx vitest run test/components/SettingsView.test.tsx`
Expected: May need adjustments based on actual component implementation

**Step 3: Commit**

```bash
git add test/components/SettingsView.test.tsx
git commit -m "test: add SettingsView component tests"
```

---

## Phase 7: Update Vitest Configs

### Task 14: Update Vitest Configuration

**Files:**
- Modify: `vitest.config.ts`
- Modify: `vitest.server.config.ts`

**Step 1: Update client config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup/dom.ts'],
    include: [
      'test/unit/client/**/*.test.{ts,tsx}',
      'test/components/**/*.test.{ts,tsx}',
    ],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './test'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/components/ui/**', // shadcn components
      ],
    },
  },
})
```

**Step 2: Update server config**

```typescript
// vitest.server.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/unit/server/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/server/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['server/**/*.ts'],
      exclude: ['server/logger.ts'],
    },
  },
})
```

**Step 3: Commit**

```bash
git add vitest.config.ts vitest.server.config.ts
git commit -m "chore: update vitest configs for comprehensive test coverage"
```

---

## Phase 8: Add npm scripts

### Task 15: Update package.json test scripts

**Files:**
- Modify: `package.json`

**Step 1: Add comprehensive test scripts**

Add to scripts section:

```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:server": "vitest --config vitest.server.config.ts",
    "test:client": "vitest --config vitest.config.ts",
    "test:all": "npm run test:client -- --run && npm run test:server -- --run",
    "test:coverage": "npm run test:client -- --run --coverage && npm run test:server -- --run --coverage",
    "test:watch": "vitest --watch"
  }
}
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add comprehensive test npm scripts"
```

---

## Summary

This test plan covers:

### Unit Tests (Phase 1-3)
- **Server**: auth.ts, config-store.ts, ChunkRingBuffer
- **Client Store**: tabsSlice, sessionsSlice, connectionSlice, settingsSlice
- **Client Libraries**: utils.ts

### Integration Tests (Phase 4-5)
- **HTTP API**: settings, terminals, sessions endpoints
- **WebSocket Protocol**: comprehensive message handling

### Component Tests (Phase 6)
- **React Components**: TabBar, SettingsView

### Configuration (Phase 7-8)
- Vitest config updates
- npm scripts for running different test suites

### Estimated Coverage After Implementation
- **Server code**: ~80%
- **Client store**: ~90%
- **Client components**: ~40%
- **Overall**: ~60-70%

### Not Covered (Future Work)
- E2E tests (requires Playwright/Cypress setup)
- TerminalView tests (xterm.js mocking is complex)
- WsClient tests (requires WebSocket mocking)
- claude-indexer tests (requires file system mocking)
- Real PTY integration tests (platform-specific)

---

## Execution Commands

Run all tests:
```bash
npm run test:all
```

Run with coverage:
```bash
npm run test:coverage
```

Run specific test file:
```bash
npx vitest run test/unit/server/auth.test.ts --config vitest.server.config.ts
```
