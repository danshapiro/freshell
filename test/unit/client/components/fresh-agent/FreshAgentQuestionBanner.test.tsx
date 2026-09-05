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

  it('keeps distinct provider question IDs when question text repeats', () => {
    const onAnswer = vi.fn()
    render(<FreshAgentQuestionBanner providerLabel="Codex" onAnswer={onAnswer} question={{
      requestId: 'questions-with-ids',
      questions: [
        { id: 'frontend', header: 'Frontend', question: 'Which approach?', options: [{ label: 'React', description: '' }], multiSelect: false },
        { id: 'backend', header: 'Backend', question: 'Which approach?', options: [{ label: 'Rust', description: '' }], multiSelect: false },
      ],
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'React' }))
    expect(screen.getByRole('button', { name: 'React', pressed: true })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Rust' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit all answers' }))
    expect(onAnswer).toHaveBeenCalledWith({ frontend: 'React', backend: 'Rust' })
  })

  it('submits a free-text answer with Enter using an accessible question label', () => {
    const onAnswer = vi.fn()
    render(<FreshAgentQuestionBanner question={singleQuestion} providerLabel="Claude" onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const input = screen.getByRole('textbox', { name: 'How should Claude proceed?' })
    fireEvent.change(input, { target: { value: '  Please investigate  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith({ 'How should Claude proceed?': 'Please investigate' })
  })

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

  it('gates the multi-select Submit on at least one selection (empty answer cannot submit)', () => {
    const onAnswer = vi.fn()
    render(
      <FreshAgentQuestionBanner
        providerLabel="Claude"
        onAnswer={onAnswer}
        question={{
          requestId: 'q-multi',
          questions: [{
            header: 'Pick',
            question: 'Which apply?',
            options: [
              { label: 'X', description: 'x' },
              { label: 'Y', description: 'y' },
            ],
            multiSelect: true,
          }],
        }}
      />,
    )

    const submit = screen.getByRole('button', { name: 'Submit' })
    // Zero selection: the gate at FreshAgentQuestionBanner.tsx (selected.size === 0) disables.
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(onAnswer).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'X' }))
    expect(submit).toBeEnabled()
    // Toggling the only selection back off returns to the disabled gate.
    fireEvent.click(screen.getByRole('button', { name: 'X' }))
    expect(submit).toBeDisabled()
  })

  it('gates the Other submit on non-empty trimmed text (whitespace cannot submit)', () => {
    const onAnswer = vi.fn()
    render(
      <FreshAgentQuestionBanner
        question={singleQuestion}
        providerLabel="Claude"
        onAnswer={onAnswer}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const input = screen.getByRole('textbox')
    const submit = screen.getByRole('button', { name: 'Submit' })
    // Empty text: the gate at FreshAgentQuestionBanner.tsx (!otherText.trim()) disables.
    expect(submit).toBeDisabled()

    fireEvent.change(input, { target: { value: '   ' } })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(onAnswer).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'custom path' } })
    expect(submit).toBeEnabled()
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
