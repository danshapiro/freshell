import { memo, useState, useCallback } from 'react'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { QuestionRequest } from '@/store/claudeChatTypes'

interface QuestionBannerProps {
  question: QuestionRequest
  onAnswer: (requestId: string, answers: Record<string, string | string[]>) => void
  disabled?: boolean
}

function QuestionBanner({ question, onAnswer, disabled }: QuestionBannerProps) {
  const [selections, setSelections] = useState<Record<string, string | string[]>>({})
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({})
  const [usingOther, setUsingOther] = useState<Record<string, boolean>>({})

  const handleOptionClick = useCallback((header: string, label: string, multiSelect: boolean) => {
    setUsingOther(prev => ({ ...prev, [header]: false }))
    setSelections(prev => {
      if (multiSelect) {
        const current = (prev[header] as string[]) || []
        const idx = current.indexOf(label)
        if (idx >= 0) {
          return { ...prev, [header]: current.filter(l => l !== label) }
        }
        return { ...prev, [header]: [...current, label] }
      }
      return { ...prev, [header]: label }
    })
  }, [])

  const handleOtherToggle = useCallback((header: string) => {
    setUsingOther(prev => {
      const next = !prev[header]
      if (next) {
        // Clear option selection when switching to Other
        setSelections(p => {
          const copy = { ...p }
          delete copy[header]
          return copy
        })
      }
      return { ...prev, [header]: next }
    })
  }, [])

  const handleOtherChange = useCallback((header: string, value: string, multiSelect: boolean) => {
    setOtherInputs(prev => ({ ...prev, [header]: value }))
    setSelections(prev => ({ ...prev, [header]: multiSelect ? [value] : value }))
  }, [])

  const allAnswered = question.questions.every(q => {
    if (usingOther[q.header]) return !!otherInputs[q.header]?.trim()
    const sel = selections[q.header]
    if (q.multiSelect) return Array.isArray(sel) && sel.length > 0
    return typeof sel === 'string' && sel.length > 0
  })

  const handleSubmit = useCallback(() => {
    if (!allAnswered) return
    onAnswer(question.requestId, selections)
  }, [allAnswered, onAnswer, question.requestId, selections])

  return (
    <div
      className="border border-blue-500/50 bg-blue-500/10 rounded-lg p-3 space-y-3"
      role="form"
      aria-label="Claude is asking a question"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <HelpCircle className="h-4 w-4 text-blue-500" />
        <span>Claude needs your input</span>
      </div>

      {question.questions.map((q) => (
        <div key={q.header} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">
              {q.header}
            </span>
            <span className="text-sm">{q.question}</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const isSelected = q.multiSelect
                ? (Array.isArray(selections[q.header]) && (selections[q.header] as string[]).includes(opt.label))
                : selections[q.header] === opt.label
              return (
                <button
                  key={opt.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleOptionClick(q.header, opt.label, q.multiSelect)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md border transition-colors',
                    'disabled:opacity-50',
                    isSelected
                      ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                      : 'border-border hover:border-blue-500/50 hover:bg-blue-500/5'
                  )}
                  aria-pressed={isSelected}
                  aria-label={`${opt.label}: ${opt.description}`}
                >
                  {opt.label}
                </button>
              )
            })}
            <button
              type="button"
              disabled={disabled}
              onClick={() => handleOtherToggle(q.header)}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md border transition-colors',
                'disabled:opacity-50',
                usingOther[q.header]
                  ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                  : 'border-border hover:border-blue-500/50 hover:bg-blue-500/5'
              )}
              aria-pressed={usingOther[q.header] || false}
              aria-label="Provide a custom answer"
            >
              Other
            </button>
          </div>

          {/* Option descriptions */}
          {!usingOther[q.header] && selections[q.header] && (
            <div className="text-xs text-muted-foreground pl-1">
              {q.options.find(o =>
                q.multiSelect
                  ? Array.isArray(selections[q.header]) && (selections[q.header] as string[]).includes(o.label)
                  : o.label === selections[q.header]
              )?.description}
            </div>
          )}

          {/* Other text input */}
          {usingOther[q.header] && (
            <input
              type="text"
              value={otherInputs[q.header] || ''}
              onChange={(e) => handleOtherChange(q.header, e.target.value, q.multiSelect)}
              placeholder="Type your answer..."
              disabled={disabled}
              className="w-full px-2 py-1 text-xs rounded border border-border bg-background focus:border-blue-500 focus:outline-none"
              aria-label={`Custom answer for ${q.header}`}
            />
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || !allAnswered}
        className={cn(
          'px-3 py-1 text-xs rounded font-medium',
          'bg-blue-600 text-white hover:bg-blue-700',
          'disabled:opacity-50'
        )}
        aria-label="Submit answers"
      >
        Submit
      </button>
    </div>
  )
}

export default memo(QuestionBanner)
