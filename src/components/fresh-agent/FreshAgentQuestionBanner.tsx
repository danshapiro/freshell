import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'

type FreshAgentQuestion = {
  requestId: string
  questions: Array<{
    id?: string
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

function SingleSelectQuestion({
  question,
  answer,
  onSelect,
  disabled,
}: {
  question: FreshAgentQuestion['questions'][number]
  answer?: string
  onSelect: (answer: string) => void
  disabled?: boolean
}) {
  const [showOther, setShowOther] = useState(false)
  const [otherText, setOtherText] = useState('')
  const otherInputRef = useRef<HTMLInputElement>(null)
  const submitOther = () => {
    if (!disabled && otherText.trim()) onSelect(otherText.trim())
  }

  useEffect(() => {
    if (showOther) otherInputRef.current?.focus()
  }, [showOther])

  return (
    <div className="fresh-agent-question-block space-y-2" role="group" aria-label={question.header}>
      <p className="text-xs text-muted-foreground">{question.header}</p>
      <p className="fresh-agent-question-text text-sm font-medium">{question.question}</p>
      <div className="fresh-agent-question-options flex flex-wrap gap-2">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onSelect(option.label)}
            disabled={disabled}
            className={cn(
              'fresh-agent-question-option px-3 py-1.5 text-xs rounded-md border transition-colors',
              'bg-sky-600/10 border-sky-500/30 hover:bg-sky-600/20 hover:border-sky-500/50',
              'disabled:opacity-50',
              answer === option.label && 'bg-sky-600/30 border-sky-500/60 ring-1 ring-sky-500/40',
            )}
            aria-label={option.label}
            aria-pressed={answer === option.label}
          >
            <span className="font-medium">{option.label}</span>
            {option.description ? (
              <span className="block text-[10px] text-muted-foreground">{option.description}</span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowOther(true)}
          disabled={disabled}
          className={cn(
            'fresh-agent-question-option fresh-agent-question-option-other px-3 py-1.5 text-xs rounded-md border transition-colors',
            'bg-muted/50 border-border hover:bg-muted',
            'disabled:opacity-50',
          )}
          aria-label="Other"
          aria-pressed={answer !== undefined && !question.options.some((option) => option.label === answer)}
        >
          Other
        </button>
      </div>
      {showOther ? (
        <div className="fresh-agent-question-other flex items-center gap-2">
          <input
            ref={otherInputRef}
            type="text"
            aria-label={question.question}
            disabled={disabled}
            value={otherText}
            onChange={(event) => setOtherText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                submitOther()
              }
            }}
            placeholder="Type your answer..."
            className="fresh-agent-question-input flex-1 rounded border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={submitOther}
            disabled={disabled || !otherText.trim()}
            className={cn(
              'fresh-agent-question-submit px-3 py-1 text-xs rounded font-medium',
              'bg-sky-600 text-white hover:bg-sky-700',
              'disabled:opacity-50',
            )}
            aria-label="Submit"
          >
            Submit
          </button>
        </div>
      ) : null}
    </div>
  )
}

function MultiSelectQuestion({
  question,
  onSelect,
  disabled,
}: {
  question: FreshAgentQuestion['questions'][number]
  onSelect: (answer: string) => void
  disabled?: boolean
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = useCallback((label: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const handleSubmit = useCallback(() => {
    if (selected.size > 0) onSelect(Array.from(selected).join(', '))
  }, [onSelect, selected])

  return (
    <div className="fresh-agent-question-block space-y-2" role="group" aria-label={question.header}>
      <p className="text-xs text-muted-foreground">{question.header}</p>
      <p className="fresh-agent-question-text text-sm font-medium">{question.question}</p>
      <div className="fresh-agent-question-options flex flex-wrap gap-2">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => toggle(option.label)}
            disabled={disabled}
            className={cn(
              'fresh-agent-question-option px-3 py-1.5 text-xs rounded-md border transition-colors',
              selected.has(option.label)
                ? 'bg-sky-600/30 border-sky-500/60 ring-1 ring-sky-500/40'
                : 'bg-sky-600/10 border-sky-500/30 hover:bg-sky-600/20',
              'disabled:opacity-50',
            )}
            aria-label={option.label}
            aria-pressed={selected.has(option.label)}
          >
            <span className="font-medium">{option.label}</span>
            {option.description ? (
              <span className="block text-[10px] text-muted-foreground">{option.description}</span>
            ) : null}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || selected.size === 0}
        className={cn(
          'fresh-agent-question-submit px-3 py-1 text-xs rounded font-medium',
          'bg-sky-600 text-white hover:bg-sky-700',
          'disabled:opacity-50',
        )}
        aria-label="Submit"
      >
        Submit
      </button>
    </div>
  )
}

function FreshAgentQuestionBanner({
  question,
  onAnswer,
  disabled,
  providerLabel,
}: {
  question: FreshAgentQuestion
  onAnswer: (answers: Record<string, string>) => void
  disabled?: boolean
  providerLabel: string
}) {
  const [answered, setAnswered] = useState<Record<string, string>>({})
  const questions = question.questions

  const handleAnswer = useCallback((idx: number, answer: string) => {
    if (questions.length === 1) {
      const entry = questions[idx]
      onAnswer({ [entry.id ?? entry.question]: answer })
      return
    }
    setAnswered((prev) => ({ ...prev, [String(idx)]: answer }))
  }, [onAnswer, questions])

  const allAnswered = questions.length > 1 && questions.every((_, idx) => answered[String(idx)] !== undefined)
  const regionLabel = `Question from ${providerLabel}`
  const heading = `${providerLabel} has a question`

  return (
    <div
      className="fresh-agent-question-card rounded-lg border border-sky-500/50 bg-sky-500/10 p-3 space-y-3"
      role="region"
      aria-label={regionLabel}
    >
      <div className="fresh-agent-question-heading flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestion className="h-4 w-4 text-sky-500" />
        <span>{heading}</span>
      </div>

      {questions.map((entry, idx) => (
        entry.multiSelect ? (
          <MultiSelectQuestion
            key={entry.id ?? `${idx}-${entry.question}`}
            question={entry}
            onSelect={(answer) => handleAnswer(idx, answer)}
            disabled={disabled}
          />
        ) : (
          <SingleSelectQuestion
            key={entry.id ?? `${idx}-${entry.question}`}
            question={entry}
            answer={answered[String(idx)]}
            onSelect={(answer) => handleAnswer(idx, answer)}
            disabled={disabled}
          />
        )
      ))}

      {allAnswered ? (
        <button
          type="button"
          onClick={() => {
            const result: Record<string, string> = {}
            questions.forEach((entry, idx) => {
              result[entry.id ?? entry.question] = answered[String(idx)]
            })
            onAnswer(result)
          }}
          disabled={disabled}
          className={cn(
            'fresh-agent-question-submit px-4 py-1.5 text-xs rounded font-medium',
            'bg-sky-600 text-white hover:bg-sky-700',
            'disabled:opacity-50',
          )}
          aria-label="Submit all answers"
        >
          Submit all answers
        </button>
      ) : null}
    </div>
  )
}

export default memo(FreshAgentQuestionBanner)
