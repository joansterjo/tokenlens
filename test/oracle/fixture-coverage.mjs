/** Read-only CDP matching-declaration coverage. This is NOT a cascade-winner oracle. */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from '@playwright/test';
const root = process.cwd();
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!/^\/test\/fixtures\/[\w-]+\.(?:html|css)$/.test(path)) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(resolve(root, `.${path}`))); }
  catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const bundle = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve(root, 'src/adapters/capture-live.ts'), formats: ['iife'], name: 'TokenLensCapture' } } });
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = { capturedAt: new Date().toISOString(), browser: browser.version(), metric: 'Presence of selector/property pairs among CDP matched author rules and inherited author rules. Values, order, winners, origin conflicts and shadow internals are NOT measured; this is not a cascade oracle agreement rate.', fixtures: [] };
const normalize = value => value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
try {
  const context = await browser.newContext(); const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  for (const fixture of ['01-basic', '02-shorthands', '03-broken', '04-layers', '05-tailwind-v4', '06-hostile', '07-heavy', '08-shadow']) {
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/${fixture}.html`);
    await page.addScriptTag({ content: code });
    const report = await page.evaluate(() => window.TokenLensCapture.captureElement(document.querySelector('#primary')));
    const { root: documentNode } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#primary' });
    const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const rules = [...(matched.matchedCSSRules ?? []), ...(matched.inherited ?? []).flatMap(parent => parent.matchedCSSRules ?? [])];
    const cdpPairs = new Set(), resolverPairs = new Set();
    for (const { rule } of rules) {
      if (rule.origin !== 'regular') continue;
      for (const property of rule.style.cssProperties) {
        if (property.disabled || property.implicit || property.parsedOk === false || !property.name.startsWith('--')) continue;
        cdpPairs.add(`${normalize(rule.selectorList.text)} | ${property.name}`);
      }
    }
    for (const declaration of Object.values(report.declarations)) {
      const source = report.sources[declaration.sourceId];
      if (source.origin !== 'author' || !declaration.property.startsWith('--')) continue;
      resolverPairs.add(`${normalize(source.selectorText ?? '')} | ${declaration.property}`);
    }
    const common = [...cdpPairs].filter(pair => resolverPairs.has(pair));
    results.fixtures.push({ fixture, cdpCustomDeclarationPairs: cdpPairs.size, resolverCustomDeclarationPairs: resolverPairs.size,
      sharedPairs: common.length, cdpPairsMissingFromResolver: [...cdpPairs].filter(pair => !resolverPairs.has(pair)), resolverPairsAbsentFromCDP: [...resolverPairs].filter(pair => !cdpPairs.has(pair)),
      probeMismatchCount: report.diagnostics.filter(diagnostic => diagnostic.code === 'PROBE_MISMATCH').length });
  }
} finally { await browser.close(); server.close(); }
const total = results.fixtures.reduce((acc, result) => ({ cdp: acc.cdp + result.cdpCustomDeclarationPairs, shared: acc.shared + result.sharedPairs }), { cdp: 0, shared: 0 });
results.totalCdpPairs = total.cdp; results.totalSharedPairs = total.shared; results.matchingDeclarationCoverage = total.cdp ? total.shared / total.cdp : null;
await writeFile(resolve(root, 'test/oracle/fixture-coverage-results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
