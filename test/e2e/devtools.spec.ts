import { test, expect, chromium, type BrowserContext, type Page, type CDPSession } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';

let context: BrowserContext, inspected: Page, profile: string;
const extension = resolve('dist');
const bundled = join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'tokenlens-devtools-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync(bundled) ? { executablePath: bundled } : { channel: 'chromium' }),
    headless: process.env.TL_HEADLESS === '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--auto-open-devtools-for-tabs'],
  });
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  inspected = context.pages().find(page => !page.url().startsWith('devtools:')) || await context.newPage();
  await inspected.goto('http://127.0.0.1:4173/test/fixtures/01-basic.html');
});
test.afterEach(async () => { await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });

async function targetSession(parent: CDPSession, targetId: string) {
  const { sessionId } = await parent.send('Target.attachToTarget', { targetId, flatten: false });
  let sequence = 0;
  async function send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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
      void parent.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
  }
  return {
    send,
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    },
  };
}

test('real DevTools panel edits, exports, and reconnects after service-worker termination', async () => {
  const cdp = await context.newCDPSession(inspected);
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.url.includes('/src/devtools/devtools.html'))).toBe(true);
  const mainTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.startsWith('devtools:'))!;
  const frontend = await targetSession(cdp, mainTarget.targetId);
  // Playwright intentionally hides DevTools pages. Use the frontend's tab controller
  // to activate the already registered Tokens tab, then drive the shipped panel DOM.
  await expect.poll(() => frontend.evaluate<boolean>(`import('./ui/legacy/legacy.js').then(m=>m.InspectorView.InspectorView.instance().tabbedPane.tabIds().some(id=>id.endsWith('Tokens')))`)).toBe(true);
  await frontend.evaluate(`import('./ui/legacy/legacy.js').then(m=>{const i=m.InspectorView.InspectorView.instance();return i.showPanel(i.tabbedPane.tabIds().find(id=>id.endsWith('Tokens'))).then(()=>true)})`);
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.url.includes('/src/panel/panel.html'))).toBe(true);
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.includes('/src/panel/panel.html'))!;
  const panel = await targetSession(cdp, target.targetId);
  await expect.poll(() => panel.evaluate<string>('document.body.innerText')).toContain('Pick element');
  const shellTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.includes('/src/devtools/devtools.html'))!;
  const shell = await targetSession(cdp, shellTarget.targetId);
  // A real DevTools Console API selection triggers the shipped Elements listener.
  await shell.evaluate(`new Promise(resolve => chrome.devtools.inspectedWindow.eval('inspect(document.querySelector("#primary")); true', (result, error) => resolve({result,error})))`);
  await expect.poll(() => panel.evaluate<string>('document.body.innerText')).toContain('--brand-500');
  await panel.evaluate(`(() => { const row = [...document.querySelectorAll('.token-row')].find(el => el.querySelector('.token-name')?.textContent === '--brand-500'); if (!row) throw new Error('Brand token not rendered'); row.click(); })()`);
  await expect.poll(() => panel.evaluate<boolean>(`Boolean(document.querySelector('[aria-label="CSS color"]'))`)).toBe(true);
  async function inputColor(value: string) {
    await panel.evaluate(`(() => { const input=document.querySelector('[aria-label="CSS color"]'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.blur(); })()`);
  }
  await inputColor('#118a6f');
  await expect(inspected.locator('#primary')).toHaveCSS('background-color', 'rgb(17, 138, 111)');
  await panel.evaluate(`document.querySelector('.export-open-button').click()`);
  await expect.poll(() => panel.evaluate<string>(`document.querySelector('[aria-label="Exported CSS"]')?.value ?? ""`)).toContain('#118a6f');
  expect(await panel.evaluate<string>(`document.querySelector('[aria-label="Exported CSS"]').value`)).toContain(':root');
  await panel.evaluate(`document.querySelector('[aria-label="Close export"]').click()`);

  const originalWorker = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker')!.targetId;
  await context.serviceWorkers()[0].evaluate(() => { (globalThis as {__tlProbe?:string}).__tlProbe = 'before-stop'; });
  const internals = await context.newPage();
  await internals.goto('chrome://serviceworker-internals');
  await internals.getByRole('button', {name:'Stop',exact:true}).click();
  // Chromium retains the service-worker target ID across restarts. A fresh
  // execution context (our in-memory marker disappears) proves termination.
  const restartedWorker = await targetSession(cdp, originalWorker);
  await expect.poll(() => restartedWorker.evaluate<string>('typeof globalThis.__tlProbe').catch(() => 'restarting')).toBe('undefined');
  await internals.close();
  await expect.poll(() => panel.evaluate<string>('document.body.innerText')).toContain('Connected');
  await expect(inspected.locator('#primary')).toHaveCSS('background-color', 'rgb(17, 138, 111)');
  await inputColor('#b045d4');
  await expect(inspected.locator('#primary')).toHaveCSS('background-color', 'rgb(176, 69, 212)');
  await panel.evaluate(`document.querySelector('.export-open-button').click()`);
  await expect.poll(() => panel.evaluate<string>(`document.querySelector('[aria-label="Exported CSS"]')?.value ?? ""`)).toContain('#b045d4');
  await panel.evaluate(`document.querySelector('[aria-label="Close export"]').click()`);
  await panel.evaluate(`document.querySelector('[aria-label="Revert --brand-500"]').click()`);
  await expect(inspected.locator('#primary')).toHaveCSS('background-color', 'rgb(99, 91, 255)');

  // CSS Color 4 permits missing channels. This used to unmount the entire
  // Tokens panel when the picker selected a page using such a token.
  await inspected.addStyleTag({ content: ':root { --brand-500: oklch(.5 none none); }' });
  const originalMissingColor = await inspected.locator('#primary').evaluate(element => getComputedStyle(element).backgroundColor);
  expect(originalMissingColor).toContain('oklch');
  await panel.evaluate(`document.querySelector('.pick-button').click()`);
  await expect(inspected.locator('tokenlens-root')).toHaveCount(1);
  await inspected.locator('#primary').click();
  await expect(inspected.locator('tokenlens-root')).toHaveCount(0);
  await expect.poll(() => panel.evaluate<string>(`document.querySelector('[aria-label="CSS color"]')?.value ?? ""`)).toContain('none');
  expect(await panel.evaluate<string>('document.body.innerText')).not.toContain('The editor hit a problem.');
  await inputColor('#118a6f');
  await expect(inspected.locator('#primary')).toHaveCSS('background-color', 'rgb(17, 138, 111)');
  await panel.evaluate(`document.querySelector('.export-open-button').click()`);
  await expect.poll(() => panel.evaluate<string>(`document.querySelector('[aria-label="Exported CSS"]')?.value ?? ""`)).toContain('#118a6f');
  await panel.evaluate(`document.querySelector('[aria-label="Close export"]').click()`);
  await panel.evaluate(`document.querySelector('[aria-label="Revert --brand-500"]').click()`);
  await expect(inspected.locator('#primary')).toHaveCSS('background-color', originalMissingColor);
});
