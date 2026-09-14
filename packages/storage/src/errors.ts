/**
 * Every storage failure a caller has to tell apart gets its own class. The UI
 * says different things for each: a wrong passphrase is a retry, a missing
 * keychain key is lost data, an unavailable keychain is a platform limitation
 * (D22) that must not look like a failed save.
 *
 * No message here ever includes key material or a passphrase.
 */
export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The key or passphrase does not open this database, or the file is not one. */
export class WrongKeyError extends StorageError {}

/** The keychain answered, and holds no key for this workspace. */
export class KeyMissingError extends StorageError {}

/** No OS credential store is reachable: on Linux, no Secret Service (D22). */
export class SecretStoreUnavailableError extends StorageError {}

/**
 * The store accepted a write or delete but never showed its effect, after every
 * retry. A full Windows Credential Manager refuses writes and hides existing
 * entries; a key that is not confirmed readable must not be used to encrypt
 * anything.
 */
export class SecretWriteUnconfirmedError extends StorageError {}

/** The request itself is invalid: an empty passphrase, a file that already exists. */
export class InvalidWorkspaceRequestError extends StorageError {}
