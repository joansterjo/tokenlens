import { test, expect, chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
test('optional-permission package injects its loader and persists a granted site on reload', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tokenlens-store-test-'));
  const bundle = join(temporary,'extension');
  await cp(resolve('dist-store'),bundle,{recursive:true});
  const manifest = JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
  expect(manifest.content_scripts).toBeUndefined(); expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.permissions).not.toContain('debugger'); expect(manifest.permissions).not.toContain('tabs');
  // Grant only the disposable local fixture origin in this test copy. Native permission prompting is a separate manual check.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(bundle,'manifest.json'),JSON.stringify(manifest));
  const bundled = join(homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const context = await chromium.launchPersistentContext(join(temporary,'profile'), {
    ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : existsSync(bundled) ? {executablePath:bundled} : {channel:'chromium'}),
    headless:process.env.TL_HEADLESS === '1',args:[`--disable-extensions-except=${bundle}`,`--load-extension=${bundle}`],
  });
  try {
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const page=context.pages()[0]||await context.newPage(); await page.goto('http://127.0.0.1:4173/test/fixtures/01-basic.html');
    const tabId=await worker.evaluate(async()=>(await chrome.tabs.query({})).find(t=>t.url?.includes('/01-basic.html'))!.id!);
    const ready=()=>worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id},func:()=>Boolean(globalThis.__TOKENLENS__)}))[0].result,tabId);
    expect(await ready()).toBe(false);
    const popup=await context.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
    expect(await popup.evaluate(id=>chrome.runtime.sendMessage({type:'tokenlens:inject',tabId:id}),tabId)).toMatchObject({ok:true,status:{connected:true}});
    await expect.poll(ready).toBe(true);
    expect((await worker.evaluate(()=>chrome.scripting.getRegisteredContentScripts())).length).toBe(1);
    await page.reload(); await expect.poll(ready).toBe(true);
  } finally { await context.close(); await rm(temporary,{recursive:true,force:true}); }
});
