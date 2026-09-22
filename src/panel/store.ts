import type { Edit, ElementTokenReport, Diagnostic, ResolvedToken, ResolvedProperty, ConditionCtx, TokenCategory } from '../core/model';
import type { Transport } from '../core/ports';
import type { Envelope, MsgType } from '../transport/protocol';
export type EditScope = 'global'|'scope'|'element';
export interface Item {
  id: string; name: string; value: string; raw: string; category: TokenCategory;
  token?: ResolvedToken; property?: ResolvedProperty;
}
export interface AuditResult {
  tokens: { name: string; value: string; category: string; consumers: number; scopes: string[] }[];
  findings: { type: 'hardcoded'|'orphan'|'duplicate'|'contrast'; message: string; token?: string; selector?: string }[];
  scanned: number; total: number; truncated: boolean;
}
interface PanelState {
  report: ElementTokenReport | null; edits: Edit[]; diagnostics: Diagnostic[];
  picking: boolean; connected: boolean; undoCount: number; redoCount: number;
  audit: AuditResult | null; auditProgress: { scanned: number; total: number } | null;
}
const blankContext: ConditionCtx = { media: null, supports: null, layerPath: [], container: null };
export function buildEdits(report: ElementTokenReport, item: Item, value: string, scope: EditScope, scopeIndex = 0): Edit[] {
  const token = item.token;
  const scopes = token?.scopes.length ? token.scopes : [{ selector: token?.declaredOn?.cssPath ?? ':root', ctx: blankContext, value: item.value }];
  const targets = scope === 'element' || !token ? [{ selector: report.element.ref.cssPath, ctx: blankContext, value: item.value }] : scope === 'scope' ? [scopes[scopeIndex] ?? scopes[0]] : scopes;
  const treeScope = scope === 'element' || !token ? report.element.ref.treeScope : token.declaredOn?.treeScope ?? report.element.ref.treeScope;
  const sourceId = token?.winningDeclarationId ?? item.property?.winningDeclarationId;
  const source = sourceId ? report.sources[report.declarations[sourceId]?.sourceId] : undefined;
  return targets.map(target => ({
    id: `edit:${report.element.ref.documentId ?? 'unknown'}:${report.element.ref.frameId ?? 0}:${scope === 'element' || !token ? 'element' : 'token'}:${treeScope.id}:${target.selector}:${JSON.stringify(target.ctx)}:${item.name}`,
    mode: scope === 'element' || !token ? 'element' : 'token', property: item.name,
    scopeSelector: target.selector, ctx: target.ctx, treeScope,
    from: target.value, to: value, rung: 'doubled', verified: false, enabled: true,
    chainHint: [item.name, ...(token?.aliasedBy ?? [])], srcHint: source?.sheet?.href ?? null,
    blastRadius: scope === 'element' ? null : token?.usedBy?.truncated ? null : token?.usedBy?.elementCount ?? null,
    exportable: true,
  }));
}

export function reportItems(report: ElementTokenReport | null, view: 'used'|'all'|'values'): Item[] {
  if (!report) return [];
  if (view === 'values') return report.properties.filter(p => p.computedValue).map(property => ({ id: `prop:${property.property}`, name: property.property, value: property.computedValue, raw: property.winningDeclarationId ? report.declarations[property.winningDeclarationId]?.valueText ?? property.computedValue : property.computedValue, category: property.category, property }));
  const used = new Set<string>();
  const walk = (chain: ElementTokenReport['properties'][0]['chains'][0]) => { used.add(chain.name); chain.children.forEach(walk); };
  report.properties.forEach(p => { p.tokenRefs.forEach(ref => used.add(ref.name)); p.chains.forEach(walk); });
  return Object.values(report.tokensInScope).filter(t => view === 'all' || used.has(t.name)).map(token => ({ id: token.name, name: token.name, value: token.computedValue ?? token.terminalValue ?? token.rawValue ?? '', raw: token.rawValue ?? '', category: token.category, token }));
}

export class PanelStore {
  private state: PanelState = { report: null, edits: [], diagnostics: [], picking: false, connected: false, undoCount: 0, redoCount: 0, audit: null, auditProgress: null };
  private listeners = new Set<() => void>();
  private undoStack: Edit[][] = [];
  private redoStack: Edit[][] = [];
  private before: Edit[] | null = null;
  private pendingMutations = new Set<string>();
  private off: () => void;
  private disposed = false;
  private screenColorRequest: { resolve: (color: string | undefined) => void; reject: (error: Error) => void } | null = null;
  constructor(private transport: Transport) {
    this.off = transport.on(message => this.receive(message));
    this.send('resync', {});
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  dispose = () => { if (!this.disposed) { this.off(); this.disposed = true; } };
  private update(next: Partial<PanelState>) { this.state = { ...this.state, ...next }; this.listeners.forEach(f => f()); }
  send(type: MsgType, payload: unknown) {
    const id = crypto.randomUUID();
    if (type === 'edit:apply' || type === 'edit:revert') {
      this.pendingMutations.add(id);
      if (this.pendingMutations.size > 100) this.pendingMutations.delete(this.pendingMutations.values().next().value!);
    }
    this.transport.send({ v: 1, id, type, payload, ...(this.state.report ? { documentId: this.state.report.element.ref.documentId, frameId: this.state.report.element.ref.frameId } : {}) });
  }
  private receive(message: Envelope) {
    const payload = message.payload;
    if (message.type === 'edit:verified' || message.type === 'diag') this.pendingMutations.delete(message.id);
    if (message.type === 'report:result') {
      const report = payload as ElementTokenReport;
      const previous = this.state.report?.element.ref;
      const next = report.element.ref;
      const changedDocument = previous && (previous.documentId !== next.documentId || previous.frameId !== next.frameId);
      if (changedDocument) {
        this.undoStack = []; this.redoStack = []; this.before = null; this.pendingMutations.clear();
        this.update({ report, edits: [], diagnostics: [], undoCount: 0, redoCount: 0, audit: null, auditProgress: null, connected: true, picking: false });
        this.send('resync', {});
      } else this.update({ report, connected: true, picking: false, diagnostics: this.state.diagnostics.filter(d => d.code !== 'CONNECTION_FAILED') });
    }
    if (message.type === 'resync') {
      const state = payload as { report?: ElementTokenReport|null; edits?: Edit[] };
      this.update({ ...(state.report !== undefined ? { report: state.report } : {}), ...(state.edits && !this.before && !this.pendingMutations.size ? { edits: state.edits } : {}), connected: true, diagnostics: this.state.diagnostics.filter(d => d.code !== 'CONNECTION_FAILED') });
    }
    if (message.type === 'edit:verified') {
      const ref = this.state.report?.element.ref;
      if ((message.documentId && ref?.documentId && message.documentId !== ref.documentId) || (message.frameId !== undefined && ref?.frameId !== undefined && message.frameId !== ref.frameId)) return;
      const data = payload as { edits: Edit[]; diagnostics?: Diagnostic[] };
      const accepted = new Map(data.edits.map(e => [e.id, e]));
      this.update({ edits: this.state.edits.map(e => accepted.get(e.id)?.to === e.to && accepted.get(e.id)?.enabled === e.enabled ? accepted.get(e.id)! : e), diagnostics: data.diagnostics ?? [] });
    }
    if (message.type === 'edit:blast-radius') {
      const data = payload as { editId: string; count: number };
      this.update({ edits: this.state.edits.map(e => e.id === data.editId ? { ...e, blastRadius: data.count } : e) });
    }
    if (message.type === 'pick:stop' || message.type === 'pick:locked') this.update({ picking: false });
    if (message.type === 'nav:changed') { this.undoStack = []; this.redoStack = []; this.before = null; this.pendingMutations.clear(); this.update({ report: null, edits: [], diagnostics: [], undoCount: 0, redoCount: 0, audit: null }); }
    if (message.type === 'diag') {
      const data = payload as Diagnostic | { diagnostics: Diagnostic[] };
      this.update({ diagnostics: 'diagnostics' in data ? data.diagnostics : [data] });
    }
    if (message.type === 'audit:progress') this.update({ auditProgress: (payload as { cancelled?: boolean }).cancelled ? null : payload as PanelState['auditProgress'] });
    if (message.type === 'eyedropper:result' && this.screenColorRequest) { const result = payload as { sRGBHex?: string; error?: string }; if (result.error && !/cancel|abort/i.test(result.error)) this.screenColorRequest.reject(new Error(result.error)); else this.screenColorRequest.resolve(result.sRGBHex); this.screenColorRequest = null; }
    if (message.type === 'audit:result') this.update({ audit: payload as AuditResult, auditProgress: null });
  }
  pick = () => { const picking = !this.state.picking; this.update({ picking }); this.send(picking ? 'pick:start' : 'pick:stop', {}); };
  refresh = () => this.send('report:request', {});
  begin = () => { if (!this.before) { this.before = structuredClone(this.state.edits); this.send('edit:apply', { edits: [], transaction: 'start' }); } };
  apply = (newEdits: Edit[]) => {
    this.begin();
    const map = new Map(this.state.edits.map(e => [e.id, e]));
    const edits = newEdits.map(edit => {
      const existing = map.get(edit.id);
      const next = { ...edit, from: existing?.from ?? edit.from, rung: existing?.rung ?? edit.rung, exportable: existing?.exportable ?? edit.exportable };
      map.set(edit.id, next); return next;
    });
    this.update({ edits: [...map.values()] });
    this.send('edit:apply', { edits, transaction: 'update' });
  };
  commit = () => {
    if (!this.before) return;
    if (JSON.stringify(this.before) !== JSON.stringify(this.state.edits)) { this.undoStack.push(this.before); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
    this.before = null;
    this.update({ undoCount: this.undoStack.length, redoCount: this.redoStack.length });
    this.send('edit:apply', { edits: this.state.edits, transaction: 'commit' });
  };
  private restore(edits: Edit[]) {
    const ids = this.state.edits.filter(e => !edits.some(n => n.id === e.id)).map(e => e.id);
    if (ids.length) this.send('edit:revert', { ids });
    if (edits.length) this.send('edit:apply', { edits, transaction: 'commit' });
    this.update({ edits, diagnostics: [], undoCount: this.undoStack.length, redoCount: this.redoStack.length });
  }
  cancel = () => { if (this.before) { const edits = this.before; this.before = null; this.restore(edits); } if (this.state.picking) this.pick(); };
  undo = () => { this.commit(); const edits = this.undoStack.pop(); if (edits) { this.redoStack.push(this.state.edits); this.restore(edits); } };
  redo = () => { const edits = this.redoStack.pop(); if (edits) { this.undoStack.push(this.state.edits); this.restore(edits); } };
  revert = (id?: string | string[]) => { this.commit(); this.undoStack.push(this.state.edits); this.redoStack = []; const ids = typeof id === 'string' ? [id] : id; this.restore(ids ? this.state.edits.filter(e => !ids.includes(e.id)) : []); };
  toggle = (id: string) => { const edit = this.state.edits.find(e => e.id === id); if (edit) { this.apply([{ ...edit, enabled: !edit.enabled }]); this.commit(); } };
  import = (edits: Edit[]) => { this.apply(edits); this.commit(); };
  audit = () => { this.update({ auditProgress: { scanned: 0, total: 0 } }); this.send('audit:start', {}); };
  sampleScreenColor = () => new Promise<string | undefined>((resolve, reject) => { if (this.screenColorRequest) this.screenColorRequest.resolve(undefined); this.screenColorRequest = { resolve, reject }; this.send('eyedropper:arm', {}); });
  cancelAudit = () => { this.send('audit:cancel', {}); this.update({ auditProgress: null }); };
}
