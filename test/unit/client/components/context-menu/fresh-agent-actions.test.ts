import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  copyFreshAgentCodeBlock,
  copyFreshAgentToolInput,
  copyFreshAgentToolOutput,
  copyFreshAgentDiffNew,
  copyFreshAgentDiffOld,
  copyFreshAgentFilePath,
} from '@/components/context-menu/fresh-agent-copy'

// These tests verify the copy logic in fresh-agent-copy.ts.
// We test the extraction functions directly since the full Provider render
// is expensive and already covered by e2e tests.
//
// navigator.clipboard is mocked globally by test/setup/dom.ts, so we just
// clear the mock between tests.

describe('fresh-agent copy helpers', () => {
  beforeEach(() => {
    vi.mocked(navigator.clipboard.writeText).mockClear()
  })

  it('copyFreshAgentCodeBlock copies the code element textContent', async () => {
    const code = document.createElement('code')
    code.textContent = 'const x = 1'
    await copyFreshAgentCodeBlock(code)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('copyFreshAgentCodeBlock is a no-op when el is null', async () => {
    await copyFreshAgentCodeBlock(null)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('copyFreshAgentToolInput copies the pre textContent', async () => {
    const pre = document.createElement('pre')
    pre.textContent = 'echo hello'
    await copyFreshAgentToolInput(pre)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('echo hello')
  })

  it('copyFreshAgentToolOutput copies the pre textContent', async () => {
    const pre = document.createElement('pre')
    pre.textContent = 'file1\nfile2'
    await copyFreshAgentToolOutput(pre)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('file1\nfile2')
  })

  it('copyFreshAgentDiffNew extracts only added and context lines', async () => {
    // Build DOM matching DiffView.tsx: outer div > .leading-relaxed > line divs
    const diff = document.createElement('div')
    const wrapper = document.createElement('div')
    wrapper.className = 'leading-relaxed'
    diff.appendChild(wrapper)

    // Added line (bg-green-500/10)
    const addedLine = document.createElement('div')
    addedLine.className = 'flex px-1 bg-green-500/10 text-green-400'
    const addedLineNo = document.createElement('span')
    addedLineNo.className = 'w-8 shrink-0 text-right pr-2 select-none opacity-50'
    addedLineNo.textContent = '1'
    const addedPrefix = document.createElement('span')
    addedPrefix.className = 'shrink-0 w-4 select-none'
    addedPrefix.textContent = '+'
    const addedText = document.createElement('span')
    addedText.className = 'whitespace-pre'
    addedText.textContent = 'new line'
    addedLine.appendChild(addedLineNo)
    addedLine.appendChild(addedPrefix)
    addedLine.appendChild(addedText)
    wrapper.appendChild(addedLine)

    // Context line (no bg-green or bg-red)
    const contextLine = document.createElement('div')
    contextLine.className = 'flex px-1 text-muted-foreground'
    const ctxLineNo = document.createElement('span')
    ctxLineNo.className = 'w-8 shrink-0 text-right pr-2 select-none opacity-50'
    ctxLineNo.textContent = '2'
    const ctxPrefix = document.createElement('span')
    ctxPrefix.className = 'shrink-0 w-4 select-none'
    ctxPrefix.textContent = ' '
    const ctxText = document.createElement('span')
    ctxText.className = 'whitespace-pre'
    ctxText.textContent = 'unchanged'
    contextLine.appendChild(ctxLineNo)
    contextLine.appendChild(ctxPrefix)
    contextLine.appendChild(ctxText)
    wrapper.appendChild(contextLine)

    await copyFreshAgentDiffNew(diff)
    // New version = added lines + context lines (skip removed)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('new line\nunchanged')
  })

  it('copyFreshAgentDiffOld extracts only removed and context lines', async () => {
    const diff = document.createElement('div')
    const wrapper = document.createElement('div')
    wrapper.className = 'leading-relaxed'
    diff.appendChild(wrapper)

    // Removed line (bg-red-500/10)
    const removedLine = document.createElement('div')
    removedLine.className = 'flex px-1 bg-red-500/10 text-red-400'
    const rmLineNo = document.createElement('span')
    rmLineNo.className = 'w-8 shrink-0 text-right pr-2 select-none opacity-50'
    rmLineNo.textContent = '1'
    const rmPrefix = document.createElement('span')
    rmPrefix.className = 'shrink-0 w-4 select-none'
    rmPrefix.textContent = '-'
    const rmText = document.createElement('span')
    rmText.className = 'whitespace-pre'
    rmText.textContent = 'old line'
    removedLine.appendChild(rmLineNo)
    removedLine.appendChild(rmPrefix)
    removedLine.appendChild(rmText)
    wrapper.appendChild(removedLine)

    // Context line
    const contextLine = document.createElement('div')
    contextLine.className = 'flex px-1 text-muted-foreground'
    const ctxLineNo = document.createElement('span')
    ctxLineNo.className = 'w-8 shrink-0 text-right pr-2 select-none opacity-50'
    ctxLineNo.textContent = '2'
    const ctxPrefix = document.createElement('span')
    ctxPrefix.className = 'shrink-0 w-4 select-none'
    ctxPrefix.textContent = ' '
    const ctxText = document.createElement('span')
    ctxText.className = 'whitespace-pre'
    ctxText.textContent = 'unchanged'
    contextLine.appendChild(ctxLineNo)
    contextLine.appendChild(ctxPrefix)
    contextLine.appendChild(ctxText)
    wrapper.appendChild(contextLine)

    await copyFreshAgentDiffOld(diff)
    // Old version = removed lines + context lines (skip added)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('old line\nunchanged')
  })

  it('copyFreshAgentDiffNew skips removed lines', async () => {
    const diff = document.createElement('div')
    const wrapper = document.createElement('div')
    wrapper.className = 'leading-relaxed'
    diff.appendChild(wrapper)

    // Removed line - should be skipped for "new"
    const removedLine = document.createElement('div')
    removedLine.className = 'flex px-1 bg-red-500/10 text-red-400'
    const rmText = document.createElement('span')
    rmText.className = 'whitespace-pre'
    rmText.textContent = 'deleted'
    removedLine.appendChild(document.createElement('span'))
    removedLine.appendChild(document.createElement('span'))
    removedLine.appendChild(rmText)
    wrapper.appendChild(removedLine)

    // Added line - should be included
    const addedLine = document.createElement('div')
    addedLine.className = 'flex px-1 bg-green-500/10 text-green-400'
    const addText = document.createElement('span')
    addText.className = 'whitespace-pre'
    addText.textContent = 'inserted'
    addedLine.appendChild(document.createElement('span'))
    addedLine.appendChild(document.createElement('span'))
    addedLine.appendChild(addText)
    wrapper.appendChild(addedLine)

    await copyFreshAgentDiffNew(diff)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('inserted')
  })

  it('copyFreshAgentDiffOld skips added lines', async () => {
    const diff = document.createElement('div')
    const wrapper = document.createElement('div')
    wrapper.className = 'leading-relaxed'
    diff.appendChild(wrapper)

    // Added line - should be skipped for "old"
    const addedLine = document.createElement('div')
    addedLine.className = 'flex px-1 bg-green-500/10 text-green-400'
    const addText = document.createElement('span')
    addText.className = 'whitespace-pre'
    addText.textContent = 'inserted'
    addedLine.appendChild(document.createElement('span'))
    addedLine.appendChild(document.createElement('span'))
    addedLine.appendChild(addText)
    wrapper.appendChild(addedLine)

    // Removed line - should be included
    const removedLine = document.createElement('div')
    removedLine.className = 'flex px-1 bg-red-500/10 text-red-400'
    const rmText = document.createElement('span')
    rmText.className = 'whitespace-pre'
    rmText.textContent = 'deleted'
    removedLine.appendChild(document.createElement('span'))
    removedLine.appendChild(document.createElement('span'))
    removedLine.appendChild(rmText)
    wrapper.appendChild(removedLine)

    await copyFreshAgentDiffOld(diff)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('deleted')
  })

  it('copyFreshAgentFilePath copies data-file-path attribute', async () => {
    const diff = document.createElement('div')
    diff.setAttribute('data-file-path', '/tmp/test.ts')
    await copyFreshAgentFilePath(diff)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/test.ts')
  })

  it('copyFreshAgentFilePath is a no-op when data-file-path is missing', async () => {
    const diff = document.createElement('div')
    await copyFreshAgentFilePath(diff)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('copyFreshAgentDiffNew is a no-op when el is null', async () => {
    await copyFreshAgentDiffNew(null)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('copyFreshAgentDiffOld is a no-op when el is null', async () => {
    await copyFreshAgentDiffOld(null)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })
})
