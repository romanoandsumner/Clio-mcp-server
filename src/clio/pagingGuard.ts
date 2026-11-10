// ============================================================
// Runaway-pagination guard for the "follow meta.paging.next" loops
// (clio/pagination.ts fetchAllPages, clio/grow.ts growFetchAllPages).
// ============================================================
//
// Both loops trust the API's `next` URL and accumulate every page in memory.
// If Clio ever hands back a `next` that points at a page already fetched (a
// self-link or a cycle), the loop never ends and the result array grows until
// the process dies of heap exhaustion — taking every other user's request
// down with it. Nothing in the loop would notice.
//
// The guard fails LOUDLY rather than returning what it has: a silently
// truncated or duplicated result set would feed wrong totals into billing and
// AR figures, which is worse than an error the caller can see.

/** Hard ceiling on pages for one list call (200 rows/page on Manage → 400k rows). */
export const MAX_PAGES_PER_FETCH = 2000;

export class PaginationLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationLoopError";
  }
}

/** Path only — never echo a query string (it can carry cursors/filters) into an error. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0];
  }
}

export interface PagingGuard {
  /**
   * Call with each URL just before requesting it. Throws PaginationLoopError
   * if the URL was already requested in this fetch or the page ceiling is hit.
   */
  visit(url: string): void;
}

export function createPagingGuard(maxPages: number = MAX_PAGES_PER_FETCH): PagingGuard {
  const seen = new Set<string>();
  return {
    visit(url: string): void {
      if (seen.has(url)) {
        throw new PaginationLoopError(
          `Clio pagination loop on ${pathOf(url)}: the API returned a next-page link that was already fetched ` +
            `(after ${seen.size} page(s)). Stopped to avoid an endless fetch; no partial data was returned.`,
        );
      }
      if (seen.size >= maxPages) {
        throw new PaginationLoopError(
          `Clio pagination on ${pathOf(url)} exceeded ${maxPages} pages. Stopped to protect the server; ` +
            `narrow the query (date range, matter, user) and retry.`,
        );
      }
      seen.add(url);
    },
  };
}
