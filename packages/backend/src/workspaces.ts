// Workspaces as the user sees them (plan phase 04; spec D3, D5, D28, D29):
// the list before anything is unlocked, create, open, switch, and the
// keychain entry checked and repaired where the user can see it.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  addToRegistry, createWorkspaceDb, openWorkspaceDb, readRegistry, registryLabel, workspaceKeyAccount,
  InvalidWorkspaceRequestError, KeyMissingError,
  type Custody, type RegistryCustody, type RegistryEntry, type SecretStore, type Workspace,
} from '../../storage/dist/index.js';

/** What the workspace picker lists: every registered workspace, including ones not unlocked (D29). */
export interface WorkspaceListing {
  id: string;
  /** The name, or "Protected workspace, created <date>" for a passphrase workspace not yet open. */
  label: string;
  custody: RegistryCustody;
  createdAt: number;
  path: string;
}

/** How a new workspace's key is held (D5). `none` stores nothing encrypted and no secrets (D4, D31). */
export type Protection =
  | { kind: 'keychain' }
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'none' };

/** How to unlock an existing workspace. Keychain workspaces need nothing; a recovery key stands in for a lost keychain entry (D28). */
export type Unlock =
  | { kind: 'keychain' }
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'recovery'; recoveryKey: string }
  | { kind: 'none' };

/**
 * Something the user must be told, in one line (D28, round 2). A repair is
 * never silent, and a failed one points at the recovery key.
 */
export type WorkspaceNotice =
  | { kind: 'keychain-restored'; workspaceId: string; name: string }
  | { kind: 'keychain-restore-failed'; workspaceId: string; name: string; message: string };

export interface OpenWorkspace {
  id: string;
  name: string;
  custody: RegistryCustody;
  encrypted: boolean;
  ws: Workspace;
}

export interface WorkspaceManagerOptions {
  /** The app's data directory: the registry and new workspace databases live under it. */
  dataDir: string;
  secrets: SecretStore;
  onNotice?: (notice: WorkspaceNotice) => void;
  now?: () => number;
}

/** The keychain entry for this workspace is gone, and the workspace can be opened with its recovery key. */
export class NeedsRecoveryKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NeedsRecoveryKeyError';
  }
}

export class WorkspaceManager {
  private current: OpenWorkspace | undefined;
  private readonly registry: string;
  private readonly now: () => number;

  constructor(private readonly opts: WorkspaceManagerOptions) {
    this.registry = join(opts.dataDir, 'workspaces.json');
    this.now = opts.now ?? Date.now;
  }

  get open(): OpenWorkspace | undefined {
    return this.current;
  }

  list(): WorkspaceListing[] {
    return readRegistry(this.registry).map((e) => ({ id: e.id, label: this.labelOf(e), custody: e.custody, createdAt: e.createdAt, path: e.path }));
  }

  /**
   * Creates a workspace and opens it, closing the one that was open. Returns
   * the recovery key for a keychain workspace: shown once, to be copied,
   * never saved to a file (round 2).
   */
  async create(name: string, protection: Protection, beforeSwitch?: () => Promise<void>): Promise<{ workspace: OpenWorkspace; recoveryKey: string | null }> {
    const id = randomUUID();
    const dir = join(this.opts.dataDir, 'workspaces');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.db`);
    const custody: Custody = protection;
    const ws = createWorkspaceDb({ path, workspaceId: id, name, custody, secrets: this.opts.secrets, now: this.now });
    const entry: RegistryEntry = {
      id, path, custody: protection.kind, createdAt: this.now(),
      // D29: a passphrase workspace's name lives only inside its database.
      ...(protection.kind === 'passphrase' ? {} : { name }),
    };
    try {
      addToRegistry(this.registry, entry);
    } catch (e) {
      ws.close();
      throw e;
    }
    const workspace = await this.switchTo({ id, name, custody: protection.kind, encrypted: ws.encrypted, ws }, beforeSwitch);
    return { workspace, recoveryKey: ws.recoveryKey };
  }

  /**
   * Makes an already-open workspace the current one. `beforeSwitch` runs only
   * now, once nothing can fail any more, so a failed open or create leaves
   * the current workspace and its sessions exactly as they were.
   */
  private async switchTo(next: OpenWorkspace, beforeSwitch?: () => Promise<void>): Promise<OpenWorkspace> {
    try {
      await beforeSwitch?.();
    } catch (e) {
      next.ws.close();
      throw e;
    }
    this.close();
    this.current = next;
    return next;
  }

  /**
   * Opens a registered workspace, closing the one that was open. A keychain
   * workspace whose entry cannot be read raises NeedsRecoveryKeyError; opened
   * with its recovery key instead, its entry is then restored and the user
   * told (D28 self-repair).
   */
  async openWorkspace(id: string, unlock: Unlock, beforeSwitch?: () => Promise<void>): Promise<OpenWorkspace> {
    const entry = readRegistry(this.registry).find((e) => e.id === id);
    if (!entry) throw new InvalidWorkspaceRequestError(`workspace ${id} is not registered`);
    const allowed: Record<RegistryCustody, Unlock['kind'][]> = { none: ['none'], keychain: ['keychain', 'recovery'], passphrase: ['passphrase'] };
    if (!allowed[entry.custody].includes(unlock.kind)) {
      throw new InvalidWorkspaceRequestError(`workspace ${id} is ${entry.custody}-protected and cannot be opened with ${unlock.kind}`);
    }
    let ws: Workspace;
    try {
      ws = openWorkspaceDb({ path: entry.path, workspaceId: id, custody: unlock, secrets: this.opts.secrets, now: this.now });
    } catch (e) {
      if (e instanceof KeyMissingError) throw new NeedsRecoveryKeyError(e.message, { cause: e });
      throw e;
    }
    const name = (ws.db.prepare('SELECT name FROM workspace_meta WHERE id = 1').get() as { name: string }).name;
    const opened = await this.switchTo({ id, name, custody: entry.custody, encrypted: ws.encrypted, ws }, beforeSwitch);
    this.checkKeychainEntry();
    return opened;
  }

  /** Closes the open workspace, checking its keychain entry first (D28). Connections must already be closed. */
  close(): void {
    const open = this.current;
    if (!open) return;
    this.checkKeychainEntry();
    this.current = undefined;
    open.ws.close();
  }

  /**
   * D28 self-repair: a keychain workspace reads its entry back; a missing one
   * is written again from the key held in memory, confirmed, and reported.
   * A failed repair is reported with a pointer to the recovery key, and is not
   * retried behind the user's back.
   */
  private checkKeychainEntry(): void {
    const open = this.current;
    if (!open || open.custody !== 'keychain') return;
    if (this.opts.secrets.get(workspaceKeyAccount(open.id)) !== null) return;
    try {
      open.ws.storeKeyInKeychain();
      this.opts.onNotice?.({ kind: 'keychain-restored', workspaceId: open.id, name: open.name });
    } catch (e) {
      this.opts.onNotice?.({ kind: 'keychain-restore-failed', workspaceId: open.id, name: open.name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private labelOf(e: RegistryEntry): string {
    // The open workspace is unlocked, so its name may be shown even when the registry has none.
    return this.current?.id === e.id ? this.current.name : registryLabel(e);
  }
}
