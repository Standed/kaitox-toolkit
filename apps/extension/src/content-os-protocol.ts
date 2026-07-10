import { collectImageSources } from '@kaitox/x-article';

export const CONTENT_OS_ORIGIN = 'https://aizao.ai';
export const CONTENT_OS_OUTBOUND_SOURCE = 'xiyangshi-content-os';
export const CONTENT_OS_INBOUND_SOURCE = 'xiyangshi-kaitox';
export const CONTENT_OS_TARGET_HANDLE = '@aaxiaoshi666';
export const MAX_HANDOFF_MEDIA = 25;
export const MAX_HANDOFF_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_HANDOFF_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_HANDOFF_TTL_MS = 60 * 60 * 1000;
export const MAX_HANDOFF_FUTURE_SKEW_MS = 5 * 60 * 1000;

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const CONTENT_OS_PUBLIC_ERROR_MESSAGES = {
  INVALID_HANDOFF: '交接包未通过安全校验，请重新导出后再试。',
  HANDOFF_REPLAY_CONFLICT: '该交接任务与已接收的内容不一致。',
  MEDIA_DOWNLOAD_FAILED: '图片下载失败，请检查素材后重试。',
  MEDIA_VALIDATION_FAILED: '图片校验失败，请重新导出素材。',
  RELAY_UNAVAILABLE: '本地 Kaitox 服务暂不可用。',
  STATUS_MISMATCH: '草稿状态与交接任务不匹配。',
  DRAFT_FAILED: 'X 草稿创建失败，请在 Kaitox 中检查后重试。',
  INVALID_RESPONSE: 'Kaitox 返回了无效响应。',
  INTERNAL_ERROR: 'Kaitox 暂时无法处理该请求，请稍后重试。',
} as const;

export type ContentOsPublicErrorCode = keyof typeof CONTENT_OS_PUBLIC_ERROR_MESSAGES;
export interface ContentOsPublicError {
  code: ContentOsPublicErrorCode;
  message: string;
}

export class ContentOsBridgeError extends Error {
  constructor(readonly code: ContentOsPublicErrorCode) {
    super(CONTENT_OS_PUBLIC_ERROR_MESSAGES[code]);
    this.name = 'ContentOsBridgeError';
  }
}

export function contentOsPublicError(error: unknown): ContentOsPublicError {
  const code = error instanceof ContentOsBridgeError ? error.code : 'INTERNAL_ERROR';
  return { code, message: CONTENT_OS_PUBLIC_ERROR_MESSAGES[code] };
}

export function parseContentOsPublicError(value: unknown): ContentOsPublicError | undefined {
  if (!isRecord(value) || typeof value.code !== 'string') return undefined;
  if (!(value.code in CONTENT_OS_PUBLIC_ERROR_MESSAGES)) return undefined;
  const code = value.code as ContentOsPublicErrorCode;
  return { code, message: CONTENT_OS_PUBLIC_ERROR_MESSAGES[code] };
}

export interface XArticleHandoffAsset {
  key: string;
  src: string;
  fileName: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytesLen: number;
  sha256: string;
}

export interface XArticleMediaMapEntry {
  assetIndex: number;
  figureIds: string[];
  sourceIndexes: number[];
  cellLabels: string[];
}

export interface XArticleHandoffManifest {
  schemaVersion: 1;
  handoffId: string;
  title: string;
  markdown: string;
  targetHandle: typeof CONTENT_OS_TARGET_HANDLE;
  assets: XArticleHandoffAsset[];
  cover?: XArticleHandoffAsset;
  mediaMap: XArticleMediaMapEntry[];
  source: 'content-os';
  createdAt: string;
  expiresAt: string;
}

export type ContentOsPageRequest =
  | { source: typeof CONTENT_OS_OUTBOUND_SOURCE; requestId: string; type: 'KAITOX_PING' }
  | {
      source: typeof CONTENT_OS_OUTBOUND_SOURCE;
      requestId: string;
      type: 'KAITOX_ENQUEUE';
      manifest: XArticleHandoffManifest;
    }
  | {
      source: typeof CONTENT_OS_OUTBOUND_SOURCE;
      requestId: string;
      type: 'KAITOX_STATUS';
      draftId: string;
      handoffId: string;
    };

export type KaitoxDraftStatus =
  | { handoffId: string; status: 'pending' | 'uploading' }
  | { handoffId: string; status: 'done'; restId: string; editUrl: string }
  | { handoffId: string; status: 'failed'; error: ContentOsPublicError };

export type ContentOsRuntimeResponse =
  | { available: true; draftOnly: true }
  | { draftId: string }
  | KaitoxDraftStatus
  | { error: ContentOsPublicError };

export type HandoffValidationResult =
  | { ok: true; manifest: XArticleHandoffManifest }
  | { ok: false; issues: string[] };

export interface ValidateHandoffOptions {
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseContentOsPageRequest(value: unknown): ContentOsPageRequest | undefined {
  if (!isRecord(value)
    || value.source !== CONTENT_OS_OUTBOUND_SOURCE
    || !isNonEmptyString(value.requestId)) {
    return undefined;
  }
  const base = { source: CONTENT_OS_OUTBOUND_SOURCE, requestId: value.requestId } as const;
  if (value.type === 'KAITOX_PING') return { ...base, type: 'KAITOX_PING' };
  if (value.type === 'KAITOX_ENQUEUE' && isRecord(value.manifest)) {
    return {
      ...base,
      type: 'KAITOX_ENQUEUE',
      manifest: value.manifest as unknown as XArticleHandoffManifest,
    };
  }
  if (value.type === 'KAITOX_STATUS' && isNonEmptyString(value.draftId)) {
    if (typeof value.handoffId !== 'string' || !HANDOFF_ID_PATTERN.test(value.handoffId)) return undefined;
    return { ...base, type: 'KAITOX_STATUS', draftId: value.draftId, handoffId: value.handoffId };
  }
  return undefined;
}

function isSafeFileName(value: unknown): value is string {
  return isNonEmptyString(value)
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

export function isAllowedHandoffMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (url.origin === 'https://media.aizao.ai') return true;
    return url.origin === CONTENT_OS_ORIGIN && url.pathname === '/api/wechat-layout-file';
  } catch {
    return false;
  }
}

function validateAsset(value: unknown, path: string, issues: string[]): value is XArticleHandoffAsset {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  if (!isNonEmptyString(value.key)) issues.push(`${path}.key must be a non-empty string`);
  if (!isAllowedHandoffMediaUrl(value.src)) issues.push(`${path}.src is not an allowlisted HTTPS media URL`);
  if (!isSafeFileName(value.fileName)) issues.push(`${path}.fileName must be a path-free file name`);
  if (typeof value.mime !== 'string' || !ALLOWED_MIME_TYPES.has(value.mime)) {
    issues.push(`${path}.mime is not supported`);
  }
  if (!Number.isInteger(value.bytesLen) || Number(value.bytesLen) < 1 || Number(value.bytesLen) >= MAX_HANDOFF_IMAGE_BYTES) {
    issues.push(`${path}.bytesLen must be below 5 MiB`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    issues.push(`${path}.sha256 must be a lowercase SHA-256 hex digest`);
  }
  return issues.every((issue) => !issue.startsWith(path));
}

function validateStringArray(value: unknown, path: string, issues: string[]): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push(`${path} must be a string array`);
    return false;
  }
  return true;
}

function validateMediaMap(value: unknown, assetCount: number, issues: string[]): void {
  if (!Array.isArray(value) || value.length !== assetCount) {
    issues.push('$.mediaMap must contain one entry for each body asset');
    return;
  }

  const sourceIndexes: number[] = [];
  value.forEach((entry, index) => {
    const path = `$.mediaMap[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${path} must be an object`);
      return;
    }
    if (entry.assetIndex !== index) issues.push(`${path}.assetIndex must equal ${index}`);
    if (!validateStringArray(entry.figureIds, `${path}.figureIds`, issues) || entry.figureIds.length === 0) {
      issues.push(`${path}.figureIds must not be empty`);
    }
    if (!Array.isArray(entry.sourceIndexes)
      || entry.sourceIndexes.length === 0
      || entry.sourceIndexes.some((sourceIndex) => !Number.isInteger(sourceIndex) || sourceIndex < 0)) {
      issues.push(`${path}.sourceIndexes must contain non-negative integers`);
    } else {
      sourceIndexes.push(...entry.sourceIndexes);
    }
    validateStringArray(entry.cellLabels, `${path}.cellLabels`, issues);
  });

  const sortedSourceIndexes = [...sourceIndexes].sort((a, b) => a - b);
  if (sortedSourceIndexes.some((sourceIndex, index) => sourceIndex !== index)) {
    issues.push('$.mediaMap.sourceIndexes must cover each original source exactly once');
  }
}

export function validateHandoff(
  value: unknown,
  options: ValidateHandoffOptions = {},
): HandoffValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['$ must be an object'] };

  if (value.schemaVersion !== 1) issues.push('$.schemaVersion must equal 1');
  if (typeof value.handoffId !== 'string' || !HANDOFF_ID_PATTERN.test(value.handoffId)) {
    issues.push('$.handoffId must be 1-128 safe identifier characters');
  }
  if (!isNonEmptyString(value.title)) issues.push('$.title must be a non-empty string');
  if (!isNonEmptyString(value.markdown)) issues.push('$.markdown must be a non-empty string');
  if (value.targetHandle !== CONTENT_OS_TARGET_HANDLE) {
    issues.push(`$.targetHandle must equal ${CONTENT_OS_TARGET_HANDLE}`);
  }
  if (value.source !== 'content-os') issues.push('$.source must equal content-os');

  const assets = value.assets;
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > MAX_HANDOFF_MEDIA) {
    issues.push(`$.assets must contain 1-${MAX_HANDOFF_MEDIA} items`);
  } else {
    assets.forEach((asset, index) => validateAsset(asset, `$.assets[${index}]`, issues));
    const markdownSources = typeof value.markdown === 'string' ? collectImageSources(value.markdown) : [];
    const assetSources = assets.map((asset) => isRecord(asset) ? asset.src : undefined);
    if (markdownSources.length !== assetSources.length
      || markdownSources.some((source, index) => source !== assetSources[index])) {
      issues.push('$.assets src values must exactly match Markdown image sources in order');
    }
    validateMediaMap(value.mediaMap, assets.length, issues);
  }

  if (value.cover !== undefined) validateAsset(value.cover, '$.cover', issues);

  const declaredTotalBytes = [
    ...(Array.isArray(assets) ? assets : []),
    ...(value.cover === undefined ? [] : [value.cover]),
  ].reduce((total, asset) => (
    total + (isRecord(asset) && Number.isInteger(asset.bytesLen) ? Number(asset.bytesLen) : 0)
  ), 0);
  if (declaredTotalBytes > MAX_HANDOFF_TOTAL_BYTES) {
    issues.push(`declared asset bytes must not exceed ${MAX_HANDOFF_TOTAL_BYTES}`);
  }

  const fileNames = [
    ...(Array.isArray(assets) ? assets.map((asset) => isRecord(asset) ? asset.fileName : undefined) : []),
    isRecord(value.cover) ? value.cover.fileName : undefined,
  ].filter((fileName): fileName is string => typeof fileName === 'string');
  if (new Set(fileNames).size !== fileNames.length) issues.push('asset fileName values must be unique');

  const createdAt = typeof value.createdAt === 'string' ? Date.parse(value.createdAt) : Number.NaN;
  const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : Number.NaN;
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(createdAt)) issues.push('$.createdAt must be an ISO date');
  if (!Number.isFinite(expiresAt)) issues.push('$.expiresAt must be an ISO date');
  if (Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt <= createdAt) {
    issues.push('$.expiresAt must be after $.createdAt');
  }
  if (Number.isFinite(createdAt) && createdAt > now + MAX_HANDOFF_FUTURE_SKEW_MS) {
    issues.push('$.createdAt is too far in the future');
  }
  if (Number.isFinite(createdAt)
    && Number.isFinite(expiresAt)
    && expiresAt - createdAt > MAX_HANDOFF_TTL_MS) {
    issues.push('handoff TTL exceeds the maximum');
  }
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    issues.push('$.expiresAt has expired');
  }

  return issues.length
    ? { ok: false, issues }
    : { ok: true, manifest: value as unknown as XArticleHandoffManifest };
}
