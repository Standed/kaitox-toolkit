import {
  CONTENT_OS_INBOUND_SOURCE,
  CONTENT_OS_ORIGIN,
  parseContentOsPageRequest,
  type ContentOsPageRequest,
  type ContentOsRuntimeResponse,
} from './content-os-protocol.js';

interface ContentOsPageWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface ContentOsPageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface ContentOsPageMessageDependencies {
  pageWindow: ContentOsPageWindow;
  sendRuntimeMessage(message: ContentOsPageRequest): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Kaitox 请求失败';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): { error: string } {
  return { error: 'Kaitox 返回了无效响应' };
}

export function normalizeContentOsRuntimeResponse(
  requestType: ContentOsPageRequest['type'],
  value: unknown,
): ContentOsRuntimeResponse {
  if (!isRecord(value)) return invalidResponse();
  if (typeof value.error === 'string' && value.error.trim()) return { error: value.error };

  if (requestType === 'KAITOX_PING') {
    return value.available === true && value.draftOnly === true
      ? { available: true, draftOnly: true }
      : invalidResponse();
  }
  if (requestType === 'KAITOX_ENQUEUE') {
    return typeof value.draftId === 'string' && value.draftId.trim()
      ? { draftId: value.draftId }
      : invalidResponse();
  }

  const status = value.status;
  if (!['pending', 'uploading', 'done', 'failed'].includes(String(status))) {
    return { error: 'Kaitox 返回了无效草稿状态' };
  }
  if (status === 'done') {
    if (typeof value.restId !== 'string'
      || !value.restId.trim()
      || value.editUrl !== `https://x.com/compose/articles/edit/${value.restId}`) {
      return { error: 'Kaitox 返回了无效草稿状态' };
    }
    return { status: 'done', restId: value.restId, editUrl: value.editUrl };
  }
  if (status === 'failed') {
    return typeof value.error === 'string' && value.error.trim()
      ? { status: 'failed', error: value.error }
      : { status: 'failed' };
  }
  return { status } as ContentOsRuntimeResponse;
}

export async function handleContentOsPageMessage(
  event: ContentOsPageEvent,
  dependencies: ContentOsPageMessageDependencies,
): Promise<void> {
  if (event.source !== dependencies.pageWindow || event.origin !== CONTENT_OS_ORIGIN) return;
  const request = parseContentOsPageRequest(event.data);
  if (!request) return;

  let response: ContentOsRuntimeResponse;
  try {
    response = normalizeContentOsRuntimeResponse(
      request.type,
      await dependencies.sendRuntimeMessage(request),
    );
  } catch (error) {
    response = { error: errorMessage(error) };
  }
  dependencies.pageWindow.postMessage({
    source: CONTENT_OS_INBOUND_SOURCE,
    requestId: request.requestId,
    ...response,
  }, CONTENT_OS_ORIGIN);
}

export function installContentOsPageBridge(): void {
  window.addEventListener('message', (event) => {
    void handleContentOsPageMessage(event, {
      pageWindow: window,
      sendRuntimeMessage: (message) => chrome.runtime.sendMessage(message),
    });
  });
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined') installContentOsPageBridge();
