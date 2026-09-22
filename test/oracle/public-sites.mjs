/** Read-only field audit. Run: node test/oracle/public-sites.mjs */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from '@playwright/test';
const root = process.cwd();
const sites = [
  { name: 'Tailwind CSS', url: 'https://tailwindcss.com/docs/colors', selectors: ['main button', 'button'] },
  { name: 'Material Web', url: 'https://material-web.dev/components/button/', selectors: ['md-filled-button', 'md-outlined-button', 'main button', 'button', 'main a'] },
  { name: 'Shopify Polaris', url: 'https://polaris.shopify.com/', selectors: ['main button', 'button', 'main a'] },
  { name: 'Material UI / Emotion', url: 'https://mui.com/material-ui/react-button/', selectors: ['.MuiButton-contained', '.MuiButton-root', 'main button', 'button'] },
  { name: 'Shoelace', url: 'https://shoelace.style/components/button', selectors: ['main sl-button', 'sl-button', 'main button', 'button'] },
];
const bundle = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve(root, 'src/adapters/capture-live.ts'), formats: ['iife'], name: 'TokenLensCapture' } } });
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = { capturedAt: new Date().toISOString(), browser: browser.version(), mode: 'Disposable browser, isolated-world capture, read-only; no edits, logins, clicks, recovery fetches or extension export validation.', sites: [] };
try {
  for (const site of sites) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const entry = { ...site, requestedAt: new Date().toISOString() };
    try {
      const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      entry.finalUrl = page.url(); entry.httpStatus = response?.status(); entry.title = await page.title();
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      await page.waitForFunction(() => document.styleSheets.length > 0, { timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const cdp = await context.newCDPSession(page);
      const tree = await cdp.send('Page.getFrameTree');
      const world = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'TokenLensReadOnlyFieldAudit' });
      const injection = await cdp.send('Runtime.evaluate', { expression: code, contextId: world.executionContextId });
      if (injection.exceptionDetails) throw new Error(injection.exceptionDetails.text);
      const capture = await cdp.send('Runtime.evaluate', {
        contextId: world.executionContextId, returnByValue: true,
        expression: `(() => {
          const selectors = ${JSON.stringify(site.selectors)};
          let element = null;
          for (const selector of selectors) {
            element = [...document.querySelectorAll(selector)].find(node => {
              const box = node.getBoundingClientRect();
              return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
            });
            if (element) break;
          }
          if (!element) throw new Error('No rendered candidate element was available.');
          const host = element;
          const inner = element.shadowRoot?.querySelector('button, a, input');
          if (inner) element = inner;
          const report = TokenLensCapture.captureElement(element, { documentId: 'read-only-field-audit', frameId: 0 });
          const tokenNames = Object.keys(report.tokensInScope);
          return {
            selected: { hostTag: host.localName, tag: element.localName, path: report.element.ref.cssPath, treeScope: report.element.ref.treeScope.kind, label: (host.getAttribute('aria-label') || host.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120) },
            tokenCount: tokenNames.length, tokenSample: tokenNames.slice(0, 20),
            directlyUsedTokenCount: new Set(report.properties.flatMap(property => property.tokenRefs.map(ref => ref.name))).size,
            propertyCount: report.properties.length,
            tracedPropertyCount: report.properties.filter(property => property.winningDeclarationId !== null).length,
            sheetCount: report.sheets.length, unreadableSheetCount: report.sheets.filter(sheet => !sheet.readable).length,
            confidence: report.confidence, diagnostics: report.diagnostics,
            timings: report.timings, pageFontsStatus: document.fonts.status,
            capturedColors: report.properties.filter(property => ['color','background-color','border-top-color','box-shadow'].includes(property.property)).map(property => ({ property: property.property, computed: property.computedValue, traced: property.winningDeclarationId !== null }))
          };
        })()`
      });
      if (capture.exceptionDetails) throw new Error(capture.exceptionDetails.exception?.description ?? capture.exceptionDetails.text);
      entry.status = 'captured'; entry.capture = capture.result.value;
      const codes = {};
      for (const diagnostic of entry.capture.diagnostics) codes[diagnostic.code] = (codes[diagnostic.code] ?? 0) + 1;
      entry.diagnosticCounts = codes;
    } catch (error) { entry.status = 'blocked'; entry.error = String(error); }
    results.sites.push(entry);
    console.log(JSON.stringify({ site: site.name, status: entry.status, url: entry.finalUrl, tokens: entry.capture?.tokenCount, confidence: entry.capture?.confidence, diagnostics: entry.diagnosticCounts, error: entry.error }));
    await context.close();
  }
} finally { await browser.close(); }
await mkdir(resolve(root, 'test/oracle'), { recursive: true });
await writeFile(resolve(root, 'test/oracle/public-site-results.json'), `${JSON.stringify(results, null, 2)}\n`);
