import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Crosshair, Code2, SlidersHorizontal, ArrowRight, ShieldCheck } from 'lucide-react';
import '../ui/styles.css';
import './popup.css';
function Popup() {
  const [message, setMessage] = useState('');
  const connect = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) { setMessage('Open a regular website to connect Tokenlens. Browser pages cannot be inspected.'); return; }
      const origin = `${new URL(tab.url).origin}/*`;
      const granted = await chrome.permissions.contains({ origins: [origin] }) || await chrome.permissions.request({ origins: [origin] });
      if (!granted) { setMessage('Site access was not granted. You can try again when ready.'); return; }
      const result = await chrome.runtime.sendMessage({ type: 'tokenlens:inject', tabId: tab.id }) as { ok?: boolean; error?: string } | undefined;
      if (result?.ok === false) throw new Error(result.error ?? 'Could not connect to this page.');
      setMessage('Site connected. Open DevTools, choose Tokens, and pick an element. Reload the page if it was open before installation.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not connect. Reload this page and try again.'); }
  };
  return <main className="popup-app"><header><span className="logo-mark"><i/><i/><i/><i/></span><strong>tokenlens</strong><small>DESIGN TOKEN STUDIO</small></header><div className="popup-title"><span className="eyebrow">FROM PIXEL TO TOKEN</span><h1>A design studio.<br/>Inside your browser.</h1><p>Inspect the tokens behind any element. Make live changes. Take the CSS with you.</p></div><ol><li><span><Code2 size={16}/></span><div><strong>Open DevTools</strong><p>Right-click this page → Inspect<br/><kbd>⌥ ⌘ I</kbd> on Mac · <kbd>F12</kbd> on Windows</p></div></li><li><span><Crosshair size={16}/></span><div><strong>Choose the Tokens tab</strong><p>Look under the » overflow menu if needed, then pick an element.</p></div></li><li><span><SlidersHorizontal size={16}/></span><div><strong>Make it yours</strong><p>Edit a color, shadow, or type token. Changes preview immediately.</p></div></li></ol><button className="primary-button full-width" onClick={() => void connect()}>Connect this site<ArrowRight size={15}/></button>{message && <p className="popup-message" role="status">{message}</p>}<footer><ShieldCheck size={13}/><span>Local, reversible, and yours. No account needed.</span></footer><p className="builder-credit">Built by Joan Sterjo</p></main>;
}
createRoot(document.getElementById('root')!).render(<Popup/>);
