import { expect, test } from 'vitest';
import { compareCascade, loserReason } from '../../../src/core/resolve/cascade';
import { specificity, splitSelectorList } from '../../../src/core/resolve/specificity';
import type { CascadeSource } from '../../../src/core/model';
const source = (patch: Partial<CascadeSource> = {}): CascadeSource => ({ id: 's', sheet: null, origin: 'author', important: false, layerPath: [], layerOrder: 0, contextDepth: 0, selectorText: '.a', matchedSelector: '.a', specificity: { a: 0, b: 1, c: 0 }, documentOrder: 0, ruleIndexPath: [], conditions: [], pseudoElement: null, ...patch });
test('H4 normal layers follow order, important reverses layers including unlayered', () => {
  const early = source({ layerPath: ['early'], layerOrder: 0 });
  const late = source({ layerPath: ['late'], layerOrder: 1 });
  expect(compareCascade(late, early)).toBeGreaterThan(0);
  expect(compareCascade(source(), late)).toBeGreaterThan(0);
  expect(compareCascade({ ...early, important: true }, { ...late, important: true })).toBeGreaterThan(0);
  expect(compareCascade({ ...early, important: true }, source({ important: true }))).toBeGreaterThan(0);
  expect(loserReason(late, early)).toBe('layer');
});
test('H5 outer context wins normal, inner context wins important, before inline', () => {
  expect(compareCascade(source(), source({ contextDepth: 1, origin: 'inline' }))).toBeGreaterThan(0);
  expect(compareCascade(source({ contextDepth: 1, important: true }), source({ important: true, origin: 'inline' }))).toBeGreaterThan(0);
});
test('inline importance and origins follow the cascade', () => {
  expect(compareCascade(source({ origin: 'inline' }), source({ specificity: { a: 100, b: 0, c: 0 } }))).toBeGreaterThan(0);
  expect(compareCascade(source({ important: true }), source({ origin: 'inline' }))).toBeGreaterThan(0);
  expect(compareCascade(source({ origin: 'user', important: true }), source({ origin: 'inline', important: true }))).toBeGreaterThan(0);
  expect(compareCascade(source({ origin: 'transition' }), source({ origin: 'user-agent', important: true }))).toBeGreaterThan(0);
});
test('specificity counts Level 4 selector functions per matching branch', () => {
  expect(specificity(':where(#id).card:is(.foo, #bar):not(a)')).toEqual({ a: 1, b: 1, c: 1 });
  expect(specificity('ul > li:nth-child(2n of .active, #focus)::before')).toEqual({ a: 1, b: 1, c: 3 });
  expect(specificity('div:has(> #child, .other)')).toEqual({ a: 1, b: 0, c: 1 });
  expect(specificity('svg|a[href="x,y"]')).toEqual({ a: 0, b: 1, c: 1 });
  expect(splitSelectorList('a:is(.x,.y), [data-x=","]')).toEqual(['a:is(.x,.y)', '[data-x=","]']);
});
