import { test, expect } from '@playwright/test';

test('S3 closed-shadow popover opens and repeated show is harmless', async ({ page }) => {
  await page.setContent('<div style="position:fixed;inset:0;z-index:2147483647">Hostile page overlay</div>');
  const result = await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    const root = host.attachShadow({ mode: 'closed' });
    const popover = document.createElement('div'); popover.popover = 'manual'; root.append(popover);
    popover.showPopover(); popover.showPopover();
    return { closed: host.shadowRoot === null, open: popover.matches(':popover-open') };
  });
  expect(result).toEqual({ closed: true, open: true });
});

test('S4 computed modern color spaces retain their representation', async ({ page }) => {
  await page.setContent('<div style="--c:oklch(.6 .2 240);color:var(--c);background:color(display-p3 1 .2 .3)">color</div>');
  const result = await page.locator('div').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  expect(result).toEqual({ color: 'oklch(0.6 0.2 240)', background: 'color(display-p3 1 0.2 0.3)' });
});

test('S5 CSSOM strips surrounding comments from custom properties', async ({ page }) => {
  await page.setContent('<style>:root { --y:12px; --x: /* a */ var(--y) /* b */; }</style>');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--x'))).toBe('12px');
});

test('S6 pseudo-element custom properties resolve', async ({ page }) => {
  await page.setContent('<style>p::before { content:"before"; --pseudo:oklch(.7 .1 20);color:var(--pseudo) }</style><p>target</p>');
  expect(await page.locator('p').evaluate(el => getComputedStyle(el, '::before').getPropertyValue('--pseudo'))).toBe('oklch(.7 .1 20)');
});

test('@property registration coercion, invalid values, inheritance and color-mix', async ({ page }) => {
  await page.setContent(`<style>
    @property --n { syntax:'<length>'; inherits:false; initial-value:8px; }
    body { --n:20px; } #typed { --n:2em;font-size:10px } #invalid { --n:red }
    #mixed { color:color-mix(in oklch,red 50%,blue) }
  </style><p id="initial"></p><p id="typed"></p><p id="invalid"></p><p id="mixed"></p>`);
  const values = await page.evaluate(() => ['initial', 'typed', 'invalid'].map(id => getComputedStyle(document.getElementById(id)!).getPropertyValue('--n')));
  expect(values).toEqual(['8px', '20px', '8px']);
  expect(await page.locator('#mixed').evaluate(el => getComputedStyle(el).color)).toBe('oklch(0.539974 0.285457 326.643)');
});

test('S11 inspector stylesheet accepts at-rules via CDP and is transient', async ({ page }) => {
  await page.route('**/spike-inspector', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p id="target">target</p>' }));
  await page.goto('http://127.0.0.1:4173/spike-inspector');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { styleSheetId } = await cdp.send('CSS.createStyleSheet', { frameId: frameTree.frame.id });
  await cdp.send('CSS.setStyleSheetText', { styleSheetId, text: '/* probe */ @media (min-width:0px) { #target { color: rgb(1, 2, 3); } } #target { background: rgb(4,5,6) }' });
  expect(await page.locator('#target').evaluate(el => getComputedStyle(el).color)).toBe('rgb(1, 2, 3)');
  await page.reload();
  expect(await page.locator('#target').evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 0, 0)');
});

test('S12 CDP isolated-world sheets adopt in document and shadow root', async ({ page }) => {
  await page.setContent('<p id="target">target</p>');
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'tokenlens-spike' });
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true, expression: `(() => {
    const sheet = new CSSStyleSheet();sheet.replaceSync('#target { color: rgb(1, 2, 3) }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets,sheet];
    const host = document.createElement('div');document.body.append(host);const root = host.attachShadow({mode:'open'});
    root.innerHTML = '<p>inside</p>';const shadowSheet = new CSSStyleSheet();shadowSheet.replaceSync('p {color:rgb(4,5,6)}');root.adoptedStyleSheets=[shadowSheet];
    return [getComputedStyle(document.querySelector('#target')).color,getComputedStyle(root.querySelector('p')).color];
  })()` });
  expect(exceptionDetails).toBeUndefined();
  expect(result.value).toEqual(['rgb(1, 2, 3)', 'rgb(4, 5, 6)']);
});
