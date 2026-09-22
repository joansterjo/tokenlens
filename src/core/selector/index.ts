import type { Edit } from '../model';

/** CSS.escape's identifier algorithm, kept pure for replay and export. */
export function escapeIdentifier(value: string): string {
  return Array.from(value).map((char, index) => {
    const code = char.codePointAt(0)!;
    if (code === 0) return '\uFFFD';
    if ((code >= 1 && code <= 31) || code === 127 || (index === 0 && /[0-9]/.test(char)) || (index === 1 && /[0-9]/.test(char) && value[0] === '-')) return `\\${code.toString(16)} `;
    if (index === 0 && char === '-' && value.length === 1) return '\\-';
    return code >= 128 || /[a-zA-Z0-9_-]/.test(char) ? char : `\\${char}`;
  }).join('');
}
export function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ').replace(/\f/g, '\\c ');
}
export function isHashedClass(value: string): boolean {
  return /^(css|sc)-[\w-]+$/.test(value) || /^[a-z]+-[a-z0-9]{5,}$/i.test(value) || /__[a-zA-Z0-9_-]{5,}$/.test(value) || /_[a-zA-Z0-9]{5,}_\d+$/.test(value);
}
/** Split only at top-level commas, respecting escapes, strings and functions. */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = []; let start = 0, depth = 0, quote = '', escaped = false;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(selector.slice(start).trim()); return parts.filter(Boolean);
}
export function doubleSelector(selector: string): string {
  return splitSelectorList(selector).map(part => {
    // Pseudo-elements must remain outside :is(), as their use inside :is is invalid.
    const pseudo = part.match(/(::[\w-]+(?:\([^)]*\))?)$/)?.[0] ?? '';
    const base = pseudo ? part.slice(0, -pseudo.length).trim() : part;
    if (/^(:root|\.[\w-]+|#[\w-]+|\[[^\]]+\])$/.test(base)) return `${base}${base}${pseudo}`;
    return `:is(${base}):is(${base})${pseudo}`;
  }).join(', ');
}
export function selectorForEdit(edit: Pick<Edit, 'scopeSelector' | 'rung'>): string {
  return edit.rung === 'order' ? edit.scopeSelector : doubleSelector(edit.scopeSelector);
}
export interface SelectorDescription { tagName: string; id?: string | null; classes?: string[]; attributes?: Record<string, string> }
export function selectorCandidates(element: SelectorDescription): { selector: string; reason: string }[] {
  const candidates: { selector: string; reason: string }[] = [];
  if (element.id) candidates.push({ selector: `#${escapeIdentifier(element.id)}`, reason: 'id' });
  for (const name of ['data-testid', 'data-test', 'data-component', 'data-name', 'aria-label', 'role']) {
    const value = element.attributes?.[name];
    if (value) candidates.push({ selector: `[${name}="${escapeAttribute(value)}"]`, reason: name });
  }
  const classes = (element.classes ?? []).filter(value => !isHashedClass(value));
  if (classes.length) candidates.push({ selector: classes.slice(0, 4).map(value => `.${escapeIdentifier(value)}`).join(''), reason: 'stable classes' });
  candidates.push({ selector: escapeIdentifier(element.tagName.toLowerCase()), reason: 'tag' });
  return candidates;
}

/** Reject declaration/rule escapes while permitting quoted punctuation and CSS functions. */
export function isSafeCssFragment(value: string, kind: 'value' | 'selector' | 'condition' = 'value'): boolean {
  if (!value.trim() && kind !== 'value') return false;
  if (value.length > 100_000 || Array.from(value).some(char => { const code = char.charCodeAt(0); return code < 32 && ![9, 10, 12, 13].includes(code); })) return false;
  const stack: string[] = []; let quote = '', escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '/' && value[i + 1] === '*') { const end = value.indexOf('*/', i + 2); if (end < 0) return false; i = end + 1; continue; }
    if (char === '{' || char === '}' || char === ';') return false;
    if (char === '(' || char === '[') stack.push(char);
    if (char === ')' && stack.pop() !== '(') return false;
    if (char === ']' && stack.pop() !== '[') return false;
  }
  return !quote && !escaped && stack.length === 0;
}
export function isSafeProperty(property: string): boolean { return /^(--[^\s:;{}]+|[a-zA-Z][a-zA-Z0-9-]*)$/.test(property); }
