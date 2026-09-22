import { PROTOCOL_VERSION, type Envelope } from '../transport/protocol';
import type { ConnectionResponse, SiteConnection } from '../shared/connection';

const panels = new Map<number, Set<chrome.runtime.Port>>();
const frames = new Map<number, Map<number, chrome.runtime.Port>>();
const documents = new Map<number, string>();
const devtoolsHosts = new Map<number, chrome.runtime.Port>();
const injections = new Map<number, Promise<void>>();
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
function post(port: chrome.runtime.Port, message: Envelope) { try { port.postMessage(message); } catch { /* disconnected */ } }
function broadcast(tab: number, message: Envelope) { panels.get(tab)?.forEach(p => post(p, message)); }

chrome.runtime.onConnect.addListener(port => {
  if (port.name.startsWith('devtools-host:')) {
    const tabId = Number(port.name.slice('devtools-host:'.length));
    if (!Number.isInteger(tabId)) return;
    devtoolsHosts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (devtoolsHosts.get(tabId) === port) devtoolsHosts.delete(tabId);
    });
    return;
  }
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
      const missingTarget = message.frameId !== undefined ? !targets?.has(message.frameId) : !targets?.has(0);
      const forward = () => {
        const current = frames.get(tab);
        if (message.frameId !== undefined) {
          const target = current?.get(message.frameId); if (target) post(target, message);
        } else current?.forEach(p => post(p, message));
      };
      if (missingTarget && ['resync', 'pick:start', 'report:request'].includes(message.type)) {
        // The content loader imports asynchronously. Queue the first action until its handshake.
        void inject(tab).then(forward).catch(error => post(port, {
          v: 1, id: message.id, type: 'diag',
          payload: { code: 'CONNECTION_FAILED', severity: 'warn', message: String(error instanceof Error ? error.message : error) },
        }));
      } else forward();
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
  panels.delete(tabId); frames.delete(tabId); devtoolsHosts.delete(tabId);
  const documentId = documents.get(tabId); documents.delete(tabId);
  if (documentId) void chrome.storage.session.remove(`tl:${documentId}`);
  void chrome.storage.session.remove(`tl:activeFrame:${tabId}`);
});

async function inspectorReady(tabId: number): Promise<boolean> {
  if (!frames.get(tabId)?.has(0)) return false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => Boolean(globalThis.__TOKENLENS__),
    });
    return result?.result === true && result.documentId === documents.get(tabId);
  } catch { return false; }
}

export async function getConnection(tabId: number): Promise<SiteConnection> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';
  const parsed = url ? new URL(url) : null;
  const file = parsed?.protocol === 'file:';
  const web = parsed?.protocol === 'http:' || parsed?.protocol === 'https:';
  const protectedPage = parsed?.hostname === 'chromewebstore.google.com'
    || (parsed?.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
  const fileAccess = file && await chrome.extension.isAllowedFileSchemeAccess();
  const supported = Boolean((web && !protectedPage) || fileAccess);
  const hasPermission = supported && (file ? fileAccess : await chrome.permissions.contains({ origins: [`${parsed!.origin}/*`] }));
  const host = devtoolsHosts.get(tabId);
  return {
    tabId, url, hostname: parsed?.hostname || (file ? 'Local file' : 'This page'), supported, hasPermission,
    connected: hasPermission && await inspectorReady(tabId),
    devtoolsOpen: Boolean(host),
    ...(!supported ? { reason: file
      ? 'Enable “Allow access to file URLs” in TokenLens extension settings, then reopen this popup.'
      : 'Open a regular website. Chrome pages, the Chrome Web Store and the built-in PDF viewer cannot be inspected.' } : {}),
  };
}

async function performInjection(tabId: number) {
  const status = await getConnection(tabId);
  if (!status.supported) throw new Error(status.reason);
  if (!status.hasPermission) throw new Error('Open TokenLens from the Chrome toolbar and choose “Connect this site” to grant access.');
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
  if (status.connected) return;
  // A restricted child frame must not prevent inspection of the main page.
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files }).catch(() => {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await inspectorReady(tabId)) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('The inspector did not start. Reload this webpage, then try connecting again.');
}

export function inject(tabId: number): Promise<void> {
  let operation = injections.get(tabId);
  if (!operation) {
    operation = performInjection(tabId).finally(() => injections.delete(tabId));
    injections.set(tabId, operation);
  }
  return operation;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!['tokenlens:enable', 'tokenlens:inject', 'tokenlens:status'].includes(message?.type) || !Number.isInteger(message.tabId)) return;
  const respond = async (): Promise<ConnectionResponse> => {
    if (message.type !== 'tokenlens:status') await inject(message.tabId);
    const status = await getConnection(message.tabId);
    return { ok: true, status };
  };
  void respond().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error instanceof Error ? error.message : error) }));
  return true;
});
