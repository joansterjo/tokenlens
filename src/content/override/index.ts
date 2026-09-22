import type { Diagnostic, Edit, PropertyRegistration } from '../../core/model';
import { validateEdit, wrapConditions } from '../../core/emit';
import { selectorForEdit } from '../../core/selector';
export { uniqueSelector } from './selector';

type StyleRoot = Document | ShadowRoot;
interface SheetState { root: StyleRoot; sheet: CSSStyleSheet; fallback: HTMLStyleElement | null; rules: Map<string, CSSStyleRule> }
interface Entry { edit: Edit; state: SheetState; rule: CSSStyleRule; target: Element | null; pseudo: string | null }
export interface OverrideResult { edits: Edit[]; diagnostics: Diagnostic[] }
export interface OverrideOptions {
  onVerified?: (edits: Edit[], diagnostics: Diagnostic[]) => void;
  registrations?: PropertyRegistration[];
  document?: Document;
  forceStyleFallback?: boolean;
}
function ruleInside(rule: CSSRule): CSSStyleRule {
  if (rule.type === CSSRule.STYLE_RULE) return rule as CSSStyleRule;
  const children = (rule as CSSGroupingRule).cssRules;
  if (!children?.length) throw new Error('The preview rule was rejected by the browser');
  return ruleInside(children[0]);
}
function normalize(value: string): string { return value.trim().replace(/\s+/g, ' '); }
function syntaxAccepted(syntax: string, value: string, view: Window): boolean {
  const css = (view as Window & typeof globalThis).CSS;
  if (syntax === '*' || /^(initial|inherit|unset|revert|revert-layer)$/.test(value) || /\bvar\(/.test(value)) return true;
  if (syntax.includes('|')) return syntax.split('|').some(part => syntaxAccepted(part.trim(), value, view));
  if (syntax.endsWith('#')) return value.split(',').every(part => syntaxAccepted(syntax.slice(0, -1), part.trim(), view));
  if (syntax.endsWith('+')) return true; // Multi-component grammar needs a parser; computed verification remains required.
  switch (syntax) {
    case '<color>': return css.supports('color', value);
    case '<length>': return !/%/.test(value) && css.supports('width', value) && !/^(auto|min-content|max-content|fit-content|stretch)$/.test(value);
    case '<length-percentage>': return css.supports('width', value) && !/^(auto|min-content|max-content|fit-content|stretch)$/.test(value);
    case '<percentage>': return /^[+-]?(?:\d*\.)?\d+%$/.test(value) || /^calc\(/.test(value);
    case '<number>': return /^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?$/i.test(value) || /^calc\(/.test(value);
    case '<integer>': return /^[+-]?\d+$/.test(value) || /^calc\(/.test(value);
    case '<angle>': return /^[+-]?(?:\d*\.)?\d+(deg|grad|rad|turn)$/.test(value) || /^calc\(/.test(value);
    case '<time>': return css.supports('animation-duration', value);
    case '<transform-function>': case '<transform-list>': return css.supports('transform', value);
    default: return syntax.startsWith('<') ? true : value === syntax;
  }
}

/** Author-origin preview only. The engine never edits a page-owned rule or inline style. */
export class OverrideEngine {
  private readonly options: OverrideOptions;
  private readonly doc: Document;
  private entries = new Map<string, Entry>();
  private sheets = new Map<StyleRoot, SheetState>();
  private diagnostics: Diagnostic[] = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, Edit>();
  private pendingSelected: Element | undefined;
  private frame: number | null = null;
  private registrations: PropertyRegistration[];
  private registrationCache = new Map<string, PropertyRegistration | null>();
  private disposed = false;
  private dragging = false;
  private lastNotified = '';
  constructor(options: OverrideOptions = {}) {
    this.options = options; this.doc = options.document ?? document; this.registrations = options.registrations ?? [];
  }
  setRegistrations(registrations: PropertyRegistration[]): void { this.registrations = registrations; this.registrationCache.clear(); }
  getEdits(): Edit[] {
    // CSS rule order is part of the cascade. Preserve it in the export/session IR.
    const ordered: Edit[] = [];
    for (const state of this.sheets.values()) for (const rule of state.rules.values()) for (const entry of this.entries.values()) if (entry.state === state && entry.rule === rule) ordered.push(structuredClone(entry.edit));
    return ordered;
  }
  apply(edits: Edit[], selected?: Element): OverrideResult {
    if (this.disposed) return { edits: [], diagnostics: [] };
    this.diagnostics = [];
    for (const input of edits) this.applyOne(structuredClone(input), selected);
    this.manageWatchdog();
    const result = { edits: this.getEdits(), diagnostics: [...this.diagnostics] };
    const signature = JSON.stringify(result);
    if (signature !== this.lastNotified) { this.lastNotified = signature; this.options.onVerified?.(result.edits, result.diagnostics); }
    return result;
  }
  /** Optional coalescing path: one declaration write per edit per frame. */
  schedule(edits: Edit[], selected?: Element): void {
    if (this.disposed) return;
    for (const edit of edits) this.pending.set(edit.id, edit);
    this.pendingSelected = selected ?? this.pendingSelected;
    if (this.frame === null) this.frame = this.doc.defaultView!.requestAnimationFrame(() => {
      this.frame = null; const updates = [...this.pending.values()]; this.pending.clear();
      this.apply(updates, this.pendingSelected); this.pendingSelected = undefined;
    });
  }
  beginDrag(): void { this.dragging = true; for (const entry of this.entries.values()) entry.rule.style.setProperty('transition', 'none', 'important'); }
  endDrag(): void {
    this.dragging = false;
    for (const entry of this.entries.values()) {
      const transition = [...this.entries.values()].find(other => other.rule === entry.rule && other.edit.property === 'transition' && other.edit.enabled);
      if (transition) entry.rule.style.setProperty('transition', transition.edit.to, transition.edit.rung === 'important' ? 'important' : '');
      else entry.rule.style.removeProperty('transition');
    }
  }
  revert(ids?: string[]): void {
    if (!ids) {
      this.pending.clear(); this.pendingSelected = undefined;
      if (this.frame !== null) this.doc.defaultView?.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    for (const id of ids ?? [...this.entries.keys()]) {
      this.pending.delete(id); const entry = this.entries.get(id); if (!entry) continue;
      this.entries.delete(id); this.clearProperty(entry);
    }
    if (!this.entries.size) this.removeSheets();
    this.manageWatchdog();
  }
  destroy(): void {
    this.disposed = true;
    if (this.frame !== null) this.doc.defaultView?.cancelAnimationFrame(this.frame);
    this.frame = null; this.pending.clear(); this.revert();
  }
  private diagnostic(edit: Edit, code: Diagnostic['code'], message: string, severity: Diagnostic['severity'] = 'warn'): void {
    this.diagnostics.push({ code, severity, message, editId: edit.id, property: edit.property });
  }
  private applyOne(edit: Edit, selected?: Element): void {
    const previous = this.entries.get(edit.id);
    const invalid = validateEdit(edit);
    const view = this.doc.defaultView as Window & typeof globalThis;
    if (invalid || (!edit.property.startsWith('--') && !view.CSS.supports(edit.property, edit.to))) {
      this.diagnostic(edit, 'REGISTERED_SYNTAX_REJECTED', invalid ?? `The browser rejects ${edit.to} for ${edit.property}.`, 'error'); return;
    }
    const registration = this.registration(edit.property);
    if (registration && !syntaxAccepted(registration.syntax, edit.to.trim(), view)) {
      this.diagnostic(edit, 'REGISTERED_SYNTAX_REJECTED', `${edit.property} requires ${registration.syntax}; the existing preview was preserved.`, 'error'); return;
    }
    let root: StyleRoot = this.doc;
    if (edit.treeScope.kind === 'shadow') {
      const host = edit.treeScope.hostPath ? this.doc.querySelector(edit.treeScope.hostPath) : null;
      const selectedRoot = selected?.getRootNode();
      const shadow = host?.shadowRoot ?? (selectedRoot instanceof ShadowRoot ? selectedRoot : null);
      if (!shadow) { this.diagnostic(edit, 'CLOSED_SHADOW_ROOT', 'This shadow root is unavailable. Change an inherited token on its host instead.'); return; }
      root = shadow; edit.exportable = false;
    }
    let state: SheetState;
    try { state = this.sheetFor(root); } catch (error) { this.diagnostic(edit, 'OVERRIDE_LOST_CASCADE', String(error), 'error'); return; }
    const pseudo = edit.scopeSelector.match(/(::[\w-]+(?:\([^)]*\))?)$/)?.[0] ?? null;
    const baseSelector = pseudo ? edit.scopeSelector.slice(0, -pseudo.length) : edit.scopeSelector;
    let targets: Element[];
    try { targets = baseSelector === ':host' && root instanceof ShadowRoot ? [root.host] : [...root.querySelectorAll(baseSelector)]; }
    catch { this.diagnostic(edit, 'OVERRIDE_LOST_CASCADE', 'The browser cannot match this scope selector.', 'error'); return; }
    const target = selected?.isConnected && targets.includes(selected) ? selected : targets[0] ?? null;
    const inactive = (edit.ctx.media && !view.matchMedia(edit.ctx.media).matches) || (edit.ctx.supports && !view.CSS.supports(edit.ctx.supports));
    if (edit.rung === 'inline-only') { edit.rung = 'important'; edit.exportable = false; }
    const sameRule = previous && previous.state === state && previous.edit.property === edit.property && previous.edit.rung === edit.rung && previous.edit.scopeSelector === edit.scopeSelector && JSON.stringify(previous.edit.ctx) === JSON.stringify(edit.ctx);
    if (previous) { this.entries.delete(edit.id); if (!sameRule || !edit.enabled) this.clearProperty(previous); }
    const setRule = (): Entry => {
      const selector = selectorForEdit(edit); const key = JSON.stringify([edit.id, selector, edit.ctx.media, edit.ctx.supports, edit.ctx.container]);
      let rule = state.rules.get(key);
      if (!rule) {
        const index = state.sheet.insertRule(wrapConditions(`${selector} {}`, edit.ctx), state.sheet.cssRules.length);
        rule = ruleInside(state.sheet.cssRules[index]); state.rules.set(key, rule);
      }
      if (edit.enabled) rule.style.setProperty(edit.property, edit.to || (edit.property.startsWith('--') ? ' ' : ''), edit.rung === 'important' ? 'important' : '');
      if (this.dragging) rule.style.setProperty('transition', 'none', 'important');
      return { edit, state, rule, target, pseudo };
    };
    let entry: Entry;
    try { entry = setRule(); } catch (error) {
      // Rejected selectors/conditions must not erase an already valid edit.
      if (previous) { this.entries.set(previous.edit.id, previous); previous.rule.style.setProperty(previous.edit.property, previous.edit.to, previous.edit.rung === 'important' ? 'important' : ''); }
      this.diagnostic(edit, 'OVERRIDE_LOST_CASCADE', `Preview rule rejected: ${String(error)}`, 'error'); return;
    }
    // A declaring root is not the number of token consumers. Keep unknown counts honest.
    if (edit.mode === 'element') edit.blastRadius ??= targets.length;
    edit.verified = false;
    if (!edit.enabled || inactive || !target?.isConnected) {
      this.entries.set(edit.id, entry);
      if (inactive) this.diagnostic(edit, 'OVERRIDE_LOST_CASCADE', 'Saved for an inactive media or support condition; it will be checked when that condition becomes active.', 'info');
      else if (!target) this.diagnostic(edit, 'OVERRIDE_LOST_CASCADE', 'No element currently matches this scope. The rule is retained for future matches.', 'info');
      return;
    }
    const expected = this.expectedValue(edit, target, pseudo, registration);
    for (;;) {
      const actual = target.ownerDocument.defaultView!.getComputedStyle(target, pseudo).getPropertyValue(edit.property);
      edit.verified = expected !== null && normalize(actual) === normalize(expected);
      if (edit.verified || expected === null || edit.ctx.container || edit.rung === 'important') break;
      entry.rule.style.removeProperty(edit.property);
      edit.rung = edit.rung === 'order' ? 'doubled' : 'important'; entry = setRule();
    }
    if (!edit.verified) {
      if (edit.ctx.container) this.diagnostic(edit, 'CONTAINER_QUERY_UNEVALUATED', 'This container query could not be verified; no priority escalation was attempted.');
      else if (expected === null) this.diagnostic(edit, 'PROBE_MISMATCH', 'This context-dependent value needs visual verification; the preview priority was preserved.');
      else {
        const inline = target instanceof HTMLElement || target instanceof SVGElement ? target.style.getPropertyPriority(edit.property) === 'important' : false;
        edit.exportable = false;
        this.diagnostic(edit, inline ? 'INLINE_STYLE_CONFLICT' : 'OVERRIDE_LOST_CASCADE', inline ? 'The page has an inline !important declaration. Author CSS cannot override it; the page inline style was preserved.' : 'The author override still loses the cascade. It is excluded from export until it can be verified.');
      }
    } else if (edit.treeScope.kind !== 'shadow') edit.exportable = true;
    if (edit.treeScope.kind === 'shadow') this.diagnostic(edit, 'CLOSED_SHADOW_ROOT', 'Preview only: a pasted document stylesheet cannot target this shadow-root rule. Override an inherited token on the host to export it.', 'info');
    this.entries.set(edit.id, entry);
  }
  private expectedValue(edit: Edit, target: Element, pseudo: string | null, registration?: PropertyRegistration): string | null {
    if (edit.property.startsWith('--') && !registration && !/\bvar\(|\b(?:initial|inherit|unset|revert|revert-layer)\b/.test(edit.to)) return edit.to;
    // Relative layout and CSS-wide keyword semantics cannot be inferred from a detached style probe.
    if (!edit.property.startsWith('--') && /%|\b(?:inherit|unset|revert|revert-layer|auto|currentColor)\b/i.test(edit.to)) return null;
    const owner = target.ownerDocument; const probe = owner.createElement('tokenlens-probe');
    probe.setAttribute('aria-hidden', 'true');
    const computed = owner.defaultView!.getComputedStyle(target, pseudo);
    probe.style.cssText = 'all:initial!important;position:fixed!important;visibility:hidden!important;pointer-events:none!important;contain:strict!important;inset:0 auto auto 0!important;';
    for (const property of ['font-size', 'font-family', 'font-weight', 'line-height', 'color']) probe.style.setProperty(property, computed.getPropertyValue(property), 'important');
    // Custom properties inherit from the target, including aliases used by the candidate value.
    try {
      target.appendChild(probe); probe.style.setProperty(edit.property, edit.to, 'important');
      return owner.defaultView!.getComputedStyle(probe).getPropertyValue(edit.property);
    } catch { return null; } finally { probe.remove(); }
  }
  private registration(property: string): PropertyRegistration | undefined {
    const known = this.registrations.find(item => item.name === property); if (known) return known;
    if (this.registrationCache.has(property)) return this.registrationCache.get(property) ?? undefined;
    if (!property.startsWith('--')) return undefined;
    const walk = (rules: CSSRuleList): PropertyRegistration | undefined => {
      for (const rule of Array.from(rules)) {
        if ('name' in rule && 'syntax' in rule && (rule as CSSPropertyRule).name === property) {
          const typed = rule as CSSPropertyRule; return { name: property as `--${string}`, syntax: typed.syntax, inherits: typed.inherits, initialValue: typed.initialValue, via: 'at-property' };
        }
        if ('cssRules' in rule) { const found = walk((rule as CSSGroupingRule).cssRules); if (found) return found; }
      }
      return undefined;
    };
    for (const sheet of [...this.doc.styleSheets, ...this.doc.adoptedStyleSheets]) { try { const found = walk(sheet.cssRules); if (found) { this.registrationCache.set(property, found); return found; } } catch { /* Cross-origin restrictions are reported by the capture engine. */ } }
    this.registrationCache.set(property, null); return undefined;
  }
  private sheetFor(root: StyleRoot): SheetState {
    const existing = this.sheets.get(root); if (existing) return existing;
    let sheet: CSSStyleSheet; let fallback: HTMLStyleElement | null = null;
    try {
      if (this.options.forceStyleFallback) throw new Error('Fallback requested');
      sheet = new (this.doc.defaultView as Window & typeof globalThis).CSSStyleSheet();
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      fallback = this.doc.createElement('style'); fallback.id = 'tokenlens-preview';
      (root instanceof Document ? root.head ?? root.documentElement : root).append(fallback);
      if (!fallback.sheet) { fallback.remove(); throw new Error('The page blocked the preview stylesheet.'); }
      sheet = fallback.sheet;
    }
    Object.defineProperty(sheet, '__tokenlensPreview', { value: true, configurable: true });
    const state = { root, sheet, fallback, rules: new Map<string, CSSStyleRule>() }; this.sheets.set(root, state); return state;
  }
  private clearProperty(entry: Entry): void {
    const remaining = [...this.entries.values()].reverse().find(other => other.rule === entry.rule && other.edit.property === entry.edit.property && other.edit.enabled);
    if (remaining) entry.rule.style.setProperty(remaining.edit.property, remaining.edit.to, remaining.edit.rung === 'important' ? 'important' : '');
    else entry.rule.style.removeProperty(entry.edit.property);
  }
  private manageWatchdog(): void {
    if (this.entries.size && !this.watchdog) this.watchdog = setInterval(() => this.recover(), 500);
    else if (!this.entries.size && this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }
  private recover(): void {
    for (const { root, sheet, fallback } of this.sheets.values()) {
      if (fallback) { if (!fallback.isConnected) (root instanceof Document ? root.head ?? root.documentElement : root).append(fallback); }
      else if (root.adoptedStyleSheets.at(-1) !== sheet) { try { root.adoptedStyleSheets = [...root.adoptedStyleSheets.filter(item => item !== sheet), sheet]; } catch { /* Next explicit edit reports the failed preview. */ } }
    }
    // Theme/media changes and stylesheet fights are verified only while edits exist.
    if (this.entries.size) this.apply(this.getEdits());
  }
  private removeSheets(): void {
    for (const { root, sheet, fallback } of this.sheets.values()) {
      if (fallback) fallback.remove();
      else { try { root.adoptedStyleSheets = root.adoptedStyleSheets.filter(item => item !== sheet); } catch { /* Root may have been detached. */ } }
    }
    this.sheets.clear();
  }
}
