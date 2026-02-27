import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import QuestionBanner from '@/components/claude-chat/QuestionBanner'
import type { QuestionRequest } from '@/store/claudeChatTypes'

describe('QuestionBanner', () => {
  afterEach(() => { cleanup() })
  const singleSelectQuestion: QuestionRequest = {
    requestId: 'q-1',
    questions: [
      {
        question: 'Which framework should we use?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'Popular component library' },
          { label: 'Vue', description: 'Progressive framework' },
          { label: 'Svelte', description: 'Compiler-based approach' },
        ],
        multiSelect: false,
      },
    ],
  }

  const multiSelectQuestion: QuestionRequest = {
    requestId: 'q-2',
    questions: [
      {
        question: 'Which features do you want to enable?',
        header: 'Features',
        options: [
          { label: 'Auth', description: 'User authentication' },
          { label: 'Dark mode', description: 'Theme support' },
          { label: 'i18n', description: 'Internationalization' },
        ],
        multiSelect: true,
      },
    ],
  }

  it('renders question text and all option buttons', () => {
    render(<QuestionBanner question={singleSelectQuestion} onAnswer={vi.fn()} />)
    expect(screen.getByText('Which framework should we use?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'React' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Vue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Svelte' })).toBeTruthy()
  })

  it('renders option descriptions', () => {
    render(<QuestionBanner question={singleSelectQuestion} onAnswer={vi.fn()} />)
    expect(screen.getByText('Popular component library')).toBeTruthy()
  })

  it('calls onAnswer with question text as key for single-select', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<QuestionBanner question={singleSelectQuestion} onAnswer={onAnswer} />)

    await user.click(screen.getByRole('button', { name: 'React' }))

    expect(onAnswer).toHaveBeenCalledWith({
      'Which framework should we use?': 'React',
    })
  })

  it('allows multi-select and submits comma-separated string', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<QuestionBanner question={multiSelectQuestion} onAnswer={onAnswer} />)

    // Click two options
    await user.click(screen.getByRole('button', { name: 'Auth' }))
    await user.click(screen.getByRole('button', { name: 'Dark mode' }))

    // Click submit
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onAnswer).toHaveBeenCalledWith({
      'Which features do you want to enable?': 'Auth, Dark mode',
    })
  })

  it('renders Other text input and submits custom text', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(<QuestionBanner question={singleSelectQuestion} onAnswer={onAnswer} />)

    // Click Other button
    await user.click(screen.getByRole('button', { name: 'Other' }))

    // Type custom answer
    const input = screen.getByRole('textbox')
    await user.type(input, 'Angular')
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onAnswer).toHaveBeenCalledWith({
      'Which framework should we use?': 'Angular',
    })
  })

  it('renders multiple questions', () => {
    const multiQuestion: QuestionRequest = {
      requestId: 'q-3',
      questions: [
        {
          question: 'First question?',
          header: 'Q1',
          options: [{ label: 'A', description: 'Option A' }],
          multiSelect: false,
        },
        {
          question: 'Second question?',
          header: 'Q2',
          options: [{ label: 'B', description: 'Option B' }],
          multiSelect: false,
        },
      ],
    }

    render(<QuestionBanner question={multiQuestion} onAnswer={vi.fn()} />)
    expect(screen.getByText('First question?')).toBeTruthy()
    expect(screen.getByText('Second question?')).toBeTruthy()
  })

  it('has accessible role and aria-label', () => {
    render(<QuestionBanner question={singleSelectQuestion} onAnswer={vi.fn()} />)
    expect(screen.getByRole('region', { name: /question/i })).toBeTruthy()
  })
})
