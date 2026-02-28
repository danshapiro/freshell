import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { QuestionRequest, QuestionDefinition } from '@/store/agentChatTypes'

interface QuestionBannerProps {
  question: QuestionRequest
  onAnswer: (answers: Record<string, string>) => void
  disabled?: boolean
}

function SingleSelectQuestion({
  q,
  onSelect,
  disabled,
}: {
  q: QuestionDefinition
  onSelect: (answer: string) => void
  disabled?: boolean
}) {
  const [showOther, setShowOther] = useState(false)
  const [otherText, setOtherText] = useState('')
  const otherInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showOther) otherInputRef.current?.focus()
  }, [showOther])

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{q.question}</p>
      <div className="flex flex-wrap gap-2">
        {q.options.map((opt) => (
          <button
            key={opt.label}
            type="button"
            onClick={() => onSelect(opt.label)}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md border transition-colors',
              'bg-blue-600/10 border-blue-500/30 hover:bg-blue-600/20 hover:border-blue-500/50',
              'disabled:opacity-50',
            )}
            aria-label={opt.label}
          >
            <span className="font-medium">{opt.label}</span>
            {opt.description && (
              <span className="block text-muted-foreground text-[10px]">{opt.description}</span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowOther(true)}
          disabled={disabled}
          className={cn(
            'px-3 py-1.5 text-xs rounded-md border transition-colors',
            'bg-muted/50 border-border hover:bg-muted',
            'disabled:opacity-50',
          )}
          aria-label="Other"
        >
          Other
        </button>
      </div>
      {showOther && (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Type your answer..."
            ref={otherInputRef}
            className="flex-1 px-2 py-1 text-xs rounded border bg-background"
          />
          <button
            type="button"
            onClick={() => otherText.trim() && onSelect(otherText.trim())}
            disabled={disabled || !otherText.trim()}
            className={cn(
              'px-3 py-1 text-xs rounded font-medium',
              'bg-blue-600 text-white hover:bg-blue-700',
              'disabled:opacity-50',
            )}
            aria-label="Submit"
          >
            Submit
          </button>
        </div>
      )}
    </div>
  )
}

function MultiSelectQuestion({
  q,
  onSelect,
  disabled,
}: {
  q: QuestionDefinition
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
    if (selected.size > 0) {
      onSelect(Array.from(selected).join(', '))
    }
  }, [selected, onSelect])

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{q.question}</p>
      <div className="flex flex-wrap gap-2">
        {q.options.map((opt) => (
          <button
            key={opt.label}
            type="button"
            onClick={() => toggle(opt.label)}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md border transition-colors',
              selected.has(opt.label)
                ? 'bg-blue-600/30 border-blue-500/60 ring-1 ring-blue-500/40'
                : 'bg-blue-600/10 border-blue-500/30 hover:bg-blue-600/20',
              'disabled:opacity-50',
            )}
            aria-label={opt.label}
            aria-pressed={selected.has(opt.label)}
          >
            <span className="font-medium">{opt.label}</span>
            {opt.description && (
              <span className="block text-muted-foreground text-[10px]">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || selected.size === 0}
        className={cn(
          'px-3 py-1 text-xs rounded font-medium',
          'bg-blue-600 text-white hover:bg-blue-700',
          'disabled:opacity-50',
        )}
        aria-label="Submit"
      >
        Submit
      </button>
    </div>
  )
}

function QuestionBanner({ question, onAnswer, disabled }: QuestionBannerProps) {
  const [answered, setAnswered] = useState<Record<string, string>>({})
  const questions = question.questions

  // Use index-based keys internally to avoid collisions with duplicate question text
  const handleAnswer = useCallback(
    (idx: number, questionText: string, answer: string) => {
      if (questions.length === 1) {
        // Single question — submit immediately
        onAnswer({ [questionText]: answer })
      } else {
        setAnswered((prev) => ({ ...prev, [String(idx)]: answer }))
      }
    },
    [questions.length, onAnswer],
  )

  // For multi-question forms, show a final submit when all are answered
  const allAnswered = questions.length > 1 &&
    questions.every((_, idx) => answered[String(idx)] !== undefined)

  return (
    <div
      className="border border-blue-500/50 bg-blue-500/10 rounded-lg p-3 space-y-3"
      role="region"
      aria-label="Question from Claude"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestion className="h-4 w-4 text-blue-500" />
        <span>Claude has a question</span>
      </div>

      {questions.map((q, idx) => (
        q.multiSelect ? (
          <MultiSelectQuestion
            key={`${idx}-${q.question}`}
            q={q}
            onSelect={(answer) => handleAnswer(idx, q.question, answer)}
            disabled={disabled}
          />
        ) : (
          <SingleSelectQuestion
            key={`${idx}-${q.question}`}
            q={q}
            onSelect={(answer) => handleAnswer(idx, q.question, answer)}
            disabled={disabled}
          />
        )
      ))}

      {allAnswered && (
        <button
          type="button"
          onClick={() => {
            // Map index-based internal keys back to question text for the SDK.
            // SDK answers are Record<string, string> keyed by question text.
            // Note: duplicate question text would cause key collisions, but this
            // matches the SDK contract — keys must be exact question text strings.
            // Claude never generates duplicate question text in practice.
            const result: Record<string, string> = {}
            questions.forEach((q, idx) => {
              result[q.question] = answered[String(idx)]
            })
            onAnswer(result)
          }}
          disabled={disabled}
          className={cn(
            'px-4 py-1.5 text-xs rounded font-medium',
            'bg-blue-600 text-white hover:bg-blue-700',
            'disabled:opacity-50',
          )}
          aria-label="Submit all answers"
        >
          Submit all answers
        </button>
      )}
    </div>
  )
}

export default memo(QuestionBanner)
