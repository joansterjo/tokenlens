import { expect, test } from 'vitest';
import type { Edit } from '../../../src/core/model';
import { emitCSS, parseSession, serializeSession } from '../../../src/core/emit';
import { version } from '../../../package.json';
export const makeEdit = (overrides: Partial<Edit> = {}): Edit => ({ id: 'test', mode: 'token', property: '--brand', scopeSelector: ':root', ctx: { media: null, supports: null, container: null, layerPath: [] }, treeScope: { id: 'document', kind: 'document', depth: 0 }, from: 'red', to: 'blue', rung: 'doubled', verified: true, enabled: true, chainHint: [], srcHint: null, blastRadius: 1, exportable: true, ...overrides });

test('export groups edits and retains authored syntax, priority and conditions', () => {
  const first = makeEdit({ ctx: { media: '(min-width: 300px)', supports: '(display:grid)', container: null, layerPath: ['tokens'] }, to: 'oklch(.6 .2 250)' });
  const second = makeEdit({ ...first, id: 'second', property: '--space', to: '12px' });
  const css = emitCSS([second, first]);
  expect(css).toContain(` * tool: tokenlens ${version}\n`);
  expect(css).toContain('@media (min-width: 300px)'); expect(css).toContain('@supports (display:grid)');
  expect(css).not.toContain('@layer'); expect(css.match(/:root:root \{/g)).toHaveLength(1);
  expect(css).toContain('--brand: oklch(.6 .2 250);');
  expect(emitCSS([makeEdit({ rung: 'important' })])).toContain('--brand: blue !important;');
});
test('all targets omit and explain nonexportable edits; full output retains inactive scopes', () => {
  const edits = [makeEdit({ verified: false }), makeEdit({ id: 'inline', scopeSelector: '#thing', exportable: false, rung: 'inline-only' })];
  expect(emitCSS(edits)).toContain('--brand: blue;');
  expect(emitCSS(edits)).toContain('NOT EXPORTED (1)');
  expect(emitCSS(edits, { target: 'flat' })).not.toContain('--brand: blue;');
  expect(emitCSS([makeEdit({ treeScope: { id: 'shadow', kind: 'shadow', depth: 1 } })])).toContain('Shadow-root');
});
test('flat output strips conditional wrappers and annotates the lost meaning', () => {
  const css = emitCSS([makeEdit({ ctx: { media: '(prefers-color-scheme: dark)', supports: null, container: null, layerPath: [] } })], { target: 'flat' });
  expect(css).not.toContain('@media'); expect(css).toContain('FLATTENED CONDITIONS: media: (prefers-color-scheme: dark)');
});
test('CSS export is deterministic and prevents rule injection', () => {
  const a = makeEdit({ property: '--a' }); const b = makeEdit({ id: 'b', property: '--b' });
  expect(emitCSS([a, b])).toBe(emitCSS([a, b]));
  expect(emitCSS([a, b]).indexOf('--a:')).toBeLessThan(emitCSS([a, b]).indexOf('--b:'));
  const css = emitCSS([makeEdit({ to: 'red; } body { display:none' })], { url: 'https://test/ */ bad' });
  expect(css).toContain('Invalid CSS value'); expect(css).not.toContain('url: https://test/ */');
});
test('sessions preserve edits but reverify when imported and reject malformed CSS', () => {
  const parsed = parseSession(serializeSession([makeEdit()], { url: 'https://test', generatedAt: '2026-09-22' }));
  expect(parsed.edits[0]).toEqual({ ...makeEdit(), verified: false });
  expect(() => parseSession(serializeSession([makeEdit({ to: 'blue; color:red' })]))).toThrow('Invalid CSS value');
  expect(() => parseSession('{"version":2,"url":"","edits":[]}')).toThrow('Unsupported');
});
