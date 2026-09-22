import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';
import type { Edit, ElementTokenReport } from '../../src/core/model';
import type { Envelope } from '../../src/transport/protocol';
import { emitCSS } from '../../src/core/emit';

declare global {
  var __tlMessages: Envelope[];
  var __tlPort: chrome.runtime.Port;
}

let context: BrowserContext, page: Page, bridge: Page, worker: Worker, profile: string, tabId: number;
const extension = resolve('dist');
const bundled = join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'tokenlens-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync(bundled) ? { executablePath: bundled } : { channel: 'chromium' }),
    headless: process.env.TL_HEADLESS === '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  page = context.pages()[0] || await context.newPage();
  await page.goto('http://127.0.0.1:4173/test/fixtures/01-basic.html');
  tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('/01-basic.html'))!.id!);
  await expect.poll(() => worker.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => Boolean(globalThis.__TOKENLENS__) }))[0]?.result, tabId)).toBe(true);
  bridge = await context.newPage();
  await bridge.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await bridge.evaluate(id => {
    globalThis.__tlMessages = [];
    globalThis.__tlPort = chrome.runtime.connect({ name: `devtools:${id}` });
    __tlPort.onMessage.addListener(m => __tlMessages.push(m));
    __tlPort.postMessage({ v: 1, id: 'initial-sync', type: 'resync', frameId: 0, payload: {} });
  }, tabId);
});
test.afterEach(async () => { await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });
async function send(type: Envelope['type'], payload: unknown, id = crypto.randomUUID()) {
  await bridge.evaluate(m => __tlPort.postMessage(m), { v: 1 as const, id, type, payload, frameId: type.startsWith('pick:') ? undefined : 0 }); return id;
}
async function reply(type: Envelope['type'], id?: string): Promise<Envelope> {
  await expect.poll(() => bridge.evaluate(({type,id}) => __tlMessages.some(m => m.type === type && (!id || m.id === id)), {type,id})).toBe(true);
  return bridge.evaluate(({type,id}) => [...__tlMessages].reverse().find(m => m.type === type && (!id || m.id === id))!, {type,id});
}
async function pick(): Promise<ElementTokenReport> {
  await send('pick:start', {});
  await expect(page.locator('tokenlens-root')).toHaveCount(1);
  await page.bringToFront(); await page.locator('#primary').click();
  return (await reply('report:result')).payload as ElementTokenReport;
}
function editFor(report: ElementTokenReport, value: string): Edit {
  const token = report.tokensInScope['--brand-500']; const scope = token.scopes.find(s => s.selector === ':root')!;
  return { id: 'brand-edit', mode: 'token', property: '--brand-500', scopeSelector: scope.selector, ctx: scope.ctx,
    treeScope: { id: 'document', kind: 'document', depth: 0 }, from: token.rawValue, to: value, rung: 'doubled',
    verified: false, enabled: true, chainHint: ['--brand-500','--action-bg'], srcHint: null, blastRadius: null, exportable: true };
}
const readStyles = (p: Page) => p.evaluate(() => [...document.querySelectorAll('body *')].filter(el => !el.closest('tokenlens-root')).slice(0,50).map(el => {
  const s = getComputedStyle(el); return [s.color,s.backgroundColor,s.boxShadow,s.fontFamily,s.fontSize,s.padding,s.borderRadius];
}));

test('pick, token aliases, reversible live edit and exported CSS round-trip on 50 elements', async () => {
  await page.evaluate(() => { const div = document.createElement('div'); div.id = 'roundtrip-samples'; div.innerHTML = '<button class="button">Sample</button>'.repeat(60); document.body.append(div); });
  const original = await readStyles(page);
  const report = await pick();
  expect(report.tokensInScope['--action-bg'].aliasesTo).toContain('--brand-500');
  expect(report.element.ref.cssPath).toContain('primary');
  await expect(page.locator('tokenlens-root')).toHaveCount(0);
  const request = await send('edit:apply', { edits: [editFor(report, '#118a6f')], transaction: 'commit' });
  const verified = (await reply('edit:verified', request)).payload as { edits: Edit[] };
  expect(verified.edits[0].verified).toBe(true);
  await expect(page.locator('#primary')).toHaveCSS('background-color', 'rgb(17, 138, 111)');
  const preview = await readStyles(page); expect(preview).not.toEqual(original);
  const bounds = await page.locator('#primary').boundingBox();
  const pixel = PNG.sync.read(await page.screenshot({ clip: { x: Math.round(bounds!.x+10), y: Math.round(bounds!.y+bounds!.height/2), width: 1, height: 1 } }));
  expect([...pixel.data].slice(0,3)).toEqual([17,138,111]);
  const css = emitCSS(verified.edits, { target: 'stylus', url: page.url() });
  await send('edit:revert', { all: true });
  await expect.poll(() => readStyles(page)).toEqual(original);
  const clean = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : existsSync(bundled) ? { executablePath: bundled } : { channel: 'chromium' }), headless: true });
  try {
    const fresh = await clean.newPage(); await fresh.goto(page.url());
    await fresh.evaluate(() => { const div = document.createElement('div'); div.id = 'roundtrip-samples'; div.innerHTML = '<button class="button">Sample</button>'.repeat(60); document.body.append(div); });
    await fresh.addStyleTag({ content: css });
    expect(await readStyles(fresh)).toEqual(preview);
  } finally { await clean.close(); }
});

test('picker suppresses page clicks and cleans up on Escape', async () => {
  await page.evaluate(() => { document.body.dataset.clicks = '0'; document.addEventListener('click', () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1); }); });
  await pick(); expect(await page.locator('body').getAttribute('data-clicks')).toBe('0');
  await send('pick:start', {}); await expect(page.locator('tokenlens-root')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(page.locator('tokenlens-root')).toHaveCount(0);
  await page.locator('#primary').click(); expect(await page.locator('body').getAttribute('data-clicks')).toBe('1');
});

test('document navigation invalidates edits and sessions do not cross tabs', async () => {
  const report = await pick(); await send('edit:apply', { edits: [editFor(report, '#118a6f')] });
  await expect(page.locator('#primary')).toHaveCSS('background-color', 'rgb(17, 138, 111)');
  const second = await context.newPage(); await second.goto(page.url());
  await expect(second.locator('#primary')).toHaveCSS('background-color','rgb(99, 91, 255)');
  await page.reload(); await expect(page.locator('#primary')).toHaveCSS('background-color','rgb(99, 91, 255)');
  await reply('nav:changed');
});

test('picker enters a cross-origin iframe and routes edits only to that document', async () => {
  await page.goto('http://127.0.0.1:4173/test/fixtures/12-frames.html');
  const child = page.frameLocator('iframe[src^="http://127.0.0.1:4174"]');
  await expect(child.locator('#primary')).toBeVisible();
  await send('pick:start', {});
  await expect(child.locator('tokenlens-root')).toHaveCount(1);
  await child.locator('#primary').click();
  const message = await reply('report:result');
  expect(message.frameId).toBeGreaterThan(0);
  const report = message.payload as ElementTokenReport;
  const edit = editFor(report, '#118a6f');
  await bridge.evaluate(m => __tlPort.postMessage(m), { v: 1, id:'child-edit',type:'edit:apply',frameId:message.frameId,documentId:message.documentId,payload:{edits:[edit]} });
  await expect(child.locator('#primary')).toHaveCSS('background-color','rgb(17, 138, 111)');
  await expect(page.locator('#primary')).toHaveCSS('background-color','rgb(99, 91, 255)');
  await expect(page.locator('tokenlens-root')).toHaveCount(0);
});
