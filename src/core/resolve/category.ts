import type { TokenCategory } from '../model';

export function inferCategory(name: string, value = ''): TokenCategory {
  if (/(?:shadow|elevation)/i.test(name)) return 'shadow';
  if (/(?:gradient)/i.test(name) || /gradient\(/i.test(value)) return 'gradient';
  if (/(?:color|colour|background|foreground|fill|stroke|tint|brand|accent|primary|secondary|surface)/i.test(name)
    || /^(?:#[\da-f]{3,8}\b|(?:rgb|hsl|hwb|oklch|oklab|lab|lch|color)\()/i.test(value.trim())) return 'color';
  if (/(?:font|line-height|letter-spacing|text|typography|tracking|leading)/i.test(name)) return 'typography';
  if (/radius|rounded/i.test(name)) return 'radius';
  if (/border|outline|ring/i.test(name)) return 'border';
  if (/spacing|space|padding|margin|gap|inset/i.test(name)) return 'space';
  if (/width|height|size|dimension/i.test(name)) return 'size';
  if (/opacity|alpha/i.test(name)) return 'opacity';
  if (/z-index|zIndex/i.test(name)) return 'z-index';
  if (/duration|ease|transition|animation|motion|delay/i.test(name)) return 'motion';
  if (/filter|blur/i.test(name)) return 'filter';
  return 'other';
}
