import type { DraftAckPatch, DraftBundle, RelayClient } from '@kaitox/relay-protocol';
import type { PublishArticleCheckpoint, PublishArticleResume } from '@kaitox/x-article';
import { CONTENT_OS_TARGET_HANDLE } from './content-os-protocol.js';
import {
  createUploadQueueClient,
  type UploadClaim,
  type UploadQueueClient,
  type UploadQueueStatus,
} from './upload-queue.js';
import { uploadDraft, type UploadDraftOptions, type UploadResult } from './uploader.js';
import { getRelayClient } from './xsession.js';

const REQUIRED_HANDLE = CONTENT_OS_TARGET_HANDLE;
const REQUIRED_HANDLE_BARE = REQUIRED_HANDLE.slice(1).toLowerCase();
const PROFILE_LINK_SELECTOR = 'a[data-testid="AppTabBar_Profile_Link"]';
const PROFILE_WAIT_MS = 10_000;
const PROFILE_POLL_MS = 100;
const LEASE_RENEW_MS = 10_000;
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

type StoredCheckpointStage = PublishArticleCheckpoint['stage'] | 'ready-to-ack';

interface StoredUploadCheckpoint {
  version: 3;
  targetHandle: typeof REQUIRED_HANDLE;
  stage: StoredCheckpointStage;
  restId?: string;
  editUrl?: string;
  mediaMap: Record<string, string>;
  coverMediaId?: string;
  updatedAt: string;
}

export interface UploadQueuedDraftDeps {
  client: UploadClient;
  queueClient: UploadQueueClient;
  getClaim: () => UploadClaim;
  assertLease: () => Promise<void>;
  assertTargetHandle?: (bundle: DraftBundle) => Promise<string> | string;
  uploadDraft?: (
    bundle: DraftBundle,
    client: UploadClient,
    onProgress?: (message: string) => void,
    options?: UploadDraftOptions,
  ) => Promise<UploadResult>;
  onProgress?: (message: string) => void;
}

export interface ActiveTargetHandleOptions {
  timeoutMs?: number;
  pollMs?: number;
  readProfileHref?: () => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunQueuedDraftDeps extends Omit<UploadQueuedDraftDeps, 'queueClient' | 'getClaim' | 'assertLease'> {
  queueClient?: UploadQueueClient;
  renewMs?: number;
}

export interface RunAutoUploadDeps {
  pathname?: string;
  queueClient?: UploadQueueClient;
  getClient?: () => Promise<UploadClient>;
  navigate?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  uploadDeps?: Omit<RunQueuedDraftDeps, 'client' | 'queueClient'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDeclaredHandle(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^@[A-Za-z0-9_]{1,15}$/.test(value)) {
    throw new Error(`${label} 格式无效，必须是 @handle`);
  }
  return value.slice(1).toLowerCase();
}

export function validateDeclaredTargetHandles(bundle: DraftBundle): typeof REQUIRED_HANDLE {
  const declarations: Array<{ label: string; value: unknown }> = [];
  if (bundle.targetHandle !== undefined) {
    declarations.push({ label: 'bundle.targetHandle', value: bundle.targetHandle });
  }

  const sourceMeta = bundle.sourceMeta;
  const hasSourceMetaTarget = isRecord(sourceMeta)
    && Object.prototype.hasOwnProperty.call(sourceMeta, 'targetHandle');
  if (hasSourceMetaTarget) {
    declarations.push({ label: 'bundle.sourceMeta.targetHandle', value: sourceMeta.targetHandle });
  }
  if (bundle.source === 'content-os' && !hasSourceMetaTarget) {
    throw new Error(`Content OS 草稿缺少目标账号 ${REQUIRED_HANDLE}`);
  }
  if (bundle.status === 'done' && bundle.targetHandle === undefined) {
    throw new Error('已完成草稿缺少 bundle.targetHandle');
  }

  const normalized = declarations.map(({ label, value }) => normalizeDeclaredHandle(value, label));
  if (new Set(normalized).size > 1) throw new Error('草稿中的 targetHandle 声明互相冲突');
  if (normalized.some((handle) => handle !== REQUIRED_HANDLE_BARE)) {
    throw new Error(`草稿目标账号必须是 ${REQUIRED_HANDLE}`);
  }
  return REQUIRED_HANDLE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalEditUrl(restId: string): string {
  return `https://x.com/compose/articles/edit/${restId}`;
}

function validRestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function readStrictDone(bundle: DraftBundle): StrictUploadResult | undefined {
  if (bundle.status !== 'done') return undefined;
  const restId = typeof bundle.restId === 'string' ? bundle.restId.trim() : '';
  const editUrl = restId ? canonicalEditUrl(restId) : '';
  if (!validRestId(restId)
    || bundle.targetHandle !== REQUIRED_HANDLE
    || bundle.editUrl !== editUrl) {
    throw new Error('relay 中的已完成草稿缺少严格可验证结果');
  }
  return { restId, editUrl };
}

const CHECKPOINT_STAGES = new Set<StoredCheckpointStage>([
  'create-started',
  'draft-created',
  'title-updated',
  'images-uploaded',
  'content-updated',
  'cover-uploaded',
  'cover-updated',
  'ready-to-ack',
]);

function readMediaMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([src, mediaId]) => !src || typeof mediaId !== 'string' || !mediaId)) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function readStoredCheckpoint(value: unknown): StoredUploadCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('上传恢复检查点损坏，已拒绝重新创建 X 草稿');

  const restId = typeof value.restId === 'string' ? value.restId.trim() : '';
  if (value.version === 1
    && value.targetHandle === REQUIRED_HANDLE
    && validRestId(restId)
    && value.editUrl === canonicalEditUrl(restId)) {
    return {
      version: 3,
      targetHandle: REQUIRED_HANDLE,
      restId,
      editUrl: canonicalEditUrl(restId),
      stage: 'ready-to-ack',
      mediaMap: {},
      updatedAt: new Date(0).toISOString(),
    };
  }

  const mediaMap = readMediaMap(value.mediaMap);
  if (value.version === 3
    && value.targetHandle === REQUIRED_HANDLE
    && value.stage === 'create-started'
    && value.restId === undefined
    && value.editUrl === undefined
    && mediaMap
    && Object.keys(mediaMap).length === 0
    && value.coverMediaId === undefined
    && typeof value.updatedAt === 'string'
    && Number.isFinite(Date.parse(value.updatedAt))) {
    return { ...value, mediaMap } as unknown as StoredUploadCheckpoint;
  }

  if ((value.version !== 2 && value.version !== 3)
    || value.targetHandle !== REQUIRED_HANDLE
    || !validRestId(restId)
    || value.editUrl !== canonicalEditUrl(restId)
    || typeof value.stage !== 'string'
    || !CHECKPOINT_STAGES.has(value.stage as StoredCheckpointStage)
    || !mediaMap
    || (value.coverMediaId !== undefined && (typeof value.coverMediaId !== 'string' || !value.coverMediaId))
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('上传恢复检查点损坏，已拒绝重新创建 X 草稿');
  }
  return { ...value, version: 3, restId, mediaMap } as unknown as StoredUploadCheckpoint;
}

function storedCheckpoint(
  checkpoint: PublishArticleCheckpoint,
  stage: StoredCheckpointStage = checkpoint.stage,
): StoredUploadCheckpoint {
  if (checkpoint.stage === 'create-started') {
    return {
      version: 3,
      targetHandle: REQUIRED_HANDLE,
      stage,
      mediaMap: {},
      updatedAt: new Date().toISOString(),
    };
  }
  if (!validRestId(checkpoint.restId)) throw new Error('X 草稿检查点缺少有效 rest_id');
  return {
    version: 3,
    targetHandle: REQUIRED_HANDLE,
    restId: checkpoint.restId,
    editUrl: canonicalEditUrl(checkpoint.restId),
    stage,
    mediaMap: { ...checkpoint.mediaMap },
    coverMediaId: checkpoint.coverMediaId,
    updatedAt: new Date().toISOString(),
  };
}

function checkpointResume(checkpoint: StoredUploadCheckpoint | undefined): PublishArticleResume | undefined {
  if (!checkpoint) return undefined;
  if (checkpoint.stage === 'create-started') {
    throw new Error('X 草稿创建结果不确定，必须人工核对 X Articles 后再处理，已拒绝自动重建');
  }
  if (!checkpoint.restId) throw new Error('上传恢复检查点损坏，已拒绝重新创建 X 草稿');
  return {
    restId: checkpoint.restId,
    mediaMap: checkpoint.mediaMap,
    coverMediaId: checkpoint.coverMediaId,
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
  validateDeclaredTargetHandles(bundle);

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

export async function uploadQueuedDraft(id: string, deps: UploadQueuedDraftDeps): Promise<StrictUploadResult> {
  const activeClaim = () => {
    const claim = deps.getClaim();
    if (claim.draftId !== id) throw new Error('上传租约与草稿不匹配');
    return claim;
  };
  const fencedAck = async (patch: DraftAckPatch) => {
    await deps.assertLease();
    await deps.client.ack(id, patch);
  };
  try {
    const bundle = await deps.client.getDraft(id);
    const targetHandle = await (deps.assertTargetHandle ?? assertActiveTargetHandle)(bundle);
    if (targetHandle !== REQUIRED_HANDLE) throw new Error(`当前 X 账号必须是 ${REQUIRED_HANDLE}`);
    await deps.assertLease();

    const completed = readStrictDone(bundle);
    if (completed) {
      await deps.queueClient.removeCheckpoint(activeClaim());
      return completed;
    }

    await fencedAck({ status: 'uploading' });
    const checkpoint = readStoredCheckpoint(await deps.queueClient.getCheckpoint(activeClaim()));
    if (checkpoint?.stage === 'ready-to-ack') {
      if (!checkpoint.restId || !checkpoint.editUrl) {
        throw new Error('上传恢复检查点损坏，已拒绝重新创建 X 草稿');
      }
      await fencedAck({
        status: 'done',
        targetHandle: REQUIRED_HANDLE,
        restId: checkpoint.restId,
        editUrl: checkpoint.editUrl,
      });
      await deps.queueClient.removeCheckpoint(activeClaim());
      return { restId: checkpoint.restId, editUrl: checkpoint.editUrl };
    }

    const result = await (deps.uploadDraft ?? uploadDraft)(bundle, deps.client, deps.onProgress, {
      resume: checkpointResume(checkpoint),
      beforeRemoteMutation: deps.assertLease,
      onCheckpoint: async (next) => {
        await deps.queueClient.setCheckpoint(activeClaim(), storedCheckpoint(next));
      },
    });
    const restId = typeof result.restId === 'string' ? result.restId.trim() : '';
    if (!validRestId(restId)) throw new Error('X 草稿不完整或缺少 rest_id');
    if (result.skippedImages.length > 0) {
      throw new Error(`X 草稿不完整，跳过了 ${result.skippedImages.length} 张图片`);
    }

    const latest = readStoredCheckpoint(await deps.queueClient.getCheckpoint(activeClaim()));
    const ready = storedCheckpoint({
      stage: latest?.stage === 'cover-updated' ? 'cover-updated' : 'content-updated',
      restId,
      mediaMap: latest?.mediaMap ?? {},
      coverMediaId: latest?.coverMediaId,
    }, 'ready-to-ack');
    await deps.queueClient.setCheckpoint(activeClaim(), ready);
    if (!ready.restId || !ready.editUrl) throw new Error('X 草稿检查点缺少有效 rest_id');
    await fencedAck({
      status: 'done',
      targetHandle: REQUIRED_HANDLE,
      restId: ready.restId,
      editUrl: ready.editUrl,
    });
    await deps.queueClient.removeCheckpoint(activeClaim());
    return { restId: ready.restId, editUrl: ready.editUrl };
  } catch (error) {
    const failedPatch: DraftAckPatch = { status: 'failed', error: errorMessage(error) };
    await fencedAck(failedPatch).catch(() => {});
    throw error;
  }
}

async function runClaimedUpload(
  claim: UploadClaim,
  deps: RunQueuedDraftDeps,
): Promise<StrictUploadResult> {
  const queueClient = deps.queueClient ?? createUploadQueueClient();
  let currentClaim = claim;
  let leaseError: Error | undefined;
  const renew = async () => {
    try {
      const renewed = await queueClient.renew(currentClaim);
      if (!renewed) leaseError = new Error('上传租约已失效，请从面板恢复');
      else currentClaim = renewed;
    } catch (error) {
      leaseError = error instanceof Error ? error : new Error(String(error));
    }
  };
  const timer = setInterval(() => void renew(), deps.renewMs ?? LEASE_RENEW_MS);
  try {
    await renew();
    if (leaseError) throw leaseError;
    const result = await uploadQueuedDraft(claim.draftId, {
      ...deps,
      queueClient,
      getClaim: () => currentClaim,
      assertLease: async () => {
        await renew();
        if (leaseError) throw leaseError;
      },
    });
    if (leaseError) throw leaseError;
    if (!await queueClient.complete(currentClaim)) throw new Error('上传租约已被其他标签页接管');
    return result;
  } catch (error) {
    await queueClient.fail(currentClaim).catch(() => false);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

export async function runQueuedDraftUpload(id: string, deps: RunQueuedDraftDeps): Promise<StrictUploadResult> {
  const queueClient = deps.queueClient ?? createUploadQueueClient();
  const claimed = await queueClient.claim(id);
  if (claimed.status === 'wait') throw new Error('草稿正在另一个标签页上传');
  if (claimed.status === 'empty') throw new Error('无法把草稿加入上传队列');
  return runClaimedUpload(claimed.claim, { ...deps, queueClient });
}

export async function getUploadQueueStatus(
  id: string,
  queueClient: UploadQueueClient = createUploadQueueClient(),
): Promise<UploadQueueStatus> {
  return queueClient.status(id);
}

export async function runAutoUploadFromQueue(deps: RunAutoUploadDeps = {}): Promise<StrictUploadResult | undefined> {
  const pathname = (deps.pathname ?? location.pathname).replace(/\/+$/, '') || '/';
  if (pathname !== '/compose/articles') return undefined;
  const queueClient = deps.queueClient ?? createUploadQueueClient();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let claimed = await queueClient.claim();
  while (claimed.status === 'wait') {
    await sleep(Math.max(1, claimed.retryAt - Date.now()));
    claimed = await queueClient.claim();
  }
  if (claimed.status === 'empty') return undefined;

  const client = await (deps.getClient ?? getRelayClient)();
  const result = await runClaimedUpload(claimed.claim, {
    ...deps.uploadDeps,
    client,
    queueClient,
  });
  (deps.navigate ?? ((url) => location.assign(url)))(result.editUrl);
  return result;
}
