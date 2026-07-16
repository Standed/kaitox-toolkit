/**
 * X Article 正文媒体预算。
 *
 * X 把正文图片和内嵌视频都算作媒体实体；封面是独立字段，不占这里的额度。
 * 这里仅负责事前识别和阻断，不推测视频的上传 schema。
 */
import { collectImageSources } from './contentState.js';

export const X_ARTICLE_MAX_BODY_MEDIA = 25;

export interface ArticleMediaBudget {
  images: string[];
  videos: string[];
  total: number;
  remaining: number;
  overBy: number;
}

/** 收集 HTML video/source 标签中的视频地址，按正文出现顺序去重。 */
export function collectVideoSources(markdown: string): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  const tagRe = /<(source|video)\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(markdown))) {
    const tagName = match[1].toLowerCase();
    const attrs = readAttributes(match[0]);
    const isVideoSource = tagName === 'video'
      || /^(?:video)\//i.test(attrs.mime ?? '')
      || /^(?:video)\//i.test(attrs.type ?? '');
    const src = attrs.href ?? attrs.src;
    if (!isVideoSource || !src || seen.has(src)) continue;
    seen.add(src);
    sources.push(src);
  }

  return sources;
}

/** 统计 X Article 正文所占媒体实体。封面不计入总数。 */
export function inspectArticleMediaBudget(
  markdown: string,
  maxBodyMedia = X_ARTICLE_MAX_BODY_MEDIA,
): ArticleMediaBudget {
  const images = collectImageSources(markdown);
  const videos = collectVideoSources(markdown);
  const total = images.length + videos.length;
  return {
    images,
    videos,
    total,
    remaining: Math.max(0, maxBodyMedia - total),
    overBy: Math.max(0, total - maxBodyMedia),
  };
}

function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrRe = /\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(tag))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}
