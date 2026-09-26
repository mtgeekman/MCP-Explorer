import { sql as initial } from './0001-initial.js';
import { sql as serverSecrets } from './0002-server-secrets.js';
import { sql as wireUnits } from './0003-wire-units.js';
import { sql as secretNames } from './0004-secret-names.js';
import { sql as callSettings } from './0005-call-settings.js';
import { sql as callEndings } from './0006-call-endings.js';
import { sql as serverRequests } from './0007-server-requests.js';

export interface Migration {
  /** The `user_version` a database has after this migration. Contiguous from 1. */
  version: number;
  name: string;
  sql: string;
  /**
   * Rebuilds a table others reference, so it runs with foreign keys off:
   * dropping the old table with them on would cascade into its children.
   * migrate() checks every foreign key before the migration commits.
   */
  rebuildsParent?: true;
}

/**
 * Every schema migration, in order (D27). Append only: a released entry is
 * never edited or removed, and its checksum is pinned by
 * test/storage-migrations.test.mjs.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initial },
  { version: 2, name: 'server-secrets', sql: serverSecrets },
  { version: 3, name: 'wire-units', sql: wireUnits },
  { version: 4, name: 'secret-names', sql: secretNames },
  { version: 5, name: 'call-settings', sql: callSettings },
  { version: 6, name: 'call-endings', sql: callEndings, rebuildsParent: true },
  { version: 7, name: 'server-requests', sql: serverRequests },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
