/** Reproduce the known Shoelace navigation shadow-color provenance discrepancy, read-only. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from '@playwright/test';
const bundle = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve('src/adapters/capture-live.ts'), formats: ['iife'], name: 'TokenLensCapture' } } });
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('https://shoelace.style/components/button', { waitUntil: 'networkidle', timeout: 30000 });
  const cdp = await page.context().newCDPSession(page), tree = await cdp.send('Page.getFrameTree');
  const world = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'TokenLensReadOnlyShadowAudit' });
  await cdp.send('Runtime.evaluate', { contextId: world.executionContextId, expression: code });
  const result = await cdp.send('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true, expression: `(() => {
    const host = document.querySelector('sl-button');
    const element = host.shadowRoot.querySelector('button');
    const report = TokenLensCapture.captureElement(element);
    return { hostOuterHtml: host.outerHTML.slice(0,1000), path: report.element.ref.cssPath, confidence: report.confidence,
      diagnostics: report.diagnostics, color: report.properties.find(property => property.property === 'color'),
      sources: report.sources, declarations: report.declarations };
  })()` });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  const record = { capturedAt: new Date().toISOString(), browser: browser.version(), url: page.url(), mode: 'read-only isolated world', capture: result.result.value };
  await writeFile('test/oracle/shadow-discrepancy-results.json', `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ color: record.capture.color.computedValue, mismatches: record.capture.diagnostics.filter(d => d.code === 'PROBE_MISMATCH') }));
} finally { await browser.close(); }
