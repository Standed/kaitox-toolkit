import type { ArticleQueryIds, FetchLike } from '@kaitox/x-article';

export const REQUIRED_OPERATIONS = [
  'ArticleEntityDraftCreate',
  'ArticleEntityUpdateTitle',
  'ArticleEntityUpdateContent',
  'ArticleEntityUpdateCoverMedia',
] as const;
export const DISCOVERY_PAGES = [
  'https://x.com/?lang=en',
  'https://x.com/explore',
  'https://x.com/compose/articles',
] as const;
export const BUNDLE_URL = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9.-]+\.js/g;
export const QUERY_ID_CACHE_KEY = 'articleQueryIds';
export const QUERY_ID_TTL_MS = 86_400_000;

type ArticleOperation = (typeof REQUIRED_OPERATIONS)[number];

interface QueryIdCache {
  ids: ArticleQueryIds;
  fetchedAt: number;
  ttlMs: number;
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface DiscoveryResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type DiscoveryFetch = (input: string, init?: RequestInit) => Promise<DiscoveryResponse>;

export interface QueryIdDiscoveryOptions {
  fetchImpl?: DiscoveryFetch;
  storage?: StorageArea;
  now?: () => number;
  pages?: readonly string[];
  forceRefresh?: boolean;
}

interface RefreshableResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
  clone?: () => RefreshableResponse;
}

const OPERATION_SET = new Set<string>(REQUIRED_OPERATIONS);
const PROPERTY_TOKEN = /["']?(queryId|operationName)["']?\s*:\s*["']([^"']+)["']/g;
const OPERATION_NOT_FOUND =
  /(?:operation|persisted\s*query).{0,120}(?:not[ _-]?found|unknown|not recognized)|(?:not[ _-]?found|unknown).{0,120}operation|OperationNotFound|PersistedQueryNotFound/i;

function isCompleteQueryIds(value: unknown): value is ArticleQueryIds {
  if (!value || typeof value !== 'object') return false;
  return REQUIRED_OPERATIONS.every((operation) => {
    const queryId = (value as Record<string, unknown>)[operation];
    return typeof queryId === 'string' && queryId.length > 0;
  });
}

function defaultStorage(): StorageArea | undefined {
  try {
    return chrome.storage.local as StorageArea;
  } catch {
    return undefined;
  }
}

function defaultFetch(): DiscoveryFetch {
  return window.fetch.bind(window) as DiscoveryFetch;
}

async function readCache(storage: StorageArea | undefined, now: number): Promise<ArticleQueryIds | undefined> {
  if (!storage) return undefined;
  try {
    const raw = (await storage.get(QUERY_ID_CACHE_KEY))[QUERY_ID_CACHE_KEY] as Partial<QueryIdCache> | undefined;
    const age = raw ? now - Number(raw.fetchedAt) : Number.POSITIVE_INFINITY;
    if (
      raw &&
      isCompleteQueryIds(raw.ids) &&
      raw.ttlMs === QUERY_ID_TTL_MS &&
      age >= 0 &&
      age < raw.ttlMs
    ) {
      return raw.ids;
    }
  } catch {
    // Discovery still works when extension storage is unavailable.
  }
  return undefined;
}

async function removeCache(storage: StorageArea | undefined): Promise<void> {
  if (!storage) return;
  try {
    await storage.remove(QUERY_ID_CACHE_KEY);
  } catch {
    // A storage failure must not prevent a live refresh.
  }
}

async function writeCache(storage: StorageArea | undefined, ids: ArticleQueryIds, fetchedAt: number): Promise<void> {
  if (!storage) return;
  try {
    await storage.set({
      [QUERY_ID_CACHE_KEY]: { ids, fetchedAt, ttlMs: QUERY_ID_TTL_MS } satisfies QueryIdCache,
    });
  } catch {
    // A successful discovery remains usable for this upload without storage.
  }
}

export function extractArticleOperations(source: string): Partial<ArticleQueryIds> {
  const tokens: Array<{ key: string; value: string; index: number }> = [];
  for (const match of source.matchAll(new RegExp(PROPERTY_TOKEN.source, 'g'))) {
    tokens.push({ key: match[1], value: match[2], index: match.index ?? 0 });
  }

  const found: Partial<ArticleQueryIds> = {};
  for (const operationToken of tokens) {
    if (operationToken.key !== 'operationName' || !OPERATION_SET.has(operationToken.value)) continue;
    const nearestQueryId = tokens
      .filter((token) => token.key === 'queryId' && Math.abs(token.index - operationToken.index) <= 1_000)
      .sort(
        (left, right) =>
          Math.abs(left.index - operationToken.index) - Math.abs(right.index - operationToken.index),
      )[0];
    if (nearestQueryId) found[operationToken.value as ArticleOperation] = nearestQueryId.value;
  }
  return found;
}

export async function discoverArticleQueryIds(options: QueryIdDiscoveryOptions = {}): Promise<ArticleQueryIds> {
  const storage = options.storage ?? defaultStorage();
  const now = (options.now ?? Date.now)();
  if (options.forceRefresh) await removeCache(storage);
  else {
    const cached = await readCache(storage, now);
    if (cached) return cached;
  }

  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const found: Partial<ArticleQueryIds> = {};
  const seenBundles = new Set<string>();

  for (const page of options.pages ?? DISCOVERY_PAGES) {
    let html: string;
    try {
      const response = await fetchImpl(page, { credentials: 'include' });
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    }

    Object.assign(found, extractArticleOperations(html));
    if (isCompleteQueryIds(found)) break;

    const pageBundles = [...html.matchAll(new RegExp(BUNDLE_URL.source, 'g'))]
      .map((match) => match[0])
      .filter((url) => {
        if (seenBundles.has(url)) return false;
        seenBundles.add(url);
        return true;
      });

    for (let offset = 0; offset < pageBundles.length; offset += 4) {
      const sources = await Promise.all(
        pageBundles.slice(offset, offset + 4).map(async (url) => {
          try {
            const response = await fetchImpl(url, { credentials: 'omit' });
            return response.ok ? await response.text() : '';
          } catch {
            return '';
          }
        }),
      );
      for (const source of sources) Object.assign(found, extractArticleOperations(source));
      if (isCompleteQueryIds(found)) break;
    }
    if (isCompleteQueryIds(found)) break;
  }

  if (!isCompleteQueryIds(found)) {
    const missing = REQUIRED_OPERATIONS.filter((operation) => !found[operation]);
    throw new Error(`Unable to discover X Article query IDs: ${missing.join(', ')}`);
  }
  await writeCache(storage, found, now);
  return found;
}

export async function resolveArticleQueryIds(
  fallback: ArticleQueryIds,
  options: QueryIdDiscoveryOptions = {},
): Promise<ArticleQueryIds> {
  try {
    return await discoverArticleQueryIds(options);
  } catch {
    return fallback;
  }
}

function operationFromGraphqlUrl(url: string): ArticleOperation | undefined {
  if (!url.includes('/i/api/graphql/')) return undefined;
  const operation = url.split(/[?#]/, 1)[0].split('/').pop();
  return operation && OPERATION_SET.has(operation) ? (operation as ArticleOperation) : undefined;
}

async function isStaleOperationResponse(response: RefreshableResponse): Promise<boolean> {
  if (response.status === 404) return true;
  if (!response.clone) return false;
  try {
    return OPERATION_NOT_FOUND.test(await response.clone().text());
  } catch {
    return false;
  }
}

function replaceQueryIdInRequest(
  url: string,
  init: Parameters<FetchLike>[1],
  operation: ArticleOperation,
  queryId: string,
): { url: string; init: Parameters<FetchLike>[1] } {
  const operationSuffix = `/${operation}`;
  const operationIndex = url.indexOf(operationSuffix);
  const queryIdEnd = operationIndex;
  const queryIdStart = url.lastIndexOf('/', queryIdEnd - 1) + 1;
  const nextUrl = `${url.slice(0, queryIdStart)}${queryId}${url.slice(queryIdEnd)}`;
  let body = init?.body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && 'queryId' in parsed) {
        parsed.queryId = queryId;
        body = JSON.stringify(parsed);
      }
    } catch {
      // Keep non-JSON bodies untouched; XArticleClient always sends JSON here.
    }
  }
  return { url: nextUrl, init: { ...init, body } };
}

export function createQueryIdRefreshingFetch(
  fetchImpl: FetchLike,
  queryIds: ArticleQueryIds,
  refresh: () => Promise<ArticleQueryIds>,
): FetchLike {
  return async (input, init) => {
    const response = (await fetchImpl(input, init)) as RefreshableResponse;
    const operation = operationFromGraphqlUrl(input);
    if (!operation || !(await isStaleOperationResponse(response))) return response;

    const refreshedIds = await refresh();
    Object.assign(queryIds, refreshedIds);
    const retry = replaceQueryIdInRequest(input, init, operation, refreshedIds[operation]);
    return fetchImpl(retry.url, retry.init);
  };
}
