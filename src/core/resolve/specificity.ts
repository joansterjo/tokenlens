import type { Specificity } from '../model';
import { compareSpecificity } from './cascade';

/** Split only outside strings, brackets and function calls. Used for selectors and shadows. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '*') { i = Math.max(i, text.indexOf('*/', i + 2) + 1); continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === separator && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

export const splitSelectorList = (text: string): string[] => splitTopLevel(text);
const add = (a: Specificity, b: Specificity): void => { a.a += b.a; a.b += b.b; a.c += b.c; };
export const maxSpecificity = (selectors: string[]): Specificity => selectors.map(specificity)
  .sort(compareSpecificity).at(-1) ?? { a: 0, b: 0, c: 0 };

function identifierEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      const escape = text.slice(i + 1).match(/^[\da-fA-F]{1,6}\s?/);
      i += escape ? escape[0].length + 1 : 2;
    } else if (/[\w\u0080-\uffff-]/.test(text[i])) i++;
    else break;
  }
  return i;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0, quote = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if ((ch === ')' || ch === ']') && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Selectors Level 4 specificity, one selector branch at a time. */
export function specificity(selector: string): Specificity {
  const result = { a: 0, b: 0, c: 0 };
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '#') { result.a++; i = identifierEnd(selector, i + 1); }
    else if (ch === '.') { result.b++; i = identifierEnd(selector, i + 1); }
    else if (ch === '[') { result.b++; i = balancedEnd(selector, i) + 1; }
    else if (ch === ':') {
      const double = selector[i + 1] === ':';
      const start = i + (double ? 2 : 1);
      const end = identifierEnd(selector, start);
      const name = selector.slice(start, end).toLowerCase();
      const legacyElement = ['before', 'after', 'first-line', 'first-letter'].includes(name);
      if (double || legacyElement) result.c++;
      else if (!['where', 'is', 'not', 'has'].includes(name)) result.b++;
      i = end;
      if (selector[i] === '(') {
        const close = balancedEnd(selector, i);
        const body = selector.slice(i + 1, close);
        if (['is', 'not', 'has', 'host', 'host-context', 'slotted'].includes(name)) add(result, maxSpecificity(splitSelectorList(body)));
        if (name === 'nth-child' || name === 'nth-last-child') {
          const of = body.match(/\s+of\s+([\s\S]+)$/i);
          if (of) add(result, maxSpecificity(splitSelectorList(of[1])));
        }
        i = close + 1;
      }
    } else if (/[a-zA-Z_\u0080-\uffff\\-]/.test(ch)) {
      const end = identifierEnd(selector, i);
      if (selector[end] === '|' && selector[end + 1] !== '|') { i = end + 1; continue; }
      result.c++; i = end;
    } else i++;
  }
  return result;
}
