import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FreshAgentQuestionBanner from '@/components/fresh-agent/FreshAgentQuestionBanner'

const singleQuestion = {
  requestId: 'q-1',
  questions: [{
    header: 'Choose path',
    question: 'How should Claude proceed?',
    options: [
      { label: 'Continue', description: 'Keep working' },
      { label: 'Stop', description: 'Pause here' },
    ],
    multiSelect: false,
  }],
}

describe('FreshAgentQuestionBanner', () => {
  afterEach(() => cleanup())

  it('answers a single-select Question from the provider immediately', () => {
    const onAnswer = vi.fn()
    render(
      <FreshAgentQuestionBanner
        question={singleQuestion}
        providerLabel="Claude"
        onAnswer={onAnswer}
      />,
    )

    expect(screen.getByRole('region', { name: 'Question from Claude' })).toHaveTextContent('How should Claude proceed?')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAnswer).toHaveBeenCalledWith({ 'How should Claude proceed?': 'Continue' })
  })

  it('collects multiple answers before Submit answer for multi-question prompts', () => {
    const onAnswer = vi.fn()
    render(
      <FreshAgentQuestionBanner
        providerLabel="Codex"
        onAnswer={onAnswer}
        question={{
          requestId: 'q-2',
          questions: [
            {
              header: 'Direction',
              question: 'Which implementation?',
              options: [
                { label: 'A', description: 'First option' },
                { label: 'B', description: 'Second option' },
              ],
              multiSelect: false,
            },
            {
              header: 'Tests',
              question: 'Which suites?',
              options: [
                { label: 'Unit', description: 'Fast checks' },
                { label: 'E2E', description: 'Browser flow' },
              ],
              multiSelect: true,
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit all answers' }))

    expect(onAnswer).toHaveBeenCalledWith({
      'Which implementation?': 'A',
      'Which suites?': 'Unit',
    })
  })

  it('keeps mobile and desktop touch targets identifiable while disabled', () => {
    render(
      <FreshAgentQuestionBanner
        question={singleQuestion}
        providerLabel="Claude"
        onAnswer={vi.fn()}
        disabled
      />,
    )

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Other' })).toBeDisabled()
  })
})
