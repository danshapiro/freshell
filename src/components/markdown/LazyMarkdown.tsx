import { lazy, Suspense, type ReactNode } from 'react'
import { withChunkErrorRecovery } from '@/lib/import-retry'

const MarkdownRenderer = lazy(() =>
  withChunkErrorRecovery(import('./MarkdownRenderer')).then((module) => ({ default: module.MarkdownRenderer }))
)

type LazyMarkdownProps = {
  content: string
  fallback?: ReactNode
}

export function LazyMarkdown({ content, fallback = null }: LazyMarkdownProps) {
  return (
    <Suspense fallback={fallback}>
      <MarkdownRenderer content={content} />
    </Suspense>
  )
}
