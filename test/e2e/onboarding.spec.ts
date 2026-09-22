import { test, expect, chromium, type BrowserContext, type Page, type Worker, type CDPSession } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';

interface ConnectionResponse {
  ok: boolean;
  status?: { connected: boolean; hasPermission: boolean; devtoolsOpen: boolean; hostname: string };
  error?: string;
}

let context: BrowserContext, inspected: Page, worker: Worker, temporary: string, tabId: number;
const bundled = join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

async function launch(devtools = false) {
  temporary = await mkdtemp(join(tmpdir(), 'tokenlens-onboarding-test-'));
  const extension = join(temporary, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  await copyFile(join(extension, manifest.content_scripts[0].js[0]), join(extension, 'content-loader.js'));
  delete manifest.content_scripts;
  // Match the optional-permission release, granting only this disposable local
  // fixture origin. This tests the real popup and loader, not Chrome's native
  // permission prompt, which still needs a separate manual check.
  manifest.permissions = ['scripting', 'storage', 'activeTab'];
  manifest.optional_host_permissions = ['http://*/*', 'https://*/*'];
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync(bundled) ? { executablePath: bundled } : { channel: 'chromium' }),
    headless: process.env.TL_HEADLESS === '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...(devtools ? ['--auto-open-devtools-for-tabs'] : [])],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  inspected = context.pages().find(page => !page.url().startsWith('devtools:')) || await context.newPage();
  await inspected.goto('http://127.0.0.1:4173/test/fixtures/01-basic.html');
  tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('/01-basic.html'))!.id!);
}

test.afterEach(async () => {
  await context?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function targetSession(parent: CDPSession, targetId: string) {
  const { sessionId } = await parent.send('Target.attachToTarget', { targetId, flatten: false });
  let sequence = 0;
  async function send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { parent.off('Target.receivedMessageFromTarget', receive); reject(new Error(`Timed out: ${method}`)); }, 10000);
      function receive(event: { sessionId: string; message: string }) {
        if (event.sessionId !== sessionId) return;
        const reply = JSON.parse(event.message) as { id: number; result: T; error?: { message: string } };
        if (reply.id !== id) return;
        clearTimeout(timer); parent.off('Target.receivedMessageFromTarget', receive);
        if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result);
      }
      parent.on('Target.receivedMessageFromTarget', receive);
      void parent.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        clearTimeout(timer); parent.off('Target.receivedMessageFromTarget', receive); reject(error);
      });
    });
  }
  return {
    targetId,
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    },
  };
}

async function openPopup(cdp: CDPSession) {
  await inspected.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.url.endsWith('/src/popup/popup.html'))).toBe(true);
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.endsWith('/src/popup/popup.html'))!;
  const popup = await targetSession(cdp, target.targetId);
  await expect.poll(() => popup.evaluate<string>('document.body.innerText')).toContain('tokenlens');
  return popup;
}

const inspectorReady = () => worker.evaluate(async id => (await chrome.scripting.executeScript({
  target: { tabId: id }, func: () => Boolean(globalThis.__TOKENLENS__),
}))[0]?.result, tabId);

test('real toolbar popup connects an existing page and remembers readiness when reopened', async () => {
  await launch();
  expect(await inspectorReady()).toBe(false);
  const cdp = await context.newCDPSession(inspected);
  let popup = await openPopup(cdp);
  const statusBefore = await popup.evaluate<ConnectionResponse>(`chrome.runtime.sendMessage({type:'tokenlens:status',tabId:${tabId}})`);
  expect(statusBefore).toMatchObject({ ok: true, status: { hasPermission: true, connected: false, devtoolsOpen: false } });
  await expect.poll(() => popup.evaluate<string>('document.body.innerText')).toContain('Connect page inspector');
  await popup.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.includes('Connect page inspector')); if (!button) throw new Error('Connect button missing'); button.click(); })()`);
  await expect.poll(() => popup.evaluate<string>('document.querySelector("h1")?.textContent ?? ""')).toBe('Connected. Now open DevTools.');
  expect(await inspectorReady()).toBe(true);
  expect(await popup.evaluate<ConnectionResponse>(`chrome.runtime.sendMessage({type:'tokenlens:status',tabId:${tabId}})`)).toMatchObject({ ok: true, status: { connected: true, hostname: '127.0.0.1', devtoolsOpen: false } });
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toHaveLength(1);

  const firstPopup = popup.targetId;
  await popup.evaluate('window.close()').catch(() => { /* Closing destroys the popup execution context. */ });
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === firstPopup)).toBe(false);
  popup = await openPopup(cdp);
  await expect.poll(() => popup.evaluate<string>('document.querySelector("h1")?.textContent ?? ""')).toBe('Connected. Now open DevTools.');
  const text = await popup.evaluate<string>('document.body.innerText');
  expect(text).toContain('Inspector ready');
  expect(text).toContain('127.0.0.1');
  expect(text).not.toContain('A design studio.');
  expect(await popup.evaluate<string[]>('[...document.querySelectorAll("button")].map(el => el.textContent)')).not.toContain('Connect page inspector');
});

test('onboarding guides manual Tokens selection and the panel opens with the existing Elements selection', async () => {
  await launch(true);
  const cdp = await context.newCDPSession(inspected);
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.url.includes('/src/devtools/devtools.html'))).toBe(true);
  const shellTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.includes('/src/devtools/devtools.html'))!;
  const shell = await targetSession(cdp, shellTarget.targetId);
  // Select in Elements before the Tokens panel is first shown. The fixture has no
  // static content script, matching a page that was open before site connection.
  await shell.evaluate(`new Promise(resolve => chrome.devtools.inspectedWindow.eval('inspect(document.querySelector("#primary")); true', (result, error) => resolve({result,error})))`);
  const connection = await shell.evaluate<ConnectionResponse>(`chrome.runtime.sendMessage({type:'tokenlens:inject',tabId:${tabId}})`);
  expect(connection).toMatchObject({ ok: true, status: { connected: true, devtoolsOpen: true } });
  // A successful acknowledgement must already mean that the async CRX loader
  // has imported the inspector and established the top-frame connection.
  expect(await inspectorReady()).toBe(true);

  const mainTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.startsWith('devtools:'))!;
  const frontend = await targetSession(cdp, mainTarget.targetId);
  await expect.poll(() => frontend.evaluate<boolean>(`import('./ui/legacy/legacy.js').then(m=>m.InspectorView.InspectorView.instance().tabbedPane.tabIds().some(id=>id.endsWith('Tokens')))`)).toBe(true);
  const popup = await openPopup(cdp);
  await expect.poll(() => popup.evaluate<string>('document.querySelector("h1")?.textContent ?? ""')).toMatch(/Choose.*Tokens/i);
  const buttons = await popup.evaluate<string[]>('[...document.querySelectorAll("button")].map(el => el.textContent)');
  expect(buttons).not.toContain('Open Tokens panel');
  expect(await popup.evaluate<string>('document.body.innerText')).toContain('Choose the Tokens tab');
  await popup.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.includes('Close popup')); if (!button) throw new Error('Close popup button missing'); button.click(); })()`).catch(async error => {
    // Clicking Close destroys the popup's context before CDP can always reply.
    if ((await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === popup.targetId)) throw error;
  });
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === popup.targetId)).toBe(false);
  // Chrome's ExtensionPanel.show() cannot switch tabs from a popup message.
  // Exercise the manual tab selection described by onboarding using the native
  // DevTools controller, as in the existing real-DevTools integration test.
  await frontend.evaluate(`import('./ui/legacy/legacy.js').then(m=>{const i=m.InspectorView.InspectorView.instance();return i.showPanel(i.tabbedPane.tabIds().find(id=>id.endsWith('Tokens'))).then(()=>true)})`);
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.url.includes('/src/panel/panel.html'))).toBe(true);
  const panelTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.includes('/src/panel/panel.html'))!;
  const panel = await targetSession(cdp, panelTarget.targetId);
  await expect.poll(() => panel.evaluate<string>('document.body.innerText')).toContain('--brand-500');
  expect(await panel.evaluate<string>('document.body.innerText')).toContain('primary');
  await expect.poll(() => frontend.evaluate<string>(`import('./ui/legacy/legacy.js').then(m=>m.InspectorView.InspectorView.instance().tabbedPane.selectedTabId)`)).toMatch(/Tokens$/);
  // An iframe element belongs to another DOM realm. Elements selection must
  // accept it even when it is not an instanceof the top window's Element.
  await inspected.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'selection-frame';
    frame.src = '/test/fixtures/01-basic.html';
    document.body.append(frame);
  });
  const child = inspected.frameLocator('#selection-frame').locator('#primary');
  await child.waitFor();
  await child.evaluate(element => { element.id = 'iframe-primary'; });
  await shell.evaluate(`new Promise(resolve => chrome.devtools.inspectedWindow.eval('inspect(document.querySelector("#selection-frame").contentDocument.querySelector("#iframe-primary")); true', (result, error) => resolve({result,error})))`);
  await frontend.evaluate(`import('./ui/legacy/legacy.js').then(m=>{const i=m.InspectorView.InspectorView.instance();return i.showPanel(i.tabbedPane.tabIds().find(id=>id.endsWith('Tokens'))).then(()=>true)})`);
  await expect.poll(() => panel.evaluate<string>('document.querySelector(".breadcrumb")?.textContent ?? ""')).toContain('#iframe-primary');
});
