import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownPreview from '../../../../../src/components/panes/MarkdownPreview'

describe('MarkdownPreview', () => {
  it('renders markdown as HTML', () => {
    render(<MarkdownPreview content="# Hello World" />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
  })

  it('renders links', () => {
    render(<MarkdownPreview content="[Click here](https://example.com)" />)

    const link = screen.getByRole('link', { name: /click here/i })
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  it('renders code blocks', () => {
    render(
      <MarkdownPreview
        content={`\`\`\`js
const x = 1
\`\`\``}
      />
    )

    expect(screen.getByText('const x = 1')).toBeInTheDocument()
  })

  it('renders GFM tables', () => {
    render(
      <MarkdownPreview
        content={`
| A | B |
|---|---|
| 1 | 2 |
`}
      />
    )

    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  describe('XSS sanitization', () => {
    it('strips script tags from markdown content', () => {
      const { container } = render(
        <MarkdownPreview content='<script>alert("xss")</script>' language="md" />
      )
      expect(container.querySelector('script')).toBeNull()
    })

    it('strips event handler attributes from HTML in markdown', () => {
      const { container } = render(
        <MarkdownPreview content='<img src=x onerror=alert(1)>' language="md" />
      )
      expect(container.querySelector('img[onerror]')).toBeNull()
    })

    it('strips iframe tags from markdown content', () => {
      const { container } = render(
        <MarkdownPreview content='<iframe src="https://evil.com"></iframe>' language="md" />
      )
      expect(container.querySelector('iframe')).toBeNull()
    })

    it('renders javascript: protocol links safely', () => {
      const { container } = render(
        <MarkdownPreview content='[click me](javascript:alert(1))' language="md" />
      )
      const link = container.querySelector('a')
      // react-markdown should either strip the link or neutralize the protocol
      if (link) {
        expect(link.getAttribute('href')).not.toContain('javascript:')
      }
    })
  })
})
