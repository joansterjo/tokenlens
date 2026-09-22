import { afterEach, expect, test } from 'vitest';
import type { Edit } from '../../src/core/model';
import { OverrideEngine, uniqueSelector } from '../../src/content/override';
import { emitCSS } from '../../src/core/emit';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(css: string, html = '<button class="button">Buy</button>') {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const root = document.createElement('div'); root.id = 'override-fixture'; root.innerHTML = html; document.body.append(root);
  cleanup.push(() => { root.remove(); style.remove(); }); return root;
}
function engine(options = {}) { const instance = new OverrideEngine(options); cleanup.push(() => instance.destroy()); return instance; }
function edit(overrides: Partial<Edit> = {}): Edit { return { id: 'brand', mode: 'token', property: '--brand', scopeSelector: '#override-fixture', ctx: { media: null, supports: null, container: null, layerPath: [] }, treeScope: { id: 'document', kind: 'document', depth: 0 }, from: 'red', to: 'blue', rung: 'doubled', enabled: true, verified: false, chainHint: [], srcHint: null, blastRadius: null, exportable: true, ...overrides }; }
const color = (element: Element) => getComputedStyle(element).color;

test('preview and exported CSS round-trip colors, spacing, radius, typography and shadows', () => {
  const root = fixture('#override-fixture {--brand:red;--space:8px;--radius:4px;--font:14px;--shadow:0 1px 2px #0003} .button{color:var(--brand);padding:var(--space);border-radius:var(--radius);font-size:var(--font);box-shadow:var(--shadow)}');
  const button = root.firstElementChild!; const instance = engine();
  const result = instance.apply([edit(), edit({ id: 'space', property: '--space', to: '18px' }), edit({ id: 'radius', property: '--radius', to: '16px' }), edit({ id: 'font', property: '--font', to: '20px' }), edit({ id: 'shadow', property: '--shadow', to: '0 8px 24px rgb(2 4 8 / .4)' })], button);
  expect(result.edits.every(item => item.verified)).toBe(true);
  const read = () => ['color', 'padding', 'border-radius', 'font-size', 'box-shadow'].map(prop => getComputedStyle(button).getPropertyValue(prop));
  const preview = read(); const css = emitCSS(result.edits); instance.revert();
  const style = document.createElement('style'); style.textContent = css; document.head.append(style); cleanup.push(() => style.remove());
  expect(read()).toEqual(preview);
});

test('existing rule is mutated across repeated edits and full computed styles restore for 50 elements', () => {
  const root = fixture('#override-fixture{--brand:red}.restore-target{color:var(--brand)}', Array.from({ length: 50 }, (_, i) => `<span class="restore-target">${i}</span>`).join(''));
  const read = () => [...root.children].map(el => { const style = getComputedStyle(el); return [...style].map(prop => [prop, style.getPropertyValue(prop)]); });
  const baseline = read(); const instance = engine(); instance.apply([edit()]);
  const sheet = document.adoptedStyleSheets.at(-1)!; const rule = sheet.cssRules[0];
  for (let i = 0; i < 20; i++) instance.apply([edit({ to: `rgb(${i} 2 3)` })]);
  expect(sheet.cssRules[0]).toBe(rule); expect(sheet.cssRules.length).toBe(1);
  instance.revert(); expect(read()).toEqual(baseline);
});

test('cascade escalates visibly and does not mutate inline important declarations', () => {
  const root = fixture('#override-fixture {--brand:red!important}'); const instance = engine();
  const result = instance.apply([edit({ rung: 'order' })]);
  expect(result.edits[0].rung).toBe('important'); expect(result.edits[0].verified).toBe(true);
  root.style.setProperty('--brand', 'green', 'important');
  const blocked = instance.apply([edit({ rung: 'order' })]);
  expect(blocked.edits[0].verified).toBe(false); expect(blocked.edits[0].exportable).toBe(false);
  expect(root.style.getPropertyValue('--brand')).toBe('green'); expect(blocked.diagnostics.some(item => item.code === 'INLINE_STYLE_CONFLICT')).toBe(true);
});

test('inactive conditions remain exportable and verify after becoming active', () => {
  const root = fixture('#override-fixture {--brand:red}.button{color:var(--brand)}'); const instance = engine();
  const inactive = edit({ ctx: { media: '(min-width: 999999px)', supports: null, container: null, layerPath: [] } });
  const saved = instance.apply([inactive]); expect(saved.edits[0].verified).toBe(false); expect(saved.edits[0].exportable).toBe(true);
  expect(emitCSS(saved.edits)).toContain('@media (min-width: 999999px)'); expect(color(root.firstElementChild!)).toBe('rgb(255, 0, 0)');
  const active = instance.apply([edit()]); expect(active.edits[0].verified).toBe(true); expect(color(root.firstElementChild!)).toBe('rgb(0, 0, 255)');
});

test('registered custom property rejects invalid syntax and preserves last valid preview', () => {
  fixture('@property --length {syntax:"<length>";inherits:true;initial-value:8px}');
  const instance = engine(); const valid = edit({ property: '--length', to: '24px' });
  expect(instance.apply([valid]).edits[0].verified).toBe(true);
  const invalid = instance.apply([{ ...valid, to: 'red' }]);
  expect(invalid.edits[0].to).toBe('24px'); expect(invalid.diagnostics[0].code).toBe('REGISTERED_SYNTAX_REJECTED');
});

test('element property values normalize and fallback sheets restore cleanly', () => {
  const root = fixture('.button {color:red}', '<button id="local-button" class="button">Buy</button>');
  const button = root.firstElementChild!; const instance = engine({ forceStyleFallback: true });
  const result = instance.apply([edit({ mode: 'element', scopeSelector: '#local-button', property: 'color', to: '#0080ff' })], button);
  expect(result.edits[0].verified).toBe(true); expect(color(button)).toBe('rgb(0, 128, 255)');
  expect(document.getElementById('tokenlens-preview')).not.toBeNull(); instance.revert();
  expect(color(button)).toBe('rgb(255, 0, 0)'); expect(document.getElementById('tokenlens-preview')).toBeNull();
});

test('watchdog recovers a removed adopted sheet without losing page sheets', async () => {
  const root = fixture('#override-fixture {--brand:red}.button{color:var(--brand)}'); const instance = engine();
  instance.apply([edit()]); const preview = document.adoptedStyleSheets.at(-1)!;
  const other = new CSSStyleSheet(); other.replaceSync('html { --page-owned: 1 }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter(sheet => sheet !== preview), other];
  cleanup.push(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== other); });
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(color(root.firstElementChild!)).toBe('rgb(0, 0, 255)'); expect(document.adoptedStyleSheets.includes(other)).toBe(true);
});

test('open shadow preview is flagged nonexportable and host token overrides export', () => {
  const root = fixture('#override-fixture{--brand:red}', '<div id="shadow-host"></div>'); const host = root.firstElementChild!;
  const shadow = host.attachShadow({ mode: 'open' }); shadow.innerHTML = '<style>button{color:var(--brand)}</style><button>Shadow</button>';
  const button = shadow.querySelector('button')!; const instance = engine();
  const inner = instance.apply([edit({ mode: 'element', scopeSelector: 'button', property: 'color', to: 'blue', treeScope: { id: 'shadow', kind: 'shadow', depth: 1, hostPath: '#shadow-host' } })], button);
  expect(color(button)).toBe('rgb(0, 0, 255)'); expect(inner.edits[0].exportable).toBe(false); instance.revert();
  const outer = instance.apply([edit({ scopeSelector: '#shadow-host', to: 'green' })], host);
  expect(color(button)).toBe('rgb(0, 128, 0)'); expect(outer.edits[0].exportable).toBe(true);
});

test('element selectors avoid unstable classes and actually match one element', () => {
  const root = fixture('', '<button class="css-abc123 button" data-testid="buy">A</button><button class="button">B</button>');
  const first = uniqueSelector(root.firstElementChild!); expect(first.selector).toBe('[data-testid="buy"]'); expect(first.matches).toBe(1); expect(first.rejectedClasses).toEqual(['css-abc123']);
});

test('export preserves rule order for overlapping equal-specificity selectors', () => {
  const root = fixture('.foo,.bar {--brand:red}.button{color:var(--brand)}', '<button class="foo bar button">Buy</button>');
  const button = root.firstElementChild!; const instance = engine();
  instance.apply([edit({ id: 'bar', scopeSelector: '.bar', to: 'blue' }), edit({ id: 'foo', scopeSelector: '.foo', to: 'green' })], button);
  // Updating an earlier rule does not silently move it after a later rule.
  const result = instance.apply([edit({ id: 'bar', scopeSelector: '.bar', to: 'purple' })], button);
  const before = color(button); const css = emitCSS(result.edits); instance.revert();
  const exported = document.createElement('style'); exported.textContent = css; document.head.append(exported); cleanup.push(() => exported.remove());
  expect(color(button)).toBe(before);
});

test('reverting a pending rAF edit prevents it from reappearing', async () => {
  const root = fixture('#override-fixture{--brand:red}.button{color:var(--brand)}'); const instance = engine();
  instance.schedule([edit()]); instance.revert();
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(instance.getEdits()).toEqual([]); expect(color(root.firstElementChild!)).toBe('rgb(255, 0, 0)');
});

test('drag transition guard is temporary and element edits maintain declaration priority', () => {
  const root = fixture('.button{color:red;transition:color 2s}'); const button = root.firstElementChild!; const instance = engine();
  instance.beginDrag(); const result = instance.apply([edit({ mode: 'element', scopeSelector: '.button', property: 'color', to: 'blue' })], button);
  expect(getComputedStyle(button).transitionProperty).toBe('none'); expect(result.edits[0].verified).toBe(true);
  instance.endDrag(); expect(getComputedStyle(button).transitionProperty).toBe('color');
});

test('export preserves shorthand and longhand declaration precedence', () => {
  const root = fixture('.button{border:1px solid red}'); const button = root.firstElementChild!; const instance = engine();
  const result = instance.apply([edit({ id: 'border', mode: 'element', scopeSelector: '.button', property: 'border', to: '3px solid blue' }), edit({ id: 'border-color', mode: 'element', scopeSelector: '.button', property: 'border-color', to: 'green' })], button);
  const before = getComputedStyle(button).border; const css = emitCSS(result.edits); instance.revert();
  const exported = document.createElement('style'); exported.textContent = css; document.head.append(exported); cleanup.push(() => exported.remove());
  expect(getComputedStyle(button).border).toBe(before);
});

test('watchdog notifies changed theme verification without emitting unchanged updates', async () => {
  const root = fixture('#override-fixture {--brand:red}'); let notifications = 0;
  const instance = engine({ onVerified: () => notifications++ });
  instance.apply([edit({ scopeSelector: '#override-fixture.dark' })]); expect(notifications).toBe(1);
  root.classList.add('dark');
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(instance.getEdits()[0].verified).toBe(true); expect(notifications).toBe(2);
  await new Promise(resolve => setTimeout(resolve, 600)); expect(notifications).toBe(2);
});
