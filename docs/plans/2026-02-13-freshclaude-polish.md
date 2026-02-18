# Freshclaude Polish: Claude Chic Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring freshclaude's chat UI up to Claude Chic's level of visual polish and information density through progressive disclosure, color-coded message types, smart tool headers, auto-collapse, streaming indicators, and color-coded diffs.

**Architecture:** Incremental enhancement of existing `MessageBubble`, `ToolBlock`, and `ClaudeChatView` components. Each task is self-contained — no task depends on another unless explicitly noted. New components (`ThinkingIndicator`, `DiffView`, `CollapsedTurn`) are added alongside existing ones. CSS custom properties added for the color-coding system. A `useStreamDebounce` hook wraps the existing Redux streaming state.

**Tech Stack:** React 18, Tailwind CSS, CSS custom properties, `react-markdown` + `remark-gfm` (existing), `diff` npm package (new — for computing line diffs). Vitest + Testing Library (existing).

**Reference:** [Claude Chic](https://github.com/mrocklin/claudechic) by Matthew Rocklin — Python/Textual TUI wrapping claude-agent-sdk.

---

## Task 1: Add CSS Custom Properties for Message Type Colors

**Files:**
- Modify: `src/index.css:5-56`
- Test: Visual inspection (CSS-only change)

**Step 1: Add claude chat color variables to `:root` and `.dark`**

In `src/index.css`, add these custom properties inside the existing `:root` block (after `--warning-foreground`):

```css
  /* Claude chat message type colors */
  --claude-user: 30 90% 45%;           /* warm orange */
  --claude-assistant: 210 60% 55%;     /* sky blue */
  --claude-tool: 240 5% 55%;           /* neutral gray */
  --claude-error: 0 72% 51%;           /* red - reuse destructive */
  --claude-warning: 38 92% 50%;        /* yellow - reuse warning */
  --claude-success: 142 71% 45%;       /* green - reuse success */
```

And in the `.dark` block:

```css
  /* Claude chat message type colors (dark) */
  --claude-user: 30 85% 55%;
  --claude-assistant: 210 55% 60%;
  --claude-tool: 240 5% 45%;
  --claude-error: 0 62% 50%;
  --claude-warning: 38 92% 50%;
  --claude-success: 142 71% 45%;
```

**Step 2: Verify no build errors**

Run: `npm run build:client`
Expected: Clean build, no errors

**Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat(freshclaude): add CSS custom properties for message type color coding

Add --claude-user (orange), --claude-assistant (blue), --claude-tool (gray),
--claude-error (red), --claude-warning (yellow), --claude-success (green)
for both light and dark modes. These power the left-border visual language
inspired by Claude Chic's scannable message type system."
```

---

## Task 2: Redesign MessageBubble with Left-Border Visual Language

Replace chat-bubble alignment with a left-border color system for instant scanability. All messages left-aligned, distinguished by colored left border bars.

**Files:**
- Modify: `src/components/claude-chat/MessageBubble.tsx`
- Modify: `test/unit/client/components/claude-chat/MessageBubble.test.tsx`

**Step 1: Update MessageBubble tests for new layout**

Replace the existing test file content. Key changes: messages are no longer right/left-aligned — they all have left borders with role-specific colors. User messages have `border-l-[3px]` with `--claude-user` color. Assistant messages have `border-l-2` with `--claude-assistant` color.

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MessageBubble from '../../../../../src/components/claude-chat/MessageBubble'
import type { ChatContentBlock } from '@/store/claudeChatTypes'

describe('MessageBubble', () => {
  afterEach(cleanup)

  it('renders user text as left-aligned with orange left border', () => {
    const { container } = render(
      <MessageBubble role="user" content={[{ type: 'text', text: 'Hello world' }]} />
    )
    expect(screen.getByText('Hello world')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'user message' })).toBeInTheDocument()
    // User messages have thicker left border
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('border-l-[3px]')
  })

  it('renders assistant text with blue left border and markdown', () => {
    const { container } = render(
      <MessageBubble role="assistant" content={[{ type: 'text', text: '**Bold text**' }]} />
    )
    expect(screen.getByText('Bold text')).toBeInTheDocument()
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('border-l-2')
  })

  it('constrains content width with max-w-prose', () => {
    const { container } = render(
      <MessageBubble role="assistant" content={[{ type: 'text', text: 'Hello' }]} />
    )
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('max-w-prose')
  })

  it('renders thinking block as collapsible', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'thinking', thinking: 'Let me think...' }]}
      />
    )
    expect(screen.getByText(/Thinking/)).toBeInTheDocument()
  })

  it('renders tool use block', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }]}
      />
    )
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })

  it('renders timestamp and model', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'text', text: 'Hi' }]}
        timestamp="2026-02-13T10:00:00Z"
        model="claude-sonnet-4-5"
        showTimecodes={true}
      />
    )
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument()
  })
})

describe('MessageBubble display toggles', () => {
  afterEach(cleanup)

  const textBlock: ChatContentBlock = { type: 'text', text: 'Hello world' }
  const thinkingBlock: ChatContentBlock = { type: 'thinking', thinking: 'Let me think about this...' }
  const toolUseBlock: ChatContentBlock = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
  const toolResultBlock: ChatContentBlock = { type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }

  it('hides thinking blocks when showThinking is false', () => {
    render(
      <MessageBubble role="assistant" content={[textBlock, thinkingBlock]} showThinking={false} />
    )
    expect(screen.queryByText(/Let me think/)).not.toBeInTheDocument()
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('shows thinking blocks when showThinking is true', () => {
    render(
      <MessageBubble role="assistant" content={[thinkingBlock]} showThinking={true} />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
  })

  it('hides tool_use blocks when showTools is false', () => {
    render(
      <MessageBubble role="assistant" content={[textBlock, toolUseBlock]} showTools={false} />
    )
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
  })

  it('hides tool_result blocks when showTools is false', () => {
    render(
      <MessageBubble role="assistant" content={[textBlock, toolResultBlock]} showTools={false} />
    )
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
  })

  it('shows timestamp when showTimecodes is true', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock]}
        timestamp="2026-02-13T10:00:00Z"
        showTimecodes={true}
      />
    )
    expect(screen.getByRole('article').querySelector('time')).toBeInTheDocument()
  })

  it('hides timestamp when showTimecodes is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock]}
        timestamp="2026-02-13T10:00:00Z"
        showTimecodes={false}
      />
    )
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })

  it('defaults to showing thinking and tools, hiding timecodes', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, thinkingBlock, toolUseBlock]}
        timestamp="2026-02-13T10:00:00Z"
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/MessageBubble.test.tsx`
Expected: FAIL — `border-l-[3px]` and `max-w-prose` not present in current output

**Step 3: Rewrite MessageBubble component**

Replace `src/components/claude-chat/MessageBubble.tsx`:

```tsx
import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import type { ChatContentBlock } from '@/store/claudeChatTypes'
import ToolBlock from './ToolBlock'

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp?: string
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
}

function MessageBubble({
  role,
  content,
  timestamp,
  model,
  showThinking = true,
  showTools = true,
  showTimecodes = false,
}: MessageBubbleProps) {
  // Pair tool_use blocks with their tool_result blocks for unified rendering.
  // This allows ToolBlock to show the tool name, input preview, AND result
  // summary in one place, instead of rendering them as separate blocks.
  const resultMap = useMemo(() => {
    const map = new Map<string, ChatContentBlock>()
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, block)
      }
    }
    return map
  }, [content])

  return (
    <div
      className={cn(
        'max-w-prose pl-3 py-1 text-sm',
        role === 'user'
          ? 'border-l-[3px] border-l-[hsl(var(--claude-user))]'
          : 'border-l-2 border-l-[hsl(var(--claude-assistant))]'
      )}
      role="article"
      aria-label={`${role} message`}
    >
      {content.map((block, i) => {
        if (block.type === 'text' && block.text) {
          if (role === 'user') {
            return <p key={i} className="whitespace-pre-wrap">{block.text}</p>
          }
          return (
            <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
            </div>
          )
        }

        if (block.type === 'thinking' && block.thinking) {
          if (!showThinking) return null
          return (
            <details key={i} className="text-xs text-muted-foreground mt-1">
              <summary className="cursor-pointer select-none">
                Thinking ({block.thinking.length.toLocaleString()} chars)
              </summary>
              <pre className="mt-1 whitespace-pre-wrap text-xs opacity-70">{block.thinking}</pre>
            </details>
          )
        }

        if (block.type === 'tool_use' && block.name) {
          if (!showTools) return null
          // Look up the matching tool_result to show as a unified block
          const result = block.id ? resultMap.get(block.id) : undefined
          const resultContent = result
            ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
            : undefined
          return (
            <ToolBlock
              key={block.id || i}
              name={block.name}
              input={block.input}
              output={resultContent}
              isError={result?.is_error}
              status={result ? 'complete' : 'running'}
            />
          )
        }

        if (block.type === 'tool_result') {
          if (!showTools) return null
          // Skip if already merged into a matching tool_use block above
          if (block.tool_use_id && content.some(b => b.type === 'tool_use' && b.id === block.tool_use_id)) {
            return null
          }
          // Render orphaned results (no matching tool_use) as standalone
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content)
          return (
            <ToolBlock
              key={block.tool_use_id || i}
              name="Result"
              output={resultContent}
              isError={block.is_error}
              status="complete"
            />
          )
        }

        return null
      })}

      {((showTimecodes && timestamp) || model) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          {showTimecodes && timestamp && (
            <time>{new Date(timestamp).toLocaleTimeString()}</time>
          )}
          {model && <span className="opacity-60">{model}</span>}
        </div>
      )}
    </div>
  )
}

export default memo(MessageBubble)
```

Key changes from original:
- Removed chat-bubble alignment (`ml-auto`/`mr-auto`) — all messages left-aligned
- Removed `rounded-lg`, `bg-primary`/`bg-muted` backgrounds — transparent with colored left border
- User: `border-l-[3px]` with `--claude-user` (orange, thicker = more prominent)
- Assistant: `border-l-2` with `--claude-assistant` (blue, thinner = less prominent)
- Added `max-w-prose` (~65ch) for readability
- Metadata moved from separate flex row to inline `mt-1` below content

**Step 4: Run tests to verify they pass**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/MessageBubble.test.tsx`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/components/claude-chat/MessageBubble.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx
git commit -m "feat(freshclaude): replace chat bubbles with left-border visual language

Replace right-aligned user bubbles and muted assistant bubbles with a
Claude Chic-inspired left border color system:
- User messages: 3px orange left border (--claude-user)
- Assistant messages: 2px blue left border (--claude-assistant)
- All messages left-aligned with max-w-prose for readability
- Transparent backgrounds — border color is the primary differentiator

This provides instant scanability in long conversations without reading content."
```

---

## Task 3: Smart Tool Headers with Result Summaries

Enhance `ToolBlock` to show context-rich one-line headers and append result summaries after completion. Inspired by Claude Chic's `format_tool_header()`.

**Files:**
- Modify: `src/components/claude-chat/ToolBlock.tsx`
- Modify: `test/unit/client/components/claude-chat/ToolBlock.test.tsx`

**Step 1: Write new tests for smart headers and result summaries**

Add to the existing test file:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolBlock from '../../../../../src/components/claude-chat/ToolBlock'

describe('ToolBlock', () => {
  afterEach(cleanup)

  it('renders tool name and preview', () => {
    render(<ToolBlock name="Bash" input={{ command: 'ls -la' }} status="running" />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('$ ls -la')).toBeInTheDocument()
  })

  it('shows file path preview for Read tool', () => {
    render(<ToolBlock name="Read" input={{ file_path: '/home/user/file.ts' }} status="complete" />)
    expect(screen.getByText('/home/user/file.ts')).toBeInTheDocument()
  })

  it('expands to show details on click', async () => {
    const user = userEvent.setup()
    render(<ToolBlock name="Bash" input={{ command: 'echo hello' }} status="complete" />)
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows error styling when isError is true', () => {
    render(<ToolBlock name="Result" output="Command failed" isError={true} status="complete" />)
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  // --- New: smart header tests ---

  it('shows Bash description field when available', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'npm install --save-dev vitest', description: 'Install test runner' }}
        status="running"
      />
    )
    expect(screen.getByText('Install test runner')).toBeInTheDocument()
  })

  it('shows Grep pattern in preview', () => {
    render(
      <ToolBlock
        name="Grep"
        input={{ pattern: 'useState', path: 'src/' }}
        status="running"
      />
    )
    expect(screen.getByText(/useState/)).toBeInTheDocument()
  })

  it('shows Edit file path with old/new string indicator', () => {
    render(
      <ToolBlock
        name="Edit"
        input={{ file_path: 'src/App.tsx', old_string: 'foo', new_string: 'bar' }}
        status="running"
      />
    )
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
  })

  it('appends result summary for completed Read tool', () => {
    const output = Array(50).fill('line of code').join('\n')
    render(
      <ToolBlock name="Read" input={{ file_path: 'src/App.tsx' }} output={output} status="complete" />
    )
    // Should show line count summary
    expect(screen.getByText(/50 lines/)).toBeInTheDocument()
  })

  it('appends result summary for completed Bash tool with exit code', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'false' }}
        output="error output"
        isError={true}
        status="complete"
      />
    )
    expect(screen.getByText(/error/i)).toBeInTheDocument()
  })

  it('appends result summary for completed Grep tool', () => {
    const output = 'file1.ts\nfile2.ts\nfile3.ts'
    render(
      <ToolBlock
        name="Grep"
        input={{ pattern: 'foo' }}
        output={output}
        status="complete"
      />
    )
    expect(screen.getByText(/3 match/)).toBeInTheDocument()
  })

  it('uses tool-colored left border', () => {
    const { container } = render(
      <ToolBlock name="Bash" input={{ command: 'ls' }} status="running" />
    )
    const wrapper = container.firstElementChild!
    expect(wrapper.className).toContain('border-l')
  })
})
```

**Step 2: Run tests to verify new ones fail**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/ToolBlock.test.tsx`
Expected: New tests FAIL (description field, result summaries, border-l not present)

**Step 3: Rewrite ToolBlock with smart headers and result summaries**

Replace `src/components/claude-chat/ToolBlock.tsx`:

```tsx
import { useState, memo, useMemo } from 'react'
import { ChevronRight, Terminal, FileText, Eye, Pencil, Search, Globe, Loader2, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ToolBlockProps {
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Read: Eye,
  Write: FileText,
  Edit: Pencil,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
}

/** Generate a context-rich one-line preview for the tool header. */
function getToolPreview(name: string, input?: Record<string, unknown>): string {
  if (!input) return ''

  if (name === 'Bash') {
    // Prefer description over raw command
    if (typeof input.description === 'string') return input.description
    if (typeof input.command === 'string') return `$ ${input.command.slice(0, 120)}`
    return ''
  }

  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : ''
    return path ? `${pattern} in ${path}` : pattern
  }

  if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path
  }

  if (name === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern
  }

  if ((name === 'WebFetch' || name === 'WebSearch') && typeof input.url === 'string') {
    return input.url
  }

  return JSON.stringify(input).slice(0, 100)
}

/** Generate a short result summary (e.g. "143 lines", "5 matches", "error"). */
function getResultSummary(name: string, output?: string, isError?: boolean): string | null {
  if (!output) return null
  if (isError) return 'error'

  if (name === 'Read' || name === 'Result') {
    const lineCount = output.split('\n').length
    return `${lineCount} line${lineCount !== 1 ? 's' : ''}`
  }

  if (name === 'Grep' || name === 'Glob') {
    const matchCount = output.trim().split('\n').filter(Boolean).length
    return `${matchCount} match${matchCount !== 1 ? 'es' : ''}`
  }

  if (name === 'Bash') {
    const lineCount = output.split('\n').length
    if (lineCount > 3) return `${lineCount} lines`
    return 'done'
  }

  return 'done'
}

function ToolBlock({ name, input, output, isError, status }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const Icon = TOOL_ICONS[name] || Terminal
  const preview = useMemo(() => getToolPreview(name, input), [name, input])
  const resultSummary = useMemo(
    () => status === 'complete' ? getResultSummary(name, output, isError) : null,
    [name, output, isError, status],
  )

  return (
    <div
      className={cn(
        'border-l-2 my-1 text-xs',
        isError
          ? 'border-l-[hsl(var(--claude-error))]'
          : 'border-l-[hsl(var(--claude-tool))]'
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-2 py-1 text-left hover:bg-accent/50 rounded-r"
        aria-expanded={expanded}
        aria-label={`${name} tool call`}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        {preview && <span className="truncate text-muted-foreground font-mono">{preview}</span>}
        {resultSummary && (
          <span className={cn(
            'shrink-0 text-muted-foreground',
            isError && 'text-red-500'
          )}>
            ({resultSummary})
          </span>
        )}
        <span className="ml-auto shrink-0">
          {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === 'complete' && !isError && <Check className="h-3 w-3 text-green-500" />}
          {status === 'complete' && isError && <X className="h-3 w-3 text-red-500" />}
        </span>
      </button>

      {expanded && (
        <div className="px-2 py-1.5 border-t border-border/50 text-xs">
          {input && (
            <pre className="whitespace-pre-wrap font-mono opacity-80 max-h-48 overflow-y-auto">
              {name === 'Bash' && typeof input.command === 'string'
                ? input.command
                : JSON.stringify(input, null, 2)}
            </pre>
          )}
          {output && (
            <pre className={cn(
              'whitespace-pre-wrap font-mono max-h-48 overflow-y-auto mt-1',
              isError ? 'text-red-500' : 'opacity-80'
            )}>
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(ToolBlock)
```

Key changes:
- Left border replaces full border box (consistent with message visual language)
- `getToolPreview()` prefers `description` for Bash, handles Grep pattern+path, Glob, WebFetch
- `getResultSummary()` appends `(143 lines)`, `(5 matches)`, `(error)`, `(done)` after completion
- More tool icons: Grep/Glob get Search, WebFetch/WebSearch get Globe
- Uses `--claude-tool` / `--claude-error` CSS vars

**Step 4: Run tests to verify they pass**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/ToolBlock.test.tsx`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/components/claude-chat/ToolBlock.tsx test/unit/client/components/claude-chat/ToolBlock.test.tsx
git commit -m "feat(freshclaude): smart tool headers with result summaries

Enhance ToolBlock with context-rich one-line headers:
- Bash: shows description field when available, else truncated command
- Grep: shows 'pattern in path'
- Read/Edit/Write: shows file path
- Result summaries appended after completion: (143 lines), (5 matches), (error)
- Left border color coding: --claude-tool gray, --claude-error red
- Additional tool icons for Grep, Glob, WebFetch, WebSearch

Users can now see what happened without expanding every tool block."
```

---

## Task 4: Auto-Collapse Old Tool Blocks

Recent completed tool blocks auto-expand to show results; older ones start collapsed. Managed at the `ClaudeChatView` level to coordinate across messages.

**Files:**
- Modify: `src/components/claude-chat/ToolBlock.tsx`
- Modify: `src/components/claude-chat/MessageBubble.tsx`
- Create: `test/unit/client/components/claude-chat/ToolBlock.autocollapse.test.tsx`

**Step 1: Write failing test for auto-expand prop**

Create `test/unit/client/components/claude-chat/ToolBlock.autocollapse.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolBlock from '../../../../../src/components/claude-chat/ToolBlock'

describe('ToolBlock auto-collapse', () => {
  afterEach(cleanup)

  it('starts collapsed by default (no initialExpanded)', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        output="hello"
        status="complete"
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('starts expanded when initialExpanded is true', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        output="hello"
        status="complete"
        initialExpanded={true}
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('can be collapsed after starting expanded', async () => {
    const user = userEvent.setup()
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        output="hello"
        status="complete"
        initialExpanded={true}
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/ToolBlock.autocollapse.test.tsx`
Expected: FAIL — `initialExpanded` prop not accepted, second test expects `true` but gets `false`

**Step 3: Add `initialExpanded` prop to ToolBlock**

In `src/components/claude-chat/ToolBlock.tsx`, update the interface and initial state:

```tsx
interface ToolBlockProps {
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
  /** When true, tool block starts expanded (used for recent tools). Default: false. */
  initialExpanded?: boolean
}
```

And the component:

```tsx
function ToolBlock({ name, input, output, isError, status, initialExpanded }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(initialExpanded ?? false)
  // ... rest unchanged
}
```

**Step 4: Add `toolIndexOffset` and `autoExpandAbove` props to MessageBubble**

In `src/components/claude-chat/MessageBubble.tsx`, add props so that recent completed tool blocks auto-expand:

Update the MessageBubble props:

```tsx
interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp?: string
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
  /** Index offset for this message's completed tool blocks in the global sequence. */
  completedToolOffset?: number
  /** Completed tools at globalIndex >= this value get initialExpanded=true. */
  autoExpandAbove?: number
}
```

Then in the rendering loop for tool_use blocks:

```tsx
// Track completed tool index within this message
let completedToolIdx = 0
// ...inside the content.map:
if (block.type === 'tool_use' && block.name) {
  if (!showTools) return null
  const result = block.id ? resultMap.get(block.id) : undefined
  const resultContent = result
    ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
    : undefined
  // Only auto-expand completed tools (those with a matching result).
  // Running tools (no result) follow default collapsed behavior.
  let shouldExpand = false
  if (result) {
    const globalIdx = (completedToolOffset ?? 0) + completedToolIdx
    completedToolIdx++
    shouldExpand = autoExpandAbove != null && globalIdx >= autoExpandAbove
  }
  return (
    <ToolBlock
      key={block.id || i}
      name={block.name}
      input={block.input}
      output={resultContent}
      isError={result?.is_error}
      status={result ? 'complete' : 'running'}
      initialExpanded={shouldExpand}
    />
  )
}
```

**Step 5: Wire auto-collapse in ClaudeChatView**

In `src/components/claude-chat/ClaudeChatView.tsx`, compute tool counts and pass expand indices:

```tsx
const RECENT_TOOLS_EXPANDED = 3

// Count only COMPLETED tools (tool_use with a matching tool_result in the same message).
// Running tools (no result yet) are excluded — they follow default collapsed behavior
// and don't consume "recent" slots.
const messages = session?.messages ?? []
let totalCompletedTools = 0
const completedToolOffsets: number[] = []
for (const msg of messages) {
  completedToolOffsets.push(totalCompletedTools)
  for (const b of msg.content) {
    if (b.type === 'tool_use' && b.id) {
      const hasResult = msg.content.some(
        r => r.type === 'tool_result' && r.tool_use_id === b.id
      )
      if (hasResult) totalCompletedTools++
    }
  }
}
const autoExpandAbove = Math.max(0, totalCompletedTools - RECENT_TOOLS_EXPANDED)

// In the render:
{messages.map((msg, i) => (
  <MessageBubble
    key={i}
    role={msg.role}
    content={msg.content}
    timestamp={msg.timestamp}
    model={msg.model}
    showThinking={paneContent.showThinking ?? true}
    showTools={paneContent.showTools ?? true}
    showTimecodes={paneContent.showTimecodes ?? false}
    completedToolOffset={completedToolOffsets[i]}
    autoExpandAbove={autoExpandAbove}
  />
))}
```

**Step 6: Run all claude-chat tests**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/components/claude-chat/ToolBlock.tsx src/components/claude-chat/MessageBubble.tsx src/components/claude-chat/ClaudeChatView.tsx test/unit/client/components/claude-chat/ToolBlock.autocollapse.test.tsx
git commit -m "feat(freshclaude): auto-expand recent tool blocks, collapse old ones

The 3 most recent completed tool blocks start expanded (initialExpanded=true)
so users immediately see results. Older tools start collapsed with just the
summary header visible — click to expand and see full content.

Computed globally across all messages via toolIndexOffset + autoExpandAbove
passed through MessageBubble to individual ToolBlock instances."
```

---

## Task 5: In-Chat Thinking/Streaming Indicator

Add a visual "thinking" indicator that appears inline in the chat when Claude is processing but no assistant response content has arrived yet.

**Timing considerations:** The SDK message flow has gaps between `content_block_stop` and `sdk.assistant` where `streamingActive` is briefly false while status is still `running`. A naive condition would flash the indicator during these ~50ms gaps. To prevent this, the component uses a 200ms render delay — it only becomes visible after being mounted for 200ms, absorbing any transient gap flashes.

**Files:**
- Create: `src/components/claude-chat/ThinkingIndicator.tsx`
- Create: `test/unit/client/components/claude-chat/ThinkingIndicator.test.tsx`
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`

**Step 1: Write test for ThinkingIndicator**

Create `test/unit/client/components/claude-chat/ThinkingIndicator.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import ThinkingIndicator from '../../../../../src/components/claude-chat/ThinkingIndicator'

describe('ThinkingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('does not render immediately (debounced to prevent flash)', () => {
    render(<ThinkingIndicator />)
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument()
  })

  it('renders thinking text after 200ms delay', () => {
    render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByText('Thinking...')).toBeInTheDocument()
  })

  it('has assistant message styling (blue border) when visible', () => {
    const { container } = render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(200) })
    const wrapper = container.firstElementChild!
    expect(wrapper.className).toContain('border-l')
  })

  it('has status role for accessibility when visible', () => {
    render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('does not flash if unmounted before delay completes', () => {
    const { unmount } = render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(100) })
    unmount()
    // No assertion needed — test verifies no errors on unmount during pending timer
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/ThinkingIndicator.test.tsx`
Expected: FAIL — module not found

**Step 3: Create ThinkingIndicator component**

Create `src/components/claude-chat/ThinkingIndicator.tsx`:

```tsx
import { memo, useState, useEffect } from 'react'

/** Delay before showing indicator, prevents flash during brief SDK message gaps. */
const RENDER_DELAY_MS = 200

function ThinkingIndicator() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), RENDER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div
      className="border-l-2 border-l-[hsl(var(--claude-assistant))] pl-3 py-1 max-w-prose"
      role="status"
      aria-label="Claude is thinking"
    >
      <span className="text-sm text-muted-foreground animate-pulse">
        Thinking...
      </span>
    </div>
  )
}

export default memo(ThinkingIndicator)
```

**Step 4: Run test to verify it passes**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/ThinkingIndicator.test.tsx`
Expected: All PASS

**Step 5: Wire into ClaudeChatView**

In `src/components/claude-chat/ClaudeChatView.tsx`, add the indicator after the streaming block. The condition checks:
- `status === 'running'` — Claude is actively processing
- `!streamingActive` — no text is currently streaming
- Last message is from the user — no assistant content has been committed to the message list yet

The 200ms render delay inside ThinkingIndicator absorbs brief gaps between SDK events (e.g., between `content_block_stop` and `sdk.assistant`), preventing flashes.

```tsx
import ThinkingIndicator from './ThinkingIndicator'

// ... in the render, after the streaming MessageBubble block:

{/* Thinking indicator — shown when running but no response content yet.
    Three guards prevent false positives:
    1. status === 'running' — Claude is actively processing
    2. !streamingActive — no text currently streaming
    3. lastMessage.role === 'user' — no assistant content committed yet
    The component self-debounces with a 200ms render delay to prevent
    flash during brief SDK gaps (content_block_stop → sdk.assistant). */}
{session?.status === 'running' &&
  !session.streamingActive &&
  session.messages.length > 0 &&
  session.messages[session.messages.length - 1].role === 'user' && (
  <ThinkingIndicator />
)}
```

**Step 6: Add ClaudeChatView integration test for indicator gating**

Add to `test/unit/client/components/claude-chat/ClaudeChatView.status.test.tsx` (or a new `ClaudeChatView.indicator.test.tsx`) tests that verify the indicator condition at the view level:

```tsx
it('shows thinking indicator when status=running and last message is from user', () => {
  // Render ClaudeChatView with session: status='running', messages=[{role:'user',...}],
  // streamingActive=false
  // Advance timers by 200ms for the render delay
  // Assert: screen.getByRole('status') is in the document
})

it('hides thinking indicator when assistant message exists after user message', () => {
  // Session: status='running', messages=[{role:'user',...},{role:'assistant',...}],
  // streamingActive=false
  // Assert: screen.queryByRole('status') is NOT in the document
})

it('hides thinking indicator when streaming is active', () => {
  // Session: status='running', messages=[{role:'user',...}],
  // streamingActive=true, streamingText='...'
  // Assert: screen.queryByRole('status') is NOT in the document
})
```

**Step 7: Run all claude-chat tests**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/`
Expected: All PASS

**Step 8: Commit**

```bash
git add src/components/claude-chat/ThinkingIndicator.tsx test/unit/client/components/claude-chat/ThinkingIndicator.test.tsx src/components/claude-chat/ClaudeChatView.tsx test/unit/client/components/claude-chat/ClaudeChatView.indicator.test.tsx
git commit -m "feat(freshclaude): add in-chat thinking indicator with flash prevention

Show a pulsing 'Thinking...' indicator inline in the chat when Claude is
processing but no streaming text has arrived yet. Uses assistant-style
blue left border for visual consistency.

The component uses a 200ms render delay to prevent flash during brief
SDK message gaps (e.g., between content_block_stop and sdk.assistant
events, which are dispatched as separate Redux actions). Only sustained
'thinking' periods (>200ms) show the indicator."
```

---

## Task 6: Streaming Debounce Hook

Add a `useStreamDebounce` hook that batches rapid `appendStreamDelta` updates to limit markdown re-parsing to ~20x/sec.

**Files:**
- Create: `src/components/claude-chat/useStreamDebounce.ts`
- Create: `test/unit/client/components/claude-chat/useStreamDebounce.test.ts`
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`

**Step 1: Write test for useStreamDebounce**

Create `test/unit/client/components/claude-chat/useStreamDebounce.test.ts`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStreamDebounce } from '../../../../../src/components/claude-chat/useStreamDebounce'

describe('useStreamDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns raw text immediately for short strings', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: 'Hello', active: true } },
    )
    expect(result.current).toBe('Hello')
  })

  it('debounces rapid updates', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )

    // Rapid updates
    rerender({ text: 'a', active: true })
    rerender({ text: 'ab', active: true })
    rerender({ text: 'abc', active: true })

    // Should have debounced — may not have latest yet
    // After timer fires, should catch up
    act(() => { vi.advanceTimersByTime(50) })
    expect(result.current).toBe('abc')
  })

  it('flushes immediately when buffer exceeds threshold', () => {
    const longText = 'x'.repeat(250)
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )
    rerender({ text: longText, active: true })
    // Should flush immediately due to size threshold
    expect(result.current).toBe(longText)
  })

  it('returns final text when streaming stops', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: 'partial', active: true } },
    )
    rerender({ text: 'complete', active: false })
    expect(result.current).toBe('complete')
  })

  it('clears stale text when a new stream starts', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )
    // Simulate first stream producing text
    rerender({ text: 'old stream content', active: true })
    act(() => { vi.advanceTimersByTime(50) })
    expect(result.current).toBe('old stream content')

    // Stream ends
    rerender({ text: '', active: false })
    expect(result.current).toBe('')

    // New stream starts — should not flash old content
    rerender({ text: '', active: true })
    expect(result.current).toBe('')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/useStreamDebounce.test.ts`
Expected: FAIL — module not found

**Step 3: Create useStreamDebounce hook**

Create `src/components/claude-chat/useStreamDebounce.ts`:

```ts
import { useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 50
const FLUSH_THRESHOLD = 200

/**
 * Debounces streaming text updates to limit markdown re-parsing frequency.
 * Flushes every DEBOUNCE_MS or when the buffer delta exceeds FLUSH_THRESHOLD chars.
 * Returns the debounced text string for rendering.
 */
export function useStreamDebounce(text: string, active: boolean): string {
  const [debouncedText, setDebouncedText] = useState(text)
  const lastFlushedLenRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevActiveRef = useRef(active)

  useEffect(() => {
    // When streaming is inactive, always show final text and reset
    if (!active) {
      setDebouncedText(text)
      lastFlushedLenRef.current = text.length
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      prevActiveRef.current = active
      return
    }

    // Reset on new stream start to prevent stale text from previous stream.
    // Without this, React batching could leave debouncedText holding old
    // content for a render frame when streamingActive transitions true.
    if (!prevActiveRef.current && active) {
      setDebouncedText(text) // text is '' at stream start
      lastFlushedLenRef.current = text.length
      prevActiveRef.current = active
      return
    }
    prevActiveRef.current = active

    const delta = text.length - lastFlushedLenRef.current

    // Flush immediately if buffer is large enough
    if (delta >= FLUSH_THRESHOLD) {
      setDebouncedText(text)
      lastFlushedLenRef.current = text.length
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    // Otherwise debounce
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        setDebouncedText(text)
        lastFlushedLenRef.current = text.length
        timerRef.current = null
      }, DEBOUNCE_MS)
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [text, active])

  return debouncedText
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/useStreamDebounce.test.ts`
Expected: All PASS

**Step 5: Wire into ClaudeChatView**

In `src/components/claude-chat/ClaudeChatView.tsx`:

```tsx
import { useMemo } from 'react'
import { useStreamDebounce } from './useStreamDebounce'

// Inside the component:
const debouncedStreamingText = useStreamDebounce(
  session?.streamingText ?? '',
  session?.streamingActive ?? false,
)

// IMPORTANT: Memoize the content array so React.memo on MessageBubble
// actually works. Without this, a new array reference is created every
// render (even when debouncedStreamingText hasn't changed), defeating
// the memo and causing unnecessary markdown re-parsing.
const streamingContent = useMemo(
  () => debouncedStreamingText
    ? [{ type: 'text' as const, text: debouncedStreamingText }]
    : [],
  [debouncedStreamingText],
)

// Replace the streaming MessageBubble:
{session?.streamingActive && streamingContent.length > 0 && (
  <MessageBubble
    role="assistant"
    content={streamingContent}
    showThinking={paneContent.showThinking ?? true}
    showTools={paneContent.showTools ?? true}
    showTimecodes={paneContent.showTimecodes ?? false}
  />
)}
```

> **Note:** The debounce hook limits how frequently `debouncedStreamingText` changes (~20x/sec), which directly reduces markdown re-parsing frequency. The `useMemo` around the content array ensures that when the text hasn't changed, `React.memo` on MessageBubble prevents re-renders entirely. For full optimization, a future task could extract the streaming bubble into its own Redux-connected component to avoid re-rendering the parent `ClaudeChatView` on every `appendStreamDelta` dispatch.

**Step 6: Run all tests**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/components/claude-chat/useStreamDebounce.ts test/unit/client/components/claude-chat/useStreamDebounce.test.ts src/components/claude-chat/ClaudeChatView.tsx
git commit -m "feat(freshclaude): debounce streaming text to limit re-renders

Add useStreamDebounce hook that batches rapid appendStreamDelta updates:
- Flushes every 50ms (limits markdown re-parsing to ~20x/sec)
- Immediately flushes when delta exceeds 200 chars (prevents visual stutter)
- Always shows final text when streaming stops
Inspired by Claude Chic's MarkdownStream debounce strategy."
```

---

## Task 7: System Reminder Stripping

Strip `<system-reminder>...</system-reminder>` tags from tool result output before rendering.

**Files:**
- Modify: `src/components/claude-chat/MessageBubble.tsx`
- Add to: `test/unit/client/components/claude-chat/MessageBubble.test.tsx`

**Step 1: Write failing test**

Add to `MessageBubble.test.tsx`:

```tsx
it('strips system-reminder tags from standalone tool result content', () => {
  render(
    <MessageBubble
      role="assistant"
      content={[{
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'actual content\n<system-reminder>\nHidden system text\n</system-reminder>\nmore content',
      }]}
    />
  )
  expect(screen.queryByText(/Hidden system text/)).not.toBeInTheDocument()
})

it('strips system-reminder tags from paired tool_use/tool_result content', () => {
  render(
    <MessageBubble
      role="assistant"
      content={[
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'foo.ts' } },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'file content\n<system-reminder>\nSecret metadata\n</system-reminder>\nmore',
        },
      ]}
    />
  )
  expect(screen.queryByText(/Secret metadata/)).not.toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/MessageBubble.test.tsx`
Expected: FAIL — system-reminder text is visible

**Step 3: Add stripping utility**

In `src/components/claude-chat/MessageBubble.tsx`, add before the component:

```tsx
/** Strip SDK-injected <system-reminder>...</system-reminder> tags from text. */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}
```

Then update **both** result rendering paths — the paired path (tool_use with matched result) and the standalone orphaned-result path:

```tsx
// In the paired tool_use rendering (from Task 2):
if (block.type === 'tool_use' && block.name) {
  if (!showTools) return null
  const result = block.id ? resultMap.get(block.id) : undefined
  const rawResult = result
    ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
    : undefined
  // Strip system reminders from paired results too
  const resultContent = rawResult ? stripSystemReminders(rawResult) : undefined
  return (
    <ToolBlock
      key={block.id || i}
      name={block.name}
      input={block.input}
      output={resultContent}
      isError={result?.is_error}
      status={result ? 'complete' : 'running'}
    />
  )
}

// In the standalone tool_result rendering:
if (block.type === 'tool_result') {
  if (!showTools) return null
  if (block.tool_use_id && content.some(b => b.type === 'tool_use' && b.id === block.tool_use_id)) {
    return null // already merged into paired tool_use
  }
  const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  const resultContent = stripSystemReminders(raw)
  return (
    <ToolBlock
      key={block.tool_use_id || i}
      name="Result"
      output={resultContent}
      isError={block.is_error}
      status="complete"
    />
  )
}
```

> **Important:** Most tool results flow through the paired path (tool_use + matched tool_result). The stripping MUST apply there too, not just the standalone orphan path.

**Step 4: Run test to verify it passes**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/MessageBubble.test.tsx`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/components/claude-chat/MessageBubble.tsx test/unit/client/components/claude-chat/MessageBubble.test.tsx
git commit -m "feat(freshclaude): strip system-reminder tags from tool results

SDK injects <system-reminder> tags into tool result content. These are
internal metadata not meant for user display. Strip them before rendering
to reduce visual noise."
```

---

## Task 8: Collapsed Turns for Long Conversations

Older turns (user+assistant pairs) collapse into single-line summaries for navigability. Only the N most recent turns show in full.

**Files:**
- Create: `src/components/claude-chat/CollapsedTurn.tsx`
- Create: `test/unit/client/components/claude-chat/CollapsedTurn.test.tsx`
- Modify: `src/components/claude-chat/ClaudeChatView.tsx`

**Step 1: Write test for CollapsedTurn**

Create `test/unit/client/components/claude-chat/CollapsedTurn.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CollapsedTurn from '../../../../../src/components/claude-chat/CollapsedTurn'
import type { ChatMessage } from '@/store/claudeChatTypes'

const userMsg: ChatMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'Fix the authentication bug in login flow' }],
  timestamp: '2026-02-13T10:00:00Z',
}

const assistantMsg: ChatMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'I will fix that.' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'auth.ts' } },
    { type: 'tool_result', tool_use_id: 't1', content: 'done' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_result', tool_use_id: 't2', content: 'all pass' },
    { type: 'text', text: 'Fixed!' },
  ],
  timestamp: '2026-02-13T10:01:00Z',
}

describe('CollapsedTurn', () => {
  afterEach(cleanup)

  it('renders a summary line with truncated user text and block counts', () => {
    render(<CollapsedTurn userMessage={userMsg} assistantMessage={assistantMsg} />)
    // User text truncated to ~40 chars
    expect(screen.getByText(/Fix the authentication/)).toBeInTheDocument()
    // Tool count
    expect(screen.getByText(/2 tools/)).toBeInTheDocument()
  })

  it('starts collapsed', () => {
    render(<CollapsedTurn userMessage={userMsg} assistantMessage={assistantMsg} />)
    expect(screen.getByRole('button', { name: /expand turn/i })).toBeInTheDocument()
  })

  it('expands to show full messages on click', async () => {
    const user = userEvent.setup()
    render(<CollapsedTurn userMessage={userMsg} assistantMessage={assistantMsg} />)
    await user.click(screen.getByRole('button', { name: /expand turn/i }))
    // After expanding, should show the actual message content
    expect(screen.getByText('I will fix that.')).toBeInTheDocument()
    expect(screen.getByText('Fixed!')).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/CollapsedTurn.test.tsx`
Expected: FAIL — module not found

**Step 3: Create CollapsedTurn component**

Create `src/components/claude-chat/CollapsedTurn.tsx`:

```tsx
import { memo, useState, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ChatMessage } from '@/store/claudeChatTypes'
import MessageBubble from './MessageBubble'

interface CollapsedTurnProps {
  userMessage: ChatMessage
  assistantMessage: ChatMessage
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
}

function makeSummary(userMsg: ChatMessage, assistantMsg: ChatMessage): string {
  // Truncate user text
  const userTextBlock = userMsg.content.find(b => b.type === 'text' && b.text)
  let userText = userTextBlock?.text?.trim().replace(/\n/g, ' ') ?? '(no text)'
  if (userText.length > 40) {
    userText = userText.slice(0, 37) + '...'
  }

  // Count assistant blocks
  const toolCount = assistantMsg.content.filter(b => b.type === 'tool_use').length
  const textCount = assistantMsg.content.filter(b => b.type === 'text').length

  const parts: string[] = []
  if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`)
  if (textCount) parts.push(`${textCount} msg${textCount > 1 ? 's' : ''}`)

  const responseSummary = parts.length ? parts.join(', ') : 'empty'
  return `${userText} → ${responseSummary}`
}

function CollapsedTurn({
  userMessage,
  assistantMessage,
  showThinking = true,
  showTools = true,
  showTimecodes = false,
}: CollapsedTurnProps) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(
    () => makeSummary(userMessage, assistantMessage),
    [userMessage, assistantMessage],
  )

  if (expanded) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Collapse turn"
        >
          <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          <span className="font-mono opacity-70">{summary}</span>
        </button>
        <MessageBubble
          role={userMessage.role}
          content={userMessage.content}
          timestamp={userMessage.timestamp}
          showThinking={showThinking}
          showTools={showTools}
          showTimecodes={showTimecodes}
        />
        <MessageBubble
          role={assistantMessage.role}
          content={assistantMessage.content}
          timestamp={assistantMessage.timestamp}
          model={assistantMessage.model}
          showThinking={showThinking}
          showTools={showTools}
          showTimecodes={showTimecodes}
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      aria-label="Expand turn"
    >
      <ChevronRight className="h-3 w-3 shrink-0 transition-transform" />
      <span className="font-mono truncate">{summary}</span>
    </button>
  )
}

export default memo(CollapsedTurn)
```

**Step 4: Run test to verify it passes**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/CollapsedTurn.test.tsx`
Expected: All PASS

**Step 5: Wire into ClaudeChatView**

In `src/components/claude-chat/ClaudeChatView.tsx`, pair messages into turns and collapse old ones.

The pairing algorithm walks messages sequentially, pairing each user message with the immediately following assistant message. This preserves chronological order and handles edge cases (consecutive user messages, orphaned assistant messages) correctly.

```tsx
import CollapsedTurn from './CollapsedTurn'

const RECENT_TURNS_FULL = 3

// Build render items in chronological order.
// Pair adjacent user→assistant messages into turns; everything else is standalone.
type RenderItem =
  | { kind: 'turn'; user: ChatMessage; assistant: ChatMessage }
  | { kind: 'standalone'; message: ChatMessage }

const renderItems: RenderItem[] = []
let mi = 0
while (mi < messages.length) {
  const msg = messages[mi]
  // Try to pair user + immediately following assistant
  if (
    msg.role === 'user' &&
    mi + 1 < messages.length &&
    messages[mi + 1].role === 'assistant'
  ) {
    renderItems.push({ kind: 'turn', user: msg, assistant: messages[mi + 1] })
    mi += 2
  } else {
    renderItems.push({ kind: 'standalone', message: msg })
    mi++
  }
}

// Count turns for collapse threshold
const turnItems = renderItems.filter(r => r.kind === 'turn')
const collapseThreshold = Math.max(0, turnItems.length - RECENT_TURNS_FULL)
let turnIndex = 0

// Render:
{renderItems.map((item, i) => {
  if (item.kind === 'turn') {
    const isOld = turnIndex < collapseThreshold
    turnIndex++
    if (isOld) {
      return (
        <CollapsedTurn
          key={`turn-${i}`}
          userMessage={item.user}
          assistantMessage={item.assistant}
          showThinking={paneContent.showThinking ?? true}
          showTools={paneContent.showTools ?? true}
          showTimecodes={paneContent.showTimecodes ?? false}
        />
      )
    }
    return (
      <React.Fragment key={`turn-${i}`}>
        <MessageBubble role={item.user.role} content={item.user.content}
          timestamp={item.user.timestamp} ... />
        <MessageBubble role={item.assistant.role} content={item.assistant.content}
          timestamp={item.assistant.timestamp} model={item.assistant.model} ... />
      </React.Fragment>
    )
  }
  // Standalone messages (unpaired user waiting for response, orphaned assistant, etc.)
  return (
    <MessageBubble
      key={`msg-${i}`}
      role={item.message.role}
      content={item.message.content}
      timestamp={item.message.timestamp}
      model={item.message.model}
      ...
    />
  )
})}
```

This replaces the flat `messages.map()` with a turn-aware renderer that collapses old turns while preserving strict chronological ordering.

**Step 6: Add ClaudeChatView integration test for turn collapsing**

Add to a new `test/unit/client/components/claude-chat/ClaudeChatView.turns.test.tsx` tests that verify the turn pairing and collapse logic at the view level:

```tsx
it('collapses old turns and shows recent turns in full', () => {
  // Render ClaudeChatView with session containing 5 user+assistant turn pairs
  // Assert: first 2 turns render as CollapsedTurn (expand button visible)
  // Assert: last 3 turns render as full MessageBubbles
})

it('preserves chronological order with consecutive user messages', () => {
  // Session: [user1, user2, assistant1, user3, assistant2]
  // user1 should be standalone (not paired — followed by another user)
  // user2+assistant1 should be paired
  // user3+assistant2 should be paired
  // Assert: messages appear in correct chronological order (user1 before user2)
})

it('renders unpaired trailing user message at correct position', () => {
  // Session: [user1, assistant1, user2] (user2 waiting for response)
  // Assert: user2 renders after the turn, not at top or bottom
})
```

**Step 7: Run all tests**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/`
Expected: All PASS

**Step 8: Commit**

```bash
git add src/components/claude-chat/CollapsedTurn.tsx test/unit/client/components/claude-chat/CollapsedTurn.test.tsx src/components/claude-chat/ClaudeChatView.tsx test/unit/client/components/claude-chat/ClaudeChatView.turns.test.tsx
git commit -m "feat(freshclaude): collapse old turns into summary lines

Group messages into user+assistant turn pairs. Only the 3 most recent
turns show in full; older turns collapse into single-line summaries like
'Fix the auth bug → 2 tools, 1 msg'. Click to expand and see full content.
Uses lazy rendering — collapsed turns don't mount MessageBubble children
until expanded, improving performance for long conversations."
```

---

## Task 9: Color-Coded Diff View for Edit Tool

Render Edit tool results as proper diffs with red/green color coding for removed/added lines. This is the largest task.

**Files:**
- Install: `diff` npm package
- Create: `src/components/claude-chat/DiffView.tsx`
- Create: `test/unit/client/components/claude-chat/DiffView.test.tsx`
- Modify: `src/components/claude-chat/ToolBlock.tsx`

**Step 1: Install diff package**

Run: `npm install diff`

**Step 2: Write test for DiffView**

Create `test/unit/client/components/claude-chat/DiffView.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DiffView from '../../../../../src/components/claude-chat/DiffView'

describe('DiffView', () => {
  afterEach(cleanup)

  it('renders removed and added lines', () => {
    const { container } = render(
      <DiffView oldStr="const foo = 1" newStr="const bar = 1" />
    )
    // Should show removed line with - prefix or red styling
    expect(container.textContent).toContain('foo')
    expect(container.textContent).toContain('bar')
  })

  it('renders with line numbers', () => {
    const { container } = render(
      <DiffView oldStr="line1\nline2\nline3" newStr="line1\nchanged\nline3" />
    )
    expect(container.textContent).toContain('changed')
  })

  it('shows no-changes message when strings are identical', () => {
    render(<DiffView oldStr="same" newStr="same" />)
    expect(screen.getByText(/no changes/i)).toBeInTheDocument()
  })

  it('uses semantic role', () => {
    render(<DiffView oldStr="a" newStr="b" />)
    expect(screen.getByRole('figure', { name: /diff/i })).toBeInTheDocument()
  })
})
```

**Step 3: Run test to verify it fails**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/DiffView.test.tsx`
Expected: FAIL — module not found

**Step 4: Create DiffView component**

Create `src/components/claude-chat/DiffView.tsx`:

```tsx
import { memo, useMemo } from 'react'
import { diffLines } from 'diff'
import { cn } from '@/lib/utils'

interface DiffViewProps {
  oldStr: string
  newStr: string
  filePath?: string
}

function DiffView({ oldStr, newStr, filePath }: DiffViewProps) {
  const hunks = useMemo(() => diffLines(oldStr, newStr), [oldStr, newStr])

  const hasChanges = hunks.some(h => h.added || h.removed)

  if (!hasChanges) {
    return (
      <div role="figure" aria-label="diff view" className="text-xs text-muted-foreground italic py-1">
        No changes detected
      </div>
    )
  }

  // Build line-numbered output
  const lines: Array<{ type: 'added' | 'removed' | 'context'; text: string; lineNo: string }> = []
  let oldLine = 1
  let newLine = 1

  for (const hunk of hunks) {
    const hunkLines = hunk.value.replace(/\n$/, '').split('\n')
    for (const line of hunkLines) {
      if (hunk.removed) {
        lines.push({ type: 'removed', text: line, lineNo: String(oldLine++) })
      } else if (hunk.added) {
        lines.push({ type: 'added', text: line, lineNo: String(newLine++) })
      } else {
        lines.push({ type: 'context', text: line, lineNo: String(newLine) })
        oldLine++
        newLine++
      }
    }
  }

  return (
    <div role="figure" aria-label="diff view" className="text-xs font-mono overflow-x-auto">
      {filePath && (
        <div className="text-muted-foreground px-2 py-0.5 border-b border-border/50 text-2xs">
          {filePath}
        </div>
      )}
      <div className="leading-relaxed">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'flex px-1',
              line.type === 'removed' && 'bg-red-500/10 text-red-400',
              line.type === 'added' && 'bg-green-500/10 text-green-400',
              line.type === 'context' && 'text-muted-foreground',
            )}
          >
            <span className="w-8 shrink-0 text-right pr-2 select-none opacity-50">
              {line.lineNo}
            </span>
            <span className="shrink-0 w-4 select-none">
              {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(DiffView)
```

**Step 5: Run test to verify it passes**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/DiffView.test.tsx`
Expected: All PASS

**Step 6: Wire DiffView into ToolBlock for Edit results**

In `src/components/claude-chat/ToolBlock.tsx`, when `name === 'Edit'` and the tool has `old_string`/`new_string` in input, render a `DiffView` inside the expanded content instead of raw JSON:

```tsx
import DiffView from './DiffView'

// Inside the expanded content section:
{expanded && (
  <div className="px-2 py-1.5 border-t border-border/50 text-xs">
    {name === 'Edit' && input &&
      typeof input.old_string === 'string' &&
      typeof input.new_string === 'string' ? (
      <DiffView
        oldStr={input.old_string}
        newStr={input.new_string}
        filePath={typeof input.file_path === 'string' ? input.file_path : undefined}
      />
    ) : (
      <>
        {input && (
          <pre className="whitespace-pre-wrap font-mono opacity-80 max-h-48 overflow-y-auto">
            {name === 'Bash' && typeof input.command === 'string'
              ? input.command
              : JSON.stringify(input, null, 2)}
          </pre>
        )}
        {output && (
          <pre className={cn(
            'whitespace-pre-wrap font-mono max-h-48 overflow-y-auto mt-1',
            isError ? 'text-red-500' : 'opacity-80'
          )}>
            {output}
          </pre>
        )}
      </>
    )}
  </div>
)}
```

**Step 7: Run all tests**

Run: `npm run test:client -- --run test/unit/client/components/claude-chat/`
Expected: All PASS

**Step 8: Commit**

```bash
git add package.json package-lock.json src/components/claude-chat/DiffView.tsx test/unit/client/components/claude-chat/DiffView.test.tsx src/components/claude-chat/ToolBlock.tsx
git commit -m "feat(freshclaude): color-coded diff view for Edit tool results

Add DiffView component that renders Edit tool old_string/new_string as
a proper line diff with:
- Red/green color coding for removed/added lines
- Line numbers in a dimmed gutter
- File path header when available
- 'No changes' message for identical strings
Uses the 'diff' npm package for reliable diff computation.

Edit tool blocks now show the diff inline when expanded, replacing
raw JSON display of old_string/new_string."
```

---

## Task 10: Final Integration, E2E Tests, and Cleanup

Run full test suite, add e2e coverage, verify build, update docs/index.html.

**Step 1: Run full test suite**

Run: `npm test`
Expected: All PASS

**Step 2: Verify build**

Run: `npm run verify`
Expected: Clean build + all tests pass

**Step 3: Run lint**

Run: `npm run lint`
Expected: No a11y violations

**Step 4: Add e2e test coverage**

Per project rules (AGENTS.md: "We ensure both unit test & e2e coverage of everything"), add browser-use e2e tests covering:

- Left-border message layout renders correctly (user=orange, assistant=blue borders)
- Tool block expand/collapse interaction (click to expand, shows content, click again to collapse)
- Auto-collapse: old tools start collapsed, recent tools in default state
- Collapsed turn summary: old turns show summary line, click expands full messages
- Thinking indicator: appears when Claude is processing, disappears when content arrives
- Diff view: Edit tool expanded view shows red/green color-coded diff
- System reminder stripping: `<system-reminder>` tags not visible in rendered output

Use the `browser-use-testing` skill for writing intent-based test instructions.

**Step 5: Update docs/index.html**

If the docs mock references the freshclaude chat UI, update it to reflect the new visual style (left borders instead of chat bubbles, collapsed turns, diff views).

**Step 6: Final commit**

```bash
git add -A
git commit -m "chore(freshclaude): final integration, e2e tests, and cleanup

Add e2e test coverage for all freshclaude polish features.
Ensure all tests pass, build is clean, lint has no violations.
Update docs mock if applicable."
```

---

## Summary

| Task | Feature | New Files | Modified Files |
|------|---------|-----------|----------------|
| 1 | CSS color variables | — | `src/index.css` |
| 2 | Left-border message layout + tool_use/result pairing | — | `MessageBubble.tsx` + test |
| 3 | Smart tool headers + summaries | — | `ToolBlock.tsx` + test |
| 4 | Auto-expand recent / collapse old tools | 1 test | `ToolBlock.tsx`, `MessageBubble.tsx`, `ClaudeChatView.tsx` |
| 5 | Thinking indicator (with flash prevention) | `ThinkingIndicator.tsx` + test | `ClaudeChatView.tsx` |
| 6 | Streaming debounce + memoized content | `useStreamDebounce.ts` + test | `ClaudeChatView.tsx` |
| 7 | System reminder stripping | — | `MessageBubble.tsx` + test |
| 8 | Collapsed turns (sequential pairing) | `CollapsedTurn.tsx` + test | `ClaudeChatView.tsx` |
| 9 | Color-coded diff view for Edit tool | `DiffView.tsx` + test, `diff` pkg | `ToolBlock.tsx` |
| 10 | Integration, e2e tests & cleanup | e2e tests | Various |
