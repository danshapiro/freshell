import { copyText } from '@/lib/clipboard'

export async function copyAgentChatCodeBlock(el: HTMLElement | null) {
  const text = el?.textContent?.trim()
  if (text) await copyText(text)
}

export async function copyAgentChatToolInput(el: HTMLElement | null) {
  const text = el?.textContent?.trim()
  if (text) await copyText(text)
}

export async function copyAgentChatToolOutput(el: HTMLElement | null) {
  const text = el?.textContent?.trim()
  if (text) await copyText(text)
}

/**
 * Extract lines from the DiffView DOM by class inspection.
 *
 * DiffView.tsx renders:
 *   <div data-diff data-file-path={filePath}>
 *     <div className="leading-relaxed">
 *       <div className="flex px-1 bg-green-500/10 ...">  <!-- added -->
 *         <span>lineNo</span>
 *         <span>prefix</span>
 *         <span className="whitespace-pre">text</span>
 *       </div>
 *       <div className="flex px-1 bg-red-500/10 ...">    <!-- removed -->
 *         ...
 *       </div>
 *       <div className="flex px-1 text-muted-foreground"> <!-- context -->
 *         ...
 *       </div>
 *     </div>
 *   </div>
 *
 * Added lines have a class containing 'bg-green', removed have 'bg-red'.
 * Context lines have neither.
 */
function extractDiffLines(el: HTMLElement, include: 'new' | 'old'): string {
  const lines: string[] = []
  const divs = el.querySelectorAll('.leading-relaxed > div')
  for (const div of divs) {
    const isAdded = div.className.includes('bg-green')
    const isRemoved = div.className.includes('bg-red')
    const textSpan = div.querySelector('.whitespace-pre')
    const text = textSpan?.textContent ?? ''

    if (include === 'new') {
      // New version: context lines + added lines (skip removed)
      if (!isRemoved) lines.push(text)
    } else {
      // Old version: context lines + removed lines (skip added)
      if (!isAdded) lines.push(text)
    }
  }
  return lines.join('\n')
}

export async function copyAgentChatDiffNew(el: HTMLElement | null) {
  if (!el) return
  const text = extractDiffLines(el, 'new')
  if (text) await copyText(text)
}

export async function copyAgentChatDiffOld(el: HTMLElement | null) {
  if (!el) return
  const text = extractDiffLines(el, 'old')
  if (text) await copyText(text)
}

export async function copyAgentChatFilePath(el: HTMLElement | null) {
  const path = el?.getAttribute('data-file-path')
  if (path) await copyText(path)
}
