// Renders the Rust claude snapshots built from REAL transcripts of the pinned
// Claude CLI 2.1.237 (test/fixtures/fresh-agent/claude/real-cli-2.1.237/*/
// snapshot.golden.json, pinned to the Rust builder by
// crates/freshell-freshagent/src/claude_snapshot_real_cli_tests.rs) through the
// existing transcript and diff-panel renderers: every projected kind must
// render with no new client code and no stray rows.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'
import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'
import { FreshAgentSnapshotSchema, type FreshAgentSnapshot } from '@shared/fresh-agent-contract'

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

const root = path.join(__dirname, '../../../../fixtures/fresh-agent/claude/real-cli-2.1.237')

function golden(scenario: string): FreshAgentSnapshot {
  return FreshAgentSnapshotSchema.parse(
    JSON.parse(fs.readFileSync(path.join(root, scenario, 'snapshot.golden.json'), 'utf-8')),
  )
}

function renderTranscript(scenario: string) {
  return render(<FreshAgentTranscript turns={golden(scenario).turns} />)
}

function expandAllActivity() {
  for (const toggle of screen.queryAllByRole('button', { name: 'Toggle activity details' })) {
    fireEvent.click(toggle)
  }
}

describe('claude real-CLI snapshots render through the existing transcript', () => {
  afterEach(() => cleanup())

  it('a synchronous subagent renders one delegation block with its activity and result, and no orphan Result row', () => {
    renderTranscript('tools-sync')
    expandAllActivity()
    const blocks = screen.getAllByTestId('fresh-agent-delegation-block')
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    expect(block).toHaveAttribute('data-status', 'completed')
    expect(within(block).getByText('General-purpose Task — check file')).toBeInTheDocument()
    const rows = within(block).getAllByTestId('fresh-agent-delegation-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('↳Read/fixture/ws/a.txt')
    expect(within(block).getByTestId('fresh-agent-delegation-result')).toHaveTextContent('SUBAGENT-DONE: file has two')
    // The delegation's tool result was absorbed server-side: no unpaired
    // tool_result renders as a stray "Result" row.
    expect(screen.queryByLabelText('Result tool call')).not.toBeInTheDocument()
    // The ordinary tools still render as tool rows.
    expect(screen.getAllByLabelText('Edit tool call')).toHaveLength(3)
    expect(screen.getByText('All done.')).toBeInTheDocument()
  })

  it('a background subagent renders as a background delegation and its notification never shows as a prompt', () => {
    renderTranscript('agent-async')
    expandAllActivity()
    const block = screen.getByTestId('fresh-agent-delegation-block')
    expect(within(block).getByText('General-purpose Task (background) — check file')).toBeInTheDocument()
    expect(within(block).getByTestId('fresh-agent-delegation-result')).toHaveTextContent('SUBAGENT-DONE: file has two')
    expect(screen.queryByText(/task-notification/)).not.toBeInTheDocument()
    expect(screen.getByText('The background check finished.')).toBeInTheDocument()
  })

  it('a failed subagent renders a failed delegation with the error text', () => {
    renderTranscript('agent-failed')
    expandAllActivity()
    const block = screen.getByTestId('fresh-agent-delegation-block')
    expect(block).toHaveAttribute('data-status', 'failed')
    expect(within(block).getByTestId('fresh-agent-delegation-result')).toHaveTextContent("Agent type 'no-such-agent-type' not found")
  })

  it('compaction renders the compaction card, the typed slash commands, and command output as markdown system rows', () => {
    renderTranscript('compact-ok')
    expect(screen.getAllByText('Context compaction')).toHaveLength(1)
    expect(screen.getByText('/compact keep it short')).toBeInTheDocument()
    expect(screen.getByText('/usage')).toBeInTheDocument()
    expect(screen.getByText('/context')).toBeInTheDocument()
    expect(screen.getByText(/Total cost:/)).toBeInTheDocument()
    // /context output is markdown: its category table renders as a table.
    const contextTable = screen.getAllByRole('table')
      .find((table) => within(table).queryByText('Category') !== null)
    expect(contextTable).toBeDefined()
    expect(screen.getAllByLabelText('System transcript turn').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText(/local-command/)).not.toBeInTheDocument()
    expect(screen.queryByText(/This session is being continued/)).not.toBeInTheDocument()
  })

  it('a failed compaction renders the command error module once', () => {
    renderTranscript('compact-fail')
    const module = screen.getByTestId('fresh-agent-turn-error')
    expect(module).toHaveTextContent('Error during compaction: API Error: 400 compaction refused by fake')
    expect(screen.getAllByText(/compaction refused by fake/)).toHaveLength(1)
    expect(screen.queryByText('Context compaction')).not.toBeInTheDocument()
  })

  it('an API error renders the durable error module once', () => {
    renderTranscript('api-error')
    const module = screen.getByTestId('fresh-agent-turn-error')
    expect(module).toHaveTextContent('API Error: 400 fixture bad request')
    expect(screen.getAllByText(/fixture bad request/)).toHaveLength(1)
  })

  it('image attachments render as placeholders', () => {
    renderTranscript('image')
    expect(screen.getByText('what is this')).toBeInTheDocument()
    expect(screen.getByText('[image]')).toBeInTheDocument()
  })

  it('a message the CLI re-appended during a compaction renders once', () => {
    renderTranscript('compact-ok')
    expect(screen.getAllByText('reply 3')).toHaveLength(1)
  })
})

describe('claude real-CLI snapshots feed the diff panel', () => {
  afterEach(() => cleanup())

  it('lists each changed file with its created or +added −removed status', () => {
    const snapshot = golden('tools-sync')
    expect(snapshot.capabilities.diffs).toBe(true)
    render(<FreshAgentDiffPanel diffs={snapshot.diffs} cwd="/fixture/ws" />)
    const created = screen.getByRole('button', { name: 'Diff: /fixture/ws/a.txt' })
    expect(created).toHaveTextContent('created')
    const edited = screen.getByRole('button', { name: 'Diff: /fixture/ws/b.txt' })
    expect(edited).toHaveTextContent('+1 −0')
  })

  it('shows no panel for a session that changed no files', () => {
    const snapshot = golden('compact-ok')
    expect(snapshot.capabilities.diffs).toBe(false)
    const { container } = render(<FreshAgentDiffPanel diffs={snapshot.diffs} cwd="/fixture/ws" />)
    expect(container).toBeEmptyDOMElement()
  })
})
