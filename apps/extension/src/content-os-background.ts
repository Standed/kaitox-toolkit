import { HttpRelayClient } from '@kaitox/relay-protocol';
import type { DraftBundle, PostDraftInput } from '@kaitox/relay-protocol';
import {
  CONTENT_OS_ORIGIN,
  CONTENT_OS_TARGET_HANDLE,
  MAX_HANDOFF_IMAGE_BYTES,
  ContentOsBridgeError,
  contentOsPublicError,
  isAllowedHandoffMediaUrl,
  parseContentOsPageRequest,
  validateHandoff,
  type ContentOsRuntimeResponse,
  type KaitoxDraftStatus,
  type XArticleHandoffAsset,
  type XArticleHandoffManifest,
} from './content-os-protocol.js';
import { getSettings } from './xsession.js';

const DOWNLOAD_CONCURRENCY = 3;
const X_ARTICLES_URL = 'https://x.com/compose/articles';
const HANDOFF_RECORD_PREFIX = 'kaitoxContentOsHandoff:';

interface ContentOsRelayClient {
  postDraft(input: PostDraftInput): Promise<{ id: string }>;
  getDraft(id: string): Promise<DraftBundle>;
}

interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

interface TabCreator {
  create(value: { url: string }): Promise<unknown>;
}

export interface ContentOsBackgroundDependencies {
  now?: () => number;
  getClient(): Promise<ContentOsRelayClient>;
  fetchImpl: typeof fetch;
  storageLocal: LocalStorageArea;
  tabs: TabCreator;
}

interface StoredHandoffRecord {
  version: 1;
  handoffId: string;
  fingerprint: string;
  draftId: string;
  targetHandle: typeof CONTENT_OS_TARGET_HANDLE;
}

const activeHandoffs = new Map<string, {
  fingerprint: string;
  promise: Promise<{ draftId: string }>;
}>();

function handoffRecordKey(handoffId: string): string {
  return `${HANDOFF_RECORD_PREFIX}${handoffId}`;
}

function readStoredHandoffRecord(value: unknown): StoredHandoffRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1
    || typeof record.handoffId !== 'string'
    || typeof record.fingerprint !== 'string'
    || typeof record.draftId !== 'string'
    || record.targetHandle !== CONTENT_OS_TARGET_HANDLE) return undefined;
  return record as unknown as StoredHandoffRecord;
}

async function defaultRelayClient(): Promise<HttpRelayClient> {
  const { relayBase, token } = await getSettings();
  return new HttpRelayClient(relayBase, { token, fetchImpl: globalThis.fetch.bind(globalThis) });
}

function defaultDependencies(): ContentOsBackgroundDependencies {
  return {
    getClient: defaultRelayClient,
    fetchImpl: globalThis.fetch.bind(globalThis),
    storageLocal: chrome.storage.local,
    tabs: chrome.tabs,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function handoffFingerprint(manifest: XArticleHandoffManifest): Promise<string> {
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    handoffId: manifest.handoffId,
    title: manifest.title,
    markdown: manifest.markdown,
    targetHandle: manifest.targetHandle,
    assets: manifest.assets.map(({ key, src, fileName, mime, bytesLen, sha256 }) => (
      { key, src, fileName, mime, bytesLen, sha256 }
    )),
    cover: manifest.cover
      ? (({ key, src, fileName, mime, bytesLen, sha256 }) => (
          { key, src, fileName, mime, bytesLen, sha256 }
        ))(manifest.cover)
      : undefined,
    mediaMap: manifest.mediaMap,
    source: manifest.source,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
  });
  return sha256Hex(new TextEncoder().encode(canonical));
}

function hasExpectedImageSignature(bytes: Uint8Array, mime: XArticleHandoffAsset['mime']): boolean {
  if (mime === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte);
  }
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

function validateDownloadHeaders(response: Response, asset: XArticleHandoffAsset): void {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== asset.mime) throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');

  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength === null) return;
  if (!/^\d+$/.test(rawContentLength)) throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength)
    || contentLength !== asset.bytesLen
    || contentLength >= MAX_HANDOFF_IMAGE_BYTES) {
    throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  }
}

async function readBoundedResponseBody(response: Response, asset: XArticleHandoffAsset): Promise<Uint8Array> {
  if (!response.body) throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
    const nextSize = received + value.byteLength;
    if (nextSize > asset.bytesLen || nextSize >= MAX_HANDOFF_IMAGE_BYTES) {
      const cancel = (reader as { cancel?: () => Promise<void> }).cancel;
      if (cancel) void cancel.call(reader).catch(() => {});
      throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
    }
    chunks.push(value);
    received = nextSize;
  }
  if (received !== asset.bytesLen) throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function downloadAsset(
  asset: XArticleHandoffAsset,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(asset.src, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    throw new ContentOsBridgeError('MEDIA_DOWNLOAD_FAILED');
  }
  if (!response.ok) throw new ContentOsBridgeError('MEDIA_DOWNLOAD_FAILED');
  if (response.url && !isAllowedHandoffMediaUrl(response.url)) {
    throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  }
  validateDownloadHeaders(response, asset);
  const bytes = await readBoundedResponseBody(response, asset);
  if (!hasExpectedImageSignature(bytes, asset.mime)) {
    throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  }
  if (await sha256Hex(bytes) !== asset.sha256) {
    throw new ContentOsBridgeError('MEDIA_VALIDATION_FAILED');
  }
  return bytes;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

async function enqueueValidatedHandoff(
  manifest: XArticleHandoffManifest,
  fingerprint: string,
  dependencies: ContentOsBackgroundDependencies,
): Promise<{ draftId: string }> {
  const storageKey = handoffRecordKey(manifest.handoffId);
  const storedValue = (await dependencies.storageLocal.get(storageKey))[storageKey];
  if (storedValue !== undefined) {
    const stored = readStoredHandoffRecord(storedValue);
    if (!stored || stored.handoffId !== manifest.handoffId || stored.fingerprint !== fingerprint) {
      throw new ContentOsBridgeError('HANDOFF_REPLAY_CONFLICT');
    }
    return { draftId: stored.draftId };
  }
  const downloadList = manifest.cover ? [...manifest.assets, manifest.cover] : manifest.assets;
  const downloaded = await mapWithConcurrency(
    downloadList,
    DOWNLOAD_CONCURRENCY,
    (asset) => downloadAsset(asset, dependencies.fetchImpl),
  );
  const bodyBytes = downloaded.slice(0, manifest.assets.length);
  const coverBytes = manifest.cover ? downloaded[manifest.assets.length] : undefined;
  let draftId: string;
  try {
    const client = await dependencies.getClient();
    ({ id: draftId } = await client.postDraft({
      title: manifest.title,
      markdown: manifest.markdown,
      mode: 'rich',
      source: 'content-os',
      sourceMeta: {
        handoffId: manifest.handoffId,
        handoffFingerprint: fingerprint,
        targetHandle: CONTENT_OS_TARGET_HANDLE,
      },
      assets: manifest.assets.map((asset, index) => ({
        key: asset.key,
        src: asset.src,
        fileName: asset.fileName,
        mime: asset.mime,
        bytes: bodyBytes[index],
      })),
      cover: manifest.cover && coverBytes
        ? {
            key: manifest.cover.key,
            src: '__cover__',
            fileName: manifest.cover.fileName,
            mime: manifest.cover.mime,
            bytes: coverBytes,
          }
        : undefined,
    }));
  } catch (error) {
    if (error instanceof ContentOsBridgeError) throw error;
    throw new ContentOsBridgeError('RELAY_UNAVAILABLE');
  }

  const record: StoredHandoffRecord = {
    version: 1,
    handoffId: manifest.handoffId,
    fingerprint,
    draftId,
    targetHandle: CONTENT_OS_TARGET_HANDLE,
  };
  await dependencies.storageLocal.set({
    [storageKey]: record,
    kaitoxAutoUploadDraftId: draftId,
  });
  await dependencies.tabs.create({ url: X_ARTICLES_URL });
  return { draftId };
}

export async function enqueueContentOsHandoff(
  value: unknown,
  dependencies: ContentOsBackgroundDependencies = defaultDependencies(),
): Promise<{ draftId: string }> {
  const validation = validateHandoff(value, { now: dependencies.now });
  if (!validation.ok) throw new ContentOsBridgeError('INVALID_HANDOFF');
  const manifest = validation.manifest;
  const fingerprint = await handoffFingerprint(manifest);
  const active = activeHandoffs.get(manifest.handoffId);
  if (active) {
    if (active.fingerprint !== fingerprint) throw new ContentOsBridgeError('HANDOFF_REPLAY_CONFLICT');
    return active.promise;
  }
  const promise = enqueueValidatedHandoff(manifest, fingerprint, dependencies);
  activeHandoffs.set(manifest.handoffId, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (activeHandoffs.get(manifest.handoffId)?.promise === promise) {
      activeHandoffs.delete(manifest.handoffId);
    }
  }
}

function strictDoneStatus(draft: DraftBundle): KaitoxDraftStatus {
  if (draft.targetHandle !== CONTENT_OS_TARGET_HANDLE
    || !draft.restId
    || draft.editUrl !== `https://x.com/compose/articles/edit/${draft.restId}`) {
    throw new ContentOsBridgeError('STATUS_MISMATCH');
  }
  return { status: 'done', restId: draft.restId, editUrl: draft.editUrl };
}

export async function contentOsDraftStatus(
  draftId: string,
  handoffId: string,
  dependencies: ContentOsBackgroundDependencies = defaultDependencies(),
): Promise<KaitoxDraftStatus> {
  if (!draftId.trim() || !handoffId.trim()) throw new ContentOsBridgeError('STATUS_MISMATCH');
  let draft: DraftBundle;
  try {
    draft = await (await dependencies.getClient()).getDraft(draftId);
  } catch {
    throw new ContentOsBridgeError('RELAY_UNAVAILABLE');
  }
  if (draft.source !== 'content-os'
    || draft.sourceMeta?.handoffId !== handoffId
    || draft.sourceMeta?.targetHandle !== CONTENT_OS_TARGET_HANDLE) {
    throw new ContentOsBridgeError('STATUS_MISMATCH');
  }
  const status = draft.status ?? 'pending';
  if (status === 'done') return strictDoneStatus(draft);
  if (status === 'failed') {
    return { status, error: contentOsPublicError(new ContentOsBridgeError('DRAFT_FAILED')) };
  }
  if (status === 'pending' || status === 'uploading') return { status };
  throw new ContentOsBridgeError('STATUS_MISMATCH');
}

export function isTrustedContentOsSender(sender: Pick<chrome.runtime.MessageSender, 'url'>): boolean {
  if (!sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === CONTENT_OS_ORIGIN && url.pathname.startsWith('/writing');
  } catch {
    return false;
  }
}

export async function handleContentOsRuntimeMessage(
  value: unknown,
  sender: Pick<chrome.runtime.MessageSender, 'url'>,
  dependencies: ContentOsBackgroundDependencies = defaultDependencies(),
): Promise<ContentOsRuntimeResponse | undefined> {
  if (!isTrustedContentOsSender(sender)) return undefined;
  const request = parseContentOsPageRequest(value);
  if (!request) return undefined;
  if (request.type === 'KAITOX_PING') return { available: true, draftOnly: true };
  if (request.type === 'KAITOX_ENQUEUE') return enqueueContentOsHandoff(request.manifest, dependencies);
  return contentOsDraftStatus(request.draftId, request.handoffId, dependencies);
}

export function registerContentOsBackgroundHandlers(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedContentOsSender(sender) || !parseContentOsPageRequest(message)) return false;
    void handleContentOsRuntimeMessage(message, sender).then(
      (response) => sendResponse(response),
      (error) => sendResponse({ error: contentOsPublicError(error) }),
    );
    return true;
  });
}
