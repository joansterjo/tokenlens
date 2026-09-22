/** Regenerate real-browser captures: node test/browser/capture-snapshots.mjs */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from '@playwright/test';
const root = process.cwd();
const out = resolve(root, 'test/snapshots');
await mkdir(out, { recursive: true });
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!/^\/test\/fixtures\/[\w-]+\.(?:html|css)$/.test(path)) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(resolve(root, `.${path}`));
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/html'); response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('http://127.0.0.1:4174/**', async route => route.fulfill({ contentType: 'text/css', body: await readFile(resolve(root, 'test/fixtures/foreign.css'), 'utf8') }));
  const bundled = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve(root, 'src/adapters/capture-live.ts'), formats: ['iife'], name: 'TokenLensCapture' } } });
  const code = (Array.isArray(bundled) ? bundled[0] : bundled).output.find(item => item.type === 'chunk').code;
  const page = await context.newPage();
  const summaries = {};
  let performanceRecord;
  const fixtures = ['01-basic', '02-shorthands', '03-broken', '04-layers', '05-tailwind-v4', '06-hostile', '07-heavy', '08-shadow', '09-cross-origin', '10-case-and-escapes', '11-registered', '12-frames', '13-design-system'];
  for (const fixture of fixtures) {
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/${fixture}.html`);
    await page.addScriptTag({ content: code });
    const report = await page.evaluate(() => window.TokenLensCapture.captureElement(document.querySelector('#primary'), { documentId: 'fixture-document', frameId: 0 }));
    const stable = JSON.parse(JSON.stringify(report).replaceAll(`http://127.0.0.1:${port}`, 'http://fixture.local'));
    stable.timings = { totalMs: 0, indexMs: 0, matchMs: 0, resolveMs: 0, sheetFetchMs: 0 };
    await writeFile(resolve(out, `${fixture}.report.json`), `${JSON.stringify(stable, null, 2)}\n`);
    summaries[fixture] = {
      properties: Object.fromEntries(report.properties.filter(property => property.winningDeclarationId).map(property => [property.property, { computed: property.computedValue, selector: report.sources[report.declarations[property.winningDeclarationId].sourceId].matchedSelector, tokens: property.tokenRefs.map(ref => ref.name) }])),
      tokens: Object.fromEntries(Object.values(report.tokensInScope).map(token => [token.name, { raw: token.rawValue, computed: token.computedValue, terminal: token.terminalValue }])),
      diagnosticCodes: [...new Set(report.diagnostics.map(d => d.code))].sort(),
    };
    if (fixture === '01-basic' || fixture === '04-layers') {
      const sheets = await page.evaluate(() => window.TokenLensCapture.captureStyleSheets(document));
      await writeFile(resolve(out, `${fixture}.sheets.json`), `${JSON.stringify(sheets, null, 2).replaceAll(`http://127.0.0.1:${port}`, 'http://fixture.local')}\n`);
    }
    if (fixture === '07-heavy') {
      const metrics = await page.evaluate(() => ({ candidates: window.TokenLensCapture.captureIndexMetrics(document.querySelector('#primary')), samples: Array.from({ length: 20 }, () => window.TokenLensCapture.captureElement(document.querySelector('#primary')).timings) }));
      const samples = metrics.samples.map(sample => sample.totalMs).sort((a, b) => a - b);
      performanceRecord = { browser: browser.version(), fixture, cold: report.timings, warmSamples: metrics.samples, warmP95Ms: samples[Math.ceil(samples.length * 0.95) - 1], candidates: metrics.candidates };
    }
    if (fixture === '09-cross-origin' && !report.diagnostics.some(d => d.code === 'CROSS_ORIGIN_SHEET_UNREADABLE')) throw new Error('Cross-origin sheet fixture must report unreadable CSSOM.');
  }
  await writeFile(resolve(out, 'golden-summary.json'), `${JSON.stringify(summaries, null, 2)}\n`);
  await writeFile(resolve(out, 'perf.json'), `${JSON.stringify(performanceRecord, null, 2)}\n`);
  console.log(JSON.stringify({ browser: browser.version(), fixtureCount: fixtures.length, performance: performanceRecord }, null, 2));
} finally { await browser.close(); server.close(); }
