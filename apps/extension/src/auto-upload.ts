import type { DraftAckPatch, DraftBundle, RelayClient } from '@kaitox/relay-protocol';
import { CONTENT_OS_TARGET_HANDLE } from './content-os-protocol.js';
import { uploadDraft, type UploadResult } from './uploader.js';
import { getRelayClient } from './xsession.js';

const AUTO_UPLOAD_DRAFT_KEY = 'kaitoxAutoUploadDraftId';
const RESULT_KEY_PREFIX = 'kaitoxAutoUploadResult:';
const REQUIRED_HANDLE = CONTENT_OS_TARGET_HANDLE;
const REQUIRED_HANDLE_BARE = REQUIRED_HANDLE.slice(1).toLowerCase();
const PROFILE_LINK_SELECTOR = 'a[data-testid="AppTabBar_Profile_Link"]';
const PROFILE_WAIT_MS = 10_000;
const PROFILE_POLL_MS = 100;
const RESERVED_X_PATHS = new Set([
  'compose',
  'explore',
  'home',
  'i',
  'messages',
  'notifications',
  'search',
  'settings',
]);

type UploadClient = Pick<RelayClient, 'ack' | 'getAsset' | 'getDraft'>;

export interface StrictUploadResult {
  restId: string;
  editUrl: string;
}

interface StoredUploadResult extends StrictUploadResult {
  version: 1;
  targetHandle: typeof REQUIRED_HANDLE;
}

export interface UploadResultStore {
  get(id: string): Promise<unknown>;
  set(id: string, result: StoredUploadResult): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface UploadQueuedDraftDeps {
  client: UploadClient;
  assertTargetHandle?: (bundle: DraftBundle) => Promise<string> | string;
  uploadDraft?: (
    bundle: DraftBundle,
    client: UploadClient,
    onProgress?: (message: string) => void,
  ) => Promise<UploadResult>;
  resultStore?: UploadResultStore;
  onProgress?: (message: string) => void;
}

export interface ActiveTargetHandleOptions {
  timeoutMs?: number;
  pollMs?: number;
  readProfileHref?: () => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface AutoUploadStorage {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
}

export interface RunAutoUploadDeps {
  pathname?: string;
  storage?: AutoUploadStorage;
  getClient?: () => Promise<UploadClient>;
  navigate?: (url: string) => void;
  uploadDeps?: Omit<UploadQueuedDraftDeps, 'client'>;
}

function normalizeHandle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bare = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? bare.toLowerCase() : undefined;
}

function declaredTargetHandle(bundle: DraftBundle): string | undefined {
  return normalizeHandle(bundle.targetHandle ?? bundle.sourceMeta?.targetHandle);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalEditUrl(restId: string): string {
  return `https://x.com/compose/articles/edit/${restId}`;
}

function readStrictDone(bundle: DraftBundle): StrictUploadResult | undefined {
  if (bundle.status !== 'done') return undefined;
  const restId = typeof bundle.restId === 'string' ? bundle.restId.trim() : '';
  const editUrl = restId ? canonicalEditUrl(restId) : '';
  if (normalizeHandle(bundle.targetHandle) !== REQUIRED_HANDLE_BARE
    || !restId
    || bundle.editUrl !== editUrl) {
    throw new Error('relay 中的已完成草稿缺少严格可验证结果');
  }
  return { restId, editUrl };
}

function readStoredResult(value: unknown): StoredUploadResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const restId = typeof record.restId === 'string' ? record.restId.trim() : '';
  if (record.version !== 1
    || record.targetHandle !== REQUIRED_HANDLE
    || !/^[A-Za-z0-9_-]+$/.test(restId)
    || record.editUrl !== canonicalEditUrl(restId)) {
    return undefined;
  }
  return record as unknown as StoredUploadResult;
}

function chromeResultStore(): UploadResultStore {
  return {
    async get(id) {
      const key = `${RESULT_KEY_PREFIX}${id}`;
      return (await chrome.storage.local.get(key))[key];
    },
    async set(id, result) {
      await chrome.storage.local.set({ [`${RESULT_KEY_PREFIX}${id}`]: result });
    },
    async remove(id) {
      await chrome.storage.local.remove(`${RESULT_KEY_PREFIX}${id}`);
    },
  };
}

export function readActiveHandleFromHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, 'https://x.com');
  } catch {
    return undefined;
  }
  if (url.origin !== 'https://x.com') return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return undefined;
  const handle = segments[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || RESERVED_X_PATHS.has(handle.toLowerCase())) {
    return undefined;
  }
  return handle;
}

export async function assertActiveTargetHandle(
  bundle: DraftBundle,
  options: ActiveTargetHandleOptions = {},
): Promise<typeof REQUIRED_HANDLE> {
  const declared = declaredTargetHandle(bundle);
  if (declared && declared !== REQUIRED_HANDLE_BARE) {
    throw new Error(`草稿目标账号必须是 ${REQUIRED_HANDLE}，当前为 @${declared}`);
  }

  const timeoutMs = options.timeoutMs ?? PROFILE_WAIT_MS;
  const pollMs = options.pollMs ?? PROFILE_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readProfileHref = options.readProfileHref ?? (() => (
    document.querySelector<HTMLAnchorElement>(PROFILE_LINK_SELECTOR)?.getAttribute('href') ?? undefined
  ));
  const startedAt = now();

  while (true) {
    const active = readActiveHandleFromHref(readProfileHref());
    if (active) {
      if (active.toLowerCase() !== REQUIRED_HANDLE_BARE) {
        throw new Error(`当前 X 账号是 @${active}，必须切换到 ${REQUIRED_HANDLE} 后再上传`);
      }
      return REQUIRED_HANDLE;
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`无法确认当前 X 账号，必须登录 ${REQUIRED_HANDLE} 后再上传`);
    }
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (now() - startedAt))));
  }
}

const activeUploads = new Map<string, Promise<StrictUploadResult>>();

async function performQueuedUpload(id: string, deps: UploadQueuedDraftDeps): Promise<StrictUploadResult> {
  const resultStore = deps.resultStore ?? chromeResultStore();
  try {
    const bundle = await deps.client.getDraft(id);
    const completed = readStrictDone(bundle);
    if (completed) {
      await resultStore.remove(id);
      return completed;
    }

    await deps.client.ack(id, { status: 'uploading' });
    const targetHandle = await (deps.assertTargetHandle ?? assertActiveTargetHandle)(bundle);
    if (normalizeHandle(targetHandle) !== REQUIRED_HANDLE_BARE) {
      throw new Error(`当前 X 账号必须是 ${REQUIRED_HANDLE}`);
    }

    const stored = readStoredResult(await resultStore.get(id));
    if (stored) {
      await deps.client.ack(id, {
        status: 'done',
        targetHandle: REQUIRED_HANDLE,
        restId: stored.restId,
        editUrl: stored.editUrl,
      });
      await resultStore.remove(id);
      return { restId: stored.restId, editUrl: stored.editUrl };
    }
    await resultStore.remove(id);

    const result = await (deps.uploadDraft ?? uploadDraft)(bundle, deps.client, deps.onProgress);
    const restId = typeof result.restId === 'string' ? result.restId.trim() : '';
    if (!/^[A-Za-z0-9_-]+$/.test(restId)) {
      throw new Error('X 草稿不完整或缺少 rest_id');
    }
    if (result.skippedImages.length > 0) {
      throw new Error(`X 草稿不完整，跳过了 ${result.skippedImages.length} 张图片`);
    }

    const storedResult: StoredUploadResult = {
      version: 1,
      targetHandle: REQUIRED_HANDLE,
      restId,
      editUrl: canonicalEditUrl(restId),
    };
    await resultStore.set(id, storedResult);
    await deps.client.ack(id, {
      status: 'done',
      targetHandle: REQUIRED_HANDLE,
      restId: storedResult.restId,
      editUrl: storedResult.editUrl,
    });
    await resultStore.remove(id);
    return { restId: storedResult.restId, editUrl: storedResult.editUrl };
  } catch (error) {
    const failedPatch: DraftAckPatch = { status: 'failed', error: errorMessage(error) };
    await deps.client.ack(id, failedPatch).catch(() => {});
    throw error;
  }
}

export function uploadQueuedDraft(id: string, deps: UploadQueuedDraftDeps): Promise<StrictUploadResult> {
  const existing = activeUploads.get(id);
  if (existing) return existing;
  const promise = performQueuedUpload(id, deps);
  activeUploads.set(id, promise);
  void promise.finally(() => {
    if (activeUploads.get(id) === promise) activeUploads.delete(id);
  }).catch(() => {});
  return promise;
}

let takeQueue: Promise<void> = Promise.resolve();

export function takeAutoUploadDraftId(storage: AutoUploadStorage): Promise<string | undefined> {
  const result = takeQueue.then(async () => {
    const value = (await storage.get(AUTO_UPLOAD_DRAFT_KEY))[AUTO_UPLOAD_DRAFT_KEY];
    await storage.remove(AUTO_UPLOAD_DRAFT_KEY);
    return typeof value === 'string' && value.trim() ? value : undefined;
  });
  takeQueue = result.then(() => {}, () => {});
  return result;
}

export async function runAutoUploadFromQueue(deps: RunAutoUploadDeps = {}): Promise<StrictUploadResult | undefined> {
  const pathname = (deps.pathname ?? location.pathname).replace(/\/+$/, '') || '/';
  if (pathname !== '/compose/articles') return undefined;
  const storage = deps.storage ?? chrome.storage.local;
  const id = await takeAutoUploadDraftId(storage);
  if (!id) return undefined;
  const client = await (deps.getClient ?? getRelayClient)();
  const result = await uploadQueuedDraft(id, { ...deps.uploadDeps, client });
  (deps.navigate ?? ((url) => location.assign(url)))(result.editUrl);
  return result;
}
