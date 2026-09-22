import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowUpRight, Check, Globe2, Link2, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ConnectionResponse, SiteConnection } from '../shared/connection';
import '../ui/styles.css';
import './popup.css';

export function Popup() {
  const extensionAvailable = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id && chrome.tabs?.query);
  const version = extensionAvailable ? chrome.runtime.getManifest?.().version : undefined;
  const [status, setStatus] = useState<SiteConnection | null>(null);
  const [loading, setLoading] = useState(extensionAvailable);
  const [busy, setBusy] = useState<'connect' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const actionError = useRef(false);
  const mounted = useRef(true);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  const refresh = useCallback(async (dismissError = false) => {
    if (!extensionAvailable || busyRef.current) return;
    if (dismissError) actionError.current = false;
    const version = ++requestVersion.current;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('No active page found. Open a website and try again.');
      const response = await chrome.runtime.sendMessage({ type: 'tokenlens:status', tabId: tab.id }) as ConnectionResponse | undefined;
      if (!mounted.current || version !== requestVersion.current) return;
      if (!response?.ok || !response.status) throw new Error(response?.error ?? 'TokenLens did not respond. Reload the extension in chrome://extensions, then try again.');
      setStatus(response.status);
      if (!actionError.current) setError('');
      if (dismissError && response.status.connected) {
        setNotice(response.status.devtoolsOpen ? 'The inspector is ready. Choose Tokens in the DevTools tab bar or its » menu.' : 'The inspector is ready. Open DevTools using the shortcut below, then choose Tokens. If DevTools is already open, close and reopen it.');
      }
    } catch (cause) {
      if (!mounted.current || version !== requestVersion.current) return;
      setStatus(null);
      actionError.current = false;
      setError(cause instanceof Error ? cause.message : 'Could not check this page. Try again.');
    } finally {
      if (mounted.current && version === requestVersion.current) setLoading(false);
    }
  }, [extensionAvailable]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const checkVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const interval = window.setInterval(checkVisible, 2000);
    window.addEventListener('focus', checkVisible);
    document.addEventListener('visibilitychange', checkVisible);
    return () => {
      mounted.current = false;
      requestVersion.current++;
      window.clearInterval(interval);
      window.removeEventListener('focus', checkVisible);
      document.removeEventListener('visibilitychange', checkVisible);
    };
  }, [refresh]);

  useEffect(() => { setNotice(''); }, [status?.url, status?.connected, status?.devtoolsOpen]);

  const connect = async () => {
    if (!status?.supported || busyRef.current) return;
    busyRef.current = true;
    requestVersion.current++;
    setBusy('connect');
    actionError.current = false;
    setError('');
    setNotice('');
    try {
      // Invoke the permission prompt in this click's user gesture, before any await.
      const granted = status.hasPermission || await chrome.permissions.request({ origins: [`${new URL(status.url).origin}/*`] });
      if (!granted) throw new Error('Site access was not granted. Click Connect this site and choose Allow to continue.');
      const response = await chrome.runtime.sendMessage({ type: 'tokenlens:inject', tabId: status.tabId }) as ConnectionResponse | undefined;
      if (!mounted.current) return;
      if (response?.status) setStatus(response.status);
      if (!response?.ok || !response.status?.connected) throw new Error(response?.error ?? 'The inspector did not connect. Reload this webpage, then try again.');
    } catch (cause) {
      if (mounted.current) { actionError.current = true; setError(cause instanceof Error ? cause.message : 'Could not connect. Reload this webpage and try again.'); }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const unsupported = status && !status.supported;
  const connected = Boolean(status?.connected);
  const title = !extensionAvailable ? 'Your editor lives in DevTools.' : loading ? 'Checking this page…' : unsupported ? 'Open a website to begin.' : !status ? 'Let’s reconnect.' : !connected ? 'Connect. Then open DevTools.' : status.devtoolsOpen ? 'Connected. Choose Tokens.' : 'Connected. Now open DevTools.';
  const description = !extensionAvailable ? 'This is an onboarding preview. Install TokenLens in Chrome to inspect a real page.' : unsupported ? (status.reason ?? 'Chrome does not allow extensions to inspect this page. Open a regular website, then open TokenLens again.') : connected ? 'The page inspector is ready. Pick elements and edit their tokens in the Tokens tab.' : 'This popup connects the page. The color, typography, and shadow editors are in Chrome DevTools.';
  const action = busy ? 'Connecting inspector…' : loading ? 'Checking page…' : !extensionAvailable ? 'Use the installed extension' : connected ? (status?.devtoolsOpen ? 'Close popup — choose Tokens' : 'Close popup — open DevTools') : status?.supported ? (status.hasPermission ? 'Connect page inspector' : 'Connect this site') : 'Check again';

  return <main className={`popup-app${error || notice ? ' has-feedback' : ''}`}>
    <header className="popup-header"><span className="logo-mark" aria-hidden="true"><i/><i/><i/><i/></span><strong>tokenlens</strong><span className="popup-product-label">DESIGN TOKEN STUDIO</span></header>
    {!extensionAvailable && <p className="popup-preview-label">Preview · no website connected</p>}
    <section className={`popup-site${connected ? ' is-connected' : ''}`} aria-label="Current page connection">
      <div className="popup-site-heading"><Globe2 size={16}/><strong title={status?.url}>{loading ? 'Checking active page' : status?.hostname || 'Current page'}</strong>{extensionAvailable && <button className="popup-status-refresh" aria-label="Refresh status" title="Refresh status" disabled={loading || Boolean(busy)} onClick={() => void refresh(true)}><RefreshCw size={12}/></button>}<span className={`popup-status-badge${connected ? ' connected' : ''}`}>{busy === 'connect' ? 'Connecting' : loading ? 'Checking' : connected ? 'Connected' : unsupported ? 'Unavailable' : 'Not connected'}</span></div>
      <div className="popup-readiness"><span className={status?.hasPermission ? 'complete' : ''}><Check size={12}/>{status?.hasPermission ? 'Site access allowed' : 'Site access needed'}</span><span className={connected ? 'complete' : ''}><Check size={12}/>{connected ? 'Inspector ready' : 'Inspector waiting'}</span></div>
    </section>
    <div className="popup-intro" aria-live="polite"><h1>{title}</h1>{!error && !notice && <p>{description}</p>}</div>
    {error && <div className="popup-error" role="alert"><AlertCircle size={15}/><p>{error}</p></div>}
    {notice && !error && <p className="popup-notice" role="status">{notice}</p>}
    <button className="primary-button full-width popup-action" disabled={Boolean(busy) || loading || !extensionAvailable} onClick={() => void (connected ? window.close() : status?.supported ? connect() : refresh(true))}>
      {busy || loading ? <LoaderCircle size={16} className="spin"/> : connected ? <ArrowUpRight size={16}/> : !status?.supported ? <RefreshCw size={15}/> : <Link2 size={15}/>}{action}
    </button>
    {!unsupported && <section className="popup-guide" aria-label="Find your token editor">
      <div className="popup-step"><span className={`popup-step-number${status?.devtoolsOpen ? ' complete' : ''}`}>{status?.devtoolsOpen ? <Check size={13}/> : '1'}</span><div><h2>{status?.devtoolsOpen ? 'DevTools is open' : 'Open Chrome DevTools'}</h2>{status?.devtoolsOpen ? <p>Switch back to the DevTools window for this page.</p> : <><p>Close this popup, then right-click the page → <strong>Inspect</strong>.</p><p className="popup-shortcut">Or press <kbd>{mac ? '⌥ Option + ⌘ Command + I' : 'Ctrl + Shift + I'}</kbd></p></>}</div></div>
      <div className="popup-step"><span className="popup-step-number">2</span><div><h2>Choose the Tokens tab</h2><div className="popup-devtools-tabs" aria-label="Example DevTools tabs: Elements, Console, Tokens, overflow"><span>Elements</span><span>Console</span><strong>Tokens</strong><span className="popup-overflow">»</span></div><p>Look inside <strong>»</strong> if it’s hidden. In Tokens, click <strong>Pick element</strong> to start editing.</p></div></div>
    </section>}
    <details className="popup-help"><summary>{unsupported ? 'Which pages can I inspect?' : 'Don’t see the Tokens tab?'}</summary><p>{unsupported ? 'Open an http:// or https:// website. Chrome settings, the Chrome Web Store, PDF viewer, and other protected pages cannot be inspected. For file:// pages, the standard download also needs “Allow access to file URLs” in Chrome’s extension details. With the per-site download, serve local files through localhost.' : 'If DevTools was already open when you installed or updated TokenLens, close and reopen DevTools. The Tokens tab is in the top tab bar or its » menu. Connecting this site does not open DevTools automatically.'}</p></details>
    <footer><ShieldCheck size={13}/><span>Changes stay local. Export CSS when you’re ready.</span></footer><p className="builder-credit popup-credit"><span>Built by Joan Sterjo</span>{version && <span>v{version}</span>}</p>
  </main>;
}

const rootElement = document.getElementById('root');
if (rootElement && window.location.pathname.endsWith('/popup.html')) createRoot(rootElement).render(<Popup/>);
