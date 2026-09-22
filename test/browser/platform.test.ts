import { expect, test } from 'vitest';
test('uses a real browser with cascade layers and adopted stylesheets', () => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('@layer base { :root { --tokenlens-test: 42px } }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  expect(getComputedStyle(document.documentElement).getPropertyValue('--tokenlens-test').trim()).toBe('42px');
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
});
