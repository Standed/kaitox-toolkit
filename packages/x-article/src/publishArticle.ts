/**
 * 编排层：把「一份 Markdown」变成「一篇 X Article 草稿」。
 *
 * 完整流水线（调用顺序）：
 *   1. 创建空白草稿，并严格校验真实 rest_id
 *   2. 更新标题
 *   3. 上传全部正文图，任一失败即终止
 *   4. markdown + {src→media_id} → content_state，然后更新正文
 *   5. 可选上传封面并更新封面，任一失败即终止
 *
 * 后续要做「类似逻辑」（比如发普通推文、发 thread、导入到别的富文本编辑器）时，
 * 可复用的分层是：HTTP/鉴权（XArticleClient）+ 内容模型转换（contentState）+ 编排（本文件）。
 */

import { XArticleClient, XArticleClientOptions } from './xArticleClient.js';
import { collectImageSources, markdownToContentState } from './contentState.js';
import type { ContentState, XCredentials } from './types.js';

/** 给定图片 src，返回它的二进制与 MIME。默认实现用 fetch 下载。 */
export type ImageFetcher = (src: string) => Promise<{ bytes: Uint8Array | Blob; mimeType: string }>;

/** 取封面图字节（在建草稿拿到 rest_id 后才会被调用）。 */
export type CoverFetcher = () => Promise<{ bytes: Uint8Array | Blob; mimeType: string }>;

/**
 * 上传进度事件（编排层各阶段推进时回调）。只供 UI 展示：
 * images 阶段每完成一张推一次；draft/cover 在进入该阶段时推。
 */
export type PublishProgress =
  | { stage: 'images'; done: number; total: number }
  | { stage: 'draft' }
  | { stage: 'cover' };

export interface PublishArticleParams {
  markdown: string;
  /** 文章标题。不传则取 markdown 里的第一个标题，再退化为空串。 */
  title?: string;
  credentials: XCredentials;
  clientOptions: XArticleClientOptions;
  /** 自定义图片下载逻辑（默认用 fetch）。 */
  fetchImage?: ImageFetcher;
  /**
   * 封面图：给了才设。建草稿成功拿到 rest_id 后，上传封面图（tweet_image）→
   * 调 ArticleEntityUpdateCoverMedia。封面不进正文，也不参与正文图片流程。
   */
  fetchCover?: CoverFetcher;
  /** 图片上传并发数，默认 3。 */
  imageConcurrency?: number;
  /** 进度回调（可选，只供 UI 展示；回调抛错不影响上传流程）。 */
  onProgress?: (progress: PublishProgress) => void;
}

export interface PublishArticleResult {
  restId: string;
  editUrl: string;
  title: string;
  contentState: ContentState;
  /** 每张图片 src → 上传后的 media_id。 */
  mediaMap: Record<string, string>;
  /** 严格模式不跳过图片；保留字段供旧消费方兼容。 */
  skippedImages: string[];
  /** 设为封面的 media_id（有传 fetchCover 且成功时）。 */
  coverMediaId?: string;
  raw: any;
}

/** 主入口：发布（创建草稿）一篇 X Article。 */
export async function publishXArticle(params: PublishArticleParams): Promise<PublishArticleResult> {
  const {
    markdown,
    credentials,
    clientOptions,
    fetchImage = defaultImageFetcher(clientOptions),
    imageConcurrency = 3,
  } = params;

  const client = new XArticleClient(credentials, clientOptions);
  const notify = (progress: PublishProgress) => {
    try {
      params.onProgress?.(progress);
    } catch {
      // 进度回调只是展示，出错不影响上传
    }
  };

  const title = params.title ?? deriveTitle(markdown);

  // 1：先创建空白草稿，不允许用 HTTP 200 或类似成功文案代替真实 rest_id。
  notify({ stage: 'draft' });
  const { restId, raw } = await client.createEmptyArticleDraft();
  if (!restId) throw new Error('X 未返回真实 rest_id');

  // 2：标题必须在正文和封面之前成功。
  await client.updateArticleTitle(restId, title);

  // 3：收集并严格上传全部正文图。
  const srcs = collectImageSources(markdown);
  const mediaMap: Record<string, string> = {};

  let imagesDone = 0;
  notify({ stage: 'images', done: 0, total: srcs.length });
  await mapLimit(srcs, imageConcurrency, async (src) => {
    try {
      const { bytes, mimeType } = await fetchImage(src);
      mediaMap[src] = await client.uploadMedia(bytes, mimeType, 'tweet_image');
    } finally {
      imagesDone += 1;
      notify({ stage: 'images', done: imagesDone, total: srcs.length });
    }
  });

  // 4：markdown → content_state，并更新正文。
  const {
    contentState,
    skippedImages: unresolvable,
  } = markdownToContentState(markdown, mediaMap);
  if (unresolvable.length > 0) {
    throw new Error(`正文图未全部解析：${unresolvable.join(', ')}`);
  }
  await client.updateArticleContent(restId, contentState);

  // 5：设封面（可选）。下载、上传或 GraphQL 失败都直接向上抛。
  let coverMediaId: string | undefined;
  if (params.fetchCover) {
    notify({ stage: 'cover' });
    const { bytes, mimeType } = await params.fetchCover();
    coverMediaId = await client.uploadMedia(bytes, mimeType, 'tweet_image');
    await client.updateCoverMedia(restId, coverMediaId);
  }

  return {
    restId,
    editUrl: `https://x.com/compose/articles/edit/${restId}`,
    title,
    contentState,
    mediaMap,
    skippedImages: [],
    coverMediaId,
    raw,
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 默认图片下载器：fetch → arrayBuffer，MIME 取 content-type，退化按扩展名猜。 */
function defaultImageFetcher(clientOptions: XArticleClientOptions): ImageFetcher {
  return async (src: string) => {
    const f = clientOptions?.fetchImpl ?? ((globalThis as any).fetch as any);
    if (!f) throw new Error('没有可用的 fetch 来下载图片，请传入 fetchImage。');
    const res = await f(src, { method: 'GET' });
    if (!res.ok) throw new Error(`下载图片失败 ${res.status}：${src}`);
    const arrayBuf: ArrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const mimeType = res.headers?.get?.('content-type')?.split(';')[0]?.trim() || guessMime(src);
    return { bytes, mimeType };
  };
}

function guessMime(src: string): string {
  const ext = src.split('?')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
    default:
      return 'image/webp';
  }
}

/**
 * 从 markdown 推导标题：优先第一个 H1（层级约定里 H1 = 主标题），
 * 没有 H1 再退到第一个任意级别标题，最后退化为空串。CLI/Obsidian 复用。
 */
export function deriveTitle(markdown: string): string {
  let fallback = '';
  for (const line of markdown.split('\n')) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    if (m[1].length === 1) return m[2].trim();
    if (!fallback) fallback = m[2].trim();
  }
  return fallback;
}

/** 简单的并发限制 map。 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  let stopped = false;
  let firstError: unknown;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (!stopped && i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx], idx);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
      }
    }
  });
  await Promise.all(runners);
  if (stopped) throw firstError;
}
