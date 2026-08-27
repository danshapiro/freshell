// Client and server extension panes need Node lifecycle and asset endpoints.

import { useAppSelector } from '@/store/hooks'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import type { ExtensionPaneContent } from '@/store/paneTypes'
import ExtensionError from './ExtensionError'
import { RUST_BASELINE_UNAVAILABLE } from '@/lib/rust-baseline-unavailable'

interface ExtensionPaneProps {
  tabId: string
  paneId: string
  content: ExtensionPaneContent
}

export default function ExtensionPane({ content }: ExtensionPaneProps) {
  useEnsureExtensionsRegistry()

  const extension = useAppSelector((s) =>
    s.extensions.entries.find((e) => e.name === content.extensionName),
  )

  if (!extension) {
    return <ExtensionError name={content.extensionName} />
  }

  if (extension.category === 'server' || extension.category === 'client') {
    return (
      <section className="flex h-full items-center justify-center p-4 text-center" aria-label="Unsupported extension pane" role="status">
        <div><strong>{extension.label}</strong><p>{RUST_BASELINE_UNAVAILABLE.extension}</p></div>
      </section>
    )
  }

  return <ExtensionError name={content.extensionName} message={`CLI extension "${content.extensionName}" cannot be rendered as an iframe pane.`} />
}
