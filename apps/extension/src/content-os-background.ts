import { HttpRelayClient } from '@kaitox/relay-protocol';
import type { DraftBundle, PostDraftInput } from '@kaitox/relay-protocol';
import {
  CONTENT_OS_ORIGIN,
  isAllowedHandoffMediaUrl,
  parseContentOsPageRequest,
  validateHandoff,
  type ContentOsRuntimeResponse,
  type KaitoxDraftStatus,
  type XArticleHandoffAsset,
} from './content-os-protocol.js';
import { getSettings } from './xsession.js';

const DOWNLOAD_CONCURRENCY = 3;
const X_ARTICLES_URL = 'https://x.com/compose/articles';

interface ContentOsRelayClient {
  postDraft(input: PostDraftInput): Promise<{ id: string }>;
  getDraft(id: string): Promise<DraftBundle>;
}

interface LocalStorageWriter {
  set(value: Record<string, unknown>): Promise<void>;
}

interface TabCreator {
  create(value: { url: string }): Promise<unknown>;
}

export interface ContentOsBackgroundDependencies {
  now?: () => number;
  getClient(): Promise<ContentOsRelayClient>;
  fetchImpl: typeof fetch;
  storageLocal: LocalStorageWriter;
  tabs: TabCreator;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Content OS handoff 处理失败';
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

async function downloadAsset(
  asset: XArticleHandoffAsset,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(asset.src, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`图片下载失败 ${response.status}：${asset.fileName}`);
  if (response.url && !isAllowedHandoffMediaUrl(response.url)) {
    throw new Error(`图片来源校验失败：${asset.fileName}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.bytesLen) throw new Error(`图片大小校验失败：${asset.fileName}`);
  if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`图片哈希校验失败：${asset.fileName}`);
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

export async function enqueueContentOsHandoff(
  value: unknown,
  dependencies: ContentOsBackgroundDependencies = defaultDependencies(),
): Promise<{ draftId: string }> {
  const validation = validateHandoff(value, { now: dependencies.now });
  if (!validation.ok) throw new Error(`Content OS handoff 校验失败：${validation.issues.join('; ')}`);
  const manifest = validation.manifest;
  const downloadList = manifest.cover ? [...manifest.assets, manifest.cover] : manifest.assets;
  const downloaded = await mapWithConcurrency(
    downloadList,
    DOWNLOAD_CONCURRENCY,
    (asset) => downloadAsset(asset, dependencies.fetchImpl),
  );
  const bodyBytes = downloaded.slice(0, manifest.assets.length);
  const coverBytes = manifest.cover ? downloaded[manifest.assets.length] : undefined;
  const client = await dependencies.getClient();
  const { id: draftId } = await client.postDraft({
    title: manifest.title,
    markdown: manifest.markdown,
    mode: 'rich',
    source: 'content-os',
    sourceMeta: { handoffId: manifest.handoffId, targetHandle: manifest.targetHandle },
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
  });

  await dependencies.storageLocal.set({ kaitoxAutoUploadDraftId: draftId });
  await dependencies.tabs.create({ url: X_ARTICLES_URL });
  return { draftId };
}

function strictDoneStatus(draft: DraftBundle): KaitoxDraftStatus {
  if (!draft.restId || draft.editUrl !== `https://x.com/compose/articles/edit/${draft.restId}`) {
    throw new Error('Kaitox relay 返回了无效的 done 草稿状态');
  }
  return { status: 'done', restId: draft.restId, editUrl: draft.editUrl };
}

export async function contentOsDraftStatus(
  draftId: string,
  dependencies: ContentOsBackgroundDependencies = defaultDependencies(),
): Promise<KaitoxDraftStatus> {
  if (!draftId.trim()) throw new Error('draftId 不能为空');
  const draft = await (await dependencies.getClient()).getDraft(draftId);
  if (draft.source !== 'content-os') throw new Error('该草稿不属于 Content OS');
  const status = draft.status ?? 'pending';
  if (status === 'done') return strictDoneStatus(draft);
  if (status === 'failed') return draft.error ? { status, error: draft.error } : { status };
  if (status === 'pending' || status === 'uploading') return { status };
  throw new Error('Kaitox relay 返回了无效草稿状态');
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
  return contentOsDraftStatus(request.draftId, dependencies);
}

export function registerContentOsBackgroundHandlers(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedContentOsSender(sender) || !parseContentOsPageRequest(message)) return false;
    void handleContentOsRuntimeMessage(message, sender).then(
      (response) => sendResponse(response),
      (error) => sendResponse({ error: errorMessage(error) }),
    );
    return true;
  });
}
