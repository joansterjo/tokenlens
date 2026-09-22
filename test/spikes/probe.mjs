/** Real Chromium platform probes; no DOM shim. Run with `node test/spikes/probe.mjs`.
 * PLAYWRIGHT_MODULE may point to an existing Playwright installation.
 * CHROME_EXECUTABLE optionally selects an exact Chrome/Chromium binary.
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const moduleName = process.env.PLAYWRIGHT_MODULE || '@playwright/test';
const { chromium } = require(moduleName);
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }),
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><style>
    :root { --y: 12px; --x: /* a */ var(--y) /* b */; --c: oklch(0.6 0.2 240); }
    #target { color: var(--c); background: color(display-p3 1 0.2 0.3); }
    #target::before { content: "before"; --pseudo: oklch(0.7 0.1 20); color: var(--pseudo); }
    @property --registered { syntax: '<length>'; inherits: false; initial-value: 8px; }
    body { --registered: 20px; }
    #registered { --registered: 2em; font-size: 10px; width: var(--registered); }
    #invalid { --registered: red; width: var(--registered); }
    #mix { color: color-mix(in oklch, red 50%, blue); }
  </style><div id="target">Target</div><div id="registered"></div><div id="invalid"></div><div id="mix"></div>`);
  const result = await page.evaluate(() => {
    const target = document.querySelector('#target');
    const style = getComputedStyle(target);
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({mode: 'closed'});
    const popover = document.createElement('div');
    popover.popover = 'manual';
    popover.textContent = 'Spike popover';
    shadow.append(popover);
    let showError = null, repeatError = null;
    try { popover.showPopover(); } catch (error) { showError = String(error); }
    const open = popover.matches(':popover-open');
    try { popover.showPopover(); } catch (error) { repeatError = String(error); }
    popover.hidePopover(); host.remove();
    return {
      S3: { closedRoot: host.shadowRoot === null, open, showError, repeatError },
      S4: { token: style.getPropertyValue('--c'), color: style.color, p3: style.backgroundColor },
      S5: { computed: style.getPropertyValue('--x'), authored: document.styleSheets[0].cssRules[0].style.getPropertyValue('--x') },
      S6: { token: getComputedStyle(target, '::before').getPropertyValue('--pseudo'), color: getComputedStyle(target, '::before').color },
      registration: {
        childInitial: style.getPropertyValue('--registered'),
        coerced: getComputedStyle(document.querySelector('#registered')).getPropertyValue('--registered'),
        invalid: getComputedStyle(document.querySelector('#invalid')).getPropertyValue('--registered'),
      },
      colorMix: getComputedStyle(document.querySelector('#mix')).color,
    };
  });
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'tokenlens-spike' });
  const isolated = await cdp.send('Runtime.evaluate', {
    contextId: executionContextId,
    expression: `(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('#target { --c: rgb(1, 2, 3); }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const documentColor = getComputedStyle(document.querySelector('#target')).color;
      const shadowHost = document.createElement('div'); document.body.append(shadowHost);
      const root = shadowHost.attachShadow({mode:'open'});
      root.innerHTML = '<span id="shadow-target">inside</span>';
      const shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync('#shadow-target { color: rgb(4, 5, 6); }');
      root.adoptedStyleSheets = [shadowSheet];
      return { documentColor, shadowColor: getComputedStyle(root.querySelector('span')).color };
    })()`, returnByValue: true,
  });
  const output = {
    measuredAt: new Date().toISOString(),
    playwright: require(`${moduleName}/package.json`).version,
    browser: await browser.version(),
    mode: 'headless', ...result,
    S12: { context: 'CDP-created isolated world (not extension world)', ...isolated.result.value, exception: isolated.exceptionDetails ?? null },
  };
  const json = JSON.stringify(output, null, 2);
  console.log(json);
  if (process.env.SPIKE_OUTPUT) await writeFile(process.env.SPIKE_OUTPUT, json + '\n');
} finally { await browser.close(); }
