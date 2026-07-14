/**
 * 只读采样器：X 自己保存 Article 正文时，记录视频媒体项的结构。
 *
 * 这段脚本运行在页面主世界，原因是 X 的 GraphQL 客户端不经过 content
 * script 的隔离世界。它只观察 ArticleEntityUpdateContent，且绝不保存标题、
 * 正文、cookie、media_id 或请求体。
 */
const PROBE_EVENT = 'kaitox-article-video-schema';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function sanitizeContentState(raw: unknown) {
  if (!isRecord(raw)) return [];
  const entityMap = raw.entity_map;
  const entities = Array.isArray(entityMap) ? entityMap : isRecord(entityMap) ? Object.values(entityMap) : [];
  const observed: Array<{ mediaCategory: string; fields: string[] }> = [];

  for (const entry of entities) {
    const value = isRecord(entry) && isRecord(entry.value) ? entry.value : entry;
    if (!isRecord(value) || value.type !== 'MEDIA' || !isRecord(value.data)) continue;
    const mediaItems = Array.isArray(value.data.media_items) ? value.data.media_items : [];
    for (const item of mediaItems) {
      if (!isRecord(item) || typeof item.media_category !== 'string') continue;
      if (item.media_category === 'DraftTweetImage') continue;
      observed.push({
        mediaCategory: item.media_category,
        fields: Object.keys(item).filter((field) => field !== 'media_id').sort(),
      });
    }
  }
  return observed;
}

function inspect(input: RequestInfo | URL, init?: RequestInit) {
  if (!requestUrl(input).includes('ArticleEntityUpdateContent') || typeof init?.body !== 'string') return;
  try {
    const body = JSON.parse(init.body) as UnknownRecord;
    const variables = isRecord(body.variables) ? body.variables : undefined;
    const observed = sanitizeContentState(variables?.content_state);
    if (!observed.length) return;

    window.dispatchEvent(new CustomEvent(PROBE_EVENT, {
      detail: {
        version: 1,
        observedAt: new Date().toISOString(),
        mediaItems: observed,
      },
    }));
  } catch {
    // 采样失败不能影响 X 自己的保存请求。
  }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  inspect(input, init);
  return nativeFetch(input, init);
}) as typeof window.fetch;
