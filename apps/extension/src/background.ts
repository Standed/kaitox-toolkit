/** service worker：可选的角标计数，显示 relay 里有几份待上传草稿。 */
import { DEFAULT_RELAY_BASE } from './xsession.js';
import { registerContentOsBackgroundHandlers } from './content-os-background.js';
import { registerUploadQueueBackgroundHandlers } from './upload-queue.js';

registerUploadQueueBackgroundHandlers();
registerContentOsBackgroundHandlers();

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'kaitox-article-video-schema') return;
  const probe = (message as { probe?: unknown }).probe;
  // 仅写给本机 relay，供后续按 X 的真实结构实现视频上传；失败不影响用户保存文章。
  void fetch(`${DEFAULT_RELAY_BASE}/x-article/probes/article-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(probe),
  }).catch(() => {});
});

// 点工具栏图标：任意页面弹出右侧设置浮窗。
// 1) 页面里已有脚本（x.com 文章页常驻，或此前注入过）→ 发消息开/关；
// 2) 没有 → 借 activeTab 现场注入样式和设置脚本（注入即打开）；
// 3) 连注入都不行（chrome:// 等受限页）→ 打开独立设置页兜底。
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'kaitox-toggle-settings' });
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['settings-content.js'] });
    } catch {
      void chrome.runtime.openOptionsPage();
    }
  }
});

async function updateBadge(): Promise<void> {
  try {
    // kind 命名空间路由：服务端只回 x-article 草稿，无需客户端过滤 kind。
    const res = await fetch(`${DEFAULT_RELAY_BASE}/x-article/drafts`);
    if (!res.ok) throw new Error(String(res.status));
    const items: Array<{ status?: string }> = await res.json();
    const n = items.filter((d) => d.status !== 'done').length;
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  } catch {
    await chrome.action.setBadgeText({ text: '' });
  }
}

function ensureAlarm(): void {
  chrome.alarms.create('kaitox-poll', { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'kaitox-poll') updateBadge();
});
