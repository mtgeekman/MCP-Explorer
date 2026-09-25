// Applying only the newest of overlapping requests (R06-5): a reply that
// arrives after a later request's reply is dropped, not shown over it.

/** Returns a runner: each call's `apply` runs only if no later call has been made since. */
export function latestOnly() {
  let newest = 0;
  return async <T>(request: Promise<T>, apply: (value: T) => void): Promise<void> => {
    const mine = ++newest;
    const value = await request;
    if (mine === newest) apply(value);
  };
}
