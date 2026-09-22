import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Crosshair, Palette } from 'lucide-react';
import { PanelStore, reportItems } from '../panel/store';
import { createPanelTransport } from '../adapters/chrome-port';
import { createMockTransport } from '../adapters/mock-transport';
import '../ui/styles.css';
import './sidebar.css';
const demo = typeof chrome === 'undefined' || !chrome.devtools?.inspectedWindow;
const store = new PanelStore(demo ? createMockTransport() : createPanelTransport());
function openPanel() { if (!demo) void chrome.runtime.sendMessage({ type: 'panel:show', tabId: chrome.devtools.inspectedWindow.tabId }); else window.open('../panel/panel.html', '_blank'); }
function Sidebar() {
  const { report, edits } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const items = reportItems(report, 'used');
  return <div className="sidebar-app"><header><strong><Palette size={14}/>Design tokens</strong><button onClick={openPanel} title="Open full Tokens panel"><ArrowUpRight size={15}/></button></header>{report ? <><code className="sidebar-selection">{report.element.ref.cssPath}</code>{report.confidence !== 'exact' && <div className="inline-warning">{report.confidence} provenance · open the panel for diagnostics</div>}<div className="sidebar-tokens">{items.map(item => <button key={item.id} onClick={openPanel}><span className="sidebar-swatch" style={{ background: item.category === 'color' ? item.value : undefined }}>{item.category !== 'color' ? 'Aa' : ''}</span><span><strong>{item.name}</strong><small>{edits.find(e => e.property === item.name)?.to ?? item.value}</small></span><ArrowUpRight size={12}/></button>)}{!items.length && <p className="inline-note">No token references found. Open the panel to edit computed properties.</p>}</div><button className="secondary-button full-width" onClick={openPanel}>Edit in Tokens panel <ArrowUpRight size={13}/></button></> : <div className="empty-list"><Crosshair size={22}/><span>Select an element in the Elements panel to see its tokens.</span></div>}<footer className="builder-credit">Built by Joan Sterjo</footer></div>;
}
if (!demo && chrome.devtools.panels.themeName === 'dark') document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<Sidebar/>);
window.addEventListener('pagehide', store.dispose);
