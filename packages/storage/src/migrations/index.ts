import { sql as initial } from './0001-initial.js';
import { sql as serverSecrets } from './0002-server-secrets.js';
import { sql as wireUnits } from './0003-wire-units.js';
import { sql as secretNames } from './0004-secret-names.js';
import { sql as callSettings } from './0005-call-settings.js';

export interface Migration {
  /** The `user_version` a database has after this migration. Contiguous from 1. */
  version: number;
  name: string;
  sql: string;
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
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
