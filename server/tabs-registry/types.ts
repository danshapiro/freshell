// Temporary compatibility boundary for the Node server.  The shared module
// owns the schema so client persistence and the retiring backend use one type.
export {
  RegistryTabStatusSchema,
  RegistryPaneKindSchema,
  RegistryPaneSnapshotSchema,
  TabRegistryRecordBaseSchema,
  TabRegistryRecordSchema,
  normalizeRegistryTabRecord,
} from '../../shared/tab-registry-types.js'

export type {
  RegistryTabStatus,
  RegistryPaneKind,
  RegistryPaneSnapshot,
  RegistryTabRecord,
} from '../../shared/tab-registry-types.js'
