/**
 * Canonical names for the candidate-bound receipts the cumulative gate consumes.
 *
 * Two sides need the same name. The producer (an e2e spec, or the soak script)
 * writes a receipt; the gate copies the exact validated input into its own
 * evidence tree so a PASS stays reviewable after the temporary receipt paths are
 * gone. When each side spells the name itself they drift, and the copy ends up
 * named after nothing but its case id — `browser/p5-g09.json` records that a
 * receipt was accepted, not what it proved. One table keeps a receipt
 * self-describing wherever it lands.
 */
export type RuntimeReceiptArtifact = {
  /** What the receipt proves; the stable half of every artifact name. */
  slug: string
  /** The case that owns the receipt when no explicit target path is supplied. */
  defaultCaseId: string
}

export const RUNTIME_RECEIPT_ARTIFACTS: Record<string, RuntimeReceiptArtifact> = {
  FRESHELL_RUNTIME_BROWSER_RECEIPT: { slug: 'browser-continuity', defaultCaseId: 'P2-G01' },
  FRESHELL_RUNTIME_OPENCODE_RECEIPT: { slug: 'real-opencode-continuity', defaultCaseId: 'P2-G04' },
  FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT: { slug: 'provider-resurrection', defaultCaseId: 'P3-G10' },
  FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT: { slug: 'provider-matrix', defaultCaseId: 'P3-G12' },
  FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT: { slug: 'fresh-agent-matrix', defaultCaseId: 'P3-G01' },
  FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT: { slug: 'runtime-tabs-rehydrate', defaultCaseId: 'P4-G08' },
  FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT: { slug: 'provider-matrix', defaultCaseId: 'P5-G12' },
  FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT: { slug: 'fresh-agent-matrix', defaultCaseId: 'P5-G01' },
  FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT: { slug: 'real-opencode-loss', defaultCaseId: 'P5-G02' },
  FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT: { slug: 'browser-chaos', defaultCaseId: 'P5-G09' },
  FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT: { slug: 'phase5-soak', defaultCaseId: 'P5-G10' },
}

function artifactFor(envName: string): RuntimeReceiptArtifact {
  const artifact = RUNTIME_RECEIPT_ARTIFACTS[envName]
  if (!artifact) throw new Error(`unknown receipt ${envName}: add it to RUNTIME_RECEIPT_ARTIFACTS`)
  return artifact
}

/** The evidence-tree artifact name for a receipt copied by `caseId`. */
export function receiptArtifactName(envName: string, caseId: string): string {
  return `${caseId.toLowerCase()}-${artifactFor(envName).slug}`
}

/** Where a producer writes the receipt when no explicit target path is set. */
export function defaultReceiptFileName(envName: string): string {
  const artifact = artifactFor(envName)
  return `${artifact.defaultCaseId.toLowerCase()}-${artifact.slug}.json`
}
