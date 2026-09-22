import { expect, test } from 'vitest';
import { doubleSelector, escapeIdentifier, escapeAttribute, selectorCandidates, isSafeCssFragment, isHashedClass } from '../../../src/core/selector';

test('selector specificity changes retain scope and pseudo-elements', () => {
  expect(doubleSelector(':root')).toBe(':root:root');
  expect(doubleSelector('.theme-dark')).toBe('.theme-dark.theme-dark');
  expect(doubleSelector('[data-theme="dark"]')).toBe('[data-theme="dark"][data-theme="dark"]');
  expect(doubleSelector('.card > button::before')).toBe(':is(.card > button):is(.card > button)::before');
  expect(doubleSelector('.a, :is(.b,.c)')).toBe('.a.a, :is(:is(.b,.c)):is(:is(.b,.c))');
});
test('semantic selectors escape input and reject generated classes', () => {
  expect(escapeIdentifier('1:field')).toBe('\\31 \\:field');
  expect(escapeAttribute('a"b')).toBe('a\\"b');
  expect(isHashedClass('css-abc123')).toBe(true);
  const candidates = selectorCandidates({ tagName: 'button', classes: ['css-abc123', 'button'], attributes: { 'data-testid': 'buy' } });
  expect(candidates.map(item => item.selector)).toEqual(['[data-testid="buy"]', '.button', 'button']);
});
test('CSS fragment validation blocks rule injection without rejecting nested CSS values', () => {
  expect(isSafeCssFragment('var(--x, rgb(1 2 3 / .5))')).toBe(true);
  expect(isSafeCssFragment('"semi;colon"')).toBe(true);
  expect(isSafeCssFragment('red; } body { display:none')).toBe(false);
  expect(isSafeCssFragment('var(--x')).toBe(false);
  expect(isSafeCssFragment('red /* unterminated')).toBe(false);
});
