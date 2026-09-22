import type { AliasChainNode, ChainStatus, ConditionCtx, Declaration, Diagnostic, ElementRef, PropertyRegistration, TokenName, TokenRef } from '../model';
import { splitTopLevel } from './specificity';

export interface TokenDefinition {
  name: TokenName;
  value: string;
  declaration?: Declaration | null;
  declaredOn?: ElementRef | null;
  scopeSelector?: string | null;
  scopeCtx?: ConditionCtx | null;
  registration?: PropertyRegistration | null;
  computedValue?: string | null;
  /** Typed registration value at the declaring element, normalized by the browser. */
  resolvedValue?: string;
}
export type TokenLookup = (name: TokenName, context?: TokenDefinition) => TokenDefinition | null;
export interface Resolution {
  value: string | null;
  status: ChainStatus;
  refs: TokenRef[];
  chains: AliasChainNode[];
  diagnostics: Diagnostic[];
}

/** CSS escapes in names are decoded without changing case. */
export function unescapeIdentifier(value: string): string {
  return value.replace(/\\([\da-fA-F]{1,6})\s?|\\([^\r\n\f])/g, (_all, hex: string | undefined, char: string | undefined) => {
    const code = hex ? parseInt(hex, 16) : 0;
    return hex ? String.fromCodePoint(code === 0 || code > 0x10ffff ? 0xfffd : code) : char ?? '';
  });
}

/** Top-level var occurrences, preserving offsets and nested fallback text verbatim. */
export function parseVarRefs(text: string): TokenRef[] {
  const refs: TokenRef[] = [];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue;
    }
    if (text.slice(i, i + 4).toLowerCase() !== 'var(' || (i > 0 && /[\w-]/.test(text[i - 1]))) continue;
    let depth = 1, end = i + 4, innerQuote = '';
    for (; end < text.length; end++) {
      const inner = text[end];
      if (inner === '\\') { end++; continue; }
      if (innerQuote) { if (inner === innerQuote) innerQuote = ''; continue; }
      if (inner === '"' || inner === "'") { innerQuote = inner; continue; }
      if (inner === '/' && text[end + 1] === '*') {
        const close = text.indexOf('*/', end + 2); if (close < 0) { end = text.length; break; } end = close + 1; continue;
      }
      if (inner === '(') depth++;
      if (inner === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const body = text.slice(i + 4, end);
    const parts = splitTopLevel(body);
    const rawName = parts[0].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/^--(?:[^\s,()]|\\.)+$/.test(rawName)) { i = end; continue; }
    const name = unescapeIdentifier(rawName) as TokenName;
    // Locate the first top-level comma without losing subsequent commas in the fallback.
    let comma = -1, nesting = 0, q = '';
    for (let p = 0; p < body.length; p++) {
      const c = body[p];
      if (!q && c === '/' && body[p + 1] === '*') { const close = body.indexOf('*/', p + 2); if (close < 0) break; p = close + 1; continue; }
      if (c === '\\') { p++; continue; }
      if (q) { if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') nesting++;
      else if (c === ')' || c === ']') nesting--;
      else if (c === ',' && nesting === 0) { comma = p; break; }
    }
    refs.push({ name, raw: text.slice(i, end + 1), startOffset: i, endOffset: end + 1,
      fallbackText: comma < 0 ? null : body.slice(comma + 1).trim(), usedFallback: false, resolvedTo: null });
    i = end;
  }
  return refs;
}

export function allVarNames(text: string): TokenName[] {
  const names = new Set<TokenName>();
  const pending = [text];
  for (let i = 0; i < pending.length && i < 500; i++) {
    for (const ref of parseVarRefs(pending[i])) {
      names.add(ref.name);
      if (ref.fallbackText !== null) pending.push(ref.fallbackText);
    }
  }
  return [...names];
}

/** Bounded substitution with dependency cycles, including dependencies in unused fallbacks. */
export function resolveValue(text: string, lookup: TokenLookup, options: { maxDepth?: number; maxNodes?: number } = {}): Resolution {
  const maxDepth = options.maxDepth ?? 50, maxNodes = options.maxNodes ?? 500;
  const diagnostics: Diagnostic[] = [];
  const cyclic = new Set<string>(), inspected = new Set<string>();
  let nodes = 0, graphNodes = 0;
  const key = (definition: TokenDefinition): string => `${definition.name}@${definition.declaredOn?.id ?? definition.declaration?.id ?? ''}`;
  function visit(name: TokenName, context: TokenDefinition | undefined, stack: string[]): void {
    if (++graphNodes > maxNodes || stack.length > maxDepth) return;
    const definition = lookup(name, context);
    if (!definition) return;
    const id = key(definition), at = stack.indexOf(id);
    if (at >= 0) { for (const node of stack.slice(at)) cyclic.add(node); return; }
    if (inspected.has(id)) return;
    for (const child of allVarNames(definition.value)) visit(child, definition, [...stack, id]);
    inspected.add(id);
  }
  for (const name of allVarNames(text)) visit(name, undefined, []);

  function expand(value: string, context: TokenDefinition | undefined, depth: number, stack: string[]): Omit<Resolution, 'diagnostics'> {
    const refs = parseVarRefs(value), chains: AliasChainNode[] = [];
    let result = '', offset = 0, status: ChainStatus = 'resolved', invalid = false;
    for (const ref of refs) {
      const definition = lookup(ref.name, context);
      const node: AliasChainNode = {
        name: ref.name, depth, declaration: definition?.declaration ?? null,
        declaredOn: definition?.declaredOn ?? null, scopeSelector: definition?.scopeSelector ?? null,
        scopeCtx: definition?.scopeCtx ?? null, rawValue: definition?.value ?? null,
        refs: [], registration: definition?.registration ?? null,
        computedValue: definition?.computedValue ?? null, terminalValue: null,
        status: 'resolved', children: [],
      };
      nodes++;
      if (depth >= maxDepth || nodes > maxNodes) {
        node.status = 'depth-exceeded';
        diagnostics.push({ code: 'BUDGET_EXCEEDED', severity: 'warn', token: ref.name, message: `Alias expansion stopped at ${maxDepth} levels or ${maxNodes} nodes.` });
      } else if (!definition || definition.value.trim() === 'initial') {
        node.status = 'missing';
        diagnostics.push({ code: 'TOKEN_UNDEFINED', severity: 'info', token: ref.name, message: `${ref.name} has no usable definition in this scope.` });
      } else if (cyclic.has(key(definition)) || stack.includes(key(definition))) {
        node.status = 'cycle';
        diagnostics.push({ code: 'CYCLE_DETECTED', severity: 'warn', token: ref.name, message: `${ref.name} participates in a custom-property cycle. Its value is invalid; a consumer may use its fallback.` });
      } else {
        const nested = expand(definition.value, definition, depth + 1, [...stack, key(definition)]);
        node.refs = nested.refs; node.children = nested.chains; node.terminalValue = nested.value;
        node.status = nested.value === null ? 'invalid-at-computed-value-time' : nested.status;
      }
      if (definition?.registration && definition.resolvedValue !== undefined && node.status !== 'depth-exceeded') node.terminalValue = definition.resolvedValue;
      if (node.terminalValue === null && ref.fallbackText !== null && node.status !== 'depth-exceeded') {
        const fallback = expand(ref.fallbackText, context, depth + 1, stack);
        ref.usedFallback = true; ref.resolvedTo = fallback.value;
        node.children.push(...fallback.chains);
        if (node.status === 'missing') node.status = 'fallback';
        if (fallback.value === null) invalid = true;
        else status = 'fallback';
      } else {
        ref.resolvedTo = node.terminalValue;
        if (ref.resolvedTo === null) invalid = true;
      }
      result += value.slice(offset, ref.startOffset) + (ref.resolvedTo ?? '');
      offset = ref.endOffset; chains.push(node);
    }
    result += value.slice(offset);
    return { value: invalid ? null : result, status: invalid ? 'invalid-at-computed-value-time' : status, refs, chains };
  }
  const result = expand(text, undefined, 0, []);
  return { ...result, diagnostics };
}
