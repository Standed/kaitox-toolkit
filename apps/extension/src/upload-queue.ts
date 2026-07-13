const UPLOAD_QUEUE_KEY = 'kaitoxUploadQueue';
const LEGACY_UPLOAD_SLOT_KEY = 'kaitoxAutoUploadDraftId';
const CHECKPOINT_KEY_PREFIX = 'kaitoxAutoUploadResult:';
export const DEFAULT_UPLOAD_LEASE_MS = 30_000;
export const UPLOAD_QUEUE_MESSAGE_TYPE = 'KAITOX_UPLOAD_QUEUE';

interface QueueStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface UploadLease {
  token: string;
  owner: string;
  expiresAt: number;
}

interface UploadQueueItem {
  draftId: string;
  enqueuedAt: number;
  lease?: UploadLease;
}

interface StoredUploadQueue {
  version: 1;
  items: UploadQueueItem[];
}

export interface UploadClaim {
  draftId: string;
  token: string;
  leaseExpiresAt: number;
}

export type UploadClaimResult =
  | { status: 'claimed'; claim: UploadClaim }
  | { status: 'wait'; retryAt: number }
  | { status: 'empty' };

export interface UploadQueueStatus {
  state: 'queued' | 'active' | 'absent';
  recoverable: boolean;
  leaseExpiresAt?: number;
}

export interface UploadQueueClient {
  claim(draftId?: string): Promise<UploadClaimResult>;
  renew(claim: UploadClaim): Promise<UploadClaim | undefined>;
  complete(claim: UploadClaim): Promise<boolean>;
  fail(claim: UploadClaim): Promise<boolean>;
  status(draftId: string): Promise<UploadQueueStatus>;
  getCheckpoint(claim: UploadClaim): Promise<unknown>;
  setCheckpoint(claim: UploadClaim, checkpoint: unknown): Promise<void>;
  removeCheckpoint(claim: UploadClaim): Promise<void>;
}

export interface BackgroundUploadQueueOptions {
  now?: () => number;
  leaseMs?: number;
  token?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLease(value: unknown): UploadLease | undefined {
  if (!isRecord(value)
    || typeof value.token !== 'string'
    || !value.token
    || typeof value.owner !== 'string'
    || !value.owner
    || !Number.isFinite(value.expiresAt)) return undefined;
  return { token: value.token, owner: value.owner, expiresAt: Number(value.expiresAt) };
}

function readQueue(value: unknown): StoredUploadQueue {
  if (value === undefined) return { version: 1, items: [] };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) {
    throw new Error('上传队列状态损坏，已停止自动上传');
  }
  const seen = new Set<string>();
  const items = value.items.map((item): UploadQueueItem => {
    if (!isRecord(item)
      || typeof item.draftId !== 'string'
      || !item.draftId.trim()
      || !Number.isFinite(item.enqueuedAt)
      || seen.has(item.draftId)) {
      throw new Error('上传队列状态损坏，已停止自动上传');
    }
    seen.add(item.draftId);
    const lease = item.lease === undefined ? undefined : readLease(item.lease);
    if (item.lease !== undefined && !lease) throw new Error('上传队列租约损坏，已停止自动上传');
    return { draftId: item.draftId, enqueuedAt: Number(item.enqueuedAt), lease };
  });
  return { version: 1, items };
}

export class BackgroundUploadQueue {
  private transition: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly makeToken: () => string;

  constructor(
    private readonly storage: QueueStorageArea,
    options: BackgroundUploadQueueOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_UPLOAD_LEASE_MS;
    this.makeToken = options.token ?? (() => crypto.randomUUID());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation);
    this.transition = result.then(() => {}, () => {});
    return result;
  }

  private async load(): Promise<StoredUploadQueue> {
    const stored = await this.storage.get([UPLOAD_QUEUE_KEY, LEGACY_UPLOAD_SLOT_KEY]);
    const queue = readQueue(stored[UPLOAD_QUEUE_KEY]);
    const legacy = stored[LEGACY_UPLOAD_SLOT_KEY];
    if (typeof legacy === 'string' && legacy.trim() && !queue.items.some((item) => item.draftId === legacy)) {
      queue.items.push({ draftId: legacy, enqueuedAt: this.now() });
      await this.storage.set({ [UPLOAD_QUEUE_KEY]: queue });
    }
    if (legacy !== undefined) await this.storage.remove(LEGACY_UPLOAD_SLOT_KEY);
    return queue;
  }

  private save(queue: StoredUploadQueue): Promise<void> {
    return this.storage.set({ [UPLOAD_QUEUE_KEY]: queue });
  }

  private hasActiveLease(queue: StoredUploadQueue, owner: string, claim: UploadClaim): boolean {
    const lease = queue.items.find((entry) => entry.draftId === claim.draftId)?.lease;
    return Boolean(lease
      && lease.owner === owner
      && lease.token === claim.token
      && lease.expiresAt > this.now());
  }

  private assertActiveLease(queue: StoredUploadQueue, owner: string, claim: UploadClaim): void {
    if (!this.hasActiveLease(queue, owner, claim)) {
      throw new Error('上传租约已失效，请从面板恢复');
    }
  }

  enqueue(draftId: string): Promise<void> {
    return this.serialize(async () => {
      if (!draftId.trim()) throw new Error('draftId 不能为空');
      const queue = await this.load();
      if (!queue.items.some((item) => item.draftId === draftId)) {
        queue.items.push({ draftId, enqueuedAt: this.now() });
        await this.save(queue);
      }
    });
  }

  claim(owner: string, preferredDraftId?: string, enqueueIfMissing = false): Promise<UploadClaimResult> {
    return this.serialize(async () => {
      if (!owner) throw new Error('上传租约 owner 不能为空');
      const queue = await this.load();
      const now = this.now();
      if (preferredDraftId && enqueueIfMissing && !queue.items.some((item) => item.draftId === preferredDraftId)) {
        queue.items.push({ draftId: preferredDraftId, enqueuedAt: now });
      }

      const candidates = preferredDraftId
        ? queue.items.filter((item) => item.draftId === preferredDraftId)
        : queue.items;
      const owned = candidates.find((item) => item.lease?.owner === owner && item.lease.expiresAt > now);
      if (owned?.lease) {
        return {
          status: 'claimed',
          claim: { draftId: owned.draftId, token: owned.lease.token, leaseExpiresAt: owned.lease.expiresAt },
        };
      }

      const available = candidates.find((item) => !item.lease || item.lease.expiresAt <= now);
      if (available) {
        const lease: UploadLease = {
          token: this.makeToken(),
          owner,
          expiresAt: now + this.leaseMs,
        };
        available.lease = lease;
        await this.save(queue);
        return {
          status: 'claimed',
          claim: { draftId: available.draftId, token: lease.token, leaseExpiresAt: lease.expiresAt },
        };
      }

      if (candidates.length === 0) {
        if (enqueueIfMissing && preferredDraftId) throw new Error('无法创建上传队列项');
        return { status: 'empty' };
      }
      return {
        status: 'wait',
        retryAt: Math.min(...candidates.map((item) => item.lease?.expiresAt ?? now)),
      };
    });
  }

  renew(owner: string, claim: UploadClaim): Promise<UploadClaim | undefined> {
    return this.serialize(async () => {
      const queue = await this.load();
      const item = queue.items.find((entry) => entry.draftId === claim.draftId);
      if (!item?.lease || !this.hasActiveLease(queue, owner, claim)) return undefined;
      item.lease.expiresAt = this.now() + this.leaseMs;
      await this.save(queue);
      return { ...claim, leaseExpiresAt: item.lease.expiresAt };
    });
  }

  private finish(owner: string, claim: UploadClaim): Promise<boolean> {
    return this.serialize(async () => {
      const queue = await this.load();
      const index = queue.items.findIndex((entry) => entry.draftId === claim.draftId);
      if (index < 0 || !this.hasActiveLease(queue, owner, claim)) return false;
      queue.items.splice(index, 1);
      await this.save(queue);
      return true;
    });
  }

  complete(owner: string, claim: UploadClaim): Promise<boolean> {
    return this.finish(owner, claim);
  }

  fail(owner: string, claim: UploadClaim): Promise<boolean> {
    return this.finish(owner, claim);
  }

  status(draftId: string): Promise<UploadQueueStatus> {
    return this.serialize(async () => {
      const queue = await this.load();
      const item = queue.items.find((entry) => entry.draftId === draftId);
      if (!item) return { state: 'absent', recoverable: true };
      if (item.lease && item.lease.expiresAt > this.now()) {
        return { state: 'active', recoverable: false, leaseExpiresAt: item.lease.expiresAt };
      }
      return { state: 'queued', recoverable: true, leaseExpiresAt: item.lease?.expiresAt };
    });
  }

  getCheckpoint(owner: string, claim: UploadClaim): Promise<unknown> {
    return this.serialize(async () => {
      const queue = await this.load();
      this.assertActiveLease(queue, owner, claim);
      const key = `${CHECKPOINT_KEY_PREFIX}${claim.draftId}`;
      return (await this.storage.get(key))[key];
    });
  }

  setCheckpoint(owner: string, claim: UploadClaim, checkpoint: unknown): Promise<void> {
    return this.serialize(async () => {
      const queue = await this.load();
      this.assertActiveLease(queue, owner, claim);
      await this.storage.set({ [`${CHECKPOINT_KEY_PREFIX}${claim.draftId}`]: checkpoint });
    });
  }

  removeCheckpoint(owner: string, claim: UploadClaim): Promise<void> {
    return this.serialize(async () => {
      const queue = await this.load();
      this.assertActiveLease(queue, owner, claim);
      await this.storage.remove(`${CHECKPOINT_KEY_PREFIX}${claim.draftId}`);
    });
  }
}

let backgroundQueue: BackgroundUploadQueue | undefined;

export function getBackgroundUploadQueue(): BackgroundUploadQueue {
  backgroundQueue ??= new BackgroundUploadQueue(chrome.storage.local);
  return backgroundQueue;
}

type UploadQueueRequest =
  | { type: typeof UPLOAD_QUEUE_MESSAGE_TYPE; action: 'claim'; draftId?: string }
  | { type: typeof UPLOAD_QUEUE_MESSAGE_TYPE; action: 'renew' | 'complete' | 'fail'; claim: UploadClaim }
  | { type: typeof UPLOAD_QUEUE_MESSAGE_TYPE; action: 'checkpoint-get' | 'checkpoint-remove'; claim: UploadClaim }
  | { type: typeof UPLOAD_QUEUE_MESSAGE_TYPE; action: 'checkpoint-set'; claim: UploadClaim; checkpoint: unknown }
  | { type: typeof UPLOAD_QUEUE_MESSAGE_TYPE; action: 'status'; draftId: string };

function parseRequest(value: unknown): UploadQueueRequest | undefined {
  if (!isRecord(value) || value.type !== UPLOAD_QUEUE_MESSAGE_TYPE || typeof value.action !== 'string') return undefined;
  if (value.action === 'claim') {
    return value.draftId === undefined || (typeof value.draftId === 'string' && value.draftId.trim())
      ? value as unknown as UploadQueueRequest
      : undefined;
  }
  if (value.action === 'status') {
    return typeof value.draftId === 'string' && value.draftId.trim()
      ? value as unknown as UploadQueueRequest
      : undefined;
  }
  if (!['renew', 'complete', 'fail', 'checkpoint-get', 'checkpoint-set', 'checkpoint-remove'].includes(value.action)
    || !isRecord(value.claim)) return undefined;
  const claim = value.claim;
  if (typeof claim.draftId !== 'string'
    || !claim.draftId.trim()
    || typeof claim.token !== 'string'
    || !claim.token
    || !Number.isFinite(claim.leaseExpiresAt)) return undefined;
  if (value.action === 'checkpoint-set' && !Object.prototype.hasOwnProperty.call(value, 'checkpoint')) return undefined;
  return value as unknown as UploadQueueRequest;
}

function senderOwner(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.url) return undefined;
  try {
    const url = new URL(sender.url);
    if (url.origin !== 'https://x.com' && url.origin !== 'https://twitter.com') return undefined;
    return `${sender.tab.id}:${sender.documentId ?? url.href}`;
  } catch {
    return undefined;
  }
}

export function registerUploadQueueBackgroundHandlers(queue = getBackgroundUploadQueue()): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const request = parseRequest(message);
    const owner = request ? senderOwner(sender) : undefined;
    if (!request || !owner) return false;
    let operation: Promise<unknown>;
    switch (request.action) {
      case 'claim':
        operation = queue.claim(owner, request.draftId, request.draftId !== undefined);
        break;
      case 'renew':
        operation = queue.renew(owner, request.claim);
        break;
      case 'complete':
        operation = queue.complete(owner, request.claim);
        break;
      case 'fail':
        operation = queue.fail(owner, request.claim);
        break;
      case 'checkpoint-get':
        operation = queue.getCheckpoint(owner, request.claim);
        break;
      case 'checkpoint-set':
        operation = queue.setCheckpoint(owner, request.claim, request.checkpoint);
        break;
      case 'checkpoint-remove':
        operation = queue.removeCheckpoint(owner, request.claim);
        break;
      case 'status':
        operation = queue.status(request.draftId);
        break;
    }
    void operation.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}

async function sendQueueRequest<T>(request: UploadQueueRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as unknown;
  if (!isRecord(response) || response.ok !== true || !('result' in response)) {
    const message = isRecord(response) && typeof response.error === 'string'
      ? response.error
      : '上传队列后台无响应';
    throw new Error(message);
  }
  return response.result as T;
}

export function createUploadQueueClient(): UploadQueueClient {
  return {
    claim: (draftId) => sendQueueRequest<UploadClaimResult>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'claim',
      draftId,
    }),
    renew: (claim) => sendQueueRequest<UploadClaim | undefined>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'renew',
      claim,
    }),
    complete: (claim) => sendQueueRequest<boolean>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'complete',
      claim,
    }),
    fail: (claim) => sendQueueRequest<boolean>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'fail',
      claim,
    }),
    status: (draftId) => sendQueueRequest<UploadQueueStatus>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'status',
      draftId,
    }),
    getCheckpoint: (claim) => sendQueueRequest<unknown>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'checkpoint-get',
      claim,
    }),
    setCheckpoint: (claim, checkpoint) => sendQueueRequest<void>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'checkpoint-set',
      claim,
      checkpoint,
    }),
    removeCheckpoint: (claim) => sendQueueRequest<void>({
      type: UPLOAD_QUEUE_MESSAGE_TYPE,
      action: 'checkpoint-remove',
      claim,
    }),
  };
}
