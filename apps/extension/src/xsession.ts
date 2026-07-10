/** x.com 会话 / relay 连接 / queryId 解析。 */
import { HttpRelayClient } from '@kaitox/relay-protocol';
import {
  ARTICLE_DRAFT_CREATE_QUERY_ID,
  ARTICLE_UPDATE_TITLE_QUERY_ID,
  ARTICLE_UPDATE_CONTENT_QUERY_ID,
  ARTICLE_UPDATE_COVER_MEDIA_QUERY_ID,
} from '@kaitox/x-article';
import type { ArticleQueryIds } from '@kaitox/x-article';
import { resolveArticleQueryIds } from './query-id-discovery.js';

export { DEFAULT_RELAY_BASE } from '@kaitox/relay-protocol';
import { DEFAULT_RELAY_BASE } from '@kaitox/relay-protocol';

export interface Settings {
  relayBase: string;
  queryIds: ArticleQueryIds;
  token?: string;
  /** 是否在 X 文章草稿页显示「上传草稿」按钮（设置页开关，默认开）。 */
  showUploadButton: boolean;
}

const FALLBACK_ARTICLE_QUERY_IDS: ArticleQueryIds = {
  ArticleEntityDraftCreate: ARTICLE_DRAFT_CREATE_QUERY_ID,
  ArticleEntityUpdateTitle: ARTICLE_UPDATE_TITLE_QUERY_ID,
  ArticleEntityUpdateContent: ARTICLE_UPDATE_CONTENT_QUERY_ID,
  ArticleEntityUpdateCoverMedia: ARTICLE_UPDATE_COVER_MEDIA_QUERY_ID,
};

/** Force a live X frontend scan, falling back to bundled IDs only when discovery fails. */
export async function refreshArticleQueryIds(): Promise<ArticleQueryIds> {
  return resolveArticleQueryIds(FALLBACK_ARTICLE_QUERY_IDS, { forceRefresh: true });
}

/** 读取插件设置（chrome.storage.sync），带默认值。 */
export async function getSettings(): Promise<Settings> {
  let stored: Record<string, any> = {};
  try {
    stored = await chrome.storage.sync.get([
      'relayBase',
      'queryId',
      'titleQueryId',
      'contentQueryId',
      'coverQueryId',
      'relayToken',
      'showUploadButton',
    ]);
  } catch {
    /* storage 不可用时用默认 */
  }
  const discoveredQueryIds = await resolveArticleQueryIds(FALLBACK_ARTICLE_QUERY_IDS);
  return {
    relayBase: stored.relayBase || DEFAULT_RELAY_BASE,
    // Explicit user override → current X frontend discovery/cache → bundled fallback.
    queryIds: {
      ArticleEntityDraftCreate: stored.queryId || discoveredQueryIds.ArticleEntityDraftCreate,
      ArticleEntityUpdateTitle: stored.titleQueryId || discoveredQueryIds.ArticleEntityUpdateTitle,
      ArticleEntityUpdateContent: stored.contentQueryId || discoveredQueryIds.ArticleEntityUpdateContent,
      ArticleEntityUpdateCoverMedia: stored.coverQueryId || discoveredQueryIds.ArticleEntityUpdateCoverMedia,
    },
    token: stored.relayToken || undefined,
    showUploadButton: stored.showUploadButton !== false,
  };
}

/** 从 document.cookie 读 ct0（非 HttpOnly），作 x-csrf-token。 */
export function readCt0(): string {
  const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** Read the active X account from the profile navigation/account switcher. */
export function readTargetHandle(): string {
  const href = document
    .querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"]')
    ?.getAttribute('href');
  const profileMatch = href?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
  if (profileMatch) return `@${profileMatch[1]}`;

  const switcherText = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent ?? '';
  const switcherMatch = switcherText.match(/@([A-Za-z0-9_]{1,15})\b/);
  return switcherMatch ? `@${switcherMatch[1]}` : '';
}

export async function getRelayClient(): Promise<HttpRelayClient> {
  const { relayBase, token } = await getSettings();
  return new HttpRelayClient(relayBase, { token, fetchImpl: window.fetch.bind(window) });
}
