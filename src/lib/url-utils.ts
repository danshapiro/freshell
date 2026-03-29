export type UrlMatch = {
  url: string
  startIndex: number
  endIndex: number
}

export function findUrls(line: string): UrlMatch[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g
  const results: UrlMatch[] = []
  let match
  while ((match = urlRegex.exec(line)) !== null) {
    let url = match[0]
    // Trim trailing punctuation that's likely not part of the URL
    const trailingPunct = /[.,;:!?)]+$/
    const trailingMatch = trailingPunct.exec(url)
    const endTrim = trailingMatch ? trailingMatch[0].length : 0
    url = url.slice(0, url.length - endTrim)
    results.push({
      url,
      startIndex: match.index,
      endIndex: match.index + url.length,
    })
  }
  return results
}
