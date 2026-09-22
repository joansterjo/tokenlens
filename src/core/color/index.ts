import {
  parse, converter, useMode, modeRgb, modeHsl, modeHwb, modeOklab, modeOklch,
  modeP3, modeLab, modeLab65, modeLch, modeLrgb, modeXyz50, modeXyz65, modeRec2020,
  modeA98, modeProphoto, formatHex, formatHex8, formatCss, toGamut,
  inGamut, differenceEuclidean, differenceCiede2000, wcagContrast,
} from 'culori/fn';
import type { Color, Oklch } from 'culori/fn';
import type { ColorValue, ResolvedToken } from '../model';

[modeRgb, modeHsl, modeHwb, modeOklab, modeOklch, modeP3, modeLab, modeLch,
  modeLrgb, modeXyz50, modeXyz65, modeRec2020, modeA98, modeProphoto].forEach(useMode);
const oklch = converter('oklch');
const within = inGamut('rgb');
const difference = /* @__PURE__ */ differenceEuclidean('oklab');
let difference00: ReturnType<typeof differenceCiede2000> | null = null;
const mapToRgb = toGamut('rgb', 'oklch');
const round = (n: number, digits = 4) => Number(n.toFixed(digits));
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));

function syntaxOf(text: string): ColorValue['syntax'] {
  const s = text.trim().toLowerCase();
  if (s.startsWith('#')) return `hex${s.length - 1}` as ColorValue['syntax'];
  if (/^rgba?\(/.test(s)) return s.includes(',') ? 'rgb-legacy' : 'rgb-modern';
  if (/^hsla?\(/.test(s)) return s.includes(',') ? 'hsl-legacy' : 'hsl-modern';
  const name = /^(hwb|lab|lch|oklab|oklch|color)\(/.exec(s)?.[1];
  if (name) return name === 'color' ? 'color-fn' : name as ColorValue['syntax'];
  return /^[a-z]+$/.test(s) ? 'named' : 'opaque';
}

/** Unsupported context-dependent syntax is never guessed. Supply the browser's readback as computed. */
export function parseColor(authored: string, computed?: string): ColorValue | null {
  const parsed = parse(authored);
  const color = parsed ?? (computed ? parse(computed) : undefined);
  if (!color) return null;
  const working = oklch(color);
  const syntax = parsed ? syntaxOf(authored) : 'opaque';
  const text = authored.trim();
  const alphaWasWritten = /\/|rgba\(|hsla\(/i.test(text) || /^#[\da-f]{4}$|^#[\da-f]{8}$/i.test(text);
  const space = /color\(\s*(srgb|display-p3|rec2020|xyz-d50|xyz-d65)/i.exec(text)?.[1] as ColorValue['space'];
  return {
    authored, syntax, ...(space ? { space } : {}),
    oklch: [working.l, working.c, working.h ?? 0], alpha: working.alpha ?? 1,
    alphaWasWritten, hueUnit: /deg/.test(text) ? 'deg' : 'none',
    lightnessUnit: /%/.test(text) ? 'percent' : 'number',
    outOfSrgbGamut: !within(color), engineResolved: !parsed,
  };
}

export function workingColor(value: ColorValue): Oklch {
  return { mode: 'oklch', l: value.oklch[0], c: value.oklch[1], h: value.oklch[2], alpha: value.alpha };
}

/** The unmodified value is emitted byte-for-byte. An explicit working value means an intentional edit. */
export function serializeColor(value: ColorValue, next?: Partial<{ l: number; c: number; h: number; alpha: number }>, format?: 'hex'|'oklch'|'rgb'|'hsl'): string {
  if (!next && !format) return value.authored;
  const color: Oklch = { ...workingColor(value), ...next };
  const alpha = color.alpha ?? 1;
  const suffix = alpha < 1 || value.alphaWasWritten ? ` / ${round(alpha)}` : '';
  const syntax = format ?? value.syntax;
  if (syntax === 'oklch' || syntax === 'opaque' || syntax === 'keyword') {
    const light = value.lightnessUnit === 'percent' ? `${round(color.l * 100)}%` : round(color.l);
    return `oklch(${light} ${round(color.c)} ${round(color.h ?? 0)}${value.hueUnit === 'deg' ? 'deg' : ''}${suffix})`;
  }
  if (syntax === 'hex' || syntax.startsWith('hex') || syntax === 'named') {
    const mapped = mapToRgb(color);
    return (alpha < 1 || value.alphaWasWritten ? formatHex8 : formatHex)(mapped)!;
  }
  if (/^(rgb|hsl)/.test(syntax)) {
    const hsl = syntax.startsWith('hsl');
    const mapped = mapToRgb(color);
    const converted = converter('hsl')(mapped);
    const channels = hsl ? [`${round(converted.h ?? 0)}${value.hueUnit === 'deg' ? 'deg' : ''}`, `${round(converted.s * 100)}%`, `${round(converted.l * 100)}%`] : [mapped.r, mapped.g, mapped.b].map(c => round(clamp(c) * 255, 3));
    const legacy = syntax.endsWith('legacy');
    return `${hsl ? 'hsl' : 'rgb'}${legacy && suffix ? 'a' : ''}(${channels.join(legacy ? ', ' : ' ')}${suffix ? legacy ? `, ${round(alpha)}` : suffix : ''})`;
  }
  const target = syntax === 'color-fn' ? ({ 'srgb': 'rgb', 'display-p3': 'p3', 'rec2020': 'rec2020', 'xyz-d50': 'xyz50', 'xyz-d65': 'xyz65' } as const)[value.space ?? 'srgb'] : syntax;
  return formatCss(converter(target as Color['mode'])(color));
}

export function toHex(value: ColorValue | string, includeAlpha = false): string {
  const color = typeof value === 'string' ? parse(value) : workingColor(value);
  if (!color) return '#000000';
  return (includeAlpha ? formatHex8 : formatHex)(mapToRgb(color))!;
}

export function gamutMap(value: ColorValue): { css: string; mapped: boolean; delta: number } {
  const original = workingColor(value);
  const mapped = mapToRgb(original);
  return { css: formatCss(mapped), mapped: !within(original), delta: difference(original, mapped) };
}

export function deltaEOK(a: ColorValue, b: ColorValue): number { return difference(workingColor(a), workingColor(b)); }
export function deltaE00(a: ColorValue, b: ColorValue): number {
  if (!difference00) { useMode(modeLab65); difference00 = differenceCiede2000(); }
  return difference00(workingColor(a), workingColor(b));
}

export function gamutBoundary(lightness: number, hue: number): number {
  let lo = 0; let hi = 0.5;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (within({ mode: 'oklch', l: lightness, c: mid, h: hue })) lo = mid; else hi = mid;
  }
  return lo;
}

/** WCAG 2 luminance contrast. Callers must composite transparent colors onto their real backdrop first. */
export function contrastRatio(a: ColorValue | string, b: ColorValue | string): number | null {
  const first = typeof a === 'string' ? parse(a) : workingColor(a);
  const second = typeof b === 'string' ? parse(b) : workingColor(b);
  return !first || !second || (first.alpha ?? 1) < 1 || (second.alpha ?? 1) < 1 ? null : wcagContrast(first, second);
}

export function palette(tokens: Record<string, ResolvedToken>): { name: string; value: string; color: ColorValue }[] {
  const seen = new Set<string>();
  return Object.values(tokens).flatMap(token => {
    const value = token.computedValue ?? token.terminalValue ?? '';
    const color = parseColor(value);
    if (!color) return [];
    const key = toHex(color, true);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name: token.name, value, color }];
  }).sort((a, b) => a.color.oklch[2] - b.color.oklch[2] || a.color.oklch[0] - b.color.oklch[0]);
}
