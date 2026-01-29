# Testing Skill for Claude Code Session Organizer

> **Quick Start:** Run `npm run test:all` to run the full test suite.

## Test Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Watch mode (re-runs on file changes) |
| `npm run test:all` | Full suite (client + server configs) |
| `npm run test:unit` | Unit tests only |
| `npm run test:client` | Client/frontend tests only |
| `npm run test:server` | Server tests (node environment) |
| `npm run test:integration` | Integration tests only |
| `npm run test:coverage` | Generate coverage report |

---

## Test Structure

```
test/
├── unit/                      # Pure unit tests (no I/O, fast)
│   ├── client/
│   │   ├── store/             # Redux slice tests
│   │   │   ├── tabsSlice.test.ts
│   │   │   ├── sessionsSlice.test.ts
│   │   │   ├── connectionSlice.test.ts
│   │   │   ├── settingsSlice.test.ts
│   │   │   └── state-edge-cases.test.ts
│   │   └── components/        # React component tests
│   │       ├── TabBar.test.tsx
│   │       ├── SettingsView.test.tsx
│   │       └── component-edge-cases.test.tsx
│   ├── server/                # Server unit tests
│   │   ├── auth.test.ts
│   │   ├── config-store.test.ts
│   │   ├── chunk-ring-buffer.test.ts
│   │   ├── logger.test.ts
│   │   ├── terminal-lifecycle.test.ts
│   │   └── production-edge-cases.test.ts
│   └── lib/                   # Shared utilities
│       └── utils.test.ts
├── server/                    # Server integration tests
│   ├── ws-protocol.test.ts    # WebSocket protocol tests
│   ├── ws-edge-cases.test.ts  # WebSocket edge cases
│   └── terminals-api.test.ts  # REST API tests
├── integration/
│   └── server/
│       ├── settings-api.test.ts
│       └── api-edge-cases.test.ts
└── setup/
    └── dom.ts                 # jsdom setup for client tests
```

---

## Writing New Tests

### 1. Choose the Right Location

| Test Type | Location | Environment |
|-----------|----------|-------------|
| Redux slice | `test/unit/client/store/` | jsdom |
| React component | `test/unit/client/components/` | jsdom |
| Server utility | `test/unit/server/` | node |
| Shared utility | `test/unit/lib/` | jsdom |
| REST API | `test/integration/server/` | node |
| WebSocket | `test/server/` | node |

### 2. Use the Right Config

- **Client tests** (`.tsx`, Redux, React): Use default `vitest.config.ts` (jsdom)
- **Server tests** (Express, WebSocket, node-pty): Use `vitest.server.config.ts` (node)

### 3. Test File Template

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('FeatureName', () => {
  beforeEach(() => {
    // Setup: runs before each test
  })

  afterEach(() => {
    // Cleanup: runs after each test
  })

  describe('methodName', () => {
    it('does expected behavior when given input', () => {
      // Arrange
      const input = 'test'

      // Act
      const result = functionUnderTest(input)

      // Assert
      expect(result).toBe('expected')
    })
  })
})
```

---

## Test Isolation Rules

Tests run in parallel with shuffled order. Follow these rules:

### Environment Variables
```typescript
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.MY_VAR = 'test-value'
})

afterEach(() => {
  process.env = savedEnv
})
```

### File System Operations
```typescript
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test-'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})
```

### Redux Store
```typescript
import { configureStore } from '@reduxjs/toolkit'
import reducer from '@/store/mySlice'

function createTestStore(preloadedState = {}) {
  return configureStore({
    reducer: { mySlice: reducer },
    preloadedState,
  })
}

// Each test creates fresh store
it('test case', () => {
  const store = createTestStore({ mySlice: { value: 'initial' } })
  // ...
})
```

### React Components
```typescript
import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'

afterEach(() => {
  cleanup()
})

it('renders component', () => {
  const store = createTestStore()
  render(
    <Provider store={store}>
      <MyComponent />
    </Provider>
  )
})
```

### Mocking Modules
```typescript
// Mock at top of file
vi.mock('@/lib/api', () => ({
  fetchSettings: vi.fn(),
}))

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks()
})
```

---

## Common Patterns

### Testing Redux Actions
```typescript
it('addTab creates new tab with defaults', () => {
  const store = createTestStore()
  store.dispatch(addTab())

  const state = store.getState().tabs
  expect(state.tabs).toHaveLength(1)
  expect(state.tabs[0].status).toBe('creating')
})
```

### Testing Async Actions
```typescript
it('fetches data on mount', async () => {
  const mockData = { theme: 'dark' }
  vi.mocked(fetchSettings).mockResolvedValue(mockData)

  render(<SettingsView />)

  await waitFor(() => {
    expect(screen.getByText('dark')).toBeInTheDocument()
  })
})
```

### Testing WebSocket Messages
```typescript
it('sends terminal.create message', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise(resolve => ws.on('open', resolve))

  ws.send(JSON.stringify({ type: 'hello', token: 'valid-token' }))

  const ready = await waitForMessage(ws, 'ready')
  expect(ready.type).toBe('ready')

  ws.close()
})
```

### Testing Error Scenarios
```typescript
it('handles API failure gracefully', async () => {
  vi.mocked(fetchSettings).mockRejectedValue(new Error('Network error'))

  render(<SettingsView />)

  await waitFor(() => {
    expect(screen.getByText(/error/i)).toBeInTheDocument()
  })
})
```

---

## Edge Case Testing

When adding new features, also add tests for:

1. **Invalid inputs**: null, undefined, empty strings, wrong types
2. **Boundary conditions**: empty arrays, max values, exactly-at-threshold
3. **Error recovery**: what happens after an error?
4. **Concurrent operations**: rapid clicks, multiple clients
5. **Resource cleanup**: unmount during async, disconnect during operation

See these files for examples:
- `test/unit/client/store/state-edge-cases.test.ts`
- `test/unit/server/production-edge-cases.test.ts`
- `test/unit/client/components/component-edge-cases.test.tsx`
- `test/integration/server/api-edge-cases.test.ts`

---

## Known Issues

### Windows File Locking
ConfigStore has a TOCTOU race condition. Concurrent writes can fail with EPERM on Windows. The concurrency test is skipped on Windows:

```typescript
it.skipIf(process.platform === 'win32')('handles concurrent writes', ...)
```

### Component Crash Scenarios
Some components crash when receiving null from API. These are documented in `component-edge-cases.test.tsx` and should be fixed with null checks.

---

## Debugging Tests

### Run single test file
```bash
npx vitest run test/unit/server/auth.test.ts
```

### Run with pattern matching
```bash
npx vitest run -t "handles invalid token"
```

### Run with verbose output
```bash
npx vitest run --reporter=verbose
```

### Run in watch mode for single file
```bash
npx vitest test/unit/server/auth.test.ts
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Vitest",
  "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
  "args": ["run", "${relativeFile}"],
  "console": "integratedTerminal"
}
```
