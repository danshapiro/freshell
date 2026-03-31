// Detects http/https URLs in terminal output text with balanced-paren handling.


export type UrlMatch = {
  url: string
  startIndex: number
  endIndex: number
}

export function findUrls(line: string): UrlMatch[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g
  const results: UrlMatch[] = []
  let match
  while ((match = urlRegex.exec(line)) !== null) {
    let url = match[0]
    // Trim trailing punctuation that's likely not part of the URL.
    // Preserve balanced parentheses (e.g. Wikipedia URLs like
    // https://en.wikipedia.org/wiki/Foo_(bar) ).
    const trailingPunct = /[.,;:!?)]+$/
    const trailingMatch = trailingPunct.exec(url)
    if (trailingMatch) {
      let trimmed = trailingMatch[0]
      // Walk backwards through the trailing punctuation. For each
      // closing paren, keep it if the URL body has a matching open
      // paren; otherwise strip it along with everything after it.
      let keep = ''
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === ')') {
          // Count parens in the URL prefix (before the trailing chunk)
          // plus any trailing chars we've already decided to keep.
          const prefix = url.slice(0, url.length - trimmed.length) + keep
          const opens = prefix.split('(').length - 1
          const closes = prefix.split(')').length - 1
          if (opens > closes) {
            keep += trimmed[i]
            continue
          }
        }
        // Non-paren trailing punct or unbalanced paren: strip from here
        break
      }
      url = url.slice(0, url.length - trimmed.length) + keep
    }
    results.push({
      url,
      startIndex: match.index,
      endIndex: match.index + url.length,
    })
  }
  return results
}
