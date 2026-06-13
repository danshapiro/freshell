export function FreshAgentApprovalBanner({ text }: { text: string }) {
  return (
    <div role="alert" className="fresh-agent-banner rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
      {text}
    </div>
  )
}
