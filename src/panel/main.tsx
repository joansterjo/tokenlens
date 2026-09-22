import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { PanelStore } from './store';
import { createPanelTransport } from '../adapters/chrome-port';
import { createMockTransport } from '../adapters/mock-transport';
import '../ui/styles.css';

const demo = typeof chrome === 'undefined' || !chrome.devtools?.inspectedWindow;
const store = new PanelStore(demo ? createMockTransport() : createPanelTransport());
createRoot(document.getElementById('root')!).render(<ErrorBoundary store={store} onRetry={store.recoverEditor}><App store={store} demo={demo}/></ErrorBoundary>);
window.addEventListener('pagehide', store.dispose);
