export function FreshAgentQuestionBanner({ text }: { text: string }) {
  return (
    <div role="alert" className="rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-2 text-sm">
      {text}
    </div>
  )
}
