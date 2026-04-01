import type { ProjectGroup, CodingCliSession } from './coding-cli/types.js'
import type { SessionAssociationCoordinator } from './session-association-coordinator.js'

export type AppliedSessionAssociation = {
  session: CodingCliSession
  terminalId: string
}

type SessionAssociationCoordinatorLike = Pick<SessionAssociationCoordinator, 'collectNewOrAdvanced' | 'associateSingleSession'>

export function collectAppliedSessionAssociations(
  coordinator: SessionAssociationCoordinatorLike,
  projects: ProjectGroup[],
): AppliedSessionAssociation[] {
  const applied: AppliedSessionAssociation[] = []

  for (const session of coordinator.collectNewOrAdvanced(projects)) {
    const result = coordinator.associateSingleSession(session)
    if (!result.associated || !result.terminalId) continue
    applied.push({
      session,
      terminalId: result.terminalId,
    })
  }

  return applied
}
