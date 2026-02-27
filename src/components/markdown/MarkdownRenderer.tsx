import { useState, useCallback, useRef, useEffect, type ReactNode, type ReactElement, isValidElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, Check, ExternalLink } from 'lucide-react'

type MarkdownRendererProps = {
  content: string
}

/**
 * Extract the language string from a code element's className.
 * react-markdown v9 sets className="language-xxx" on the <code> inside <pre>.
 */
function extractLanguage(codeElement: ReactElement): string | null {
  const className = codeElement.props?.className as string | undefined
  if (!className) return null
  const match = className.match(/language-(\S+)/)
  return match ? match[1] : null
}

/**
 * Extract the text content from a code element's children.
 */
function extractCode(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractCode).join('')
  if (isValidElement(children) && children.props?.children) {
    return extractCode(children.props.children as ReactNode)
  }
  return ''
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(code)
      if (timerRef.current) clearTimeout(timerRef.current)
      setCopied(true)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Permission denied or other clipboard error
    }
  }, [code])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      aria-label="Copy code"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5" />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          <span>Copy</span>
        </>
      )}
    </button>
  )
}

/**
 * Custom <pre> wrapper for fenced code blocks.
 * Adds a header bar with language label and copy button.
 */
function PreBlock({ children, ...props }: React.ComponentProps<'pre'>) {
  // Check if this pre wraps a <code> with a language class (fenced code block)
  const codeChild = isValidElement(children) && (children as ReactElement).type === 'code'
    ? (children as ReactElement)
    : null

  if (!codeChild) {
    return <pre {...props}>{children}</pre>
  }

  const language = extractLanguage(codeChild)
  const codeText = extractCode(codeChild.props?.children as ReactNode)
  const normalizedCode = codeText.replace(/\n$/, '')

  return (
    <div className="rounded-md border border-border overflow-hidden my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
        <span className="text-xs text-muted-foreground font-mono">
          {language ?? ''}
        </span>
        <CopyButton code={normalizedCode} />
      </div>
      <SyntaxHighlighter
        language={language ?? 'text'}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: 0, border: 'none' }}
        showLineNumbers={false}
      >
        {normalizedCode}
      </SyntaxHighlighter>
    </div>
  )
}

/**
 * Custom <a> component that opens links in a new tab with an external link icon.
 */
function ExternalAnchor({ children, ...props }: React.ComponentProps<'a'>) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink className="inline-block h-3 w-3 ml-0.5 align-baseline" aria-hidden />
    </a>
  )
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: PreBlock,
        a: ExternalAnchor,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
