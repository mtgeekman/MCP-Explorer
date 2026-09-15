import { sql as initial } from './0001-initial.js';
import { sql as serverSecrets } from './0002-server-secrets.js';

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
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
