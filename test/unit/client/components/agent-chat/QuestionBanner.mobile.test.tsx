import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import QuestionBanner from '@/components/agent-chat/QuestionBanner'

describe('QuestionBanner mobile touch targets', () => {
  const baseQuestion = {
    requestId: 'q-1',
    questions: [{
      question: 'Which option?',
      options: [
        { label: 'Option A', description: 'First' },
        { label: 'Option B', description: 'Second' },
      ],
    }],
  }

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('option buttons have min-h-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    render(
      <QuestionBanner
        question={baseQuestion}
        onAnswer={vi.fn()}
      />,
    )
    const optionA = screen.getByRole('button', { name: /option a/i })
    expect(optionA.className).toContain('min-h-11')
  })

  it('Other button has min-h-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    render(
      <QuestionBanner
        question={baseQuestion}
        onAnswer={vi.fn()}
      />,
    )
    const otherBtn = screen.getByRole('button', { name: /other/i })
    expect(otherBtn.className).toContain('min-h-11')
  })

  it('option buttons do not have min-h-11 on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    render(
      <QuestionBanner
        question={baseQuestion}
        onAnswer={vi.fn()}
      />,
    )
    const optionA = screen.getByRole('button', { name: /option a/i })
    expect(optionA.className).not.toContain('min-h-11')
  })
})
