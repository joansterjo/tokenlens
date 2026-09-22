import type {
  CascadeSource, ConditionCtx, ConditionRef, ConsumerSummary, Declaration, Diagnostic,
  ElementMeta, ElementRef, ElementTokenReport, PropertyRegistration, ResolvedProperty, ResolvedToken,
  ShorthandGroup, StyleSheetRef, TokenName, TreeScopeRef,
} from '../core/model';
import { compareCascade, compareSpecificity, loserReason } from '../core/resolve/cascade';
import { inferCategory } from '../core/resolve/category';
import { allVarNames, resolveValue, type TokenDefinition } from '../core/resolve/variables';
import { maxSpecificity, specificity, splitSelectorList, splitTopLevel } from '../core/resolve/specificity';
import type { RuleSnapshot, SheetSnapshot } from '../core/resolve/snapshot';

type Root = Document | ShadowRoot;
type Options = { documentId?: string; frameId?: number };
interface LiveRule { rule: CSSStyleRule; snapshot: RuleSnapshot; selectors: string[]; root: Root }
interface Index {
  sheets: SheetSnapshot[]; rules: LiveRule[]; registrations: PropertyRegistration[];
  diagnostics: Diagnostic[]; layers: { name: string; order: number }[];
  buckets: Map<string, Set<LiveRule>>; always: Set<LiveRule>; built: number; signature: string;
}
const indexes = new WeakMap<Root, Index>();
const recoveredSheets = new WeakMap<Document, Map<string, { sheet: CSSStyleSheet | null; error?: string }>>();
let recoveryVersion = 0;
const sheetIds = new WeakMap<CSSStyleSheet, string>();
const nodeIds = new WeakMap<Element, string>();
const ruleIds = new WeakMap<CSSRule, number>();
let nextId = 1;
const idFor = (node: Element): string => {
  let id = nodeIds.get(node); if (!id) { id = `el-${nextId++}`; nodeIds.set(node, id); } return id;
};
const STYLE_PROPERTIES = [
  'color', 'background-color', 'background-image', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'text-shadow', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-transform', 'text-decoration-color', 'text-decoration-line', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'row-gap', 'column-gap', 'width', 'height', 'min-width', 'max-width',
  'opacity', 'fill', 'stroke', 'outline-color', 'outline-width', 'filter', 'backdrop-filter', 'z-index',
  'transition-duration', 'transition-timing-function', 'animation-duration',
];
const INHERITED = /^(?:color|font(?:-.+)?|line-height|letter-spacing|word-spacing|text-(?:align|indent|transform|shadow)|visibility|cursor|fill|stroke(?:-.+)?)$/;
const SHORTHANDS: Record<string, string[]> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  border: ['top', 'right', 'bottom', 'left'].flatMap(side => ['width', 'style', 'color'].map(type => `border-${side}-${type}`)),
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat'],
  font: ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'line-height'],
  gap: ['row-gap', 'column-gap'],
  outline: ['outline-color', 'outline-style', 'outline-width'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
};

export function cssPath(element: Element): string {
  const esc = (value: string): string => element.ownerDocument.defaultView?.CSS.escape(value) ?? value.replace(/[^\w-]/g, '\\$&');
  const root = element.getRootNode() as Root;
  if (element.id) {
    const selector = `#${esc(element.id)}`;
    try { if (root.querySelectorAll(selector).length === 1) return selector; } catch { /* Fall through to structural path. */ }
  }
  for (const attr of ['data-testid', 'data-test', 'data-qa']) {
    const value = element.getAttribute(attr);
    if (value) {
      const selector = `[${attr}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
      try { if (root.querySelectorAll(selector).length === 1) return selector; } catch { /* Structural fallback. */ }
    }
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    let part = current.localName;
    if (current.id && current !== element && root.querySelectorAll(`#${esc(current.id)}`).length === 1) { part = `#${esc(current.id)}`; parts.unshift(part); break; }
    const siblings: Element[] = current.parentElement ? [...current.parentElement.children].filter(sibling => sibling.localName === current!.localName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part); current = current.parentElement;
  }
  return parts.join(' > ');
}

function treeScope(root: Root): TreeScopeRef {
  if (root.nodeType === 9) return { id: 'document', kind: 'document', depth: 0 };
  const shadow = root as ShadowRoot;
  const parent = treeScope(shadow.host.getRootNode() as Root);
  return { id: `shadow:${idFor(shadow.host)}`, kind: 'shadow', hostPath: cssPath(shadow.host), depth: parent.depth + 1 };
}
export function elementRef(element: Element, options: Options = {}): ElementRef {
  return { id: idFor(element), cssPath: cssPath(element), tagName: element.localName, treeScope: treeScope(element.getRootNode() as Root), ...options };
}
export function findElement(ref: ElementRef, root: Root = document): Element | null {
  try {
    if (ref.treeScope.kind === 'shadow') {
      const roots = [root];
      for (let i = 0; i < roots.length && i < 200; i++) {
        const scope = treeScope(roots[i]);
        if (scope.id === ref.treeScope.id) return roots[i].querySelector(ref.cssPath);
        for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
      }
      return null;
    }
    return root.querySelector(ref.cssPath);
  } catch { return null; }
}
function parentOf(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode(); return root.nodeType === 11 ? (root as ShadowRoot).host : null;
}
function sheetList(root: Root): CSSStyleSheet[] {
  return [...root.styleSheets, ...root.adoptedStyleSheets].filter(sheet => !(sheet.ownerNode as Element | null)?.id?.startsWith('tokenlens-overlay'));
}
function getSheetId(sheet: CSSStyleSheet): string {
  let id = sheetIds.get(sheet); if (!id) { id = `sheet-${nextId++}`; sheetIds.set(sheet, id); } return id;
}
function signature(sheets: CSSStyleSheet[]): string {
  let visited = 0;
  const rules = (list: CSSRuleList): string => {
    let value = `${list.length}:`;
    for (const rule of list) {
      if (++visited > 25000) break;
      let id = ruleIds.get(rule); if (!id) { id = nextId++; ruleIds.set(rule, id); }
      const nested = rule as CSSRule & { cssRules?: CSSRuleList; selectorText?: string; conditionText?: string; styleSheet?: CSSStyleSheet };
      value += `${id}/${nested.selectorText ?? nested.conditionText ?? ''};`;
      if (nested.cssRules) value += rules(nested.cssRules);
      if (nested.styleSheet) { try { value += rules(nested.styleSheet.cssRules); } catch { value += 'unreadable'; } }
    }
    return value;
  };
  return sheets.map(sheet => { try { return `${getSheetId(sheet)}:${sheet.disabled}:${sheet.media.mediaText}:${rules(sheet.cssRules)}`; } catch { return `${getSheetId(sheet)}:unreadable`; } }).join('|');
}
function conditionCtx(source: CascadeSource): ConditionCtx {
  const conditions = (type: ConditionRef['type']): string | null => source.conditions.filter(c => c.type === type).map(c => `(${c.text})`).join(' and ') || null;
  return { media: conditions('media'), supports: conditions('supports'), container: source.conditions.find(c => c.type === 'container')?.text ?? null, layerPath: source.layerPath };
}

function readDeclarations(style: CSSStyleDeclaration, source: CascadeSource): Declaration[] {
  // cssText preserves the pending-substitution shorthand which style.item/longhand reads may erase.
  const authored = splitTopLevel(style.cssText, ';').map(part => {
    const colon = part.indexOf(':');
    return colon < 0 ? null : { property: part.slice(0, colon).trim(), value: part.slice(colon + 1).replace(/\s*!important\s*$/i, '').trim(), important: /!important\s*$/i.test(part) };
  }).filter((value): value is NonNullable<typeof value> => value !== null);
  const output: Declaration[] = [];
  for (const entry of authored) {
    const declaration: Declaration = { id: `${source.id}:${entry.property}`, property: entry.property, valueText: entry.value,
      important: entry.important, sourceId: source.id, parsedOk: true, winner: false };
    output.push(declaration);
    for (const longhand of SHORTHANDS[entry.property] ?? []) {
      output.push({ ...declaration, id: `${source.id}:${longhand}`, property: longhand,
        valueText: style.getPropertyValue(longhand) || entry.value, shorthandOf: entry.property, shorthandText: entry.value });
    }
  }
  return output;
}

/** CSSOM snapshots remain plain JSON and can be replayed without a browser. */
export function captureStyleSheets(root: Root): SheetSnapshot[] { return buildIndex(root).sheets; }
export function invalidateCapture(root: Root): void { indexes.delete(root); }
/** Best-effort provenance recovery only; the parsed sheet is never adopted or applied to the page. */
export function recoverStyleSheet(url: string, text: string, ownerDocument: Document = document): boolean {
  const recovered = recoveredSheets.get(ownerDocument) ?? new Map<string, { sheet: CSSStyleSheet | null; error?: string }>();
  recoveredSheets.set(ownerDocument, recovered);
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let error: string | undefined;
  if (text.length > 3 * 1024 * 1024) error = `Recovered stylesheet ${url} exceeds the 3 MB parsing budget.`;
  else if (/@import\b|@\\/i.test(stripped)) error = `Recovered stylesheet ${url} contains @import or an escaped at-rule. Its import graph cannot be recovered faithfully, so it was not reparsed.`;
  if (error) { recovered.set(url, { sheet: null, error }); recoveryVersion++; return false; }
  try {
    const Constructor = (ownerDocument.defaultView as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet;
    const sheet = new Constructor(); sheet.replaceSync(text);
    recovered.set(url, { sheet }); recoveryVersion++; return true;
  } catch {
    recovered.set(url, { sheet: null, error: `Recovered stylesheet ${url} could not be parsed.` }); recoveryVersion++; return false;
  }
}


function buildIndex(root: Root): Index {
  const sheets = sheetList(root), sig = `${recoveryVersion}:${signature(sheets)}`, cached = indexes.get(root);
  // Direct CSSOM declaration mutations are read live below. Rebuild periodically for same-count selector replacement.
  if (cached && cached.signature === sig && performance.now() - cached.built < 500) return cached;
  const result: Index = { sheets: [], rules: [], registrations: [], diagnostics: [], layers: [], buckets: new Map(), always: new Set(), built: performance.now(), signature: sig };
  const view = root.nodeType === 9 ? (root as Document).defaultView! : (root as ShadowRoot).ownerDocument.defaultView!;
  const scope = treeScope(root), layerPositions = new Map<string, number[]>(), siblingCounts = new Map<string, number>();
  let order = 0;
  function registerLayer(path: string[]): void {
    for (let i = 0; i < path.length; i++) {
      const name = path.slice(0, i + 1).join('.'), parent = path.slice(0, i).join('.');
      if (!layerPositions.has(name)) {
        const position = siblingCounts.get(parent) ?? 0; siblingCounts.set(parent, position + 1);
        layerPositions.set(name, [...(layerPositions.get(parent) ?? []), position]);
      }
    }
  }
  const seen = new Set<CSSStyleSheet>();
  function visitSheet(sheet: CSSStyleSheet, kind: StyleSheetRef['kind'], importChain: string[], inherited: ConditionRef[] = [], layer: string[] = []): void {
    if (seen.has(sheet)) return; seen.add(sheet);
    const owner = sheet.ownerNode as Element | null;
    const preview = Boolean((sheet as CSSStyleSheet & { __tokenlensPreview?: boolean }).__tokenlensPreview) || owner?.id === 'tokenlens-preview';
    const ref: StyleSheetRef = { id: getSheetId(sheet), href: sheet.href, kind: preview ? 'injected' : kind, ownerNodePath: owner?.nodeType === 1 ? cssPath(owner) : null,
      treeScope: scope, sheetIndex: result.sheets.length, media: sheet.media.mediaText || null, disabled: sheet.disabled,
      readable: true, reparsed: false, importChain, ruleCount: null };
    const snapshot: SheetSnapshot = { sheet: ref, rules: [], registrations: [] }; result.sheets.push(snapshot);
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; ref.ruleCount = rules.length; }
    catch {
      ref.readable = false;
      const ownerDocument = root.nodeType === 9 ? root as Document : (root as ShadowRoot).ownerDocument;
      const recovered = sheet.href ? recoveredSheets.get(ownerDocument)?.get(sheet.href) : null;
      if (recovered?.sheet) {
        rules = recovered.sheet.cssRules; ref.reparsed = true; ref.ruleCount = rules.length;
        result.diagnostics.push({ code: 'CROSS_ORIGIN_SHEET_UNREADABLE', severity: 'info', sheetId: ref.id, message: `${sheet.href} was recovered by a credential-free fetch. Re-fetched CSS may differ from the version served to this page; provenance is best-effort.` });
      } else {
        result.diagnostics.push({ code: 'CROSS_ORIGIN_SHEET_UNREADABLE', severity: 'warn', sheetId: ref.id, message: `Cannot read ${sheet.href ?? 'a stylesheet'}. Computed values remain available; its declaration provenance is unavailable.` });
        if (recovered?.error) result.diagnostics.push({ code: 'SHEET_REPARSE_FAILED', severity: 'warn', sheetId: ref.id, message: recovered.error });
        return;
      }
    }
    const sheetConditions = [...inherited];
    if (ref.media) sheetConditions.push({ type: 'media', text: ref.media, matched: view.matchMedia(ref.media).matches });
    if (sheet.disabled) sheetConditions.push({ type: 'media', text: 'disabled stylesheet', matched: false });
    walk(rules, [], sheetConditions, layer, null);
    function walk(list: CSSRuleList, path: number[], conditions: ConditionRef[], layers: string[], parentSelector: string | null): void {
      for (let i = 0; i < list.length; i++) {
        if (result.rules.length >= 20000) {
          if (!result.diagnostics.some(d => d.code === 'BUDGET_EXCEEDED')) result.diagnostics.push({ code: 'BUDGET_EXCEEDED', severity: 'warn', message: 'Stylesheet indexing stopped at 20,000 style rules. The token inventory is partial.' });
          return;
        }
        const rule = list[i], rulePath = [...path, i], text = rule.cssText, prefix = text.slice(0, text.indexOf('{') < 0 ? text.length : text.indexOf('{')).trim();
        const nested = rule as CSSRule & { cssRules?: CSSRuleList; conditionText?: string; name?: string; selectorText?: string; style?: CSSStyleDeclaration; styleSheet?: CSSStyleSheet; media?: MediaList; layerName?: string; supportsText?: string; syntax?: string; inherits?: boolean; initialValue?: string };
        const sourceId = `${ref.id}:${rulePath.join('.')}`;
        if (rule.type === 3 && nested.styleSheet) {
          const nextConditions = [...conditions];
          if (nested.media?.mediaText) nextConditions.push({ type: 'media', text: nested.media.mediaText, matched: view.matchMedia(nested.media.mediaText).matches });
          if (nested.supportsText) nextConditions.push({ type: 'supports', text: nested.supportsText, matched: view.CSS.supports(nested.supportsText) });
          const nextLayer = nested.layerName ? [...layers, ...nested.layerName.split('.')] : layers;
          registerLayer(nextLayer); visitSheet(nested.styleSheet, 'import', [...importChain, ref.id], nextConditions, nextLayer); continue;
        }
        if (/^@property\s/.test(text)) {
          if (conditions.some(condition => condition.matched !== true)) continue;
          const name = (nested.name ?? prefix.replace(/^@property\s+/, '')) as TokenName;
          const registration: PropertyRegistration = { name, syntax: nested.syntax ?? '*', inherits: nested.inherits ?? true, initialValue: nested.initialValue || null, via: 'at-property', sourceId };
          result.registrations.push(registration); snapshot.registrations!.push(registration); continue;
        }
        if (/^@layer\s/.test(text) && !nested.cssRules) {
          for (const name of prefix.replace(/^@layer\s+/, '').replace(/;$/, '').split(',')) registerLayer([...layers, ...name.trim().split('.')]);
          continue;
        }
        if (nested.selectorText !== undefined && nested.style) {
          let selector = nested.selectorText;
          if (parentSelector) selector = splitSelectorList(selector).map(child => child.includes('&') ? child.replace(/&/g, `:is(${parentSelector})`) : `:is(${parentSelector}) ${child}`).join(', ');
          if (/::(?:part|slotted)\(|:host-context\(|:host(?:\([^)]*\))?\s+[>+~]?\s*[^,{]/.test(selector)) {
            result.diagnostics.push({ code: 'SCOPE_UNEVALUATED', severity: 'warn', sheetId: ref.id, message: `Shadow selector ${selector} cannot be fully traced through this CSSOM resolver. Browser computed values remain authoritative.` });
          }
          const source: CascadeSource = { id: sourceId, sheet: ref, origin: preview ? 'override' : 'author', important: false,
            layerPath: layers, layerOrder: 0, contextDepth: scope.depth, selectorText: selector, matchedSelector: null,
            specificity: maxSpecificity(splitSelectorList(selector)), documentOrder: order++, ruleIndexPath: rulePath, conditions,
            pseudoElement: null };
          const snap = { source, declarations: readDeclarations(nested.style, source) }; snapshot.rules.push(snap);
          result.rules.push({ rule: rule as CSSStyleRule, snapshot: snap, selectors: splitSelectorList(selector), root });
          if (nested.cssRules) walk(nested.cssRules, rulePath, conditions, layers, selector);
          continue;
        }
        if (nested.cssRules) {
          let nextConditions = conditions, nextLayers = layers;
          if (/^@layer\b/.test(prefix)) {
            const name = nested.name || prefix.replace(/^@layer\s*/, '') || `anonymous-${sourceId}`;
            nextLayers = [...layers, ...name.split('.')]; registerLayer(nextLayers);
            nextConditions = [...conditions, { type: 'layer', text: name, matched: true }];
          } else if (/^@media\b/.test(prefix)) {
            const condition = nested.conditionText ?? prefix.replace(/^@media\s*/, '');
            nextConditions = [...conditions, { type: 'media', text: condition, matched: view.matchMedia(condition).matches }];
          } else if (/^@supports\b/.test(prefix)) {
            const condition = nested.conditionText ?? prefix.replace(/^@supports\s*/, '');
            nextConditions = [...conditions, { type: 'supports', text: condition, matched: view.CSS.supports(condition) }];
          } else if (/^@(container|scope)\b/.test(prefix)) {
            const type = prefix.startsWith('@container') ? 'container' : 'scope';
            const condition = nested.conditionText ?? prefix.replace(/^@\w+\s*/, '');
            nextConditions = [...conditions, { type, text: condition, matched: 'unknown' }];
            result.diagnostics.push({ code: type === 'container' ? 'CONTAINER_QUERY_UNEVALUATED' : 'SCOPE_UNEVALUATED', severity: 'warn', sheetId: ref.id,
              message: `TokenLens does not yet evaluate ${prefix}. These conditional declarations are excluded from the source trace; browser-computed values remain available.` });
          } else if (/^@starting-style\b/.test(prefix)) {
            nextConditions = [...conditions, { type: 'starting-style', text: '@starting-style', matched: false }];
          } else if (/^@(?:-\w+-)?keyframes\b/.test(prefix)) continue;
          walk(nested.cssRules, rulePath, nextConditions, nextLayers, parentSelector);
        }
      }
    }
  }
  for (const sheet of sheets) visitSheet(sheet, sheet.ownerNode ? (sheet.href ? 'link' : 'style') : 'adopted', []);
  const layerNames = [...layerPositions.keys()].sort((a, b) => {
    const aa = layerPositions.get(a)!, bb = layerPositions.get(b)!;
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) { const d = (aa[i] ?? 1e6) - (bb[i] ?? 1e6); if (d) return d; } return 0;
  });
  result.layers = layerNames.map((name, index) => ({ name, order: index }));
  for (const live of result.rules) {
    live.snapshot.source.layerOrder = layerNames.indexOf(live.snapshot.source.layerPath.join('.'));
    for (const selector of live.selectors) {
      const bucket = selectorBucket(selector);
      if (!bucket) result.always.add(live);
      else { const set = result.buckets.get(bucket) ?? new Set(); set.add(live); result.buckets.set(bucket, set); }
    }
  }
  indexes.set(root, result); return result;
}

function selectorBucket(selector: string): string | null {
  // Functional / escaped selectors use the conservative bucket; never omit a possible match.
  if (/[(:\\["']/.test(selector)) return null;
  const compound = selector.trim().split(/[\s>+~]+/).at(-1) ?? '';
  const id = compound.match(/#([\w-]+)/); if (id) return `#${id[1]}`;
  const cls = compound.match(/\.([\w-]+)/); if (cls) return `.${cls[1]}`;
  const attr = compound.match(/\[([\w-]+)/); if (attr) return `[${attr[1]}`;
  const tag = compound.match(/^[a-zA-Z][\w-]*/); return tag ? tag[0].toLowerCase() : null;
}
function candidates(index: Index, element: Element): Set<LiveRule> {
  const output = new Set(index.always);
  const keys = [element.localName, `#${element.id}`, ...[...element.classList].map(cls => `.${cls}`), ...[...element.attributes].map(attr => `[${attr.name}`)];
  for (const key of keys) for (const rule of index.buckets.get(key) ?? []) output.add(rule);
  return output;
}
function matches(element: Element, selector: string, root: Root): boolean {
  try {
    if (selector.includes('::') || /:(?:before|after|first-letter|first-line)\b/.test(selector)) return false;
    if (selector.includes(':host')) {
      if (root.nodeType !== 11 || (root as ShadowRoot).host !== element) return false;
      const transformed = selector.replace(/:host\(([^()]*)\)/g, '$1').replace(/:host\b/g, '*');
      return element.matches(transformed);
    }
    if (element.getRootNode() !== root) return false;
    return element.matches(selector);
  } catch { return false; }
}

export function captureElement(element: Element, options: Options = {}): ElementTokenReport {
  if (!element || element.nodeType !== 1 || !element.isConnected) throw new Error('Choose an element that is still attached to the inspected page.');
  const started = performance.now(), doc = element.ownerDocument, view = doc.defaultView!;
  const computed = view.getComputedStyle.bind(view), targetStyle = computed(element);
  const ancestors: Element[] = [], ancestrySeen = new Set<Element>();
  let current: Element | null = element;
  while (current && ancestors.length < 100 && !ancestrySeen.has(current)) { ancestors.push(current); ancestrySeen.add(current); current = parentOf(current); }
  const roots = new Set<Root>();
  for (const ancestor of ancestors) { roots.add(ancestor.getRootNode() as Root); if (ancestor.shadowRoot) roots.add(ancestor.shadowRoot); }
  const indices = [...roots].map(buildIndex), indexMs = performance.now() - started;
  const diagnostics: Diagnostic[] = indices.flatMap(index => index.diagnostics);
  const registrations = indices.flatMap(index => index.registrations);
  const registrationMap = new Map(registrations.map(registration => [registration.name, registration]));
  const declarations: Record<string, Declaration> = Object.create(null);
  const sources: Record<string, CascadeSource> = Object.create(null);
  const local = new Map<Element, Map<string, Declaration[]>>();
  const declaredOn = new Map<string, Element>();
  const groups: ShorthandGroup[] = [];
  const ref = (node: Element): ElementRef => elementRef(node, options);
  const elementById = new Map(ancestors.map(node => [idFor(node), node]));
  for (const ancestor of ancestors) {
    const byProperty = new Map<string, Declaration[]>(); local.set(ancestor, byProperty);
    const add = (original: CascadeSource, values: Declaration[]): void => {
      for (const value of values) {
        const id = `${original.id}@${idFor(ancestor)}${value.important ? ':important' : ''}`;
        const source: CascadeSource = { ...original, id, important: value.important };
        const declaration: Declaration = { ...value, id: `${id}:${value.property}`, sourceId: id, winner: false };
        declarations[declaration.id] = declaration; sources[id] = source; declaredOn.set(declaration.id, ancestor);
        const list = byProperty.get(value.property) ?? []; list.push(declaration); byProperty.set(value.property, list);
        if (ancestor === element && value.shorthandOf && !groups.some(group => group.id === `${id}:${value.shorthandOf}`)) {
          groups.push({ id: `${id}:${value.shorthandOf}`, shorthand: value.shorthandOf, authoredText: value.shorthandText ?? null,
            longhands: SHORTHANDS[value.shorthandOf] ?? [], sourceId: id });
        }
      }
    };
    for (const index of indices) {
      for (const live of candidates(index, ancestor)) {
        if (live.snapshot.source.conditions.some(condition => condition.matched !== true)) continue;
        const matching = live.selectors.filter(selector => matches(ancestor, selector, live.root));
        if (!matching.length) continue;
        matching.sort((a, b) => compareSpecificity(specificity(b), specificity(a)));
        const source = { ...live.snapshot.source, matchedSelector: matching[0], specificity: specificity(matching[0]) };
        add(source, readDeclarations(live.rule.style, source));
      }
    }
    const inlineStyle = (ancestor as HTMLElement).style;
    if (inlineStyle?.length) {
      const source: CascadeSource = { id: `inline:${idFor(ancestor)}`, sheet: null, origin: 'inline', important: false,
        layerPath: [], layerOrder: 0, contextDepth: ref(ancestor).treeScope.depth, selectorText: cssPath(ancestor), matchedSelector: cssPath(ancestor),
        specificity: { a: 0, b: 0, c: 0 }, documentOrder: Number.MAX_SAFE_INTEGER, ruleIndexPath: [], conditions: [], pseudoElement: null };
      add(source, readDeclarations(inlineStyle, source));
    }
    for (const list of byProperty.values()) {
      list.sort((a, b) => compareCascade(sources[b.sourceId], sources[a.sourceId]));
      if (list[0]) list[0].winner = true;
      for (const item of list.slice(1)) item.loserReason = loserReason(sources[list[0].sourceId], sources[item.sourceId]);
    }
  }
  const matchMs = performance.now() - started - indexMs;
  function ownWinner(node: Element, property: string): Declaration | null {
    const values = local.get(node)?.get(property) ?? [];
    const excludedLayers = new Set<string>();
    for (const value of values) {
      const source = sources[value.sourceId], layer = source.layerPath.join('.');
      if (excludedLayers.has(layer)) continue;
      if (value.valueText.trim().toLowerCase() === 'revert') return null;
      if (value.valueText.trim().toLowerCase() === 'revert-layer') { excludedLayers.add(layer); continue; }
      return value;
    }
    return null;
  }
  const computedByNode = new Map<Element, CSSStyleDeclaration>([[element, targetStyle]]);
  function registeredValue(node: Element, name: TokenName): string {
    let style = computedByNode.get(node); if (!style) { style = computed(node); computedByNode.set(node, style); }
    return style.getPropertyValue(name).trim();
  }
  function lookup(name: TokenName, context?: TokenDefinition): TokenDefinition | null {
    const registration = registrationMap.get(name) ?? null;
    const startNode = context?.declaredOn ? elementById.get(context.declaredOn.id) ?? element : element;
    const start = Math.max(0, ancestors.indexOf(startNode));
    for (let i = start; i < ancestors.length; i++) {
      const node = ancestors[i], declaration = ownWinner(node, name);
      if (declaration) {
        const keyword = declaration.valueText.trim().toLowerCase();
        if (keyword === 'inherit' || (keyword === 'unset' && registration?.inherits !== false)) continue;
        if (keyword !== 'initial' && keyword !== 'unset') {
          const source = sources[declaration.sourceId];
          return { name, value: declaration.valueText, declaration, declaredOn: ref(node), scopeSelector: source.matchedSelector,
            scopeCtx: conditionCtx(source), registration, computedValue: targetStyle.getPropertyValue(name).trim() || null,
            ...(registration ? { resolvedValue: registeredValue(node, name) } : {}) };
        }
        break;
      }
      if (registration?.inherits === false) break;
    }
    if (registration?.initialValue !== null && registration?.initialValue !== undefined) {
      return { name, value: registration.initialValue, registration, declaredOn: ref(startNode), computedValue: targetStyle.getPropertyValue(name).trim() || null, resolvedValue: registeredValue(startNode, name) };
    }
    return null;
  }
  let animations: Animation[] = [];
  try { animations = element.getAnimations().filter(animation => animation.playState === 'running'); } catch { /* Unavailable on unusual XML elements. */ }
  if (animations.length) diagnostics.push({ code: 'ANIMATION_ACTIVE', severity: 'info', message: `${animations.length} active animation(s) can change computed values between reads.` });
  if (element.localName.includes('-') && !element.shadowRoot) diagnostics.push({ code: 'CLOSED_SHADOW_ROOT', severity: 'info', message: 'This custom element has no accessible shadow root. Closed internals, if present, cannot be inspected; host tokens remain editable.' });
  if (['input', 'textarea', 'select', 'video', 'audio'].includes(element.localName)) diagnostics.push({ code: 'CLOSED_SHADOW_ROOT', severity: 'info', message: 'Browser-managed internal controls cannot be enumerated. This report describes the host element.' });
  if (element.localName === 'iframe') {
    try { if (!(element as HTMLIFrameElement).contentDocument) diagnostics.push({ code: 'CROSS_ORIGIN_FRAME', severity: 'warn', message: 'Iframe boundary: select the element from within its own frame to inspect its token scope.' }); } catch { diagnostics.push({ code: 'CROSS_ORIGIN_FRAME', severity: 'warn', message: 'Cross-origin iframe contents are inaccessible from this document.' }); }
  }
  const tokenNames = new Set<TokenName>();
  for (const property of Array.from(targetStyle)) if (property.startsWith('--')) tokenNames.add(property as TokenName);
  for (const declaration of Object.values(declarations)) {
    if (declaration.property.startsWith('--')) tokenNames.add(declaration.property as TokenName);
    for (const name of allVarNames(declaration.valueText)) tokenNames.add(name);
  }
  const properties: ResolvedProperty[] = [];
  const propertyNames = new Set(STYLE_PROPERTIES);
  for (const property of local.get(element)?.keys() ?? []) if (!property.startsWith('--') && !SHORTHANDS[property]) propertyNames.add(property);
  for (const property of propertyNames) {
    let winner: Declaration | null = null;
    for (const node of ancestors) {
      winner = ownWinner(node, property);
      if (winner && !['inherit', 'unset'].includes(winner.valueText)) break;
      if (winner?.valueText === 'unset' && !INHERITED.test(property)) break;
      if (!INHERITED.test(property) && winner?.valueText !== 'inherit') break;
      winner = null;
    }
    const value = targetStyle.getPropertyValue(property).trim();
    if (!value && !winner) continue;
    const winnerElement = winner ? declaredOn.get(winner.id) ?? element : element;
    const contextLookup = (name: TokenName, context?: TokenDefinition): TokenDefinition | null => lookup(name, context ?? { name, value: '', declaredOn: ref(winnerElement) });
    const resolved = resolveValue(winner?.valueText ?? '', contextLookup);
    diagnostics.push(...resolved.diagnostics);
    const list = winner ? local.get(winnerElement)?.get(property) ?? [] : [];
    if (winner && resolved.value === null) {
      winner.loserReason = 'iacvt';
      // Computed value is the browser's unset result. Never promote the runner-up declaration.
    }
    if (winner && resolved.value !== null && !animations.length && !winner.shorthandOf) {
      const expected = comparableComputed(property, resolved.value, element, targetStyle);
      if (expected !== null && normalize(expected) !== normalize(value)) diagnostics.push({ code: 'PROBE_MISMATCH', severity: 'warn', property,
        message: `${property}: traced declaration predicts ${expected}, browser computes ${value}. The browser value is shown.` });
    }
    properties.push({ property, computedValue: value, winningDeclarationId: winner?.id ?? null,
      losers: list.filter(item => item.id !== winner?.id).map(item => item.id), tokenRefs: resolved.refs, chains: resolved.chains,
      category: inferCategory(property, value), hardcoded: resolved.refs.length === 0, animating: animations.length > 0,
      ...(winner?.shorthandOf ? { groupId: `${winner.sourceId}:${winner.shorthandOf}` } : {}) });
  }
  const scopeIndex = new Map<TokenName, ResolvedToken['scopes']>();
  for (const index of indices) for (const live of index.rules) {
    for (const declaration of readDeclarations(live.rule.style, live.snapshot.source)) {
      if (!declaration.property.startsWith('--')) continue;
      const name = declaration.property as TokenName, entries = scopeIndex.get(name) ?? [];
      entries.push({ selector: live.snapshot.source.selectorText ?? ':root', ctx: conditionCtx(live.snapshot.source), value: declaration.valueText });
      scopeIndex.set(name, entries);
    }
  }
  const tokensInScope: Record<TokenName, ResolvedToken> = Object.create(null);
  // A large design system must never crowd the inspected element's own tokens out of the bounded inventory.
  const preferredNames = new Set<TokenName>();
  for (const property of properties) {
    const pending = [...property.chains];
    for (let i = 0; i < pending.length && i < 500; i++) { preferredNames.add(pending[i].name); pending.push(...pending[i].children); }
  }
  const names = [...new Set([...preferredNames, ...tokenNames])];
  if (names.length > 500) diagnostics.push({ code: 'BUDGET_EXCEEDED', severity: 'warn', message: `This scope contains ${names.length} tokens. The first 500 are shown to keep selection responsive.` });
  for (const name of names.slice(0, 500)) {
    const definition = lookup(name), resolved = resolveValue(`var(${name})`, lookup), chain = resolved.chains[0];
    diagnostics.push(...resolved.diagnostics);
    const computedValue = targetStyle.getPropertyValue(name).trim();
    if (!definition && computedValue) diagnostics.push({ code: 'JS_REGISTERED_PROPERTY', severity: 'info', token: name,
      message: `${name} has a computed value but no readable declaration. It may come from CSS.registerProperty(), an unreadable sheet or an inaccessible scope.` });
    const tokenDeclarations = ancestors.flatMap(node => local.get(node)?.get(name) ?? []);
    const scopes = scopeIndex.get(name) ?? [];
    const terminal = chain?.terminalValue ?? null;
    const registration = definition?.registration;
    if (registration && terminal !== null && definition && !definition.value.includes('var(')) {
      let rejected = false;
      const authored = definition.value;
      if (registration.syntax === '<color>') rejected = !view.CSS.supports('color', authored);
      if (registration.syntax === '<number>' && !/^[a-z-]+\(/i.test(authored)) rejected = !/^[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?$/i.test(authored.trim());
      if (registration.syntax === '<length>') rejected = !view.CSS.supports('width', authored) || /%|^(?:auto|min-content|max-content|fit-content|stretch)$/i.test(authored.trim());
      if (rejected) {
        if (chain) chain.status = 'invalid-at-computed-value-time';
        diagnostics.push({ code: 'REGISTERED_SYNTAX_REJECTED', severity: 'warn', token: name, message: `${name}: ${definition.value} does not satisfy ${registration.syntax}; the browser uses the registered fallback value ${computedValue}.` });
      }
    }
    if (definition && !definition.registration && terminal !== null && !animations.length && normalize(terminal) !== normalize(computedValue)) {
      diagnostics.push({ code: 'PROBE_MISMATCH', severity: 'warn', token: name, message: `${name}: alias expansion predicts ${terminal}, browser computes ${computedValue || '(empty)'}. The browser value is shown.` });
    }
    let category = inferCategory(name, computedValue || terminal || '');
    if (category === 'other' && view.CSS.supports('color', computedValue || terminal || '')) category = 'color';
    if (category === 'other') category = properties.find(property => property.tokenRefs.some(ref => ref.name === name))?.category ?? category;
    tokensInScope[name] = { name, category, categoryConfidence: category === 'other' ? 0.3 : 0.85, categoryAlternates: [],
      declarations: tokenDeclarations.map(declaration => declaration.id), winningDeclarationId: definition?.declaration?.id ?? null,
      declaredOn: definition?.declaredOn ?? null, scopes, registration: definition?.registration ?? registrationMap.get(name) ?? null,
      rawValue: definition?.value ?? null, computedValue, terminalValue: terminal,
      aliasesTo: allVarNames(definition?.value ?? ''), aliasedBy: [], unusedOnPage: false };
  }
  for (const token of Object.values(tokensInScope)) for (const name of token.aliasesTo) if (tokensInScope[name]) tokensInScope[name].aliasedBy.push(token.name);
  // Reverse indexing is bounded, and estimates are explicitly marked truncated.
  const consumers = countConsumers(indices, tokensInScope, options);
  for (const token of Object.values(tokensInScope)) token.usedBy = consumers.get(token.name) ?? { ruleCount: 0, elementCount: 0, sampleElements: [], properties: [], truncated: true };
  const uniqueDiagnostics = [...new Map(diagnostics.map(diagnostic => [`${diagnostic.code}:${diagnostic.token ?? ''}:${diagnostic.property ?? ''}:${diagnostic.sheetId ?? ''}:${diagnostic.message}`, diagnostic])).values()];
  const totalMs = performance.now() - started;
  // Confidence is conservative across every indexed stylesheet, not a per-token accuracy verdict.
  return { schemaVersion: 1, element: elementMetadata(element, targetStyle, options), properties, groups, declarations, sources, tokensInScope,
    sheets: indices.flatMap(index => index.sheets.map(snapshot => snapshot.sheet)), layerOrder: indices.flatMap(index => index.layers), registrations,
    diagnostics: uniqueDiagnostics, resolverMode: 'cssom', confidence: uniqueDiagnostics.some(diagnostic => diagnostic.severity === 'warn' || diagnostic.severity === 'error') ? 'degraded' : 'probable',
    timings: { totalMs, indexMs, matchMs, resolveMs: totalMs - indexMs - matchMs, sheetFetchMs: 0 } };
}
function normalize(value: string): string { return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(); }
function comparableComputed(property: string, value: string, element: Element, style: CSSStyleDeclaration): string | null {
  const view = element.ownerDocument.defaultView!;
  if (/^(?:inherit|initial|unset|revert(?:-layer)?)$/i.test(value.trim())) return null;
  if (/color|^(?:fill|stroke)$/.test(property)) {
    if (value.trim().toLowerCase() === 'currentcolor') return property === 'color' ? null : style.color;
    // Canvas normalises legacy colors without inserting a probe into the inspected page.
    if (!/^(?:#[\da-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i.test(value.trim())) return null;
    const canvas = element.ownerDocument.createElement('canvas'); const ctx = canvas.getContext('2d');
    if (!ctx || !view.CSS.supports('color', value)) return null;
    ctx.fillStyle = value;
    const canonical = ctx.fillStyle;
    if (/^#[\da-f]{6}$/i.test(canonical)) return `rgb(${parseInt(canonical.slice(1, 3), 16)}, ${parseInt(canonical.slice(3, 5), 16)}, ${parseInt(canonical.slice(5, 7), 16)})`;
    return canonical;
  }
  if (/^(?:opacity|font-weight|z-index)$/.test(property) && /^[\d.+-]+$/.test(value.trim())) return String(Number(value));
  if (/^[-+]?\d*\.?\d+px$/.test(value.trim()) && !/^(?:width|height|min-|max-)/.test(property)) return `${parseFloat(value)}px`;
  if (/^(?:font-family|font-style|text-transform)$/.test(property)) {
    const probe = element.ownerDocument.createElement('span').style; probe.setProperty(property, value);
    let serialized = probe.getPropertyValue(property);
    // Chromium's macOS style builder rewrites this legacy named family to the quoted system-ui family.
    // Other font names, including quoted generic-looking names, retain their distinction.
    if (property === 'font-family' && /Mac/.test(view.navigator.platform)) serialized = splitTopLevel(serialized).map(family =>
      family.replace(/^["']|["']$/g, '') === 'BlinkMacSystemFont' ? '"system-ui"' : family).join(', ');
    return serialized || null;
  }
  return null;
}

function countConsumers(indices: Index[], tokens: Record<TokenName, ResolvedToken>, options: Options): Map<TokenName, ConsumerSummary> {
  const started = performance.now(), summaries = new Map<TokenName, ConsumerSummary>();
  const elements = new Map<TokenName, Set<Element>>(), rules = new Map<TokenName, Set<string>>(), props = new Map<TokenName, Set<string>>();
  let tested = 0;
  const expandNames = (names: TokenName[]): Set<TokenName> => {
    const result = new Set(names), pending = [...names];
    for (let i = 0; i < pending.length && i < 500; i++) for (const name of tokens[pending[i]]?.aliasesTo ?? []) if (!result.has(name)) { result.add(name); pending.push(name); }
    return result;
  };
  outer: for (const index of indices) for (const live of index.rules) {
    if (++tested > 600 || performance.now() - started > 18) break outer;
    if (live.snapshot.source.conditions.some(condition => condition.matched !== true)) continue;
    const consumers = new Map<TokenName, Set<string>>();
    for (const declaration of readDeclarations(live.rule.style, live.snapshot.source)) {
      if (declaration.property.startsWith('--')) continue;
      for (const name of expandNames(allVarNames(declaration.valueText))) {
        if (!tokens[name]) continue;
        const set = consumers.get(name) ?? new Set<string>(); set.add(declaration.property); consumers.set(name, set);
      }
    }
    if (!consumers.size) continue;
    let nodes: Element[] = [];
    try { nodes = Array.from(live.root.querySelectorAll(live.snapshot.source.selectorText ?? '')).slice(0, 1000); } catch { continue; }
    for (const [name, properties] of consumers) {
      const seenElements = elements.get(name) ?? new Set<Element>(), seenRules = rules.get(name) ?? new Set<string>(), seenProperties = props.get(name) ?? new Set<string>();
      for (const node of nodes) { if (seenElements.size >= 1000) break; seenElements.add(node); }
      for (const property of properties) seenProperties.add(property);
      seenRules.add(live.snapshot.source.id); elements.set(name, seenElements); rules.set(name, seenRules); props.set(name, seenProperties);
    }
  }
  for (const name of Object.keys(tokens) as TokenName[]) {
    const nodes = elements.get(name) ?? new Set<Element>();
    // Selector matches can include losing declarations and omit inherited consumers. Never present this as an exact blast radius.
    summaries.set(name, { ruleCount: rules.get(name)?.size ?? 0, elementCount: nodes.size,
      sampleElements: [...nodes].slice(0, 5).map(node => elementRef(node, options)), properties: [...(props.get(name) ?? [])], truncated: true });
  }
  return summaries;
}

function elementMetadata(element: Element, style: CSSStyleDeclaration, options: Options): ElementMeta {
  const rect = element.getBoundingClientRect(), num = (property: string): number => parseFloat(style.getPropertyValue(property)) || 0;
  const leftBorder = num('border-left-width'), rightBorder = num('border-right-width'), topBorder = num('border-top-width'), bottomBorder = num('border-bottom-width');
  const leftPadding = num('padding-left'), rightPadding = num('padding-right'), topPadding = num('padding-top'), bottomPadding = num('padding-bottom');
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const padding = { x: rect.x + leftBorder, y: rect.y + topBorder, width: Math.max(0, rect.width - leftBorder - rightBorder), height: Math.max(0, rect.height - topBorder - bottomBorder) };
  const content = { x: padding.x + leftPadding, y: padding.y + topPadding, width: Math.max(0, padding.width - leftPadding - rightPadding), height: Math.max(0, padding.height - topPadding - bottomPadding) };
  const parent = parentOf(element), parentStyle = parent ? element.ownerDocument.defaultView!.getComputedStyle(parent) : null;
  const attributes = Object.fromEntries([...element.attributes].filter(attr => attr.name !== 'value' && !attr.name.startsWith('data-tokenlens')).slice(0, 40).map(attr => [attr.name, attr.value.slice(0, 200)]));
  const explicitLabel = element.getAttribute('aria-label');
  const labelIds = element.getAttribute('aria-labelledby');
  const labelledBy = labelIds?.split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ');
  const name = explicitLabel || labelledBy || element.getAttribute('alt') || element.getAttribute('title') || element.textContent?.trim().slice(0, 160) || null;
  const implicitRole: Record<string, string> = { button: 'button', a: element.hasAttribute('href') ? 'link' : '', input: 'textbox', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main', h1: 'heading', h2: 'heading', h3: 'heading' };
  const pseudos: string[] = [];
  for (const pseudo of ['::before', '::after']) {
    try { const pseudoStyle = element.ownerDocument.defaultView!.getComputedStyle(element, pseudo); if (pseudoStyle.content !== 'none' && pseudoStyle.content !== 'normal' && pseudoStyle.display !== 'none') pseudos.push(pseudo); } catch { /* Unsupported pseudo. */ }
  }
  const classList = [...element.classList];
  return {
    ref: elementRef(element, options), tagName: element.localName, id: element.id || null, classList,
    hashedClasses: classList.filter(name => /(?:^css-|__|[_-])[\da-z]{5,}(?:$|[_-])/i.test(name) && /\d/.test(name)), attributes,
    box: { content, padding, border: box, margin: { x: rect.x - num('margin-left'), y: rect.y - num('margin-top'), width: rect.width + num('margin-left') + num('margin-right'), height: rect.height + num('margin-top') + num('margin-bottom') } },
    display: style.display, position: style.position, zIndex: style.zIndex,
    isStackingContext: element === element.ownerDocument.documentElement || ['fixed', 'sticky'].includes(style.position) || (style.position !== 'static' && style.zIndex !== 'auto') || Number(style.opacity) < 1 || style.transform !== 'none' || style.filter !== 'none' || style.isolation === 'isolate',
    layoutRole: parentStyle && /flex|grid/.test(parentStyle.display) ? `${parentStyle.display} child · grow ${style.flexGrow} · align ${style.alignSelf}` : null,
    containingBlock: (element as HTMLElement).offsetParent ? elementRef((element as HTMLElement).offsetParent!, options) : parent ? elementRef(parent, options) : null,
    fontStack: splitTopLevel(style.fontFamily).map(font => font.replace(/^['"]|['"]$/g, '')),
    a11y: { role: element.getAttribute('role') || implicitRole[element.localName] || null, name,
      nameSource: explicitLabel ? 'aria-label' : labelledBy ? 'aria-labelledby' : element.hasAttribute('alt') ? 'alt' : 'text or title (approximate)', contrastRatio: null, approximate: true },
    pseudos, frameworkHints: [],
  };
}

/** Diagnostic measurement helper, intentionally separate from the frozen report contract. */
export function captureIndexMetrics(element: Element): { rules: number; candidates: number; reductionFactor: number } {
  const index = buildIndex(element.getRootNode() as Root), count = candidates(index, element).size;
  return { rules: index.rules.length, candidates: count, reductionFactor: count ? index.rules.length / count : index.rules.length };
}
