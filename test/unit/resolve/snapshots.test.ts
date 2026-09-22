import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import type { ElementTokenReport, TokenName } from '../../../src/core/model';
import { resolveValue } from '../../../src/core/resolve/variables';
import { compareCascade } from '../../../src/core/resolve/cascade';
const fixtures = ['01-basic', '02-shorthands', '03-broken', '04-layers', '05-tailwind-v4', '06-hostile', '07-heavy', '08-shadow', '09-cross-origin', '10-case-and-escapes', '11-registered', '12-frames', '13-design-system'];
const snapshot = (name: string): ElementTokenReport => JSON.parse(readFileSync(resolve('test/snapshots', `${name}.report.json`), 'utf8'));
for (const fixture of fixtures) {
  test(`real Chromium snapshot ${fixture} retains complete normalized references`, () => {
    const report = snapshot(fixture);
    for (const declaration of Object.values(report.declarations)) expect(report.sources[declaration.sourceId]).toBeDefined();
    for (const property of report.properties) if (property.winningDeclarationId) expect(report.declarations[property.winningDeclarationId]).toBeDefined();
    for (const token of Object.values(report.tokensInScope)) {
      const value = resolveValue(`var(${token.name})`, name => {
        const found = report.tokensInScope[name];
        return found?.rawValue !== null && found?.rawValue !== undefined ? { name, value: found.rawValue, declaredOn: found.declaredOn, registration: found.registration, ...(found.registration && found.computedValue ? { resolvedValue: found.computedValue } : {}) } : null;
      });
      if (token.terminalValue !== null) expect(value.value?.trim()).toBe(token.terminalValue.trim());
    }
  });
}
test('H4 golden layer cascade can be replayed entirely in Node', () => {
  const report = snapshot('04-layers');
  for (const name of Object.keys(report.tokensInScope) as TokenName[]) {
    const token = report.tokensInScope[name];
    if (!token.winningDeclarationId) continue;
    const declaredOnId = token.declaredOn?.id;
    const candidates = token.declarations.map(id => report.declarations[id]).filter(declaration => declaration.id.includes(`@${declaredOnId}`));
    candidates.sort((a, b) => compareCascade(report.sources[b.sourceId], report.sources[a.sourceId]));
    expect(candidates[0]?.id).toBe(token.winningDeclarationId);
  }
});
test('H6 unreadable cross-origin stylesheet stays visible in the golden', () => {
  const report = snapshot('09-cross-origin');
  expect(report.sheets.some(sheet => !sheet.readable)).toBe(true);
  expect(report.diagnostics.some(d => d.code === 'CROSS_ORIGIN_SHEET_UNREADABLE')).toBe(true);
  expect(report.confidence).toBe('degraded');
});
