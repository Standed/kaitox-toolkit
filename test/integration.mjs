/**
 * 端到端集成测试（自包含）：进程内起 relay，跑四条链路的断言。
 *   0. X 前端 queryId 发现 + 24h 缓存 + 失效后单次刷新
 *   1. relay CRUD + 封面字节 + 目录穿越防护 + done→sent
 *   2. 插件上传流水线（relay 拉字节 → publishXArticle mock 掉 X 接口 → content_state 正确 + 封面 mutation）
 *   3. styleCheck + 纯文本兜底通用不变量
 *
 * 用法：npm run test:integration（需先 npm run build）
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build as buildTestModule } from 'esbuild';

// 必须在 import relay 之前设好，config 每次读 env。
const home = await mkdtemp(join(tmpdir(), 'kaitox-itest-'));
process.env.KAITOX_HOME = home;
process.env.KAITOX_RELAY_PORT = '8788';

const { startRelay } = await import('@kaitox/relay');
const { HttpRelayClient, RelayHttpError } = await import('@kaitox/relay-protocol');
const { saveDraft } = await import('../packages/relay/dist/storage.js');
const {
  publishXArticle,
  collectImageSources,
  checkMarkdownStyle,
  toPlaintextMarkdown,
  DEFAULT_COVER_MEDIA_FEATURES,
} = await import('@kaitox/x-article');

const discoveryBuild = await buildTestModule({
  entryPoints: [join(process.cwd(), 'apps/extension/src/query-id-discovery.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const discoveryModuleUrl = `data:text/javascript;base64,${Buffer.from(discoveryBuild.outputFiles[0].contents).toString('base64')}`;
const {
  QUERY_ID_CACHE_KEY,
  QUERY_ID_FAILURE_CACHE_KEY,
  QUERY_ID_FAILURE_TTL_MS,
  QUERY_ID_TTL_MS,
  createQueryIdRefreshingFetch,
  discoverArticleQueryIds,
  extractArticleOperations,
  resolveArticleQueryIds,
} = await import(discoveryModuleUrl);

const xsessionBuild = await buildTestModule({
  entryPoints: [join(process.cwd(), 'apps/extension/src/xsession.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const xsessionModuleUrl = `data:text/javascript;base64,${Buffer.from(xsessionBuild.outputFiles[0].contents).toString('base64')}`;

const contentOsProtocolBuild = await buildTestModule({
  entryPoints: [join(process.cwd(), 'apps/extension/src/content-os-protocol.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const contentOsProtocolModuleUrl = `data:text/javascript;base64,${Buffer.from(contentOsProtocolBuild.outputFiles[0].contents).toString('base64')}`;
const {
  CONTENT_OS_ORIGIN,
  CONTENT_OS_INBOUND_SOURCE,
  CONTENT_OS_OUTBOUND_SOURCE,
  CONTENT_OS_TARGET_HANDLE,
  MAX_HANDOFF_FUTURE_SKEW_MS,
  MAX_HANDOFF_IMAGE_BYTES,
  MAX_HANDOFF_MEDIA,
  MAX_HANDOFF_TOTAL_BYTES,
  MAX_HANDOFF_TTL_MS,
  contentOsPublicError,
  validateHandoff,
} = await import(contentOsProtocolModuleUrl);

const contentOsContentBuild = await buildTestModule({
  entryPoints: [join(process.cwd(), 'apps/extension/src/content-os-content.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const contentOsContentModuleUrl = `data:text/javascript;base64,${Buffer.from(contentOsContentBuild.outputFiles[0].contents).toString('base64')}`;
const {
  handleContentOsPageMessage,
  normalizeContentOsRuntimeResponse,
} = await import(contentOsContentModuleUrl);

const contentOsBackgroundBuild = await buildTestModule({
  entryPoints: [join(process.cwd(), 'apps/extension/src/content-os-background.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const contentOsBackgroundModuleUrl = `data:text/javascript;base64,${Buffer.from(contentOsBackgroundBuild.outputFiles[0].contents).toString('base64')}`;
const {
  contentOsDraftStatus,
  enqueueContentOsHandoff,
  handleContentOsRuntimeMessage,
} = await import(contentOsBackgroundModuleUrl);

const compatibilityFixture = JSON.parse(await readFile(
  new URL('./fixtures/content-os-kaitox-v1.json', import.meta.url),
  'utf8',
));

const BASE = 'http://127.0.0.1:8788';
let pass = 0,
  fail = 0;
const check = (n, c, extra = '') => {
  c ? pass++ : fail++;
  console.log(`${c ? '✅' : '❌'} ${n} ${extra}`);
};

const pngBytes = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const makeStorage = () => {
  const values = {};
  const removed = [];
  return {
    values,
    removed,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(patch) {
      Object.assign(values, patch);
    },
    async remove(key) {
      removed.push(key);
      delete values[key];
    },
  };
};

const allQueryIds = (prefix) => ({
  ArticleEntityDraftCreate: `${prefix}_CREATE`,
  ArticleEntityUpdateTitle: `${prefix}_TITLE`,
  ArticleEntityUpdateContent: `${prefix}_CONTENT`,
  ArticleEntityUpdateCoverMedia: `${prefix}_COVER`,
});

// ---- -1. Content OS handoff protocol ----
console.log('\n[-1] Content OS handoff protocol validation');
const handoffNow = Date.parse('2026-07-10T04:00:00.000Z');
const handoffBytes = pngBytes;
const handoffSha = createHash('sha256').update(handoffBytes).digest('hex');
const makeHandoffAsset = (index, overrides = {}) => ({
  key: `x-article-media/media-${index}.png`,
  src: `https://media.aizao.ai/x-article-media/media-${index}.png`,
  fileName: `media-${index}.png`,
  mime: 'image/png',
  bytesLen: handoffBytes.byteLength,
  sha256: handoffSha,
  ...overrides,
});
const makeHandoffAssets = (count) => Array.from({ length: count }, (_, index) => makeHandoffAsset(index + 1));
const validHandoffAssets = makeHandoffAssets(2);
const validHandoff = {
  schemaVersion: 1,
  handoffId: 'handoff-task-6',
  title: 'Task 6 bridge',
  markdown: validHandoffAssets.map((asset, index) => `![image ${index + 1}](${asset.src})`).join('\n\n'),
  targetHandle: '@aaxiaoshi666',
  assets: validHandoffAssets,
  cover: makeHandoffAsset('cover', {
    key: 'x-article-cover/cover-5x2.png',
    src: 'https://media.aizao.ai/x-article-cover/cover-5x2.png',
    fileName: 'cover-5x2.png',
  }),
  mediaMap: validHandoffAssets.map((_, assetIndex) => ({
    assetIndex,
    figureIds: [`figure-${assetIndex + 1}`],
    sourceIndexes: [assetIndex],
    cellLabels: [],
  })),
  source: 'content-os',
  createdAt: '2026-07-10T03:30:00.000Z',
  expiresAt: '2026-07-10T04:30:00.000Z',
};
const handoffOk = (manifest) => validateHandoff(manifest, { now: () => handoffNow }).ok;
check('Content OS exact origin constant is locked', CONTENT_OS_ORIGIN === 'https://aizao.ai');
check('valid Content OS handoff passes', handoffOk(validHandoff));
check('cross-repo compatibility fixture is accepted by Kaitox', handoffOk(compatibilityFixture.manifest));
check('cross-repo pending status preserves handoffId',
  JSON.stringify(normalizeContentOsRuntimeResponse(
    compatibilityFixture.statusRequest,
    compatibilityFixture.pendingStatus,
  )) === JSON.stringify(compatibilityFixture.pendingStatus));
check('cross-repo done status preserves handoffId',
  JSON.stringify(normalizeContentOsRuntimeResponse(
    compatibilityFixture.statusRequest,
    compatibilityFixture.doneStatus,
  )) === JSON.stringify(compatibilityFixture.doneStatus));
check('cross-repo structured public error stays bounded',
  JSON.stringify(normalizeContentOsRuntimeResponse(
    compatibilityFixture.statusRequest,
    compatibilityFixture.errorResponse,
  )) === JSON.stringify(compatibilityFixture.errorResponse));
check('wrong target handle is rejected', !handoffOk({ ...validHandoff, targetHandle: 'other' }));
check('the Content OS account is locked to @aaxiaoshi666', CONTENT_OS_TARGET_HANDLE === '@aaxiaoshi666');
check('more than 25 body media are rejected', MAX_HANDOFF_MEDIA === 25 && !handoffOk({
  ...validHandoff,
  assets: makeHandoffAssets(26),
}));
check('an image at 5 MiB is rejected', MAX_HANDOFF_IMAGE_BYTES === 5 * 1024 * 1024 && !handoffOk({
  ...validHandoff,
  assets: [{ ...validHandoff.assets[0], bytesLen: 5 * 1024 * 1024 }],
  markdown: `![image](${validHandoff.assets[0].src})`,
  mediaMap: [{ assetIndex: 0, figureIds: ['figure-1'], sourceIndexes: [0], cellLabels: [] }],
}));
check('non-allowlisted media host is rejected', !handoffOk({
  ...validHandoff,
  assets: [{ ...validHandoff.assets[0], src: 'https://evil.example/a.png' }],
  markdown: '![image](https://evil.example/a.png)',
  mediaMap: [{ assetIndex: 0, figureIds: ['figure-1'], sourceIndexes: [0], cellLabels: [] }],
}));
check('expired manifest is rejected', !handoffOk({ ...validHandoff, expiresAt: '2026-07-09T00:00:00.000Z' }));
check('handoff TTL cannot exceed the fixed maximum', MAX_HANDOFF_TTL_MS === 60 * 60 * 1000 && !handoffOk({
  ...validHandoff,
  expiresAt: new Date(Date.parse(validHandoff.createdAt) + MAX_HANDOFF_TTL_MS + 1).toISOString(),
}));
check('createdAt cannot be too far in the future', MAX_HANDOFF_FUTURE_SKEW_MS === 5 * 60 * 1000 && !handoffOk({
  ...validHandoff,
  createdAt: new Date(handoffNow + MAX_HANDOFF_FUTURE_SKEW_MS + 1).toISOString(),
  expiresAt: new Date(handoffNow + MAX_HANDOFF_FUTURE_SKEW_MS + 60_000).toISOString(),
}));
const oversizedAggregateAssets = makeHandoffAssets(17).map((asset) => ({
  ...asset,
  bytesLen: 4 * 1024 * 1024,
}));
check('declared body and cover bytes cannot exceed the aggregate cap', MAX_HANDOFF_TOTAL_BYTES === 64 * 1024 * 1024 && !handoffOk({
  ...validHandoff,
  assets: oversizedAggregateAssets,
  cover: undefined,
  markdown: oversizedAggregateAssets.map((asset) => `![](${asset.src})`).join('\n'),
  mediaMap: oversizedAggregateAssets.map((_, assetIndex) => ({
    assetIndex,
    figureIds: [`figure-${assetIndex + 1}`],
    sourceIndexes: [assetIndex],
    cellLabels: [],
  })),
}));
check('Markdown image order must exactly match assets', !handoffOk({
  ...validHandoff,
  markdown: [...validHandoffAssets].reverse().map((asset) => `![](${asset.src})`).join('\n'),
}));
check('asset file names cannot contain paths', !handoffOk({
  ...validHandoff,
  assets: [{ ...validHandoff.assets[0], fileName: '../a.png' }],
  markdown: `![image](${validHandoff.assets[0].src})`,
  mediaMap: [{ assetIndex: 0, figureIds: ['figure-1'], sourceIndexes: [0], cellLabels: [] }],
}));

// ---- -0.5. Content OS page/background bridge ----
console.log('\n[-0.5] Content OS exact-origin page/background bridge');
const pagePosts = [];
const forwardedRequests = [];
const pageWindow = {
  postMessage(message, targetOrigin) {
    pagePosts.push({ message, targetOrigin });
  },
};
const sendRuntimeMessage = async (message) => {
  forwardedRequests.push(message);
  if (message.type === 'KAITOX_PING') {
    return { available: true, draftOnly: true, relayToken: 'must-not-cross-page-boundary' };
  }
  if (message.type === 'KAITOX_ENQUEUE') return { draftId: 'draft-content-os-1', extra: 'drop-me' };
  return {
    handoffId: message.handoffId,
    status: 'done',
    restId: 'rest-content-os-1',
    editUrl: 'https://x.com/compose/articles/edit/rest-content-os-1',
    targetHandle: '@aaxiaoshi666',
  };
};
const pingRequest = {
  source: CONTENT_OS_OUTBOUND_SOURCE,
  requestId: 'request-ping-1',
  type: 'KAITOX_PING',
  xCredentials: { cookie: 'must-not-cross-extension-boundary' },
};
const statusRequest = {
  source: CONTENT_OS_OUTBOUND_SOURCE,
  requestId: 'request-status-1',
  type: 'KAITOX_STATUS',
  draftId: 'draft-content-os-1',
  handoffId: validHandoff.handoffId,
};
await handleContentOsPageMessage({
  source: pageWindow,
  origin: 'https://evil.example',
  data: pingRequest,
}, { pageWindow, sendRuntimeMessage });
await handleContentOsPageMessage({
  source: {},
  origin: CONTENT_OS_ORIGIN,
  data: pingRequest,
}, { pageWindow, sendRuntimeMessage });
await handleContentOsPageMessage({
  source: pageWindow,
  origin: CONTENT_OS_ORIGIN,
  data: { ...pingRequest, source: 'other-page' },
}, { pageWindow, sendRuntimeMessage });
check('wrong origin/window/source messages are ignored', forwardedRequests.length === 0 && pagePosts.length === 0);

await handleContentOsPageMessage({
  source: pageWindow,
  origin: CONTENT_OS_ORIGIN,
  data: pingRequest,
}, { pageWindow, sendRuntimeMessage });
check('trusted page request is forwarded once with unknown fields removed',
  forwardedRequests.length === 1 &&
  JSON.stringify(forwardedRequests[0]) === JSON.stringify({
    source: CONTENT_OS_OUTBOUND_SOURCE,
    requestId: pingRequest.requestId,
    type: 'KAITOX_PING',
  }));
check('reply preserves exact request id and exact target origin',
  pagePosts.length === 1 &&
  pagePosts[0].targetOrigin === CONTENT_OS_ORIGIN &&
  pagePosts[0].message.source === CONTENT_OS_INBOUND_SOURCE &&
  pagePosts[0].message.requestId === pingRequest.requestId);
check('page reply exposes only ping status, never relay credentials',
  JSON.stringify(pagePosts[0].message) === JSON.stringify({
    source: CONTENT_OS_INBOUND_SOURCE,
    requestId: pingRequest.requestId,
    available: true,
    draftOnly: true,
  }));
check('malformed done status is rejected by the page bridge',
  normalizeContentOsRuntimeResponse(statusRequest, {
    handoffId: statusRequest.handoffId,
    status: 'done',
    restId: 'rest-1',
    editUrl: 'https://x.com/compose/articles/edit/other',
  }).error.code === 'INVALID_RESPONSE');
const redactedPublicError = normalizeContentOsRuntimeResponse(statusRequest, {
  error: { code: 'INTERNAL_ERROR', message: 'secret /Users/person token=abc' },
});
check('page errors are bounded code/message pairs with untrusted details removed',
  redactedPublicError.error.code === 'INTERNAL_ERROR' &&
  redactedPublicError.error.message.length <= 120 &&
  !JSON.stringify(redactedPublicError).includes('/Users/person') &&
  !JSON.stringify(redactedPublicError).includes('token=abc'));
check('raw string errors are never forwarded to the page',
  normalizeContentOsRuntimeResponse(statusRequest, { error: 'relay /Users/person token=abc' }).error.code === 'INVALID_RESPONSE');
check('unknown internal exceptions map to one fixed public error',
  JSON.stringify(contentOsPublicError(new Error('relay /Users/person token=abc'))) === JSON.stringify({
    code: 'INTERNAL_ERROR',
    message: 'Kaitox 暂时无法处理该请求，请稍后重试。',
  }));

const backgroundAssets = makeHandoffAssets(4);
const backgroundManifest = {
  ...validHandoff,
  assets: backgroundAssets,
  markdown: backgroundAssets.map((asset) => `![](${asset.src})`).join('\n'),
  mediaMap: backgroundAssets.map((_, assetIndex) => ({
    assetIndex,
    figureIds: [`figure-${assetIndex + 1}`],
    sourceIndexes: [assetIndex],
    cellLabels: [],
  })),
};
let activeHandoffDownloads = 0;
let maxActiveHandoffDownloads = 0;
const handoffFetches = [];
const postDraftInputs = [];
const storedAutoUpload = [];
const openedTabs = [];
const backgroundClient = {
  async postDraft(input) {
    postDraftInputs.push(input);
    return { id: 'draft-content-os-1' };
  },
  async getDraft(draftId) {
    return {
      id: draftId,
      source: 'content-os',
      status: 'done',
      restId: 'rest-content-os-1',
      editUrl: 'https://x.com/compose/articles/edit/rest-content-os-1',
      targetHandle: '@aaxiaoshi666',
      sourceMeta: {
        handoffId: validHandoff.handoffId,
        targetHandle: '@aaxiaoshi666',
      },
      markdown: 'secret body must not cross status',
    };
  },
};
const backgroundDeps = {
  now: () => handoffNow,
  getClient: async () => backgroundClient,
  fetchImpl: async (url, init) => {
    handoffFetches.push({ url, init });
    activeHandoffDownloads++;
    maxActiveHandoffDownloads = Math.max(maxActiveHandoffDownloads, activeHandoffDownloads);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeHandoffDownloads--;
    return new Response(handoffBytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(handoffBytes.byteLength),
      },
    });
  },
  storageLocal: {
    values: {},
    async get(key) { return { [key]: this.values[key] }; },
    async set(value) {
      Object.assign(this.values, value);
      storedAutoUpload.push(value);
    },
  },
  tabs: {
    async create(value) { openedTabs.push(value); },
  },
};
const enqueueResult = await enqueueContentOsHandoff(backgroundManifest, backgroundDeps);
check('enqueue returns the local relay draft id', enqueueResult.draftId === 'draft-content-os-1');
check('media downloads use concurrency 3', handoffFetches.length === 5 && maxActiveHandoffDownloads === 3);
check('media downloads omit credentials and reject redirects', handoffFetches.every(({ init }) =>
  init?.credentials === 'omit' && init?.redirect === 'error'));
check('relay bundle preserves exact body src and verified local bytes',
  postDraftInputs.length === 1 &&
  postDraftInputs[0].source === 'content-os' &&
  postDraftInputs[0].sourceMeta.handoffId === backgroundManifest.handoffId &&
  postDraftInputs[0].sourceMeta.targetHandle === backgroundManifest.targetHandle &&
  postDraftInputs[0].assets.every((asset, index) =>
    asset.src === backgroundManifest.assets[index].src && asset.bytes.byteLength === handoffBytes.byteLength));
check('cover becomes the relay cover sentinel',
  postDraftInputs[0].cover.src === '__cover__' &&
  postDraftInputs[0].cover.bytes.byteLength === handoffBytes.byteLength);
check('auto-upload id is stored before opening only the X Articles composer',
  storedAutoUpload[0]?.kaitoxAutoUploadDraftId === 'draft-content-os-1' &&
  openedTabs.length === 1 && openedTabs[0].url === 'https://x.com/compose/articles');

const replayResult = await enqueueContentOsHandoff(backgroundManifest, backgroundDeps);
check('replaying the same handoffId is idempotent and creates no duplicate draft or tab',
  replayResult.draftId === enqueueResult.draftId && postDraftInputs.length === 1 && openedTabs.length === 1);
await assert.rejects(
  () => enqueueContentOsHandoff({ ...backgroundManifest, title: 'conflicting replay' }, backgroundDeps),
  (error) => error?.code === 'HANDOFF_REPLAY_CONFLICT',
);
check('the same handoffId cannot be replayed with different content', postDraftInputs.length === 1);

await assert.rejects(
  () => enqueueContentOsHandoff({ ...backgroundManifest, handoffId: 'handoff-relay-conflict' }, {
    ...backgroundDeps,
    storageLocal: { async get() { return {}; }, async set() {} },
    getClient: async () => ({
      async postDraft() {
        throw new RelayHttpError('POST', 'http://127.0.0.1:8765/x-article/drafts', 409);
      },
    }),
  }),
  (error) => error?.code === 'HANDOFF_REPLAY_CONFLICT',
);
check('relay idempotency conflicts preserve the bounded public conflict code', true);

let corruptedReplayPostCount = 0;
await assert.rejects(
  () => enqueueContentOsHandoff({ ...backgroundManifest, handoffId: 'handoff-corrupt-record' }, {
    ...backgroundDeps,
    storageLocal: {
      async get(key) { return { [key]: { version: 1, handoffId: 'tampered' } }; },
      async set() {},
    },
    getClient: async () => ({
      async postDraft() { corruptedReplayPostCount++; return { id: 'must-not-exist' }; },
    }),
  }),
  (error) => error?.code === 'HANDOFF_REPLAY_CONFLICT',
);
check('a corrupt persisted replay record fails closed before relay enqueue', corruptedReplayPostCount === 0);

let concurrentPostCount = 0;
const concurrentStorage = {
  values: {},
  async get(key) { return { [key]: this.values[key] }; },
  async set(value) { Object.assign(this.values, value); },
};
const concurrentDeps = {
  ...backgroundDeps,
  storageLocal: concurrentStorage,
  getClient: async () => ({
    async postDraft() {
      concurrentPostCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: 'draft-concurrent' };
    },
  }),
};
const concurrentManifest = { ...backgroundManifest, handoffId: 'handoff-concurrent' };
const concurrentResults = await Promise.all([
  enqueueContentOsHandoff(concurrentManifest, concurrentDeps),
  enqueueContentOsHandoff(concurrentManifest, concurrentDeps),
]);
check('concurrent duplicate handoffs share one relay enqueue',
  concurrentPostCount === 1 && concurrentResults.every(({ draftId }) => draftId === 'draft-concurrent'));

let expiryNow = handoffNow;
let expiredPostCount = 0;
await assert.rejects(
  () => enqueueContentOsHandoff({
    ...backgroundManifest,
    handoffId: 'handoff-expires-during-download',
    expiresAt: new Date(handoffNow + 10).toISOString(),
  }, {
    ...backgroundDeps,
    now: () => expiryNow,
    fetchImpl: async () => {
      expiryNow += 20;
      return new Response(handoffBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(handoffBytes.byteLength),
        },
      });
    },
    storageLocal: { values: {}, async get() { return {}; }, async set() {} },
    getClient: async () => ({
      async postDraft() { expiredPostCount++; return { id: 'must-not-exist' }; },
    }),
  }),
  (error) => error?.code === 'INVALID_HANDOFF',
);
check('expiry is rechecked immediately before relay post', expiredPostCount === 0);

const safeStatus = await contentOsDraftStatus('draft-content-os-1', validHandoff.handoffId, backgroundDeps);
check('status response is strict and omits body/account/credential-adjacent fields',
  JSON.stringify(safeStatus) === JSON.stringify({
    handoffId: validHandoff.handoffId,
    status: 'done',
    restId: 'rest-content-os-1',
    editUrl: 'https://x.com/compose/articles/edit/rest-content-os-1',
  }));
let wrongTerminalRejected = false;
await assert.rejects(
  () => contentOsDraftStatus('draft-content-os-1', 'wrong-handoff', backgroundDeps),
  (error) => error?.code === 'STATUS_MISMATCH',
);
await assert.rejects(
  () => contentOsDraftStatus('draft-content-os-1', validHandoff.handoffId, {
    ...backgroundDeps,
    getClient: async () => ({
      ...backgroundClient,
      async getDraft(id) { return { ...(await backgroundClient.getDraft(id)), targetHandle: '@other' }; },
    }),
  }),
  (error) => (wrongTerminalRejected = error?.code === 'STATUS_MISMATCH'),
);
check('status lookup correlates handoffId and the terminal @aaxiaoshi666 handle', wrongTerminalRejected);
check('background rejects runtime messages from non-Content-OS senders',
  await handleContentOsRuntimeMessage(pingRequest, { url: 'https://evil.example/writing' }, backgroundDeps) === undefined);
check('background ping is draft-only and credential-free',
  JSON.stringify(await handleContentOsRuntimeMessage(
    pingRequest,
    { url: 'https://aizao.ai/writing/123' },
    backgroundDeps,
  )) === JSON.stringify({ available: true, draftOnly: true }));
check('status page requests must carry the handoffId correlation key',
  JSON.stringify(await handleContentOsRuntimeMessage(
    statusRequest,
    { url: 'https://aizao.ai/writing/123' },
    backgroundDeps,
  )) === JSON.stringify(safeStatus) &&
  await handleContentOsRuntimeMessage(
    { ...statusRequest, handoffId: undefined },
    { url: 'https://aizao.ai/writing/123' },
    backgroundDeps,
  ) === undefined);

let integrityPostCount = 0;
let contentTypeRejected = false;
await assert.rejects(
  () => enqueueContentOsHandoff({
    ...validHandoff,
    handoffId: 'handoff-integrity',
    assets: [{ ...validHandoff.assets[0], sha256: '0'.repeat(64) }],
    markdown: `![](${validHandoff.assets[0].src})`,
    mediaMap: [{ assetIndex: 0, figureIds: ['figure-1'], sourceIndexes: [0], cellLabels: [] }],
    cover: undefined,
  }, {
    ...backgroundDeps,
    storageLocal: { values: {}, async get() { return {}; }, async set() {} },
    getClient: async () => ({
      async postDraft() { integrityPostCount++; return { id: 'must-not-exist' }; },
    }),
  }),
  (error) => error?.code === 'MEDIA_VALIDATION_FAILED',
);
check('integrity failure prevents relay enqueue', integrityPostCount === 0);

const singleAssetHandoff = {
  ...validHandoff,
  assets: [validHandoff.assets[0]],
  cover: undefined,
  markdown: `![](${validHandoff.assets[0].src})`,
  mediaMap: [{ assetIndex: 0, figureIds: ['figure-1'], sourceIndexes: [0], cellLabels: [] }],
};
let preflightReadCount = 0;
await assert.rejects(
  () => enqueueContentOsHandoff(singleAssetHandoff, {
    ...backgroundDeps,
    storageLocal: { values: {}, async get() { return {}; }, async set() {} },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: validHandoff.assets[0].src,
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': String(MAX_HANDOFF_IMAGE_BYTES),
      }),
      body: { getReader() { preflightReadCount++; throw new Error('body must not be read'); } },
      async arrayBuffer() { throw new Error('arrayBuffer must not be called'); },
    }),
  }),
  (error) => error?.code === 'MEDIA_VALIDATION_FAILED',
);
check('Content-Length is rejected before reading or allocating an oversized body', preflightReadCount === 0);

let arrayBufferCalled = false;
let streamReadCount = 0;
await assert.rejects(
  () => enqueueContentOsHandoff(singleAssetHandoff, {
    ...backgroundDeps,
    storageLocal: { values: {}, async get() { return {}; }, async set() {} },
    fetchImpl: async () => {
      const chunks = [new Uint8Array(MAX_HANDOFF_IMAGE_BYTES), new Uint8Array([1])];
      return {
        ok: true,
        status: 200,
        url: validHandoff.assets[0].src,
        headers: new Headers({ 'content-type': 'image/png' }),
        body: {
          getReader() {
            return {
              async read() {
                streamReadCount++;
                return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
              },
            };
          },
        },
        async arrayBuffer() { arrayBufferCalled = true; throw new Error('must stream'); },
      };
    },
  }),
  (error) => error?.code === 'MEDIA_VALIDATION_FAILED',
);
check('streaming cap aborts before a whole response allocation', streamReadCount === 1 && !arrayBufferCalled);

await assert.rejects(
  () => enqueueContentOsHandoff(singleAssetHandoff, {
    ...backgroundDeps,
    storageLocal: { values: {}, async get() { return {}; }, async set() {} },
    fetchImpl: async () => new Response(handoffBytes, {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-length': String(handoffBytes.byteLength),
      },
    }),
  }),
  (error) => (contentTypeRejected = error?.code === 'MEDIA_VALIDATION_FAILED'),
);
check('downloaded Content-Type must match the manifest image MIME', contentTypeRejected);

const fakePngBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
const fakePngAsset = {
  ...validHandoff.assets[0],
  bytesLen: fakePngBytes.byteLength,
  sha256: createHash('sha256').update(fakePngBytes).digest('hex'),
};
let signatureRejected = false;
await assert.rejects(
  () => enqueueContentOsHandoff({
    ...validHandoff,
    assets: [fakePngAsset],
    cover: undefined,
    markdown: `![](${fakePngAsset.src})`,
    mediaMap: [{ assetIndex: 0, figureIds: ['figure-1'], sourceIndexes: [0], cellLabels: [] }],
  }, {
    ...backgroundDeps,
    storageLocal: { values: {}, async get() { return {}; }, async set() {} },
    fetchImpl: async () => new Response(fakePngBytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(fakePngBytes.byteLength),
      },
    }),
  }),
  (error) => (signatureRejected = error?.code === 'MEDIA_VALIDATION_FAILED'),
);
check('downloaded bytes must match the declared image signature', signatureRejected);

const failedStatus = await contentOsDraftStatus('draft-content-os-1', validHandoff.handoffId, {
  ...backgroundDeps,
  getClient: async () => ({
    ...backgroundClient,
    async getDraft(id) {
      return {
        ...(await backgroundClient.getDraft(id)),
        status: 'failed',
        targetHandle: undefined,
        restId: undefined,
        editUrl: undefined,
        error: 'relay /Users/person token=abc',
      };
    },
  }),
});
check('failed relay status exposes only a fixed public error code/message',
  failedStatus.status === 'failed' &&
  failedStatus.error.code === 'DRAFT_FAILED' &&
  !JSON.stringify(failedStatus).includes('/Users/person') &&
  !JSON.stringify(failedStatus).includes('token=abc'));

// ---- 0. X 前端 queryId 动态发现 ----
console.log('\n[0] X 前端 queryId 发现 + 缓存 + 单次刷新');
const fixture = `e.exports={queryId:"abc_123",operationName:"ArticleEntityUpdateContent"};`;
check(
  '解析 queryId → operationName',
  extractArticleOperations(fixture).ArticleEntityUpdateContent === 'abc_123',
);
const reversed = `operationName:"ArticleEntityUpdateTitle",queryId:"title_456"`;
check(
  '解析 operationName → queryId',
  extractArticleOperations(reversed).ArticleEntityUpdateTitle === 'title_456',
);
const nearbyWrongId = `{queryId:"RIGHT_CONTENT",padding:"${'x'.repeat(200)}",operationName:"ArticleEntityUpdateContent"},{queryId:"WRONG_NEARBY"}`;
check(
  'operation 只映射同一对象里的 queryId',
  extractArticleOperations(nearbyWrongId).ArticleEntityUpdateContent === 'RIGHT_CONTENT',
);

const bundleBase = 'https://abs.twimg.com/responsive-web/client-web';
const bundleUrls = Array.from({ length: 5 }, (_, i) => `${bundleBase}/task5-${i + 1}.js`);
const pageHtml = bundleUrls.map((url) => `<script src="${url}"></script>`).join('');
const bundleBodies = new Map([
  [bundleUrls[0], `queryId:"LIVE_CREATE",operationName:"ArticleEntityDraftCreate"`],
  [bundleUrls[1], `operationName:"ArticleEntityUpdateTitle",queryId:"LIVE_TITLE"`],
  [bundleUrls[2], `queryId:"LIVE_CONTENT",operationName:"ArticleEntityUpdateContent"`],
  [bundleUrls[3], `operationName:"ArticleEntityUpdateCoverMedia",queryId:"LIVE_COVER"`],
  [bundleUrls[4], 'unused fifth bundle'],
]);
const storage = makeStorage();
const fetchedUrls = [];
let activeBundles = 0;
let maxActiveBundles = 0;
const discoveryFetch = async (url) => {
  fetchedUrls.push(url);
  if (url.startsWith(bundleBase)) {
    activeBundles++;
    maxActiveBundles = Math.max(maxActiveBundles, activeBundles);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeBundles--;
    return new Response(bundleBodies.get(url), { status: 200 });
  }
  return new Response(pageHtml, { status: 200 });
};
const now = 1_800_000_000_000;
const liveIds = await discoverArticleQueryIds({ fetchImpl: discoveryFetch, storage, now: () => now });
check('四个 operation 精确映射', JSON.stringify(liveIds) === JSON.stringify({
  ArticleEntityDraftCreate: 'LIVE_CREATE',
  ArticleEntityUpdateTitle: 'LIVE_TITLE',
  ArticleEntityUpdateContent: 'LIVE_CONTENT',
  ArticleEntityUpdateCoverMedia: 'LIVE_COVER',
}));
check('前端 bundle 最多四并发', maxActiveBundles === 4);
check('集齐四个 operation 后停止抓 bundle', !fetchedUrls.includes(bundleUrls[4]));
check('local cache 写入 ids + fetchedAt + 24h TTL',
  storage.values[QUERY_ID_CACHE_KEY]?.fetchedAt === now &&
    storage.values[QUERY_ID_CACHE_KEY]?.ttlMs === 86_400_000 &&
    QUERY_ID_TTL_MS === 86_400_000,
);
const cachedIds = await discoverArticleQueryIds({
  fetchImpl: async () => { throw new Error('fresh cache must not fetch'); },
  storage,
  now: () => now + QUERY_ID_TTL_MS - 1,
});
check('24h 内直接使用 cache', JSON.stringify(cachedIds) === JSON.stringify(liveIds));

const boundaryIds = allQueryIds('BOUNDARY');
let boundaryFetches = 0;
const boundaryBundle = `${bundleBase}/boundary.js`;
const boundaryResult = await discoverArticleQueryIds({
  fetchImpl: async (url) => {
    boundaryFetches++;
    return new Response(url === boundaryBundle
      ? Object.entries(boundaryIds).map(([operationName, queryId]) => `operationName:"${operationName}",queryId:"${queryId}"`).join(';')
      : `<script src="${boundaryBundle}"></script>`, { status: 200 });
  },
  storage,
  now: () => now + QUERY_ID_TTL_MS,
});
check('恰好 24h 时 cache 过期并重新发现',
  boundaryFetches >= 2 && JSON.stringify(boundaryResult) === JSON.stringify(boundaryIds));

const runtimeIds = allQueryIds('RUNTIME');
const runtimeBundle = `${bundleBase}/bundle.TwitterArticles.8202180a.js`;
const runtimeSource = `p.u=e=>""+({67713:"bundle.TwitterArticles"}[e]||e)+"."+({67713:"8202180"})[e]+"a.js",p.p="${bundleBase}/"`;
const runtimeFetches = [];
const runtimeResult = await discoverArticleQueryIds({
  fetchImpl: async (url) => {
    runtimeFetches.push(url);
    if (url === runtimeBundle) {
      return new Response(Object.entries(runtimeIds)
        .map(([operationName, queryId]) => `e.exports={queryId:"${queryId}",operationName:"${operationName}",operationType:"mutation"}`)
        .join(';'), { status: 200 });
    }
    return new Response(runtimeSource, { status: 200 });
  },
  storage: makeStorage(),
  pages: ['https://x.com/compose/articles'],
});
check('webpack runtime/chunk map 定位动态 TwitterArticles bundle',
  runtimeFetches.includes(runtimeBundle) && JSON.stringify(runtimeResult) === JSON.stringify(runtimeIds));

const resourceIds = allQueryIds('RESOURCE');
const resourceBundle = `${bundleBase}/bundle.TwitterArticles.resourcea.js`;
const resourceResult = await discoverArticleQueryIds({
  fetchImpl: async (url) => new Response(Object.entries(resourceIds)
    .map(([operationName, queryId]) => `queryId:"${queryId}",operationName:"${operationName}"`)
    .join(';'), { status: url === resourceBundle ? 200 : 404 }),
  storage: makeStorage(),
  pages: [],
  resourceUrls: [resourceBundle],
});
check('已加载 performance resource 可直接发现 TwitterArticles bundle',
  JSON.stringify(resourceResult) === JSON.stringify(resourceIds));

const sharedStorage = makeStorage();
let sharedFetches = 0;
let releaseSharedPage;
const sharedPage = new Promise((resolve) => { releaseSharedPage = resolve; });
const sharedBundle = `${bundleBase}/shared.js`;
const sharedFetch = async (url) => {
  sharedFetches++;
  if (url === sharedBundle) {
    return new Response(Object.entries(allQueryIds('SHARED'))
      .map(([operationName, queryId]) => `queryId:"${queryId}",operationName:"${operationName}"`)
      .join(';'), { status: 200 });
  }
  await sharedPage;
  return new Response(`<script src="${sharedBundle}"></script>`, { status: 200 });
};
const sharedA = discoverArticleQueryIds({ fetchImpl: sharedFetch, storage: sharedStorage, pages: ['https://x.com/a'] });
const sharedB = discoverArticleQueryIds({ fetchImpl: sharedFetch, storage: sharedStorage, pages: ['https://x.com/a'] });
releaseSharedPage();
const [sharedResultA, sharedResultB] = await Promise.all([sharedA, sharedB]);
check('并发调用共享同一个 discovery in-flight promise',
  sharedFetches === 2 && JSON.stringify(sharedResultA) === JSON.stringify(sharedResultB));

const timeoutFallback = allQueryIds('TIMEOUT_FALLBACK');
const timeoutStorage = makeStorage();
let timeoutFetches = 0;
const boundedResult = await Promise.race([
  resolveArticleQueryIds(timeoutFallback, {
    fetchImpl: async () => {
      timeoutFetches++;
      return new Promise(() => {});
    },
    storage: timeoutStorage,
    pages: ['https://x.com/hangs'],
    fetchTimeoutMs: 10,
  }),
  new Promise((resolve) => setTimeout(() => resolve('HUNG'), 100)),
]);
const cachedFailureResult = await resolveArticleQueryIds(timeoutFallback, {
  fetchImpl: async () => {
    timeoutFetches++;
    return new Response('must not retry during failure TTL', { status: 500 });
  },
  storage: timeoutStorage,
  pages: ['https://x.com/hangs'],
});
check('discovery fetch 有超时上限且失败会负缓存',
  boundedResult !== 'HUNG' && timeoutFetches === 1 &&
    timeoutStorage.values[QUERY_ID_FAILURE_CACHE_KEY]?.ttlMs === QUERY_ID_FAILURE_TTL_MS &&
    JSON.stringify(cachedFailureResult) === JSON.stringify(timeoutFallback));

const staleStorage = makeStorage();
const staleCachedIds = allQueryIds('STALE_CACHE');
staleStorage.values[QUERY_ID_CACHE_KEY] = { ids: staleCachedIds, fetchedAt: now, ttlMs: QUERY_ID_TTL_MS };
let staleNow = now + QUERY_ID_TTL_MS;
let staleFetchMode = 'fail';
let staleFetches = 0;
const recoveredIds = allQueryIds('RECOVERED');
const recoveryBundle = `${bundleBase}/recovery.js`;
const staleFetch = async (url) => {
  staleFetches++;
  if (staleFetchMode === 'fail') return new Response('unavailable', { status: 503 });
  return new Response(url === recoveryBundle
    ? Object.entries(recoveredIds).map(([operationName, queryId]) => `queryId:"${queryId}",operationName:"${operationName}"`).join(';')
    : `<script src="${recoveryBundle}"></script>`, { status: 200 });
};
const staleResult = await discoverArticleQueryIds({
  fetchImpl: staleFetch,
  storage: staleStorage,
  pages: ['https://x.com/stale'],
  now: () => staleNow,
});
const staleFetchesAfterFailure = staleFetches;
const staleCooldownResult = await discoverArticleQueryIds({
  fetchImpl: staleFetch,
  storage: staleStorage,
  pages: ['https://x.com/stale'],
  now: () => staleNow + 1,
});
staleNow += QUERY_ID_FAILURE_TTL_MS;
staleFetchMode = 'recover';
const recoveredResult = await discoverArticleQueryIds({
  fetchImpl: staleFetch,
  storage: staleStorage,
  pages: ['https://x.com/stale'],
  now: () => staleNow,
});
check('过期 cache 在失败期兜底，负缓存到期后可恢复',
  JSON.stringify(staleResult) === JSON.stringify(staleCachedIds) &&
    JSON.stringify(staleCooldownResult) === JSON.stringify(staleCachedIds) &&
    staleFetches === staleFetchesAfterFailure + 2 &&
    JSON.stringify(recoveredResult) === JSON.stringify(recoveredIds));

const forcedIds = allQueryIds('FORCED');
const forcedHtml = `${bundleBase}/forced.js`;
let forcedFetches = 0;
await discoverArticleQueryIds({
  fetchImpl: async (url) => {
    forcedFetches++;
    return new Response(url === forcedHtml
      ? Object.entries(forcedIds).map(([operationName, queryId]) => `operationName:"${operationName}",queryId:"${queryId}"`).join(';')
      : `<script src="${forcedHtml}"></script>`, { status: 200 });
  },
  storage,
  now: () => now + 1,
  forceRefresh: true,
});
check('强制刷新先清 cache 再重新发现', storage.removed.includes(QUERY_ID_CACHE_KEY) && forcedFetches >= 2);

const fallbackIds = allQueryIds('FALLBACK');
const resolvedFallback = await resolveArticleQueryIds(fallbackIds, {
  fetchImpl: async () => new Response('unavailable', { status: 503 }),
  storage: makeStorage(),
});
check('前端发现失败时才用内置 fallback', JSON.stringify(resolvedFallback) === JSON.stringify(fallbackIds));

const staleIds = allQueryIds('STALE');
const freshIds = allQueryIds('FRESH');
const retryCalls = [];
let refreshCount = 0;
const retryingFetch = createQueryIdRefreshingFetch(
  async (url, init) => {
    retryCalls.push({ url, body: init?.body });
    return new Response(retryCalls.length === 1 ? 'not found' : JSON.stringify({ data: { ok: true } }), {
      status: retryCalls.length === 1 ? 404 : 200,
    });
  },
  staleIds,
  async () => {
    refreshCount++;
    return freshIds;
  },
);
await retryingFetch(
  `https://x.com/i/api/graphql/${staleIds.ArticleEntityUpdateTitle}/ArticleEntityUpdateTitle`,
  { method: 'POST', body: JSON.stringify({ queryId: staleIds.ArticleEntityUpdateTitle, variables: { title: 'T' } }) },
);
check('GraphQL 404 只刷新一次并重试同一 operation',
  refreshCount === 1 && retryCalls.length === 2 &&
    retryCalls[1].url.includes(`/${freshIds.ArticleEntityUpdateTitle}/ArticleEntityUpdateTitle`),
);
check('刷新后同步 URL、body 和后续 operation 映射',
  retryCalls[1] && JSON.parse(retryCalls[1].body).queryId === freshIds.ArticleEntityUpdateTitle &&
    staleIds.ArticleEntityUpdateContent === freshIds.ArticleEntityUpdateContent,
);

let operationRefreshes = 0;
let operationCalls = 0;
const operationRetryFetch = createQueryIdRefreshingFetch(
  async () => {
    operationCalls++;
    return new Response(operationCalls === 1
      ? JSON.stringify({ errors: [{ message: 'Operation ArticleEntityUpdateContent not found' }] })
      : JSON.stringify({ data: { ok: true } }), { status: 200 });
  },
  allQueryIds('OLD'),
  async () => {
    operationRefreshes++;
    return allQueryIds('NEW');
  },
);
await operationRetryFetch('https://x.com/i/api/graphql/OLD_CONTENT/ArticleEntityUpdateContent', {
  method: 'POST',
  body: JSON.stringify({ queryId: 'OLD_CONTENT' }),
});
check('operation-not-found 也只刷新并重试一次', operationRefreshes === 1 && operationCalls === 2);

let unrelatedRefreshes = 0;
const unrelatedResponse = new Response(JSON.stringify({ errors: [{ message: 'You are not allowed to edit this article' }] }), {
  status: 403,
});
const unrelatedFetch = createQueryIdRefreshingFetch(
  async () => unrelatedResponse,
  allQueryIds('UNCHANGED'),
  async () => {
    unrelatedRefreshes++;
    return allQueryIds('UNUSED');
  },
);
const unrelatedResult = await unrelatedFetch(
  'https://x.com/i/api/graphql/UNCHANGED_CONTENT/ArticleEntityUpdateContent',
  { method: 'POST', body: JSON.stringify({ queryId: 'UNCHANGED_CONTENT' }) },
);
check('无关 GraphQL 错误原样透传且不触发 discovery',
  unrelatedResult === unrelatedResponse && unrelatedRefreshes === 0);

let ordinaryNetworkCalls = 0;
globalThis.window = { fetch: async () => { ordinaryNetworkCalls++; throw new Error('ordinary settings must not fetch'); } };
globalThis.chrome = {
  storage: {
    sync: {
      async get() {
        return { relayBase: 'http://127.0.0.1:9999', relayToken: 'local-token' };
      },
    },
    local: {
      async get() {
        ordinaryNetworkCalls++;
        throw new Error('ordinary settings must not read discovery cache');
      },
    },
  },
};
const { getSettings: getOrdinarySettings } = await import(xsessionModuleUrl);
const ordinarySettings = await getOrdinarySettings();
check('普通 relay/UI 设置读取与网络 discovery 解耦',
  ordinarySettings.relayBase === 'http://127.0.0.1:9999' &&
    ordinarySettings.token === 'local-token' &&
    ordinaryNetworkCalls === 0);

const handle = await startRelay();
try {
  const client = new HttpRelayClient(BASE);

  // ---- 1. relay CRUD（含封面）----
  console.log('\n[1] relay CRUD + 封面字节');
  const { id } = await client.postDraft({
    title: '集成测试', mode: 'rich', source: 'cli',
    markdown: '# 集成测试\n\n正文 **粗**。\n\n![图](images/a.png)\n',
    assets: [{ key: 'img-0', src: 'images/a.png', fileName: 'a.png', mime: 'image/png', bytes: pngBytes }],
    cover: { key: 'cover', src: '__cover__', fileName: 'cover-c.png', mime: 'image/png', bytes: pngBytes },
  });
  check('post 返回 id', typeof id === 'string');
  check('list 含草稿', (await client.listDrafts()).some((d) => d.id === id));
  const got = await client.getAsset(id, 'a.png');
  check('正文图字节回读一致', got.length === pngBytes.length && got[0] === pngBytes[0]);
  const gotCover = await client.getAsset(id, 'cover-c.png');
  check('封面字节回读一致', gotCover.length === pngBytes.length);
  const draftMeta = await client.getDraft(id);
  check('bundle.cover 元信息保留', draftMeta.cover?.fileName === 'cover-c.png');
  // 封面原图：PUT cover 带 original → 原图随成品落盘；不带（重裁语义）→ 原图保留
  await client.setCover(id, {
    fileName: 'c2.png', mime: 'image/png', bytes: pngBytes,
    original: { fileName: 'orig.png', mime: 'image/png', bytes: pngBytes },
  });
  const withOrig = await client.getDraft(id);
  check('setCover 带 original → coverOriginal 落盘', withOrig.coverOriginal?.fileName === 'cover-original-orig.png');
  check('原图字节回读一致', (await client.getAsset(id, 'cover-original-orig.png')).length === pngBytes.length);
  await client.setCover(id, { fileName: 'c3.png', mime: 'image/png', bytes: pngBytes });
  const recropped = await client.getDraft(id);
  check(
    '重裁（不带 original）→ 封面替换、原图保留',
    recropped.cover?.fileName === 'cover-c3.png' && recropped.coverOriginal?.fileName === 'cover-original-orig.png',
  );
  check('kind 缺省时按 x-article 落盘', draftMeta.kind === 'x-article');
  const listedItem = (await client.listDrafts()).find((d) => d.id === id);
  check('list 条目带 kind', listedItem?.kind === 'x-article');
  // 自定义 kind 原样经 relay 往返（relay 只存转不解释；命名空间由路径段决定，relay 零改动）。
  const demoClient = new HttpRelayClient(BASE, { kind: 'demo-feature' });
  const { id: kindId } = await demoClient.postDraft({
    title: 'kind 往返', mode: 'rich', source: 'my-service',
    markdown: 'hello', assets: [],
  });
  check('自定义 kind 往返保留', (await demoClient.getDraft(kindId)).kind === 'demo-feature');
  check('跨 kind 隔离：x-article 列表不含 demo-feature', !(await client.listDrafts()).some((d) => d.id === kindId));
  await demoClient.deleteDraft(kindId);

  const idempotentInput = {
    title: 'Content OS idempotency', mode: 'rich', source: 'content-os', markdown: '', assets: [],
    sourceMeta: {
      handoffId: 'handoff-relay-idempotency',
      handoffFingerprint: 'a'.repeat(64),
      targetHandle: '@aaxiaoshi666',
    },
  };
  const firstIdempotent = await client.postDraft(idempotentInput);
  const replayedIdempotent = await client.postDraft(idempotentInput);
  check('relay enqueue is idempotent on handoffId and fingerprint',
    firstIdempotent.id === replayedIdempotent.id);
  await assert.rejects(
    () => client.postDraft({
      ...idempotentInput,
      sourceMeta: { ...idempotentInput.sourceMeta, handoffFingerprint: 'b'.repeat(64) },
    }),
    (error) => error?.status === 409,
  );
  check('relay rejects a conflicting fingerprint for the same handoffId', true);

  const interruptedWire = {
    bundle: {
      schemaVersion: 1,
      id: 'caller-generated-id-is-not-authoritative',
      kind: 'x-article',
      title: 'Interrupted Content OS enqueue',
      markdown: '',
      mode: 'rich',
      assets: [],
      createdAt: '2026-07-10T04:00:00.000Z',
      source: 'content-os',
      sourceMeta: {
        handoffId: 'handoff-relay-interruption',
        handoffFingerprint: 'c'.repeat(64),
        targetHandle: '@aaxiaoshi666',
      },
    },
    assets: [],
  };
  await assert.rejects(
    () => saveDraft(interruptedWire, 'x-article', {
      afterIdempotencyPrecommit() { throw new Error('simulated interruption'); },
    }),
    /simulated interruption/,
  );
  const recoveredId = await saveDraft(interruptedWire, 'x-article');
  const replayedRecoveredId = await saveDraft(interruptedWire, 'x-article');
  check('durable precommit reconciles an interrupted relay enqueue',
    recoveredId === replayedRecoveredId && Boolean(await client.getDraft(recoveredId)));

  let failExtensionStorage = true;
  const recoveryTabs = [];
  const recoveryStorage = {
    values: {},
    async get(key) { return { [key]: this.values[key] }; },
    async set(value) {
      if (failExtensionStorage) {
        failExtensionStorage = false;
        throw new Error('simulated extension storage failure');
      }
      Object.assign(this.values, value);
    },
  };
  const recoveryDeps = {
    now: () => handoffNow,
    getClient: async () => client,
    fetchImpl: async () => new Response(handoffBytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(handoffBytes.byteLength),
      },
    }),
    storageLocal: recoveryStorage,
    tabs: { async create(value) { recoveryTabs.push(value); } },
  };
  await assert.rejects(
    () => enqueueContentOsHandoff(compatibilityFixture.manifest, recoveryDeps),
    /simulated extension storage failure/,
  );
  const recoveredEnqueue = await enqueueContentOsHandoff(compatibilityFixture.manifest, recoveryDeps);
  const recoveredMatches = (await client.listDrafts()).filter((draft) =>
    draft.title === compatibilityFixture.manifest.title);
  check('relay identity closes the extension storage partial-failure window',
    recoveredMatches.length === 1
    && recoveredMatches[0].id === recoveredEnqueue.draftId
    && recoveryTabs.length === 1);
  let traversalBlocked = false;
  try { await client.getAsset(id, '../../etc/passwd'); } catch { traversalBlocked = true; }
  check('目录穿越被拦', traversalBlocked);

  // ---- 1b. 边界校验 + 基础设施路由 ----
  console.log('\n[1b] wire 校验、旧路由 410、/setting');
  const postRaw = (path, body, headers = {}) =>
    fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const badRes = await postRaw('/x-article/drafts', JSON.stringify({ bundle: { id: '' }, assets: 'nope' }));
  check('畸形 POST → 400', badRes.status === 400);
  const badJson = await badRes.json();
  check(
    '400 带 issue 路径',
    Array.isArray(badJson.issues) && badJson.issues.some((i) => i.path === '$.assets') && badJson.issues.some((i) => i.path === '$.bundle.id'),
  );
  check('JSON 语法错 → 400 而非 500', (await postRaw('/x-article/drafts', '{oops')).status === 400);
  const mismatch = await postRaw('/x-article/drafts', JSON.stringify({
    bundle: { schemaVersion: 1, id: 'mm-1', kind: 'other-kind', title: 't', markdown: 'm', mode: 'rich', assets: [], createdAt: '2026-01-01T00:00:00Z', source: 'test' },
    assets: [],
  }));
  check('bundle.kind 与路径 kind 不一致 → 400', mismatch.status === 400);
  check('非法 kind 段 → 400', (await fetch(`${BASE}/Bad_Kind/drafts`)).status === 400);
  check('保留段作 kind → 400', (await fetch(`${BASE}/setting/drafts`)).status === 400);
  check('旧根路由 /drafts → 410 Gone', (await fetch(`${BASE}/drafts`)).status === 410);
  const badPatch = await fetch(`${BASE}/x-article/drafts/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }),
  });
  check('畸形 PATCH → 400（不再把垃圾 status 写盘）', badPatch.status === 400);

  const setting = await (await fetch(`${BASE}/setting`)).json();
  check('GET /setting 形态（不含 token 值）', setting.port === 8788 && typeof setting.version === 'string' && setting.tokenConfigured === false && !('token' in setting));
  const patchSetting = (body, headers = {}) =>
    fetch(`${BASE}/setting`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const tokenSet = await (await patchSetting({ token: 'itest-token' })).json();
  check('PATCH /setting 设 token 即时生效', tokenSet.tokenConfigured === true);
  check('无 token 请求被 401', (await fetch(`${BASE}/x-article/drafts`)).status === 401);
  check('带 token 请求放行', (await fetch(`${BASE}/x-article/drafts`, { headers: { 'x-kaitox-token': 'itest-token' } })).status === 200);
  check('/health 保持 token 豁免', (await fetch(`${BASE}/health`)).status === 200);
  check('改 token 需先出示旧 token', (await patchSetting({ token: null })).status === 401);
  const tokenCleared = await (await patchSetting({ token: null }, { 'x-kaitox-token': 'itest-token' })).json();
  check('PATCH /setting 清 token', tokenCleared.tokenConfigured === false);

  // ---- 2. 严格四步草稿流水线（含封面）----
  console.log('\n[2] 插件严格四步草稿流水线 + 封面');
  const draft = await client.getDraft(id);
  const calls = [];
  const ok = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); }, async json() { return obj; } });
  let initN = 0;
  const mockFetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers, credentials: init.credentials, body: init.body });
    if (url.includes('command=INIT')) return ok({ media_id_string: `MID_${++initN}` }); // 正文图=MID_1，封面=MID_2
    if (url.includes('command=APPEND')) return ok({});
    if (url.includes('command=FINALIZE')) {
      const m = url.match(/[?&]media_id=([^&]+)/);
      return ok({ media_id_string: m ? m[1] : 'MID_x' });
    }
    if (url.includes('/ArticleEntityDraftCreate')) return ok({ data: { articleentity_create_draft: { article_entity_results: { result: { rest_id: 'ART_777' } } } } });
    if (url.includes('/ArticleEntityUpdateTitle')) return ok({ data: { articleentity_update_title: { success: true } } });
    if (url.includes('/ArticleEntityUpdateContent')) return ok({ data: { articleentity_update_content: { success: true } } });
    if (url.includes('/ArticleEntityUpdateCoverMedia')) return ok({ data: { articleentity_update_cover_media: { success: true } } });
    throw new Error('unexpected ' + url);
  };
  const progress = [];
  const result = await publishXArticle({
    markdown: draft.markdown, title: draft.title,
    credentials: { bearerToken: '', csrfToken: 'CT0' },
    clientOptions: {
      fetchImpl: mockFetch,
      credentialsMode: 'include',
      queryIds: {
        ArticleEntityDraftCreate: 'CREATE_QID',
        ArticleEntityUpdateTitle: 'TITLE_QID',
        ArticleEntityUpdateContent: 'CONTENT_QID',
        ArticleEntityUpdateCoverMedia: 'COVER_QID',
      },
    },
    fetchImage: async (src) => {
      const a = draft.assets.find((x) => x.src === src);
      return { bytes: await client.getAsset(draft.id, a.fileName), mimeType: a.mime };
    },
    fetchCover: async () => ({ bytes: await client.getAsset(draft.id, draft.cover.fileName), mimeType: draft.cover.mime }),
    onProgress: (p) => progress.push(p),
  });
  // 进度回调：先建空白 draft，再上传 images，最后处理 cover。
  check(
    '进度回调：images 0/1 → 1/1',
    progress.some((p) => p.stage === 'images' && p.done === 0 && p.total === 1) &&
      progress.some((p) => p.stage === 'images' && p.done === 1 && p.total === 1),
  );
  const stageIdx = (s) => progress.findIndex((p) => p.stage === s);
  check(
    '进度回调：draft → images → cover 顺序',
    stageIdx('draft') >= 0 && stageIdx('draft') < stageIdx('images') && stageIdx('cover') > progress.map((p) => p.stage).lastIndexOf('images'),
  );
  const init = calls.find((c) => c.url.includes('command=INIT'));
  check('INIT media_category=tweet_image', init.url.includes('media_category=tweet_image'));
  const create = calls.find((c) => c.url.includes('/ArticleEntityDraftCreate'));
  check('create 用了 queryId', create.url.includes('CREATE_QID'));
  check('create credentials=include', create.credentials === 'include');
  check('create 无手动 cookie 头', !('cookie' in create.headers));
  check(
    'create 使用已确认可用的空白草稿 variables',
    JSON.stringify(JSON.parse(create.body).variables) === JSON.stringify({
      content_state: { blocks: [], entity_map: [] },
      title: '',
    }),
  );
  const titleCall = calls.find((c) => c.url.includes('/ArticleEntityUpdateTitle'));
  check('title mutation 用了 TITLE_QID', titleCall?.url.includes('TITLE_QID'));
  check('title mutation 传 articleEntityId + title', titleCall && JSON.stringify(JSON.parse(titleCall.body).variables) === JSON.stringify({ articleEntityId: 'ART_777', title: '集成测试' }));
  const contentCall = calls.find((c) => c.url.includes('/ArticleEntityUpdateContent'));
  check('content mutation 用了 CONTENT_QID', contentCall?.url.includes('CONTENT_QID'));
  const cs = contentCall ? JSON.parse(contentCall.body).variables.content_state : { entity_map: [] };
  const media = cs.entity_map.find((e) => e.value.type === 'MEDIA');
  check('MEDIA.media_id=正文图上传值', media?.value.data.media_items[0].media_id === 'MID_1');
  check('MEDIA.category=DraftTweetImage', media?.value.data.media_items[0].media_category === 'DraftTweetImage');
  check('restId 解析', result.restId === 'ART_777');

  // 封面：上传发生在建草稿之后，且用独立的 UpdateCoverMedia mutation
  check('result.coverMediaId=封面上传值', result.coverMediaId === 'MID_2');
  const coverCall = calls.find((c) => c.url.includes('/ArticleEntityUpdateCoverMedia'));
  check('调用了 UpdateCoverMedia', !!coverCall);
  check('cover mutation 用了 coverQueryId', coverCall.url.includes('COVER_QID'));
  const coverBody = JSON.parse(coverCall.body);
  check('cover.articleEntityId=草稿 restId', coverBody.variables.articleEntityId === 'ART_777');
  check('cover.media_id=封面上传值', coverBody.variables.coverMedia.media_id === 'MID_2');
  check('cover.media_category=DraftTweetImage', coverBody.variables.coverMedia.media_category === 'DraftTweetImage');
  check('cover 无 fieldToggles', !('fieldToggles' in coverBody));
  check('cover 用封面专属 features', coverBody.features.profile_label_improvements_pcf_label_in_post_enabled === DEFAULT_COVER_MEDIA_FEATURES.profile_label_improvements_pcf_label_in_post_enabled && DEFAULT_COVER_MEDIA_FEATURES.profile_label_improvements_pcf_label_in_post_enabled === true);
  // 四个 GraphQL mutation 必须精确有序，不得调用发布 mutation。
  const graphqlOperations = calls
    .filter((c) => c.url.includes('/i/api/graphql/'))
    .map((c) => c.url.split('/').pop());
  check(
    'GraphQL 顺序=create → title → content → cover',
    JSON.stringify(graphqlOperations) === JSON.stringify([
      'ArticleEntityDraftCreate',
      'ArticleEntityUpdateTitle',
      'ArticleEntityUpdateContent',
      'ArticleEntityUpdateCoverMedia',
    ]),
    `(got ${graphqlOperations.join(', ')})`,
  );
  check('全程 draft-only，无 publish mutation', graphqlOperations.every((name) => !/publish/i.test(name)));
  check('返回精确编辑链接', result.editUrl === 'https://x.com/compose/articles/edit/ART_777');

  // 重试必须清掉旧错误；done 必须持久化可核验的账号与精确编辑地址。
  await client.ack(id, { status: 'failed', error: 'stale upload failure' });
  const staleBundlePath = join(home, 'x-article', 'outbox', id, 'bundle.json');
  const staleBundle = JSON.parse(await readFile(staleBundlePath, 'utf8'));
  Object.assign(staleBundle, {
    targetHandle: '@stale_account',
    restId: 'STALE_REST_ID',
    editUrl: 'https://x.com/compose/articles/edit/STALE_REST_ID',
  });
  await writeFile(staleBundlePath, JSON.stringify(staleBundle, null, 2), 'utf8');
  await client.ack(id, { status: 'uploading' });
  const retrying = await client.getDraft(id);
  check(
    'failed → uploading 清掉 stale terminal state',
    retrying.status === 'uploading' &&
      retrying.error === undefined &&
      retrying.targetHandle === undefined &&
      retrying.restId === undefined &&
      retrying.editUrl === undefined,
  );
  const editUrl = 'https://x.com/compose/articles/edit/ART_777';
  await client.ack(id, {
    status: 'done',
    targetHandle: '@aaxiaoshi666',
    restId: 'ART_777',
    editUrl,
  });
  const doneDraft = await client.getDraft(id);
  check(
    'done 持久化 targetHandle + restId + exact editUrl 且无 stale error',
    doneDraft.status === 'done' &&
      doneDraft.targetHandle === '@aaxiaoshi666' &&
      doneDraft.restId === 'ART_777' &&
      doneDraft.editUrl === editUrl &&
      doneDraft.error === undefined,
  );
  // done → sent（迁移目录归档，但列表仍要能看到——草稿箱「已上传」Tab 依赖）
  const doneItem = (await client.listDrafts()).find((d) => d.id === id);
  check('done 后仍在列表且 status=done', doneItem?.status === 'done');
  check('done 迁移后原图资产仍可读', (await client.getAsset(id, 'cover-original-orig.png')).length === pngBytes.length);
  await client.deleteDraft(id);

  // ---- 3. styleCheck + plaintext ----
  console.log('\n[3] styleCheck + plaintext');
  const md = '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n  - nested\n\n![r](https://cdn.x/y.png)\n';
  const rep = checkMarkdownStyle(md);
  check('表格降为 info（X 原生渲染表格）', rep.issues.some((i) => i.rule === 'table' && i.severity === 'info'));
  check('检测到嵌套列表 warning', rep.issues.some((i) => i.rule === 'nested-list'));
  check('不友好', rep.friendly === false);
  const pt = toPlaintextMarkdown(md);
  check('纯文本降级保留表格（不再打平）', /\| a \| b \|/.test(pt));
  check('纯文本降级拍平嵌套列表', !/ {2}- nested/.test(pt) && /- nested/.test(pt));
  check('纯文本保留远程图片 src', collectImageSources(pt).includes('https://cdn.x/y.png'));
} finally {
  await handle.close();
  await rm(home, { recursive: true, force: true });
}

console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
