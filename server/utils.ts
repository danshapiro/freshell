/** Normalize nullable string overrides: null/empty/whitespace → undefined */
export const cleanString = (value: string | null | undefined): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : value
  return trimmed ? trimmed : undefined
}
