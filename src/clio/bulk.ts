/**
 * Shared runner for the bulk_* tools.
 *
 * Clio has no bulk write endpoint, so a bulk tool is still N API round trips.
 * What it removes is N model turns and N connector calls. Two constraints
 * shape the runner:
 *
 *   - The connector gateway times out a single tool call (~30s observed).
 *     Rather than let a large batch die mid-flight with no report of what was
 *     applied, the runner stops *starting* new items once its time budget is
 *     spent and returns the untouched remainder as `not_attempted`, so the
 *     caller re-submits just those.
 *   - Clio rate-limits per token. Concurrency is kept small; 429s are already
 *     retried with backoff inside the pagination helpers.
 *
 * Per-item failures are isolated: one bad line never aborts the rest.
 */

export const BULK_MAX_ITEMS = 100;
export const BULK_DEFAULT_BUDGET_SECONDS = 22;
export const BULK_MAX_BUDGET_SECONDS = 50;
const BULK_CONCURRENCY = 3;

export interface BulkItemResult<T> {
  /** Position in the caller's input list. */
  index: number;
  id: number;
  status: "ok" | "failed";
  result?: T;
  error?: { message: string; status?: number; context?: string; clio_error?: unknown };
}

export interface BulkOutcome<T> {
  results: Array<BulkItemResult<T>>;
  /** Input ids never started because the time budget ran out. */
  not_attempted: number[];
  summary: { requested: number; succeeded: number; failed: number; not_attempted: number };
  elapsed_ms: number;
}

export function parseIdList(csv: string): number[] {
  const ids: number[] = [];
  for (const raw of csv.split(/[\s,]+/)) {
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid ID "${raw}" in list; expected comma-separated positive integers.`);
    }
    ids.push(n);
  }
  const deduped = Array.from(new Set(ids));
  if (deduped.length === 0) throw new Error("ID list is empty.");
  if (deduped.length > BULK_MAX_ITEMS) {
    throw new Error(
      `${deduped.length} IDs exceeds the per-call cap of ${BULK_MAX_ITEMS}. Split into batches.`,
    );
  }
  return deduped;
}

export async function runBulk<T>(
  ids: number[],
  worker: (id: number) => Promise<T>,
  opts: { budgetSeconds?: number; concurrency?: number; now?: () => number } = {},
): Promise<BulkOutcome<T>> {
  const now = opts.now ?? Date.now;
  const start = now();
  const budgetMs =
    Math.min(opts.budgetSeconds ?? BULK_DEFAULT_BUDGET_SECONDS, BULK_MAX_BUDGET_SECONDS) * 1000;
  const concurrency = Math.max(1, opts.concurrency ?? BULK_CONCURRENCY);

  const results: Array<BulkItemResult<T>> = [];
  let next = 0;

  async function lane(): Promise<void> {
    while (next < ids.length) {
      if (now() - start >= budgetMs) return;
      const index = next++;
      const id = ids[index];
      try {
        results.push({ index, id, status: "ok", result: await worker(id) });
      } catch (err: any) {
        results.push({
          index,
          id,
          status: "failed",
          error: {
            message: err?.message ?? String(err),
            status: err?.response?.status ?? err?.statusCode,
            context: err?.response?.data?.context,
            clio_error: err?.response?.data,
          },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, lane));

  results.sort((a, b) => a.index - b.index);
  const notAttempted = ids.slice(next);
  const succeeded = results.filter((r) => r.status === "ok").length;
  return {
    results,
    not_attempted: notAttempted,
    summary: {
      requested: ids.length,
      succeeded,
      failed: results.length - succeeded,
      not_attempted: notAttempted.length,
    },
    elapsed_ms: now() - start,
  };
}
