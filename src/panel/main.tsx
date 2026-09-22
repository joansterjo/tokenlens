import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PanelStore } from './store';
import { createPanelTransport } from '../adapters/chrome-port';
import { createMockTransport } from '../adapters/mock-transport';
import '../ui/styles.css';

const demo = typeof chrome === 'undefined' || !chrome.devtools?.inspectedWindow;
const store = new PanelStore(demo ? createMockTransport() : createPanelTransport());
createRoot(document.getElementById('root')!).render(<App store={store} demo={demo}/>);
window.addEventListener('pagehide', store.dispose);
