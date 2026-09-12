import { describe, expect, it } from 'vitest'

import { extractTitleFromMessage } from '../../../shared/title-utils.js'

describe('extractTitleFromMessage', () => {
  it('returns content unchanged if shorter than maxLen', () => {
    expect(extractTitleFromMessage('Hello world', 50)).toBe('Hello world')
  })

  it('truncates content to maxLen if longer', () => {
    const result = extractTitleFromMessage('A'.repeat(100), 50)
    expect(result).toBe('A'.repeat(50))
    expect(result.length).toBe(50)
  })

  it('uses default maxLen of 50', () => {
    expect(extractTitleFromMessage('A'.repeat(100)).length).toBe(50)
  })

  it('collapses whitespace', () => {
    expect(extractTitleFromMessage('  Multiple   spaces   here  ')).toBe('Multiple spaces here')
  })

  it('trims leading and trailing whitespace', () => {
    expect(extractTitleFromMessage('  trimmed  ')).toBe('trimmed')
  })

  it('handles empty and whitespace-only strings', () => {
    expect(extractTitleFromMessage('')).toBe('')
    expect(extractTitleFromMessage('   ')).toBe('')
  })

  it('respects a custom maxLen', () => {
    expect(extractTitleFromMessage('A'.repeat(300), 200).length).toBe(200)
  })

  it('uses the first non-empty line for multi-line content', () => {
    expect(extractTitleFromMessage('Fix the login bug\nThis needs edge cases')).toBe('Fix the login bug')
    expect(extractTitleFromMessage('\n\n  \nActual title here\nMore details')).toBe('Actual title here')
  })

  it('truncates the selected first line', () => {
    expect(extractTitleFromMessage(`${'A'.repeat(100)}\nSecond line`, 50)).toBe('A'.repeat(50))
  })

  it('collapses single-line content and handles all-empty lines', () => {
    expect(extractTitleFromMessage('Just a single line with   extra   spaces')).toBe('Just a single line with extra spaces')
    expect(extractTitleFromMessage('\n\n  \n  ')).toBe('')
  })
})
