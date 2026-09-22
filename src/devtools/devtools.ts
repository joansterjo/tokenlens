let panel: chrome.devtools.panels.ExtensionPanel | undefined;
chrome.devtools.panels.create('Tokens', 'icons/32.png', 'src/panel/panel.html', created => { panel = created; });
chrome.devtools.panels.elements.createSidebarPane('Design Tokens', pane => { pane.setPage('src/sidebar/sidebar.html'); pane.setHeight('320px'); });
function syncSelection() {
  chrome.devtools.inspectedWindow.eval('Boolean(globalThis.__TOKENLENS__ && $0 && globalThis.__TOKENLENS__.select($0))', { useContentScriptContext: true }, (_result, error) => {
    if (error?.isException) {
      chrome.devtools.inspectedWindow.eval('typeof $0 !== "undefined" && $0 instanceof Element && ($0.setAttribute("data-tokenlens-sel", ""), true)');
      chrome.runtime.sendMessage({ type: 'tokenlens:enable', tabId: chrome.devtools.inspectedWindow.tabId }).catch(() => {});
    }
  });
}
chrome.devtools.panels.elements.onSelectionChanged.addListener(syncSelection);
chrome.devtools.network.onNavigated.addListener(() => setTimeout(syncSelection, 500));
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'panel:show' && message.tabId === chrome.devtools.inspectedWindow.tabId) panel?.show();
});
