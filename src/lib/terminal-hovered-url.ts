const hoveredUrls = new Map<string, string>()

export function setHoveredUrl(paneId: string, url: string): void {
  hoveredUrls.set(paneId, url)
}

export function clearHoveredUrl(paneId: string): void {
  hoveredUrls.delete(paneId)
}

export function getHoveredUrl(paneId: string): string | undefined {
  return hoveredUrls.get(paneId)
}
