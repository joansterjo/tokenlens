/** Actual extension-world probes in a disposable profile. Requires Chrome for Testing. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
const moduleName = process.env.PLAYWRIGHT_MODULE || '@playwright/test';
const { chromium } = require(moduleName);
const extensionDir = await mkdtemp(join(tmpdir(), 'tokenlens-spike-extension-'));
const profileDir = await mkdtemp(join(tmpdir(), 'tokenlens-spike-profile-'));
const content = `(() => {
  const sheet = new CSSStyleSheet(); sheet.replaceSync('body { color: rgb(1, 2, 3); }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const host = document.createElement('div'); document.body.append(host);
  const root = host.attachShadow({mode:'open'}); root.innerHTML = '<span>inside</span>';
  const shadowSheet = new CSSStyleSheet(); shadowSheet.replaceSync('span { color: rgb(4, 5, 6); }');
  root.adoptedStyleSheets = [shadowSheet];
  globalThis.tokenlensSpikeContent = true;
  chrome.runtime.sendMessage({kind:'content', url:location.href, isTop:window === top,
    documentColor: getComputedStyle(document.body).color,
    shadowColor: getComputedStyle(root.querySelector('span')).color });
})()`;
const devtools = `(() => {
  const ev = (source, options = {}) => new Promise(resolve => chrome.devtools.inspectedWindow.eval(source, options, (value, error) => resolve({value, error})));
  async function run() {
    const ready = await ev('document.querySelector("#target") !== null');
    if (!ready.value) return setTimeout(run, 100);
    await ev('inspect(document.querySelector("#target")); true');
    await new Promise(resolve => setTimeout(resolve, 200));
    const main = await ev('({type: typeof $0, id: $0?.id, content:typeof tokenlensSpikeContent})');
    const isolated = await ev('({type:typeof $0, id:$0?.id, content:typeof tokenlensSpikeContent})', {useContentScriptContext:true});
    await ev('inspect(document.querySelector("iframe#child").contentDocument.querySelector("#inside")); true');
    await new Promise(resolve => setTimeout(resolve, 200));
    const childSelection = await ev('({location:location.href, selectedId:$0?.id, selectedDocument:$0?.ownerDocument.URL})');
    const childExplicit = await ev('({location:location.href, selectedId:$0?.id})',{frameURL:location.origin});
    chrome.runtime.sendMessage({kind:'devtools',main,isolated,childSelection});
  }
  chrome.devtools.panels.create('Spike', '', 'panel.html', () => run());
})()`;
await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({manifest_version:3,name:'Tokenlens platform probe',version:'1.0.0',permissions:['storage'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'worker.js'},devtools_page:'devtools.html',content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js'],all_frames:true,match_origin_as_fallback:true,run_at:'document_idle'}]}));
await writeFile(join(extensionDir, 'worker.js'), 'globalThis.spikeResults=[];chrome.runtime.onMessage.addListener((message,sender)=>{spikeResults.push({...message,frameId:sender.frameId,documentId:sender.documentId});});');
await writeFile(join(extensionDir, 'content.js'), content);
await writeFile(join(extensionDir, 'devtools.html'), '<!doctype html><script src="devtools.js"></script>');
await writeFile(join(extensionDir, 'devtools.js'), devtools);
await writeFile(join(extensionDir, 'panel.html'), '<!doctype html><p>Platform probes</p>');
const server = createServer((req,res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/child' ? '<!doctype html><p id="inside">child</p>' : '<!doctype html><p id="target">top</p><iframe id="child" src="/child"></iframe><iframe srcdoc="<!doctype html><p id=srcdoc>srcdoc</p>"></iframe>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, { executablePath:process.env.CHROME_EXECUTABLE, channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium', headless:true, args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--auto-open-devtools-for-tabs'] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = context.pages()[0] || await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const deadline = Date.now() + 7000;
  let results = [];
  while (Date.now() < deadline) {
    results = await worker.evaluate(() => globalThis.spikeResults);
    if (results.some(result => result.kind === 'devtools')) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const devtoolsResult = results.find(result => result.kind === 'devtools');
  assert.equal(devtoolsResult?.main?.value?.id, 'target', 'S1 MAIN selection unavailable');
  assert.equal(devtoolsResult?.isolated?.value?.id, 'target', 'S1 isolated selection unavailable');
  assert.equal(devtoolsResult?.isolated?.value?.content, 'boolean', 'S1 wrong execution world');
  assert.equal(devtoolsResult?.childSelection?.value?.selectedId, 'inside', 'S2 child selection lost');
  assert.ok(devtoolsResult.childSelection.value.selectedDocument.endsWith('/child'));
  assert.ok(!devtoolsResult.childSelection.value.location.endsWith('/child'));
  assert.ok(results.some(result => result.url === 'about:srcdoc'), 'S10 srcdoc injection missing');
  for (const result of results.filter(result => result.kind === 'content')) {
    assert.equal(result.documentColor, 'rgb(1, 2, 3)', 'S12 document adoption failed');
    assert.equal(result.shadowColor, 'rgb(4, 5, 6)', 'S12 shadow adoption failed');
  }
  const output = {measuredAt:new Date().toISOString(), playwright:require(`${moduleName}/package.json`).version,browser:await page.evaluate(()=>navigator.userAgent), results};
  const json = JSON.stringify(output,null,2); console.log(json);
  if (process.env.SPIKE_OUTPUT) await writeFile(process.env.SPIKE_OUTPUT,json+'\n');
} finally {
  await context?.close(); await new Promise(resolve=>server.close(resolve));
  await rm(extensionDir,{recursive:true,force:true}); await rm(profileDir,{recursive:true,force:true});
}
