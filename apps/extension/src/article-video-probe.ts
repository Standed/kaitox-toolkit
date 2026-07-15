/**
 * 只读采样器：X 自己保存 Article 正文时，记录视频媒体项的结构。
 *
 * 这段脚本运行在页面主世界，原因是 X 的 GraphQL 客户端不经过 content
 * script 的隔离世界。它观察 Article 的保存请求，且绝不保存标题、正文、
 * cookie、media_id 或请求体。
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
  const observed: Array<{ mediaCategory: string; fields: string[] }> = [];

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;

    if (typeof value.media_category === 'string' && value.media_category !== 'DraftTweetImage') {
      observed.push({
        mediaCategory: value.media_category,
        fields: Object.keys(value).filter((field) => field !== 'media_id').sort(),
      });
    }
    Object.values(value).forEach(visit);
  };

  visit(raw);
  return observed;
}

function inspect(url: string, body: unknown) {
  if (!url.includes('Article') || typeof body !== 'string') return;
  try {
    const request = JSON.parse(body) as UnknownRecord;
    const variables = isRecord(request.variables) ? request.variables : undefined;
    const observed = sanitizeContentState(variables?.content_state);
    if (!observed.length) observed.push(...sanitizeContentState(variables));
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
  const url = requestUrl(input);
  if (typeof init?.body === 'string') inspect(url, init.body);
  if (input instanceof Request && !init?.body) {
    void input.clone().text().then((body) => inspect(url, body)).catch(() => {});
  }
  return nativeFetch(input, init);
}) as typeof window.fetch;

const nativeOpen = XMLHttpRequest.prototype.open;
const nativeSend = XMLHttpRequest.prototype.send;
const requestUrls = new WeakMap<XMLHttpRequest, string>();

XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null,
) {
  requestUrls.set(this, String(url));
  return (nativeOpen as unknown as (...args: unknown[]) => void).apply(this, Array.from(arguments));
};

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
  if (typeof body === 'string') inspect(requestUrls.get(this) ?? '', body);
  return nativeSend.call(this, body);
};
