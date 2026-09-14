import { createRequire } from 'node:module';

/**
 * The subset of better-sqlite3-multiple-ciphers this package uses, typed here
 * rather than through @types/better-sqlite3, whose declarations track upstream
 * better-sqlite3 and have no `key()`.
 *
 * This module is the ONLY place a database handle is constructed, and it is
 * not exported from the package. Every handle comes from workspace-db.ts,
 * which applies the D26 cipher configuration before anything reads the file.
 * test/storage-gates.test.mjs enforces both.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  key(key: Buffer): number;
  exec(sql: string): Database;
  prepare(sql: string): Statement;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): Database;
  readonly open: boolean;
}

type Constructor = new (path: string, options?: { fileMustExist?: boolean }) => Database;

const require = createRequire(import.meta.url);
const Sqlite = require('better-sqlite3-multiple-ciphers') as Constructor;

export function constructDatabase(path: string, options: { fileMustExist: boolean }): Database {
  return new Sqlite(path, options);
}
