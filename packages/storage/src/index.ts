export * from './errors.js';
export { type SecretStore, APP_SERVICE, KEYRING_PIN, keychainStore } from './secrets.js';
export type { Database, Statement } from './sqlite.js';
export {
  type Custody,
  type CreateWorkspaceRequest,
  type Workspace,
  type WorkspaceDbRequest,
  createWorkspaceDb,
  openWorkspaceDb,
  workspaceKeyAccount,
} from './workspace-db.js';
export { InvalidRecoveryKeyError, encodeRecoveryKey, decodeRecoveryKey } from './recovery.js';
export { migrate, NewerSchemaError, MigrationFailedError, type MigrationResult } from './migrate.js';
export { MIGRATIONS, SCHEMA_VERSION, type Migration } from './migrations/index.js';
export {
  type RegistryCustody,
  type RegistryEntry,
  RegistryError,
  REGISTRY_FORMAT,
  readRegistry,
  writeRegistry,
  addToRegistry,
  removeFromRegistry,
  renameInRegistry,
  registryLabel,
} from './registry.js';
export {
  type Transport,
  type ServerDefinition,
  type ServerSummary,
  type SecretNames,
  InvalidServerDefinitionError,
  SecretsRequireEncryptionError,
  saveServer,
  loadServer,
  listServers,
  deleteServer,
} from './servers.js';
export {
  HistoryRecorder,
  HistoryStateError,
  RESULT_METHODS,
  type CallKind,
  type CallStatus,
  type RoundOutcome,
  type RawUnit,
} from './history.js';
export {
  recordCapture,
  loadSnapshot,
  surfaceHistory,
  listObservations,
  diffSnapshots,
  SnapshotNotFoundError,
  type RecordedCapture,
  type SnapshotSummary,
  type Observation,
} from './snapshots.js';
export {
  purgeHistory,
  compact,
  liveBytes,
  usedBytes,
  readSettings,
  updateSettings,
  InvalidSettingsError,
  type PurgeResult,
  type WorkspaceSettings,
} from './retention.js';
