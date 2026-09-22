import { captureElement, findElement, recoverStyleSheet } from '../adapters/capture-live';
import { OverrideEngine } from './override';
import { ElementPicker } from './overlay/picker';
import type { Edit, ElementTokenReport, Diagnostic } from '../core/model';
import type { Envelope } from '../transport/protocol';
import type { ApplyPayload } from '../transport/payloads';
import { auditPage } from '../adapters/audit-live';

interface TokenLensAPI { receive: (message: Envelope) => boolean; select: (element: Element) => boolean; destroy: () => void; }
declare global { var __TOKENLENS__: TokenLensAPI | undefined; }

if (!globalThis.__TOKENLENS__) initialize();
function initialize() {
  let documentId = crypto.randomUUID() as string;
  let frameId = 0;
  let port: chrome.runtime.Port | null = null;
  let destroyed = false;
  let selected: Element | null = null;
  let report: ElementTokenReport | null = null;
  let connectedOnce = false;
  let auditController: AbortController | null = null;
  const completed = new Map<string, Envelope>();
  const inFlight = new Set<string>();
  const attemptedSheets = new Set<string>();
  const engine = new OverrideEngine({ onVerified: (edits, diagnostics) => {
    send('edit:verified', { edits, diagnostics }); persist();
  } });
  const picker = new ElementPicker(element => {
    select(element);
  }, () => send('pick:stop', {}));
  function send(type: Envelope['type'], payload: unknown, id = crypto.randomUUID() as string) {
    const message: Envelope = { v: 1, id, type, documentId, frameId, payload };
    try { port?.postMessage(message); } catch { /* reconnect will resync */ }
    return message;
  }
  function connect() {
    if (destroyed) return;
    try {
      port = chrome.runtime.connect({ name: `content:${frameId}` });
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; if (!destroyed) setTimeout(connect, 1000); });
    } catch { /* extension reloaded; page must refresh */ }
  }
  function select(element: Element, explicitSelection = true) {
    if (!element || element.nodeType !== 1 || !element.isConnected || element.closest('tokenlens-root')) return false;
    if (element.ownerDocument !== document) { element.setAttribute('data-tokenlens-sel', ''); return true; }
    selected = element;
    try {
      report = captureElement(element, { documentId, frameId });
      engine.setRegistrations(report.registrations);
      if (explicitSelection) {
        send('pick:locked', report);
        send('report:result', report);
      } else send('resync', { report, edits: engine.getEdits() });
      for (const sheet of report.sheets) {
        if (sheet.readable || sheet.reparsed || !sheet.href || attemptedSheets.has(sheet.href) || attemptedSheets.size >= 12) continue;
        attemptedSheets.add(sheet.href); send('sheet:fetch', { url: sheet.href });
      }
      persist();
      return true;
    } catch (error) { send('diag', { message: `Could not inspect this element: ${String(error)}` }); return false; }
  }
  function persist() {
    void chrome.storage.session.set({ [`tl:${documentId}`]: { ref: report?.element.ref || null, edits: engine.getEdits() } }).catch(() => {});
  }
  async function restore() {
    try {
      const key = `tl:${documentId}`;
      const stored = (await chrome.storage.session.get(key))[key] as { ref?: ElementTokenReport['element']['ref']; edits?: Edit[] } | undefined;
      if (stored?.ref) selected = findElement(stored.ref);
      if (stored?.edits?.length) await engine.apply(stored.edits, selected || undefined);
      if (selected) select(selected, false);
    } catch { /* empty or expired document session */ }
  }
  function receive(m: Envelope): boolean {
    if (m.v !== 1) { send('diag', { message: 'TokenLens version mismatch. Reload the page.' }, m.id); return false; }
    if (m.documentId && m.documentId !== documentId && m.type !== 'resync') return false;
    if (completed.has(m.id)) { try { port?.postMessage(completed.get(m.id)); } catch { /* disconnected */ } return true; }
    if (inFlight.has(m.id)) return true;
    switch (m.type) {
      case 'resync': {
        const payload = m.payload as { identity?: boolean };
        if (payload.identity) {
          documentId = m.documentId || documentId; frameId = m.frameId ?? 0;
          if (!connectedOnce) {
            connectedOnce = true;
            void restore().then(() => {
              // DevTools can mark a frame selection before this loader finishes importing.
              const marked = document.querySelector('[data-tokenlens-sel]');
              if (marked) { marked.removeAttribute('data-tokenlens-sel'); select(marked); }
              send('resync', { report, edits: engine.getEdits() }, m.id);
            });
          }
          else send('resync', { report, edits: engine.getEdits() }, m.id);
        } else send('resync', { report, edits: engine.getEdits() }, m.id);
        break;
      }
      case 'pick:start': picker.start(); break;
      case 'pick:stop': picker.stop(); break;
      case 'report:request': if (selected?.isConnected) select(selected, false); break;
      case 'sheet:fetched': {
        const result = m.payload as { url: string; css?: string; error?: string };
        if (result.css !== undefined) {
          recoverStyleSheet(result.url, result.css, document);
          clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (selected?.isConnected) select(selected, false); }, 50);
        }
        break;
      }
      case 'edit:apply': {
        const payload = m.payload as ApplyPayload;
        if (!Array.isArray(payload.edits)) return false;
        if (payload.transaction === 'start' || payload.transaction === 'update') engine.beginDrag();
        if (payload.transaction === 'commit') engine.endDrag();
        inFlight.add(m.id);
        void Promise.resolve(engine.apply(payload.edits, selected || undefined)).then(result => {
          completed.set(m.id, send('edit:verified', result, m.id));
          if (completed.size > 200) completed.delete(completed.keys().next().value!);
          persist();
        }).catch(error => send('diag', { message: String(error) }, m.id)).finally(() => inFlight.delete(m.id));
        break;
      }
      case 'edit:revert': {
        const payload = m.payload as { ids?: string[]; all?: boolean };
        engine.endDrag();
        engine.revert(payload.all ? undefined : payload.ids);
        completed.set(m.id, send('edit:verified', { edits: engine.getEdits(), diagnostics: [] as Diagnostic[] }, m.id));
        if (completed.size > 200) completed.delete(completed.keys().next().value!);
        persist(); break;
      }
      case 'audit:start': {
        auditController?.abort(); auditController = new AbortController();
        void auditPage(auditController.signal, progress => send('audit:progress', progress, m.id)).then(result => send('audit:result', result, m.id)).catch(error => { if (error?.name !== 'AbortError') send('diag', { message: String(error) }, m.id); });
        break;
      }
      case 'audit:cancel': auditController?.abort(); send('audit:progress', { cancelled: true }); break;
      case 'eyedropper:arm': {
        // EyeDropper requires a fresh user gesture in the page after the panel message.
        const hint = document.createElement('tokenlens-root');
        hint.style.cssText = 'position:fixed;inset:16px auto auto 50%;transform:translateX(-50%);z-index:2147483647;background:#242334;color:white;padding:12px 18px;border-radius:8px;font:13px system-ui;';
        hint.textContent = 'Click anywhere to sample a color · Esc to cancel'; document.documentElement.append(hint);
        const cleanup = () => { hint.remove(); window.removeEventListener('click', arm, true); window.removeEventListener('keydown', cancel, true); };
        const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') { cleanup(); send('eyedropper:result', { error: 'Cancelled' }); } };
        const arm = async (e: MouseEvent) => {
          e.preventDefault(); e.stopImmediatePropagation(); cleanup();
          const EyeDropperCtor = (globalThis as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
          try { if (!EyeDropperCtor) throw new Error('EyeDropper is unavailable on this page'); send('eyedropper:result', await new EyeDropperCtor().open()); }
          catch (error) { send('eyedropper:result', { error: String(error) }); }
        };
        window.addEventListener('click', arm, { capture: true, once: true }); window.addEventListener('keydown', cancel, true);
        break;
      }
    }
    return true;
  }
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(records => {
    const marked = records.find(r => r.attributeName === 'data-tokenlens-sel' && (r.target as Element).hasAttribute('data-tokenlens-sel'));
    if (marked) { const el = marked.target as Element; el.removeAttribute('data-tokenlens-sel'); select(el); }
    if (records.some(r => r.target === document.documentElement && r.attributeName !== 'data-tokenlens-sel')) {
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (selected?.isConnected) select(selected, false); send('theme:changed', {}); }, 120);
    }
  });
  observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-tokenlens-sel', 'class', 'data-theme', 'style'] });
  globalThis.__TOKENLENS__ = { receive, select, destroy() { destroyed = true; picker.stop(); engine.destroy(); observer.disconnect(); clearTimeout(refreshTimer); auditController?.abort(); port?.disconnect(); delete globalThis.__TOKENLENS__; } };
  connect();
}
