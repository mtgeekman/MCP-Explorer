// Applying only the newest of overlapping requests (R06-5): a reply that
// arrives after a later request's reply is dropped, not shown over it, and so
// is a superseded request's failure (R06-13).

/** Returns a runner: each call's `apply` or `fail` runs only if no later call has been made since. */
export function latestOnly() {
  let newest = 0;
  return async <T>(request: Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void): Promise<void> => {
    const mine = ++newest;
    let value: T;
    try {
      value = await request;
    } catch (e) {
      if (mine === newest) fail(e);
      return;
    }
    if (mine === newest) apply(value);
  };
}
