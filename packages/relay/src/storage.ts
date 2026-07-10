/**
 * 草稿包在磁盘上的读写。按功能（kind）命名空间化：
 * ~/.kaitox/<kind>/{outbox,sent}/<id>/bundle.json + assets/<fileName>。
 * kind 一律由路由层从 /:kind/... 路径段传入（已校验），storage 只当作目录段用。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, rename, stat, link } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { base64ToBytes } from '@kaitox/relay-protocol';
import type { DraftAckPatch, DraftBundle, DraftListItem, PostDraftWireBody } from '@kaitox/relay-protocol';
import { idempotencyDir, outboxDir, sentDir } from './config.js';
import { fitImageBytes } from './imageFit.js';

const BUNDLE_FILE = 'bundle.json';
const ASSETS_DIR = 'assets';
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

interface HandoffIdentity {
  handoffId: string;
  fingerprint: string;
}

interface HandoffPrecommit extends HandoffIdentity {
  version: 1;
  draftId: string;
}

export interface SaveDraftHooks {
  afterIdempotencyPrecommit?: () => void | Promise<void>;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('handoff idempotency conflict');
    this.name = 'IdempotencyConflictError';
  }
}

const activeIdempotentSaves = new Map<string, {
  fingerprint: string;
  promise: Promise<string>;
}>();

/** id / 文件名清洗，防目录穿越。 */
export function sanitizeId(id: string): string {
  const s = basename(String(id)).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) throw new Error('非法 id');
  return s;
}
export function sanitizeFileName(name: string): string {
  const s = basename(String(name));
  if (!s || s === '.' || s === '..' || /[\\/]/.test(name)) throw new Error('非法文件名');
  return s;
}

async function ensureDirs(kind: string): Promise<void> {
  await mkdir(outboxDir(kind), { recursive: true });
  await mkdir(sentDir(kind), { recursive: true });
  await mkdir(idempotencyDir(kind), { recursive: true });
}

function draftDir(kind: string, id: string, sent = false): string {
  return join(sent ? sentDir(kind) : outboxDir(kind), id);
}

function handoffIdentity(wire: PostDraftWireBody): HandoffIdentity | undefined {
  if (wire.bundle.source !== 'content-os') return undefined;
  const handoffId = wire.bundle.sourceMeta?.handoffId;
  const fingerprint = wire.bundle.sourceMeta?.handoffFingerprint;
  if (typeof handoffId !== 'string'
    || !HANDOFF_ID_PATTERN.test(handoffId)
    || typeof fingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new IdempotencyConflictError();
  }
  return { handoffId, fingerprint };
}

function stableHandoffKey(kind: string, handoffId: string): string {
  return createHash('sha256').update(`${kind}\0${handoffId}`).digest('hex');
}

function parsePrecommit(value: unknown): HandoffPrecommit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1
    || typeof record.handoffId !== 'string'
    || typeof record.fingerprint !== 'string'
    || typeof record.draftId !== 'string') return undefined;
  return record as unknown as HandoffPrecommit;
}

async function ensureHandoffPrecommit(kind: string, identity: HandoffIdentity): Promise<HandoffPrecommit> {
  const key = stableHandoffKey(kind, identity.handoffId);
  const file = join(idempotencyDir(kind), `${key}.json`);
  const record: HandoffPrecommit = {
    version: 1,
    ...identity,
    draftId: `contentos-${key.slice(0, 32)}`,
  };
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record), 'utf8');
  try {
    await link(temp, file);
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: HandoffPrecommit | undefined;
    try {
      existing = parsePrecommit(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      existing = undefined;
    }
    if (!existing
      || existing.handoffId !== identity.handoffId
      || existing.fingerprint !== identity.fingerprint
      || existing.draftId !== record.draftId) {
      throw new IdempotencyConflictError();
    }
    return existing;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function writeDraft(wire: PostDraftWireBody, kind: string, requestedId: string): Promise<string> {
  const id = sanitizeId(requestedId);
  const dir = draftDir(kind, id);
  await mkdir(join(dir, ASSETS_DIR), { recursive: true });

  // 写资源字节（base64 → 二进制）；超过 X 上限的图片入库前静默压到限内。
  const written = new Map<string, { mime: string; bytesLen: number }>();
  const assetsByName = new Map(wire.assets.map((a) => [sanitizeFileName(a.fileName), a]));
  for (const [fileName, a] of assetsByName) {
    const fit = await fitImageBytes(base64ToBytes(a.base64), a.mime);
    written.set(fileName, { mime: fit.mime, bytesLen: fit.bytes.byteLength });
    await writeFile(join(dir, ASSETS_DIR, fileName), fit.bytes);
  }

  const bundle: DraftBundle = {
    ...wire.bundle,
    id,
    // kind 以路径段为准盖章，与草稿所在的命名空间目录一致。
    kind,
    // 重编码可能改变格式与体积，元数据跟着落盘后的实际字节走。
    assets: (wire.bundle.assets ?? []).map((meta) => {
      const w = written.get(sanitizeFileName(meta.fileName));
      return w ? { ...meta, mime: w.mime, bytesLen: w.bytesLen } : meta;
    }),
    status: 'pending',
  };
  await writeFile(join(dir, BUNDLE_FILE), JSON.stringify(bundle, null, 2), 'utf8');
  return id;
}

async function saveIdempotentDraft(
  wire: PostDraftWireBody,
  kind: string,
  identity: HandoffIdentity,
  hooks: SaveDraftHooks,
): Promise<string> {
  const record = await ensureHandoffPrecommit(kind, identity);
  const existing = await getDraft(record.draftId, kind);
  if (existing) {
    if (existing.source !== 'content-os'
      || existing.sourceMeta?.handoffId !== identity.handoffId
      || existing.sourceMeta?.handoffFingerprint !== identity.fingerprint) {
      throw new IdempotencyConflictError();
    }
    return record.draftId;
  }

  await hooks.afterIdempotencyPrecommit?.();
  await rm(draftDir(kind, record.draftId), { recursive: true, force: true });
  return writeDraft({
    ...wire,
    bundle: { ...wire.bundle, id: record.draftId },
  }, kind, record.draftId);
}

/** 落盘一份草稿包（POST /:kind/drafts）。Content OS handoff 使用 relay 级持久幂等身份。 */
export async function saveDraft(
  wire: PostDraftWireBody,
  kind: string,
  hooks: SaveDraftHooks = {},
): Promise<string> {
  await ensureDirs(kind);
  const identity = handoffIdentity(wire);
  if (!identity) return writeDraft(wire, kind, wire.bundle.id);

  const key = stableHandoffKey(kind, identity.handoffId);
  const active = activeIdempotentSaves.get(key);
  if (active) {
    if (active.fingerprint !== identity.fingerprint) throw new IdempotencyConflictError();
    return active.promise;
  }
  const promise = saveIdempotentDraft(wire, kind, identity, hooks);
  activeIdempotentSaves.set(key, { fingerprint: identity.fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (activeIdempotentSaves.get(key)?.promise === promise) activeIdempotentSaves.delete(key);
  }
}

async function readBundleFrom(dir: string): Promise<DraftBundle | null> {
  try {
    const raw = await readFile(join(dir, BUNDLE_FILE), 'utf8');
    return JSON.parse(raw) as DraftBundle;
  } catch {
    return null;
  }
}

/** 某个 kind 的草稿列表：outbox（pending/uploading/failed）+ sent（done），按创建时间倒序。
 *  已上传的草稿要留在列表里（消费方按 status 分栏展示），角标等按 status!=='done' 自行过滤。
 *  目录已按 kind 命名空间化，因此天然只含该 kind 的草稿，无需再逐条过滤。 */
export async function listDrafts(kind: string): Promise<DraftListItem[]> {
  await ensureDirs(kind);
  const items: DraftListItem[] = [];
  const seen = new Set<string>();
  // outbox 优先：万一 done 迁移 sent/ 时 rename 失败，两边同 id 以 outbox 为准。
  for (const sent of [false, true]) {
    let ids: string[];
    try {
      ids = await readdir(sent ? sentDir(kind) : outboxDir(kind));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      const b = await readBundleFrom(draftDir(kind, id, sent));
      if (!b) continue;
      seen.add(id);
      items.push({
        id: b.id,
        kind: b.kind,
        title: b.title,
        source: b.source,
        createdAt: b.createdAt,
        mode: b.mode,
        status: b.status ?? 'pending',
        counts: b.styleReport?.counts,
        assetCount: b.assets?.length ?? 0,
      });
    }
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

/** 读取某个 kind 下的单个草稿包（先 outbox 后 sent）。 */
export async function getDraft(id: string, kind: string): Promise<DraftBundle | null> {
  const safe = sanitizeId(id);
  return (
    (await readBundleFrom(draftDir(kind, safe))) ?? (await readBundleFrom(draftDir(kind, safe, true)))
  );
}

/** 资源文件的绝对路径（存在才返回）。先 outbox 后 sent。 */
export async function getAssetPath(id: string, fileName: string, kind: string): Promise<string | null> {
  const safe = sanitizeId(id);
  const safeName = sanitizeFileName(fileName);
  for (const sent of [false, true]) {
    const p = join(draftDir(kind, safe, sent), ASSETS_DIR, safeName);
    try {
      await stat(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 设置/替换封面（PUT /drafts/:id/cover）。写字节并更新 bundle.cover；仅 outbox 里的草稿可改。
 *  body 带 original（用户新选图）时同时落盘原图并替换 bundle.coverOriginal；
 *  不带（基于原图重裁）时保留现有原图。 */
export async function setCover(
  id: string,
  cover: {
    fileName: string;
    mime: string;
    base64: string;
    original?: { fileName: string; mime: string; base64: string };
  },
  kind: string,
): Promise<DraftBundle | null> {
  const safe = sanitizeId(id);
  const dir = draftDir(kind, safe);
  const b = await readBundleFrom(dir);
  if (!b) return null;
  // 加 cover- 前缀，避免与正文图片同名互踩（正文 assets 的 fileName 来自 markdown src）。
  const fileName = `cover-${sanitizeFileName(cover.fileName)}`;
  const { bytes, mime } = await fitImageBytes(base64ToBytes(cover.base64), cover.mime);
  await mkdir(join(dir, ASSETS_DIR), { recursive: true });
  await writeFile(join(dir, ASSETS_DIR, fileName), bytes);
  let coverOriginal = b.coverOriginal;
  if (cover.original) {
    const origFileName = `cover-original-${sanitizeFileName(cover.original.fileName)}`;
    const fit = await fitImageBytes(base64ToBytes(cover.original.base64), cover.original.mime);
    await writeFile(join(dir, ASSETS_DIR, origFileName), fit.bytes);
    coverOriginal = {
      key: 'cover-original',
      src: origFileName,
      fileName: origFileName,
      mime: fit.mime,
      bytesLen: fit.bytes.byteLength,
    };
  }
  // 不再被引用的旧封面/旧原图清掉，避免越攒越多。按「仍被引用集合」判断，防同名误删。
  const referenced = new Set([
    ...(b.assets ?? []).map((a) => a.fileName),
    fileName,
    ...(coverOriginal ? [coverOriginal.fileName] : []),
  ]);
  for (const old of [b.cover?.fileName, b.coverOriginal?.fileName]) {
    if (old && !referenced.has(old)) {
      await rm(join(dir, ASSETS_DIR, sanitizeFileName(old)), { force: true }).catch(() => {});
    }
  }
  const updated: DraftBundle = {
    ...b,
    cover: { key: 'cover', src: fileName, fileName, mime, bytesLen: bytes.byteLength },
    coverOriginal,
  };
  await writeFile(join(dir, BUNDLE_FILE), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/** 更新草稿状态；status='done' 时移入 sent/。 */
export async function patchDraft(
  id: string,
  patch: DraftAckPatch,
  kind: string,
): Promise<DraftBundle | null> {
  const safe = sanitizeId(id);
  const dir = draftDir(kind, safe);
  const b = await readBundleFrom(dir);
  if (!b) return null;
  const updated: DraftBundle = patch.status === 'done'
    ? {
        ...b,
        status: 'done',
        targetHandle: patch.targetHandle,
        restId: patch.restId,
        editUrl: patch.editUrl,
        error: undefined,
      }
    : {
        ...b,
        status: patch.status,
        error: patch.error,
        targetHandle: undefined,
        restId: undefined,
        editUrl: undefined,
      };
  await writeFile(join(dir, BUNDLE_FILE), JSON.stringify(updated, null, 2), 'utf8');
  if (patch.status === 'done') {
    const dest = draftDir(kind, safe, true);
    await rm(dest, { recursive: true, force: true });
    await rename(dir, dest).catch(() => {});
  }
  return updated;
}

/** 删除草稿（outbox + sent 都删）。 */
export async function deleteDraft(id: string, kind: string): Promise<boolean> {
  const safe = sanitizeId(id);
  let removed = false;
  for (const sent of [false, true]) {
    const dir = draftDir(kind, safe, sent);
    try {
      await stat(dir);
      await rm(dir, { recursive: true, force: true });
      removed = true;
    } catch {
      /* not there */
    }
  }
  return removed;
}
