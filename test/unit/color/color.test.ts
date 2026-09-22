import { describe, expect, it } from 'vitest';
import { parseColor, serializeColor, deltaEOK, deltaE00, gamutMap, gamutBoundary, contrastRatio, palette } from '../../../src/core/color';
import type { ResolvedToken } from '../../../src/core/model';

describe('color syntax and authored-value fidelity', () => {
  const colors = ['#f0a', '#f0a8', '#663399', '#66339988', 'rebeccapurple', 'transparent', 'rgb(20, 40, 80)', 'rgba(20, 40, 80, 0.5)', 'rgb(20 40 80 / 60%)', 'hsl(210, 50%, 40%)', 'hsl(210deg 50% 40% / .4)', 'hwb(120 10% 20%)', 'lab(52% 20 -30)', 'lch(55% 30 240)', 'oklab(.6 .1 -.1)', 'oklch(65% .18 285 / .8)', 'color(srgb-linear .2 .4 .6)', 'color(display-p3 0.9 0.2 0.4)', 'color(rec2020 .5 .2 .4)', 'color(xyz-d50 .2 .3 .1)', 'color(xyz-d65 .2 .3 .1)', 'color(a98-rgb .7 .2 .4)', 'color(prophoto-rgb .7 .2 .4)'];
  it.each(colors)('preserves authored bytes and color for %s', authored => {
    const color = parseColor(authored);
    expect(color).not.toBeNull();
    expect(serializeColor(color!)).toBe(authored);
    expect(deltaEOK(color!, parseColor(serializeColor(color!))!)).toBeLessThan(0.001);
  });
  it('preserves alpha and authored RGB/HSL notation during edits', () => {
    expect(serializeColor(parseColor('rgba(20, 40, 80, 0.5)')!, { h: 190 })).toMatch(/^rgba\(.*, 0.5\)$/);
    expect(serializeColor(parseColor('hsl(210deg 50% 40% / .4)')!, { h: 190 })).toMatch(/^hsl\(.*deg .*% .*% \/ 0.4\)$/);
    expect(serializeColor(parseColor('oklch(65% .18 285 / .8)')!, { l: .5 })).toBe('oklch(50% 0.18 285 / 0.8)');
  });
  it('records browser resolution without replacing authored color syntax', () => {
    expect(parseColor('light-dark(red, blue)')).toBeNull();
    const color = parseColor('light-dark(red, blue)', 'rgb(255, 0, 0)')!;
    expect(color.engineResolved).toBe(true); expect(color.syntax).toBe('opaque');
    expect(serializeColor(color)).toBe('light-dark(red, blue)');
  });
  it('does not guess an unknown token or keyword', () => {
    expect(parseColor('var(--unknown)')).toBeNull();
    expect(parseColor('currentColor')).toBeNull();
    expect(parseColor('not a color')).toBeNull();
  });
});

describe('gamut and perceptual comparison', () => {
  it('maps P3 red locally into sRGB while retaining the source', () => {
    const color = parseColor('color(display-p3 1 0 0)')!;
    const mapped = gamutMap(color);
    expect(color.outOfSrgbGamut).toBe(true); expect(mapped.mapped).toBe(true);
    expect(parseColor(mapped.css)?.outOfSrgbGamut).toBe(false);
    expect(color.authored).toBe('color(display-p3 1 0 0)');
  });
  it('finds the visible chroma boundary for the current lightness and hue', () => {
    const boundary = gamutBoundary(0.6, 240);
    expect(boundary).toBeGreaterThan(0.05); expect(boundary).toBeLessThan(0.4);
    expect(parseColor(`oklch(.6 ${boundary} 240)`)?.outOfSrgbGamut).toBe(false);
    expect(parseColor(`oklch(.6 ${boundary + .002} 240)`)?.outOfSrgbGamut).toBe(true);
  });
  it('returns zero perceptual difference for identical colors', () => {
    const a = parseColor('red')!; const b = parseColor('#ff0000')!;
    expect(deltaEOK(a, b)).toBe(0); expect(deltaE00(a, b)).toBe(0);
  });
  it('calculates WCAG contrast but declines uncomposited transparent colors', () => {
    expect(contrastRatio('black', 'white')).toBe(21);
    expect(contrastRatio('white', 'white')).toBe(1);
    expect(contrastRatio('rgb(0 0 0 / .5)', 'white')).toBeNull();
    expect(contrastRatio('invalid', 'white')).toBeNull();
  });
  it('deduplicates a document palette by visible color', () => {
    const tokens = Object.fromEntries([['--a', '#ff0000'], ['--b', 'rgb(255 0 0)'], ['--c', '12px'], ['--d', 'blue']].map(([name, value]) => [name, { name, terminalValue: value }]));
    expect(palette(tokens as Record<string, ResolvedToken>)).toHaveLength(2);
  });
});
