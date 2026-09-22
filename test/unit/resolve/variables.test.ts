import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { allVarNames, parseVarRefs, resolveValue } from '../../../src/core/resolve/variables';
import type { TokenName } from '../../../src/core/model';
const lookup = (values: Record<string, string>) => (name: TokenName) => Object.hasOwn(values, name) ? { name, value: values[name] } : null;
describe('CSS custom property substitution', () => {
  test('H1 preserves provenance and resolves nested aliases', () => {
    const result = resolveValue('1px solid var(--button)', lookup({ '--button': 'var(--brand)', '--brand': '#f00' }));
    expect(result.value).toBe('1px solid #f00');
    expect(result.chains[0].rawValue).toBe('var(--brand)');
    expect(result.chains[0].children[0].name).toBe('--brand');
  });
  test('H2 explicitly empty differs from missing and accepts empty fallback', () => {
    expect(resolveValue('x var(--empty, wrong) y', lookup({ '--empty': '' })).value).toBe('x  y');
    expect(resolveValue('var(--missing,)', lookup({})).value).toBe('');
    expect(resolveValue('var(--missing)', lookup({})).value).toBeNull();
  });
  test('H3 cycle becomes IACVT and the consumer fallback recovers', () => {
    const result = resolveValue('var(--a, red)', lookup({ '--a': 'var(--b)', '--b': 'var(--a)' }));
    expect(result.value).toBe('red');
    expect(result.refs[0].usedFallback).toBe(true);
    expect(result.chains[0].status).toBe('cycle');
    expect(result.diagnostics.some(d => d.code === 'CYCLE_DETECTED')).toBe(true);
  });
  test('H3 unused fallback dependencies still create CSS dependency cycles', () => {
    const result = resolveValue('var(--a, red)', lookup({ '--a': 'var(--good, var(--a))', '--good': 'green' }));
    expect(result.value).toBe('red');
    expect(result.chains[0].status).toBe('cycle');
  });
  test('short circuits a fallback that has no role in the variable dependency graph', () => {
    const result = resolveValue('var(--good, var(--missing))', lookup({ '--good': 'green' }));
    expect(result.value).toBe('green');
    expect(result.diagnostics).toEqual([]);
  });
  test('H13 shadow list fallback commas are preserved', () => {
    const value = 'var(--shadow, 0 1px rgb(0, 0, 0), 0 2px blue)';
    expect(resolveValue(value, lookup({})).value).toBe('0 1px rgb(0, 0, 0), 0 2px blue');
  });
  test('H17 names are case sensitive and escaped names are decoded', () => {
    expect(resolveValue('var(--A) var(--a)', lookup({ '--A': '1', '--a': '2' })).value).toBe('1 2');
    expect(parseVarRefs('var(--br\\61nd)')[0].name).toBe('--brand');
  });
  test('H18 expansion budget terminates long and exponential alias chains', () => {
    const values: Record<string, string> = { '--a80': 'red' };
    for (let n = 0; n < 80; n++) values[`--a${n}`] = `var(--a${n + 1}) var(--a${n + 1})`;
    expect(resolveValue('var(--a0)', lookup(values)).diagnostics.some(d => d.code === 'BUDGET_EXCEEDED')).toBe(true);
  });
  test('ignores var text in strings and comments and preserves occurrence offsets', () => {
    const value = '"var(--quoted)" /* var(--comment) */ var(--actual, "a,b")';
    const refs = parseVarRefs(value);
    expect(refs).toHaveLength(1);
    expect(value.slice(refs[0].startOffset, refs[0].endOffset)).toBe(refs[0].raw);
    expect(allVarNames('var(--a, var(--b))')).toEqual(['--a', '--b']);
  });
  test('random alias graphs always terminate and every reachable simple cycle is flagged', () => {
    fc.assert(fc.property(fc.array(fc.nat({ max: 20 }), { minLength: 1, maxLength: 20 }), edges => {
      const values = Object.fromEntries(edges.map((edge, i) => [`--t${i}`, `var(--t${edge % edges.length})`]));
      const result = resolveValue('var(--t0)', lookup(values));
      expect(result.value).toBeNull();
      expect(result.diagnostics.some(d => d.code === 'CYCLE_DETECTED')).toBe(true);
    }), { numRuns: 150 });
  });
});
