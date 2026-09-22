import type { Transport } from '../core/ports';
import type { Envelope } from '../transport/protocol';
import { PORT_DEVTOOLS } from '../transport/protocol';

export function getInspectedUrl(): Promise<string> {
  return new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.devtools?.inspectedWindow) { resolve(''); return; }
    chrome.devtools.inspectedWindow.eval('location.href', (url, error) => resolve(error?.isException ? '' : typeof url === 'string' ? url : ''));
  });
}

export function createPanelTransport(): Transport {
  const listeners = new Set<(m: Envelope) => void>();
  const tabId = chrome.devtools.inspectedWindow.tabId;
  let port: chrome.runtime.Port | null = null;
  let attempt = 0;
  let closed = false;
  let selectedFrame = 0;
  let documentId: string | undefined;
  let topDocumentId: string | undefined;
  const pending = new Map<string, Envelope>();
  const emit = (message: Envelope) => listeners.forEach(f => f(message));
  function connect() {
    if (closed) return;
    try {
      port = chrome.runtime.connect({ name: PORT_DEVTOOLS(tabId) }); attempt = 0;
      port.onMessage.addListener((m: Envelope) => {
        if (m.v !== 1) { emit({ v: 1, id: m.id, type: 'diag', payload: { message: 'Extension version mismatch. Reload the page and reopen DevTools.' } }); return; }
        if (m.type === 'report:result' || m.type === 'pick:locked') {
          selectedFrame = m.frameId ?? 0; documentId = m.documentId;
          void chrome.storage.session.set({ [`tl:activeFrame:${tabId}`]: selectedFrame });
        }
        if (m.type === 'nav:changed') {
          if (m.documentId && m.documentId === topDocumentId) return;
          topDocumentId = m.documentId; selectedFrame = 0; documentId = m.documentId; pending.clear();
        }
        if (m.type === 'resync' && (m.frameId ?? 0) === 0 && m.documentId) topDocumentId = m.documentId;
        if (m.type === 'edit:verified' || m.type === 'resync' || m.type === 'diag') pending.delete(m.id);
        if (m.type === 'resync' && (m.frameId ?? 0) !== selectedFrame) return;
        if (['edit:verified', 'edit:blast-radius', 'resync'].includes(m.type) && m.documentId && documentId && m.documentId !== documentId) return;
        if (m.type === 'edit:verified' && m.frameId !== undefined && m.frameId !== selectedFrame) return;
        if (m.type === 'resync' && m.documentId) documentId = m.documentId;
        emit(m);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; port = null;
        if (!closed) setTimeout(connect, [0, 250, 1000, 3000][Math.min(attempt++, 3)]);
      });
      void chrome.storage.session.get(`tl:activeFrame:${tabId}`).then(saved => {
        selectedFrame = saved[`tl:activeFrame:${tabId}`] ?? selectedFrame;
        port?.postMessage({ v: 1, id: crypto.randomUUID(), type: 'resync', frameId: selectedFrame, payload: {} });
      });
      pending.forEach(m => port?.postMessage(m));
    } catch { if (!closed) setTimeout(connect, 1000); }
  }
  connect();
  addEventListener('unload', () => { closed = true; port?.disconnect(); }, { once: true });
  return {
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(message) {
      const m: Envelope = { ...message, tabId, ...(message.type.startsWith('edit:') || message.type.startsWith('audit:') ? { frameId: selectedFrame, documentId } : {}) };
      if (m.type === 'pick:start' || m.type === 'pick:stop') { delete m.frameId; delete m.documentId; }
      if (m.type === 'resync' || m.type === 'report:request') m.frameId = selectedFrame;
      if (m.type === 'edit:apply' || m.type === 'edit:revert') {
        pending.set(m.id, m); if (pending.size > 100) pending.delete(pending.keys().next().value!);
        // Direct isolated-world path avoids the service-worker hop for drag updates.
        if (selectedFrame === 0) {
          chrome.devtools.inspectedWindow.eval(`Boolean(globalThis.__TOKENLENS__ && globalThis.__TOKENLENS__.receive(${JSON.stringify(m)}))`, { useContentScriptContext: true }, (ok, error) => {
            if (!ok || error?.isException) port?.postMessage(m);
          }); return;
        }
      }
      port?.postMessage(m);
    },
  };
}
