import { constants, copyFileSync, existsSync } from 'node:fs';
import { StorageError } from './errors.js';
import { MIGRATIONS, type Migration } from './migrations/index.js';
import type { Database } from './sqlite.js';

/** The database was written by a newer version of the app (D27: no downgrade). */
export class NewerSchemaError extends StorageError {}

/** A migration threw. The database is left at the last version that committed. */
export class MigrationFailedError extends StorageError {}

export interface MigrationResult {
  from: number;
  to: number;
  /** The pre-migration copy, or null when nothing was migrated or there was no data yet. */
  backupPath: string | null;
}

const userVersion = (db: Database) => db.pragma('user_version', { simple: true }) as number;

function backupPathFor(path: string, version: number): string {
  // Never overwrite an earlier backup: a second failed attempt at the same
  // upgrade must not replace the copy taken before the first.
  const base = `${path}.v${version}.bak`;
  if (!existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${path}.v${version}.${n}.bak`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Brings a workspace database to the newest schema (D27). Forward only. Each
 * migration and its `user_version` bump commit in one transaction, so a crash
 * or a failing migration leaves the previous version intact rather than half
 * a schema.
 *
 * Before the first pending migration on a database that already has a schema,
 * the file is copied beside itself as `<path>.v<N>.bak` -- still encrypted,
 * since it is the same bytes (D6, D26). The copy is taken with no transaction
 * open and the default rollback journal, so the main file alone is complete.
 */
export function migrate(db: Database, path: string, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  const from = userVersion(db);
  const head = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (from > head) {
    throw new NewerSchemaError(`this workspace was written by a newer version of MCP Explorer (schema ${from}; this version knows up to ${head}); it is left untouched`);
  }
  if (from === head) return { from, to: from, backupPath: null };

  let backupPath: string | null = null;
  if (from > 0) {
    backupPath = backupPathFor(path, from);
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
  }

  for (const m of migrations) {
    if (m.version <= from) continue;
    // SQLite's table-rebuild procedure: foreign keys off outside the
    // transaction (the pragma is a no-op inside one), checked before commit.
    const fkWasOn = m.rebuildsParent ? db.pragma('foreign_keys', { simple: true }) === 1 : false;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuildsParent) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0) throw new Error(`${broken.length} foreign key violations after the rebuild`);
        }
        db.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      const where = backupPath ? `; the pre-upgrade copy is ${backupPath}` : '';
      throw new MigrationFailedError(`schema migration ${m.version} (${m.name}) failed; the workspace is still at schema ${userVersion(db)}${where}`, { cause: err });
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
  }
  return { from, to: head, backupPath };
}
