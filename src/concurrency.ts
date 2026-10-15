/**
 * Run `fn` over `items` with at most `limit` in flight, settling each one.
 *
 * Used to load every worker group's dictionary for the "All worker groups" scope, and to
 * fan out over the packs inside one group. Firing them all at once is a real hazard
 * rather than a theoretical one: each group costs six API calls plus five per installed
 * pack, and the Cribl Leader answers a burst across ten groups with "Config helper
 * cannot be booted because the leader is under load".
 *
 * Settles rather than rejects, so one group that errors (under load, or a fleet the user
 * cannot read) does not blank out the groups that loaded fine. Results come back in input
 * order no matter what order they finish in.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  if (items.length === 0) {
    return results;
  }

  // A shared cursor rather than fixed slices, so one slow group doesn't idle a worker
  // that could be starting the next one.
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
