import type { ConnectionResponse } from '../shared/connection';

const tabId = chrome.devtools.inspectedWindow.tabId;
let hostPort: chrome.runtime.Port | undefined;
let disposed = false;
let pendingSelection = false;
let syncingSelection = false;

function connectHost() {
  if (disposed) return;
  hostPort = chrome.runtime.connect({ name: `devtools-host:${tabId}` });
  hostPort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (!disposed) setTimeout(connectHost, 500);
  });
}

function selectCurrent(): Promise<'selected' | 'empty' | 'unavailable'> {
  return new Promise(resolve => {
    chrome.devtools.inspectedWindow.eval(
      'typeof $0 === "undefined" || !$0 || $0.nodeType !== 1 || !$0.isConnected ? "empty" : (globalThis.__TOKENLENS__ ? (globalThis.__TOKENLENS__.select($0) ? "selected" : "empty") : "unavailable")',
      { useContentScriptContext: true },
      (result: unknown) => resolve(result === 'selected' || result === 'empty' ? result : 'unavailable'),
    );
  });
}

async function synchronizeSelection() {
  if (syncingSelection) return;
  syncingSelection = true;
  try {
    while (pendingSelection && !disposed) {
      pendingSelection = false;
      if (await selectCurrent() !== 'unavailable') continue;
      const result = await chrome.runtime.sendMessage({ type: 'tokenlens:enable', tabId }) as ConnectionResponse | undefined;
      if (result?.ok !== true) continue;
      if (await selectCurrent() === 'unavailable') {
        // Some frame selections cannot be evaluated in the top isolated world.
        // Mark only AFTER content listeners are ready, so the mutation is observed.
        chrome.devtools.inspectedWindow.eval('typeof $0 !== "undefined" && $0 && $0.nodeType === 1 && $0.isConnected && ($0.setAttribute("data-tokenlens-sel", ""), true)');
      }
    }
  } catch { /* The panel and popup show actionable connection errors. */ }
  finally { syncingSelection = false; }
}
function syncSelection() {
  pendingSelection = true;
  void synchronizeSelection();
}

chrome.devtools.panels.create('Tokens', 'icons/32.png', 'src/panel/panel.html', created => {
  connectHost();
  let firstShow = true;
  created.onShown.addListener(() => {
    // Reopening the tab must not overwrite a later picker selection with stale $0.
    if (firstShow) { firstShow = false; syncSelection(); }
  });
});
chrome.devtools.panels.elements.createSidebarPane('Design Tokens', pane => { pane.setPage('src/sidebar/sidebar.html'); pane.setHeight('320px'); });
chrome.devtools.panels.elements.onSelectionChanged.addListener(syncSelection);
chrome.devtools.network.onNavigated.addListener(() => setTimeout(syncSelection, 500));
addEventListener('pagehide', () => { disposed = true; hostPort?.disconnect(); }, { once: true });
