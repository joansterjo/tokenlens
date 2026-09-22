import { PROTOCOL_VERSION, type Envelope } from '../transport/protocol';

const panels = new Map<number, Set<chrome.runtime.Port>>();
const frames = new Map<number, Map<number, chrome.runtime.Port>>();
const documents = new Map<number, string>();
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
function post(port: chrome.runtime.Port, message: Envelope) { try { port.postMessage(message); } catch { /* disconnected */ } }
function broadcast(tab: number, message: Envelope) { panels.get(tab)?.forEach(p => post(p, message)); }

chrome.runtime.onConnect.addListener(port => {
  if (port.name.startsWith('devtools:')) {
    const tab = Number(port.name.slice('devtools:'.length));
    if (!Number.isInteger(tab)) return;
    if (!panels.has(tab)) panels.set(tab, new Set());
    panels.get(tab)!.add(port);
    port.onMessage.addListener((message: Envelope) => {
      if (message.v !== PROTOCOL_VERSION) {
        post(port, { v: 1, id: message.id, type: 'diag', payload: { message: 'TokenLens updated. Reload this page and reopen DevTools.' } }); return;
      }
      if (message.type === 'sheet:fetch') {
        const url = (message.payload as { url?: string }).url;
        if (!url || !/^https?:\/\//.test(url)) return;
        void fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) }).then(async r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const css = await r.text();
          if (css.length > 2_000_000) throw new Error('Stylesheet exceeds 2 MB recovery limit');
          post(port, { ...message, type: 'sheet:fetched', payload: { url, css } });
        }).catch(error => post(port, { ...message, type: 'diag', payload: { message: String(error) } })); return;
      }
      const targets = frames.get(tab);
      if (message.frameId !== undefined) {
        const target = targets?.get(message.frameId); if (target) post(target, message);
      } else targets?.forEach(p => post(p, message));
      if (!targets?.size && message.type === 'resync') {
        void inject(tab).then(() => post(port, { v: 1, id: message.id, type: 'diag', payload: { message: 'Connecting to this page…' } })).catch(() => post(port, { v: 1, id: message.id, type: 'diag', payload: { message: 'Cannot inspect this page. Chrome system pages, the Web Store and the PDF viewer are protected. For file URLs, enable file access in extension settings.' } }));
      }
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; panels.get(tab)?.delete(port); });
    return;
  }
  if (!port.name.startsWith('content:') || port.sender?.tab?.id === undefined) return;
  const tab = port.sender.tab.id;
  const frame = port.sender.frameId || 0;
  const documentId = port.sender.documentId || `${tab}:${frame}`;
  if (!frames.has(tab)) frames.set(tab, new Map());
  frames.get(tab)!.set(frame, port);
  if (frame === 0 && documents.get(tab) !== documentId) {
    const previous = documents.get(tab); documents.set(tab, documentId);
    if (previous) void chrome.storage.session.remove(`tl:${previous}`);
    if (previous) void chrome.storage.session.remove(`tl:activeFrame:${tab}`);
    broadcast(tab, { v: 1, id: crypto.randomUUID(), type: 'nav:changed', documentId, frameId: frame, payload: { previousDocumentId: previous, documentId } });
  }
  post(port, { v: 1, id: crypto.randomUUID(), type: 'resync', frameId: frame, documentId, payload: { identity: true } });
  port.onMessage.addListener((message: Envelope) => {
    if (message.v !== 1) return;
    if (message.type === 'sheet:fetch') {
      const url = (message.payload as { url?: string }).url;
      if (!url || !/^https?:\/\//.test(url)) return;
      void fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) }).then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const css = await response.text();
        if (css.length > 2_000_000) throw new Error('Stylesheet exceeds 2 MB recovery limit');
        post(port, { ...message, type: 'sheet:fetched', documentId, frameId: frame, payload: { url, css } });
      }).catch(error => post(port, { ...message, type: 'sheet:fetched', documentId, frameId: frame, payload: { url, error: String(error) } }));
      return;
    }
    const annotated = { ...message, tabId: tab, frameId: frame, documentId };
    broadcast(tab, annotated);
    // Lock selection in one frame without leaving the other frames in pick mode.
    if (message.type === 'pick:locked') frames.get(tab)?.forEach(p => post(p, { v: 1, id: crypto.randomUUID(), type: 'pick:stop', payload: {} }));
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (frames.get(tab)?.get(frame) === port) frames.get(tab)?.delete(frame); });
});

chrome.tabs.onRemoved.addListener(tabId => {
  panels.delete(tabId); frames.delete(tabId);
  const documentId = documents.get(tabId); documents.delete(tabId);
  if (documentId) void chrome.storage.session.remove(`tl:${documentId}`);
  void chrome.storage.session.remove(`tl:activeFrame:${tabId}`);
});

export async function inject(tabId: number) {
  const manifest = chrome.runtime.getManifest();
  const files = manifest.content_scripts?.[0]?.js || ['content-loader.js'];
  if (!manifest.content_scripts) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && /^https?:/.test(tab.url)) {
      const origin = `${new URL(tab.url).origin}/*`;
      if (await chrome.permissions.contains({ origins: [origin] })) {
        const id = `tl-site-${btoa(origin).replace(/[^a-zA-Z0-9]/g, '')}`;
        const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        if (!registered.length) await chrome.scripting.registerContentScripts([{ id, matches: [origin], js: files, allFrames: true, matchOriginAsFallback: true, runAt: 'document_idle', persistAcrossSessions: true }]);
      }
    }
  }
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!['tokenlens:enable', 'tokenlens:inject'].includes(message?.type) || !Number.isInteger(message.tabId)) return;
  void inject(message.tabId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error) }));
  return true;
});
