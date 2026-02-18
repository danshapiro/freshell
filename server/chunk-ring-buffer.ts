export class ChunkRingBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private maxChars: number) {}

  private trimToMax() {
    const max = this.maxChars
    if (max <= 0) {
      this.clear()
      return
    }
    while (this.size > max && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.size -= removed.length
    }
    // If a single chunk is enormous, truncate it.
    if (this.size > max && this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks[0] = only.slice(-max)
      this.size = this.chunks[0].length
    }
  }

  append(chunk: string) {
    if (!chunk) return
    this.chunks.push(chunk)
    this.size += chunk.length
    this.trimToMax()
  }

  setMaxChars(next: number) {
    this.maxChars = Math.max(0, next)
    this.trimToMax()
  }

  snapshot(): string {
    return this.chunks.join('')
  }

  clear() {
    this.chunks = []
    this.size = 0
  }
}
