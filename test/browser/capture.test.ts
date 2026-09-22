import { describe, expect, test } from 'vitest';
import golden from '../snapshots/golden-summary.json';
import { captureElement, captureStyleSheets, invalidateCapture, recoverStyleSheet } from '../../src/adapters/capture-live';
async function withPage(html: string, run: (doc: Document) => void | Promise<void>): Promise<void> {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1000px;height:700px;position:absolute;left:-10000px';
  document.body.append(frame);
  await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.srcdoc = html; });
  try { await run(frame.contentDocument!); } finally { frame.remove(); }
}
const wrap = (css: string, markup = '<button id="target">Token button</button>'): string => `<style>${css}</style>${markup}`;
describe('live browser capture', () => {
  test('H1/H12 aliases, pending shorthands and computed values retain provenance', async () => withPage(wrap(':root{--brand:#f00;--action:var(--brand);--pad:8px}.x{color:blue}#target{background:var(--action);padding:var(--pad);color:white}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--action'].rawValue).toBe('var(--brand)');
    expect(report.tokensInScope['--action'].computedValue).toBe('#f00');
    expect(report.properties.find(p => p.property === 'background-color')?.computedValue).toBe('rgb(255, 0, 0)');
    expect(report.properties.find(p => p.property === 'padding-left')?.chains[0].name).toBe('--pad');
    expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
    expect(JSON.parse(JSON.stringify(report)).schemaVersion).toBe(1);
  }));
  test('H3 IACVT uses unset, does not resurrect a losing declaration', async () => withPage(wrap(':root{--a:var(--b);--b:var(--a)}#target{color:blue;color:var(--a)}body{color:rgb(10,20,30)}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.properties.find(p => p.property === 'color')?.computedValue).toBe('rgb(10, 20, 30)');
    expect(report.diagnostics.some(d => d.code === 'CYCLE_DETECTED')).toBe(true);
  }));
  test('H4 important layers invert, normal unlayered rules win', async () => withPage(wrap('@layer a,b;@layer a{#target{--x:red!important;--y:red}}@layer b{#target{--x:blue!important;--y:blue}}#target{--x:green!important;--y:green}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--x'].rawValue).toBe('red');
    expect(report.tokensInScope['--y'].rawValue).toBe('green');
    expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
  }));
  test('inherited custom properties resolve aliases at the declaring ancestor', async () => withPage(wrap(':root{--base:red;--alias:var(--base)}#target{--base:blue;color:var(--alias)}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--alias'].terminalValue).toBe('red');
    expect(report.properties.find(p => p.property === 'color')?.computedValue).toBe('rgb(255, 0, 0)');
    expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
  }));
  test('H9/H10 non-inheriting registration uses initial and typed values avoid string mismatch', async () => withPage(wrap('@property --size{syntax:"<length>";inherits:false;initial-value:8px}@property --ink{syntax:"<color>";inherits:true;initial-value:red}:root{--size:40px}#target{padding:var(--size);color:var(--ink)}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--size'].rawValue).toBe('8px');
    expect(report.tokensInScope['--size'].computedValue).toBe('8px');
    expect(report.tokensInScope['--ink'].computedValue).toBe('rgb(255, 0, 0)');
    expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
  }));
  test('H15 unknown scope/container conditions are diagnosed and not asserted as winners', async () => withPage(wrap('#target{--x:red}@container (width > 100px){#target{--x:blue}}@scope(body){#target{--y:green}}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.diagnostics.some(d => d.code === 'CONTAINER_QUERY_UNEVALUATED')).toBe(true);
    expect(report.diagnostics.some(d => d.code === 'SCOPE_UNEVALUATED')).toBe(true);
    expect(report.confidence).toBe('degraded');
  }));
  test('H17 custom names remain case sensitive', async () => withPage(wrap('#target{--A:red;--a:blue;color:var(--A);background:var(--a)}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--A'].computedValue).toBe('red');
    expect(report.tokensInScope['--a'].computedValue).toBe('blue');
  }));
  test('H20 adopted sheet identity and rule count invalidates the index', async () => withPage(wrap('#target{--a:red}'), doc => {
    const target = doc.querySelector('#target')!;
    const sheet = new (doc.defaultView as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet();
    sheet.replaceSync('#target{--a:blue}'); doc.adoptedStyleSheets = [sheet];
    expect(captureElement(target).tokensInScope['--a'].computedValue).toBe('blue');
    sheet.insertRule('#target{--a:green}', 1);
    expect(captureElement(target).tokensInScope['--a'].rawValue).toBe('green');
    doc.adoptedStyleSheets = [];
    expect(captureElement(target).tokensInScope['--a'].computedValue).toBe('red');
    invalidateCapture(doc); expect(captureStyleSheets(doc).length).toBe(1);
  }));
  test('H5 shadow host context order is outer-normal and inner-important', async () => withPage(wrap('x-card{--normal:red;--important:red!important}', '<x-card id="target"></x-card>'), doc => {
    const host = doc.querySelector('#target')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host{--normal:blue;--important:blue!important}button{color:var(--normal)}</style><button>Shadow</button>';
    const report = captureElement(host);
    expect(report.tokensInScope['--normal'].rawValue).toBe('red');
    expect(report.tokensInScope['--important'].rawValue).toBe('blue');
    const child = captureElement(shadow.querySelector('button')!);
    expect(child.tokensInScope['--normal'].computedValue).toBe('red');
    expect(child.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
  }));
  test('H20 catches nested rule insertion and same-count selector changes immediately', async () => withPage(wrap('@media all{.other{--x:red}}#target{--x:blue}'), doc => {
    const target = doc.querySelector('#target')!;
    captureElement(target);
    const group = doc.styleSheets[0].cssRules[0] as CSSMediaRule;
    group.insertRule('#target{--x:green!important}', 1);
    expect(captureElement(target).tokensInScope['--x'].rawValue).toBe('green');
    (group.cssRules[1] as CSSStyleRule).selectorText = '.other';
    expect(captureElement(target).tokensInScope['--x'].rawValue).toBe('blue');
  }));
  test('preview sheets retain their override origin and original declarations', async () => withPage(wrap('#target{--x:red}'), doc => {
    const sheet = new (doc.defaultView as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet();
    Object.defineProperty(sheet, '__tokenlensPreview', { value: true });
    sheet.replaceSync('#target{--x:blue}'); doc.adoptedStyleSheets = [sheet];
    const report = captureElement(doc.querySelector('#target')!);
    const declaration = report.declarations[report.tokensInScope['--x'].winningDeclarationId!];
    expect(report.sources[declaration.sourceId].origin).toBe('override');
    expect(report.sources[declaration.sourceId].sheet?.kind).toBe('injected');
    expect(report.tokensInScope['--x'].declarations.length).toBe(2);
  }));
  test('H9/H10 registered syntax rejection is explicit', async () => withPage(wrap('@property --size{syntax:"<length>";inherits:false;initial-value:8px}#target{--size:red;padding:var(--size)}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--size'].computedValue).toBe('8px');
    expect(report.diagnostics.some(d => d.code === 'REGISTERED_SYNTAX_REJECTED')).toBe(true);
  }));
  test('H6/H7 recovered sheet provenance is marked best-effort and never applied', async () => withPage(wrap('#target{--foreign:#f90;color:var(--foreign)}'), doc => {
    const target = doc.querySelector('#target')!, sheet = doc.styleSheets[0];
    const url = 'https://foreign.example/tokens.css';
    Object.defineProperty(sheet, 'href', { get: () => url });
    Object.defineProperty(sheet, 'cssRules', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
    expect(captureElement(target).diagnostics.some(d => d.code === 'CROSS_ORIGIN_SHEET_UNREADABLE')).toBe(true);
    expect(recoverStyleSheet(url, '#target{--foreign:#f90;color:var(--foreign)}', doc)).toBe(true);
    const report = captureElement(target);
    expect(report.sheets[0].readable).toBe(false);
    expect(report.sheets[0].reparsed).toBe(true);
    expect(report.tokensInScope['--foreign'].rawValue).toBe('#f90');
    expect(report.confidence).toBe('probable');
    expect(doc.adoptedStyleSheets).toHaveLength(0);
  }));
  test('H8 recovery refuses to silently discard import subtrees', async () => withPage(wrap('#target{--foreign:#f90}'), doc => {
    const sheet = doc.styleSheets[0], url = 'https://foreign.example/imported.css';
    Object.defineProperty(sheet, 'href', { get: () => url });
    Object.defineProperty(sheet, 'cssRules', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
    expect(recoverStyleSheet(url, '@import "theme.css"; #target{--foreign:#f90}', doc)).toBe(false);
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.sheets[0].reparsed).toBe(false);
    expect(report.diagnostics.some(d => d.code === 'SHEET_REPARSE_FAILED')).toBe(true);
  }));
  test('H10 aliases consume a registered token after typed computation', async () => withPage(wrap('@property --ink{syntax:"<color>";inherits:true;initial-value:teal}:root{--alias:var(--ink)}#target{color:var(--alias)}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.tokensInScope['--alias'].terminalValue).toBe('rgb(0, 128, 128)');
    expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
  }));
  test('attribute selector spaces cannot cause a false-negative candidate bucket', async () => withPage(wrap('[data-label="a b"]{--chosen:green}', '<div id="target" data-label="a b"></div>'), doc => {
    expect(captureElement(doc.querySelector('#target')!).tokensInScope['--chosen'].rawValue).toBe('green');
  }));
  test('large inventories prioritize the selected element’s direct tokens and aliases', async () => withPage(wrap(`:root{${Array.from({ length: 620 }, (_, i) => `--unused-${i}: ${i}px`).join(';')};--actual-color:var(--actual-base);--actual-base:red}#target{color:var(--actual-color)}`), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(Object.keys(report.tokensInScope)).toHaveLength(500);
    expect(report.tokensInScope['--actual-color'].rawValue).toBe('var(--actual-base)');
    expect(report.tokensInScope['--actual-base'].computedValue).toBe('red');
    expect(report.diagnostics.some(d => d.code === 'BUDGET_EXCEEDED')).toBe(true);
  }));
  test('macOS legacy system font canonicalization is not a false provenance mismatch', async () => withPage(wrap('#target{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'), doc => {
    const report = captureElement(doc.querySelector('#target')!);
    expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH' && d.property === 'font-family')).toEqual([]);
  }));
  for (const fixture of ['01-basic', '02-shorthands', '03-broken', '04-layers', '05-tailwind-v4', '06-hostile', '07-heavy', '08-shadow', '09-cross-origin', '10-case-and-escapes', '11-registered', '12-frames', '13-design-system']) {
    test(`captures fixture ${fixture} into a JSON-compliant report`, async () => {
      const html = await (await fetch(`/test/fixtures/${fixture}.html`)).text();
      await withPage(html, doc => {
        const report = captureElement(doc.querySelector('#primary')!);
        expect(report.schemaVersion).toBe(1);
        expect(report.element.tagName).toBe('button');
        expect(report.properties.length).toBeGreaterThan(30);
        expect(() => JSON.stringify(report)).not.toThrow();
        const expected = (golden as Record<string, { properties: Record<string, { computed: string }> }>)[fixture];
        for (const name of ['color', 'background-color', 'padding-top', 'box-shadow', 'border-top-color']) {
          if (expected.properties[name]) expect(report.properties.find(property => property.property === name)?.computedValue).toBe(expected.properties[name].computed);
        }
        if (/^(01|02|04|05|10)/.test(fixture)) expect(report.diagnostics.filter(d => d.code === 'PROBE_MISMATCH')).toEqual([]);
        if (fixture.startsWith('03')) expect(report.diagnostics.some(d => d.code === 'CYCLE_DETECTED')).toBe(true);
        if (fixture.startsWith('07')) {
          const warm = Array.from({ length: 5 }, () => captureElement(doc.querySelector('#primary')!).timings);
          console.log('RESOLVER_PERF', JSON.stringify({ cold: report.timings, warm }));
          expect(report.timings.indexMs).toBeLessThan(400);
          expect(Math.max(...warm.map(timing => timing.totalMs))).toBeLessThan(150);
        }
        if (fixture.startsWith('11')) expect(report.diagnostics.some(d => d.code === 'JS_REGISTERED_PROPERTY')).toBe(true);
      });
    });
  }
});
