import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import QuestionBanner from '@/components/claude-chat/QuestionBanner'
import type { QuestionRequest } from '@/store/claudeChatTypes'

const baseQuestion: QuestionRequest = {
  requestId: 'q-1',
  toolUseId: 'tool-q1',
  questions: [{
    question: 'Which auth method should we use?',
    header: 'Auth method',
    options: [
      { label: 'OAuth', description: 'Use OAuth 2.0 flow' },
      { label: 'JWT', description: 'Use JSON Web Tokens' },
    ],
    multiSelect: false,
  }],
}

describe('QuestionBanner', () => {
  afterEach(() => {
    cleanup()
  })
  it('renders question with options', () => {
    render(
      <QuestionBanner question={baseQuestion} onAnswer={() => {}} />
    )
    expect(screen.getByText('Which auth method should we use?')).toBeInTheDocument()
    expect(screen.getByText('OAuth')).toBeInTheDocument()
    expect(screen.getByText('JWT')).toBeInTheDocument()
    expect(screen.getByText('Auth method')).toBeInTheDocument()
  })

  it('renders with accessible form role', () => {
    render(
      <QuestionBanner question={baseQuestion} onAnswer={() => {}} />
    )
    expect(screen.getByRole('form')).toBeInTheDocument()
  })

  it('allows selecting an option and submitting', async () => {
    const onAnswer = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionBanner question={baseQuestion} onAnswer={onAnswer} />
    )

    await user.click(screen.getByText('OAuth'))
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(onAnswer).toHaveBeenCalledWith('q-1', { 'Auth method': 'OAuth' })
  })

  it('disables submit when no option is selected', () => {
    render(
      <QuestionBanner question={baseQuestion} onAnswer={() => {}} />
    )
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
  })

  it('supports multi-select questions', async () => {
    const multiQuestion: QuestionRequest = {
      requestId: 'q-2',
      toolUseId: 'tool-q2',
      questions: [{
        question: 'Which features?',
        header: 'Features',
        options: [
          { label: 'Dark mode', description: 'Add dark theme' },
          { label: 'Notifications', description: 'Push notifications' },
        ],
        multiSelect: true,
      }],
    }
    const onAnswer = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionBanner question={multiQuestion} onAnswer={onAnswer} />
    )

    await user.click(screen.getByText('Dark mode'))
    await user.click(screen.getByText('Notifications'))
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(onAnswer).toHaveBeenCalledWith('q-2', { 'Features': ['Dark mode', 'Notifications'] })
  })

  it('shows Other text input when Other is clicked', async () => {
    const user = userEvent.setup()
    render(
      <QuestionBanner question={baseQuestion} onAnswer={() => {}} />
    )

    await user.click(screen.getByRole('button', { name: 'Provide a custom answer' }))
    expect(screen.getByPlaceholderText('Type your answer...')).toBeInTheDocument()
  })

  it('submits multi-select Other answer as array', async () => {
    const multiQuestion: QuestionRequest = {
      requestId: 'q-3',
      toolUseId: 'tool-q3',
      questions: [{
        question: 'Which features?',
        header: 'Features',
        options: [
          { label: 'Dark mode', description: 'Add dark theme' },
          { label: 'Notifications', description: 'Push notifications' },
        ],
        multiSelect: true,
      }],
    }
    const onAnswer = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionBanner question={multiQuestion} onAnswer={onAnswer} />
    )

    await user.click(screen.getByRole('button', { name: 'Provide a custom answer' }))
    await user.type(screen.getByPlaceholderText('Type your answer...'), 'Custom feature')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(onAnswer).toHaveBeenCalledWith('q-3', { 'Features': ['Custom feature'] })
  })

  it('submits with custom Other answer', async () => {
    const onAnswer = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionBanner question={baseQuestion} onAnswer={onAnswer} />
    )

    await user.click(screen.getByRole('button', { name: 'Provide a custom answer' }))
    await user.type(screen.getByPlaceholderText('Type your answer...'), 'API Key')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(onAnswer).toHaveBeenCalledWith('q-1', { 'Auth method': 'API Key' })
  })
})
