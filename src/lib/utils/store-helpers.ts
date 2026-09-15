/**
 * Store helper utilities — shared patterns for Svelte store management.
 */

import type { Writable } from "svelte/store";
import { get } from "svelte/store";

/**
 * Last-wins token for module-level stores that are cleared on project
 * switch. A fetch captures `next()` at start and only writes when its
 * token is still current; `invalidate()` (typically from `clearXState`)
 * drops every in-flight response so project B cannot land on project A.
 */
export interface FetchGuard {
  next(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createFetchGuard(): FetchGuard {
  let current = 0;
  return {
    next: () => ++current,
    invalidate: () => {
      current++;
    },
    isCurrent: (token: number) => token === current,
  };
}

/**
 * Fetch data from an async API call and update a store, with loading state management.
 * On error, sets the store to the provided fallback value.
 *
 * @param store   The writable store to update with fetched data.
 * @param loading A writable boolean store set to true while fetching.
 * @param fetcher Async function that returns the data to store.
 * @param fallback Value to set on the store if the fetcher throws.
 * @param guard   Optional last-wins guard; stale responses neither write
 *                the store nor clear the loading flag of a newer fetch.
 */
export async function fetchIntoStore<T>(
  store: Writable<T>,
  loading: Writable<boolean>,
  fetcher: () => Promise<T>,
  fallback: T,
  guard?: FetchGuard,
): Promise<void> {
  const token = guard?.next();
  loading.set(true);
  try {
    const data = await fetcher();
    if (guard && token !== undefined && !guard.isCurrent(token)) return;
    store.set(data);
  } catch {
    if (guard && token !== undefined && !guard.isCurrent(token)) return;
    store.set(fallback);
  } finally {
    if (!guard || token === undefined || guard.isCurrent(token)) {
      loading.set(false);
    }
  }
}

/**
 * Fetch a list from an async API call, update the store, and validate
 * that the current selection still exists in the new results.
 *
 * If the selected key is no longer present, clears it to null.
 *
 * @param store       The writable store for the list data.
 * @param loading     A writable boolean store set to true while fetching.
 * @param selectedKey A writable store holding the currently selected item's key.
 * @param fetcher     Async function that returns the list data.
 * @param fallback    Value to set on error.
 * @param getKey      Function to extract a unique key from each item.
 * @param guard       Optional last-wins guard (see {@link createFetchGuard}).
 */
export async function fetchListIntoStore<T>(
  store: Writable<T[]>,
  loading: Writable<boolean>,
  selectedKey: Writable<string | null>,
  fetcher: () => Promise<T[]>,
  fallback: T[],
  getKey: (item: T) => string,
  guard?: FetchGuard,
): Promise<void> {
  const token = guard?.next();
  loading.set(true);
  try {
    const data = await fetcher();
    if (guard && token !== undefined && !guard.isCurrent(token)) return;
    store.set(data);
    const currentKey = get(selectedKey);
    if (currentKey !== null && !data.some((item) => getKey(item) === currentKey)) {
      selectedKey.set(null);
    }
  } catch {
    if (guard && token !== undefined && !guard.isCurrent(token)) return;
    store.set(fallback);
    selectedKey.set(null);
  } finally {
    if (!guard || token === undefined || guard.isCurrent(token)) {
      loading.set(false);
    }
  }
}

/**
 * Fetch a page of results from an async API call.
 *
 * Page 0 replaces the store; subsequent pages append. Sets `hasMore`
 * based on whether the result count equals the page size.
 *
 * @param store    The writable store for the accumulated list data.
 * @param loading  A writable boolean store set to true while fetching.
 * @param hasMore  A writable boolean store tracking if more pages exist.
 * @param page     The page number (0-based). Page 0 replaces, page 1+ appends.
 * @param fetcher  Async function that returns one page of results.
 * @param pageSize Expected page size. hasMore = results.length >= pageSize.
 * @param guard    Optional last-wins guard (see {@link createFetchGuard}).
 */
export async function fetchPageIntoStore<T>(
  store: Writable<T[]>,
  loading: Writable<boolean>,
  hasMore: Writable<boolean>,
  page: number,
  fetcher: () => Promise<T[]>,
  pageSize: number,
  guard?: FetchGuard,
): Promise<void> {
  const token = guard?.next();
  loading.set(true);
  try {
    const data = await fetcher();
    if (guard && token !== undefined && !guard.isCurrent(token)) return;
    if (page === 0) {
      store.set(data);
    } else {
      const current = get(store);
      store.set([...current, ...data]);
    }
    hasMore.set(data.length >= pageSize);
  } catch {
    if (guard && token !== undefined && !guard.isCurrent(token)) return;
    if (page === 0) {
      store.set([]);
    }
    hasMore.set(false);
  } finally {
    if (!guard || token === undefined || guard.isCurrent(token)) {
      loading.set(false);
    }
  }
}
