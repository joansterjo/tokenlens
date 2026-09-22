import { useState, useSyncExternalStore } from 'react';
import { VERSION } from '../shared/version';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Crosshair, Palette } from 'lucide-react';
import { PanelStore, reportItems } from '../panel/store';
import { createPanelTransport } from '../adapters/chrome-port';
import { createMockTransport } from '../adapters/mock-transport';
import '../ui/styles.css';
import './sidebar.css';
const demo = typeof chrome === 'undefined' || !chrome.devtools?.inspectedWindow;
const store = new PanelStore(demo ? createMockTransport() : createPanelTransport());
const sourceTraceLabels = { exact: 'Verified', probable: 'Estimated source trace', degraded: 'Partial source trace' };
const sourceTraceHelp = 'Some stylesheet rules could not be verified. Computed values are read from the browser; source matching may be incomplete.';
function Sidebar() {
  const [showGuide, setShowGuide] = useState(false);
  const findPanel = () => { if (demo) window.open('../panel/panel.html', '_blank'); else setShowGuide(true); };
  const { report, edits } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const items = reportItems(report, 'used');
  return <div className="sidebar-app"><header><strong><Palette size={14}/>Design tokens</strong><button onClick={findPanel} title={demo ? 'Open demo panel' : 'Find Tokens tab'} aria-label={demo ? 'Open demo panel' : 'Find Tokens tab'}><ArrowUpRight size={15}/></button></header>{showGuide && <div className="sidebar-guide" role="status"><strong>Where to edit</strong><p>Choose <b>Tokens</b> in the DevTools tab bar. If it is hidden, open the <b>»</b> menu next to the tabs and choose <b>Tokens</b>.</p></div>}{report ? <><code className="sidebar-selection">{report.element.ref.cssPath}</code>{report.confidence !== 'exact' && <div className="inline-warning" title={sourceTraceHelp}>{sourceTraceLabels[report.confidence]} · computed values available. Choose the Tokens tab for source diagnostics.</div>}<div className="sidebar-tokens">{items.map(item => <button key={item.id} onClick={findPanel} title={demo ? 'Open demo panel' : `Where to edit ${item.name}`}><span className="sidebar-swatch" style={{ background: item.category === 'color' ? item.value : undefined }}>{item.category !== 'color' ? 'Aa' : ''}</span><span><strong>{item.name}</strong><small>{edits.find(e => e.property === item.name)?.to ?? item.value}</small></span><ArrowUpRight size={12}/></button>)}{!items.length && <p className="inline-note">No token references found. Choose the Tokens tab to edit computed properties.</p>}</div><button className="secondary-button full-width" onClick={findPanel}>{demo ? 'Open demo panel' : 'Find Tokens tab'} <ArrowUpRight size={13}/></button></> : <div className="empty-list"><Crosshair size={22}/><span>Select an element in the Elements panel to see its tokens.</span></div>}<footer className="builder-credit">Built by Joan Sterjo · v{VERSION}</footer></div>;
}
if (!demo && chrome.devtools.panels.themeName === 'dark') document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<Sidebar/>);
window.addEventListener('pagehide', store.dispose);
