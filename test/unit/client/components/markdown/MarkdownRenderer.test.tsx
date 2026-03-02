import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(true),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MarkdownRenderer', () => {
  describe('fenced code blocks', () => {
    it('renders a language label for fenced code blocks', async () => {
      render(
        <MarkdownRenderer
          content={`\`\`\`javascript
const x = 1
\`\`\``}
        />
      )
      expect(await screen.findByText('javascript')).toBeInTheDocument()
    })

    it('renders a copy button for fenced code blocks', async () => {
      render(
        <MarkdownRenderer
          content={`\`\`\`python
print("hello")
\`\`\``}
        />
      )
      expect(
        await screen.findByRole('button', { name: /copy code/i })
      ).toBeInTheDocument()
    })

    it('copies code to clipboard on copy button click', async () => {
      const user = userEvent.setup()
      render(
        <MarkdownRenderer
          content={`\`\`\`bash
echo hello
\`\`\``}
        />
      )
      const copyBtn = await screen.findByRole('button', { name: /copy code/i })
      await user.click(copyBtn)
      // Verify copy succeeded via the "Copied!" feedback state change.
      // The module-level vi.mock for @/lib/clipboard resolves copyText to true.
      await screen.findByText('Copied!')
    })

    it('copies code without trailing newline (no accidental shell execution)', async () => {
      const { copyText } = await import('@/lib/clipboard')
      const spy = vi.mocked(copyText)
      spy.mockResolvedValue(true)

      const user = userEvent.setup()
      render(
        <MarkdownRenderer
          content={`\`\`\`bash
echo hello
\`\`\``}
        />
      )
      const copyBtn = await screen.findByRole('button', { name: /copy code/i })
      await user.click(copyBtn)
      await screen.findByText('Copied!')
      expect(spy).toHaveBeenCalledWith('echo hello')
    })

    it('shows "Copied!" feedback after clicking copy', async () => {
      const user = userEvent.setup()
      render(
        <MarkdownRenderer
          content={`\`\`\`ts
const y = 2
\`\`\``}
        />
      )
      const copyBtn = await screen.findByRole('button', { name: /copy code/i })
      await user.click(copyBtn)
      expect(await screen.findByText('Copied!')).toBeInTheDocument()
    })

    it('does not render header for inline code', () => {
      render(<MarkdownRenderer content="Use `npm install` to install" />)
      expect(screen.getByText(/npm install/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /copy code/i })).not.toBeInTheDocument()
    })

    it('delegates clipboard writes to the shared copyText utility', async () => {
      const { copyText } = await import('@/lib/clipboard')
      const spy = vi.mocked(copyText)
      spy.mockResolvedValue(true)

      const user = userEvent.setup()
      render(
        <MarkdownRenderer
          content={`\`\`\`bash
echo fallback
\`\`\``}
        />
      )
      const copyBtn = await screen.findByRole('button', { name: /copy code/i })
      await user.click(copyBtn)
      await screen.findByText('Copied!')
      expect(spy).toHaveBeenCalledWith('echo fallback')
    })

    it('renders code block without language gracefully', async () => {
      render(
        <MarkdownRenderer
          content={`\`\`\`
some code
\`\`\``}
        />
      )
      // Should still have a copy button even without language label
      expect(
        await screen.findByRole('button', { name: /copy code/i })
      ).toBeInTheDocument()
    })
  })

  describe('links', () => {
    it('opens links in a new tab', async () => {
      render(
        <MarkdownRenderer content="Visit [Example](https://example.com) for more" />
      )
      const link = await screen.findByRole('link', { name: /example/i })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('renders an external link icon next to link text', async () => {
      render(
        <MarkdownRenderer content="See [docs](https://docs.example.com)" />
      )
      const link = await screen.findByRole('link', { name: /docs/i })
      // lucide-react ExternalLink renders an SVG inside the anchor
      const svg = link.querySelector('svg')
      expect(svg).toBeInTheDocument()
    })
  })
})
