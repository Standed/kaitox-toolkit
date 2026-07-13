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
export const BUNDLE_URL = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9._~-]+\.js/g;
export const QUERY_ID_CACHE_KEY = 'articleQueryIds';
export const QUERY_ID_FAILURE_CACHE_KEY = 'articleQueryIdsFailure';
export const QUERY_ID_TTL_MS = 86_400_000;
export const QUERY_ID_FAILURE_TTL_MS = 300_000;
export const DEFAULT_DISCOVERY_FETCH_TIMEOUT_MS = 5_000;

type ArticleOperation = (typeof REQUIRED_OPERATIONS)[number];

interface QueryIdCache {
  ids: ArticleQueryIds;
  fetchedAt: number;
  ttlMs: number;
}

interface QueryIdFailureCache {
  failedAt: number;
  ttlMs: number;
  message: string;
}

interface CacheState {
  ids?: ArticleQueryIds;
  fresh: boolean;
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
  resourceUrls?: readonly string[];
  forceRefresh?: boolean;
  fetchTimeoutMs?: number;
  maxBundleFetches?: number;
}

interface RefreshableResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
  clone?: () => RefreshableResponse;
}

const OPERATION_SET = new Set<string>(REQUIRED_OPERATIONS);
const PROPERTY_NAME = (name: string) => `["']?${name}["']?\\s*:\\s*`;
const STRING_VALUE = `["']([^"']+)["']`;
const OPERATION_NOT_FOUND =
  /(?:operation|persisted\s*query).{0,120}(?:not[ _-]?found|unknown|not recognized)|(?:not[ _-]?found|unknown).{0,120}operation|OperationNotFound|PersistedQueryNotFound/i;
let discoveryInFlight: Promise<ArticleQueryIds> | undefined;

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

function defaultResourceUrls(): string[] {
  try {
    return performance.getEntriesByType('resource').map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readCache(storage: StorageArea | undefined, now: number): Promise<CacheState> {
  if (!storage) return { fresh: false };
  try {
    const raw = (await storage.get(QUERY_ID_CACHE_KEY))[QUERY_ID_CACHE_KEY] as Partial<QueryIdCache> | undefined;
    if (!raw || !isCompleteQueryIds(raw.ids) || raw.ttlMs !== QUERY_ID_TTL_MS) return { fresh: false };
    const age = now - Number(raw.fetchedAt);
    return { ids: raw.ids, fresh: age >= 0 && age < raw.ttlMs };
  } catch {
    return { fresh: false };
  }
}

async function readRecentFailure(storage: StorageArea | undefined, now: number): Promise<QueryIdFailureCache | undefined> {
  if (!storage) return undefined;
  try {
    const raw = (await storage.get(QUERY_ID_FAILURE_CACHE_KEY))[QUERY_ID_FAILURE_CACHE_KEY] as Partial<QueryIdFailureCache> | undefined;
    const age = raw ? now - Number(raw.failedAt) : Number.POSITIVE_INFINITY;
    if (
      raw &&
      raw.ttlMs === QUERY_ID_FAILURE_TTL_MS &&
      typeof raw.message === 'string' &&
      age >= 0 &&
      age < raw.ttlMs
    ) {
      return raw as QueryIdFailureCache;
    }
  } catch {
    // Storage failures should not block live discovery.
  }
  return undefined;
}

async function removeStoredState(storage: StorageArea | undefined): Promise<void> {
  if (!storage) return;
  try {
    await Promise.all([
      storage.remove(QUERY_ID_CACHE_KEY),
      storage.remove(QUERY_ID_FAILURE_CACHE_KEY),
    ]);
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
    await storage.remove(QUERY_ID_FAILURE_CACHE_KEY);
  } catch {
    // A successful discovery remains usable for this upload without storage.
  }
}

async function writeFailure(storage: StorageArea | undefined, error: unknown, failedAt: number): Promise<void> {
  if (!storage) return;
  try {
    await storage.set({
      [QUERY_ID_FAILURE_CACHE_KEY]: {
        failedAt,
        ttlMs: QUERY_ID_FAILURE_TTL_MS,
        message: error instanceof Error ? error.message : String(error),
      } satisfies QueryIdFailureCache,
    });
  } catch {
    // Failure caching is an optimization; callers still receive the fallback.
  }
}

export function extractArticleOperations(source: string): Partial<ArticleQueryIds> {
  const found: Partial<ArticleQueryIds> = {};
  const queryThenOperation = new RegExp(
    `${PROPERTY_NAME('queryId')}${STRING_VALUE}[^{};]{0,2000}?${PROPERTY_NAME('operationName')}${STRING_VALUE}`,
    'g',
  );
  const operationThenQuery = new RegExp(
    `${PROPERTY_NAME('operationName')}${STRING_VALUE}[^{};]{0,2000}?${PROPERTY_NAME('queryId')}${STRING_VALUE}`,
    'g',
  );

  for (const match of source.matchAll(queryThenOperation)) {
    const [, queryId, operation] = match;
    if (OPERATION_SET.has(operation)) found[operation as ArticleOperation] = queryId;
  }
  for (const match of source.matchAll(operationThenQuery)) {
    const [, operation, queryId] = match;
    if (OPERATION_SET.has(operation)) found[operation as ArticleOperation] = queryId;
  }
  return found;
}

function bundleUrlsFromSource(source: string): string[] {
  return [...source.matchAll(new RegExp(BUNDLE_URL.source, 'g'))].map((match) => match[0]);
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve X's lazy Articles chunk without evaluating frontend JavaScript. */
export function extractTwitterArticlesBundleUrls(source: string): string[] {
  const urls = new Set(bundleUrlsFromSource(source).filter((url) => /\/bundle\.TwitterArticles\.[^/]+\.js$/.test(url)));
  const runtimePattern = /([A-Za-z_$][\w$]*)\.u\s*=\s*([A-Za-z_$][\w$]*)\s*=>/g;

  for (const runtime of source.matchAll(runtimePattern)) {
    const runtimeVar = runtime[1];
    const chunkParam = runtime[2];
    const start = runtime.index ?? 0;
    const segment = source.slice(start, start + 160_000);
    const publicPath = source.match(new RegExp(`${regexpEscape(runtimeVar)}\\.p\\s*=\\s*["'](https:\\/\\/[^"']+\\/)["']`))?.[1];
    if (!publicPath) continue;

    const chunkIds = [...segment.matchAll(/(?:^|[,{])(\d+):["']bundle\.TwitterArticles["']/g)].map((match) => match[1]);
    const suffix = segment.match(
      new RegExp(`\\}\\)\\[${regexpEscape(chunkParam)}\\]\\+["']([^"']*\\.js)["']`),
    )?.[1];
    if (!suffix) continue;

    for (const chunkId of chunkIds) {
      const values = [...segment.matchAll(new RegExp(`(?:^|[,{])${chunkId}:["']([^"']+)["']`, 'g'))]
        .map((match) => match[1]);
      for (const hash of values) {
        if (hash === 'bundle.TwitterArticles' || !/^[A-Za-z0-9_-]+$/.test(hash)) continue;
        urls.add(`${publicPath}bundle.TwitterArticles.${hash}${suffix}`);
      }
    }
  }
  return [...urls];
}

async function fetchText(
  fetchImpl: DiscoveryFetch,
  url: string,
  credentials: RequestCredentials,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out fetching X discovery resource: ${url}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { credentials, signal: controller.signal });
        return response.ok ? await response.text() : '';
      })(),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function bundlePriority(url: string): number {
  if (url.includes('/bundle.TwitterArticles.')) return 0;
  if (/\/main\.[^/]+\.js$/.test(url)) return 1;
  if (/\/vendor\.[^/]+\.js$/.test(url)) return 2;
  return 3;
}

async function scanCurrentFrontend(options: QueryIdDiscoveryOptions): Promise<ArticleQueryIds> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_DISCOVERY_FETCH_TIMEOUT_MS;
  const maxBundleFetches = options.maxBundleFetches ?? 24;
  const found: Partial<ArticleQueryIds> = {};
  const queued = new Set<string>();
  const fetched = new Set<string>();
  const queue: string[] = [];

  const enqueue = (urls: readonly string[]) => {
    for (const url of urls) {
      const normalized = bundleUrlsFromSource(url)[0];
      if (!normalized || queued.has(normalized)) continue;
      queued.add(normalized);
      queue.push(normalized);
    }
  };
  const inspect = (source: string) => {
    Object.assign(found, extractArticleOperations(source));
    enqueue(bundleUrlsFromSource(source));
    enqueue(extractTwitterArticlesBundleUrls(source));
  };
  const drainQueue = async () => {
    while (queue.length > 0 && fetched.size < maxBundleFetches && !isCompleteQueryIds(found)) {
      queue.sort((left, right) => bundlePriority(left) - bundlePriority(right));
      const batch = queue.splice(0, Math.min(4, maxBundleFetches - fetched.size));
      batch.forEach((url) => fetched.add(url));
      const sources = await Promise.all(batch.map(async (url) => {
        try {
          return await fetchText(fetchImpl, url, 'omit', timeoutMs);
        } catch {
          return '';
        }
      }));
      sources.forEach(inspect);
    }
  };

  enqueue(options.resourceUrls ?? defaultResourceUrls());
  await drainQueue();
  for (const page of options.pages ?? DISCOVERY_PAGES) {
    if (isCompleteQueryIds(found)) break;
    try {
      inspect(await fetchText(fetchImpl, page, 'include', timeoutMs));
    } catch {
      continue;
    }
    await drainQueue();
  }

  if (!isCompleteQueryIds(found)) {
    const missing = REQUIRED_OPERATIONS.filter((operation) => !found[operation]);
    throw new Error(`Unable to discover X Article query IDs: ${missing.join(', ')}`);
  }
  return found;
}

export async function discoverArticleQueryIds(options: QueryIdDiscoveryOptions = {}): Promise<ArticleQueryIds> {
  const storage = options.storage ?? defaultStorage();
  const now = (options.now ?? Date.now)();
  const cached = await readCache(storage, now);

  if (options.forceRefresh) await removeStoredState(storage);
  else {
    if (cached.fresh && cached.ids) return cached.ids;
    const recentFailure = await readRecentFailure(storage, now);
    if (recentFailure) {
      if (cached.ids) return cached.ids;
      throw new Error(`X Article query ID discovery is cooling down: ${recentFailure.message}`);
    }
  }

  if (discoveryInFlight) return discoveryInFlight;
  const staleIds = options.forceRefresh ? undefined : cached.ids;
  const run = scanCurrentFrontend(options)
    .then(async (ids) => {
      await writeCache(storage, ids, now);
      return ids;
    })
    .catch(async (error) => {
      await writeFailure(storage, error, now);
      if (staleIds) return staleIds;
      throw error;
    });
  discoveryInFlight = run;
  void run.finally(() => {
    if (discoveryInFlight === run) discoveryInFlight = undefined;
  }).catch(() => {});
  return run;
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
  beforeMutation?: () => Promise<void>,
): FetchLike {
  return async (input, init) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') await beforeMutation?.();
    const response = (await fetchImpl(input, init)) as RefreshableResponse;
    const operation = operationFromGraphqlUrl(input);
    if (!operation || !(await isStaleOperationResponse(response))) return response;

    const refreshedIds = await refresh();
    Object.assign(queryIds, refreshedIds);
    const retry = replaceQueryIdInRequest(input, init, operation, refreshedIds[operation]);
    if ((retry.init?.method ?? 'GET').toUpperCase() !== 'GET') await beforeMutation?.();
    return fetchImpl(retry.url, retry.init);
  };
}
