interface MissingLayoutErrorProps {
  tabTitle: string
}

export default function MissingLayoutError({ tabTitle }: MissingLayoutErrorProps) {
  return (
    <div className="h-full w-full p-4 md:p-6">
      <div
        role="alert"
        data-testid="missing-layout-error"
        className="max-w-xl rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <h2 className="text-sm font-semibold text-foreground">Layout is missing</h2>
        <p className="mt-2 text-muted-foreground">
          Freshell detected corruption in <span className="font-medium text-foreground">{tabTitle}</span>.
          The pane layout is missing, and Freshell refused to fabricate replacement content.
        </p>
      </div>
    </div>
  )
}
