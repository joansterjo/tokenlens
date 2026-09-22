import { describe, expect, it } from 'vitest';
import { PanelStore, buildEdits, reportItems } from '../../../src/panel/store';
import type { ElementTokenReport, ResolvedToken } from '../../../src/core/model';
import type { Envelope } from '../../../src/transport/protocol';
import reportJson from '../../fixtures/report-01.json';
const report = reportJson as ElementTokenReport;
function setup() {
  let receive: (m: Envelope) => void = () => {};
  const sent: Envelope[] = [];
  const store = new PanelStore({ send: m => sent.push(m), on: f => { receive = f; return () => {}; } });
  receive({ v: 1, id: 'report', type: 'report:result', payload: report });
  return { store, sent, receive };
}

describe('scope and reversible editing', () => {
  it('writes every declaring scope for a global token edit, preserving conditions', () => {
    const item = reportItems(report, 'all')[0];
    const token = { ...item.token!, scopes: [
      { selector: ':root', value: '#fff', ctx: { media: null, supports: null, layerPath: [], container: null } },
      { selector: '[data-theme="dark"]', value: '#000', ctx: { media: '(prefers-color-scheme: dark)', supports: null, layerPath: ['theme'], container: null } },
    ] } satisfies ResolvedToken;
    const edits = buildEdits(report, { ...item, token }, '#f00', 'global');
    expect(edits).toHaveLength(2); expect(edits[0].rung).toBe('doubled'); expect(edits[1].ctx.media).toBe('(prefers-color-scheme: dark)'); expect(edits[0].from).toBe('#fff');
    const scoped = buildEdits(report, { ...item, token }, '#f00', 'scope', 1);
    expect(scoped).toHaveLength(1); expect(scoped[0].scopeSelector).toBe('[data-theme="dark"]');
  });
  it('uses the inspected tree scope and selector for an element-local edit', () => {
    const item = reportItems(report, 'all')[0];
    const innerReport = structuredClone(report); innerReport.element.ref.treeScope = { id: 'shadow:card', kind: 'shadow', depth: 1, hostPath: '#card' };
    const edit = buildEdits(innerReport, item, '#f00', 'element')[0];
    expect(edit.mode).toBe('element'); expect(edit.treeScope.id).toBe('shadow:card'); expect(edit.scopeSelector).toBe(report.element.ref.cssPath);
  });
  it('coalesces 200 pointer changes into one undo entry and preserves the original value', () => {
    const { store, sent } = setup(); const item = reportItems(report, 'all')[0];
    store.begin();
    for (let i = 0; i < 200; i++) store.apply(buildEdits(report, item, `${i}px`, 'global'));
    store.commit();
    expect(store.getSnapshot().undoCount).toBe(1);
    expect(store.getSnapshot().edits[0].to).toBe('199px');
    store.undo(); expect(store.getSnapshot().edits).toHaveLength(0);
    expect(sent.some(m => m.type === 'edit:revert')).toBe(true);
    store.redo(); expect(store.getSnapshot().edits[0].to).toBe('199px');
  });
  it('cancels a drag without adding undo history', () => {
    const { store } = setup(); const item = reportItems(report, 'all')[0];
    store.apply(buildEdits(report, item, '#f00', 'global')); store.cancel();
    expect(store.getSnapshot().edits).toHaveLength(0); expect(store.getSnapshot().undoCount).toBe(0);
  });
  it('rejects stale verification responses and clears selection on navigation', () => {
    const { store, receive } = setup(); const item = reportItems(report, 'all')[0];
    const first = buildEdits(report, item, '#f00', 'global'); store.apply(first);
    const second = buildEdits(report, item, '#00f', 'global'); store.apply(second);
    receive({ v: 1, id: 'verify', type: 'edit:verified', payload: { edits: first.map(e => ({ ...e, verified: true })), diagnostics: [] } });
    expect(store.getSnapshot().edits[0].to).toBe('#00f'); expect(store.getSnapshot().edits[0].verified).toBe(false);
    receive({ v: 1, id: 'nav', type: 'nav:changed', payload: {} });
    expect(store.getSnapshot().report).toBeNull(); expect(store.getSnapshot().edits).toHaveLength(0);
  });
  it('isolates an iframe session before edits or commits can cross document boundaries', () => {
    const { store, sent, receive } = setup();
    const item = reportItems(report, 'all')[0];
    const topEdit = buildEdits(report, item, '#f00', 'global')[0];
    store.apply([topEdit]); store.commit();
    const inner = structuredClone(report);
    inner.element.ref.documentId = 'iframe-document'; inner.element.ref.frameId = 3;
    receive({ v: 1, id: 'frame-pick', type: 'report:result', documentId: 'iframe-document', frameId: 3, payload: inner });
    expect(store.getSnapshot().edits).toEqual([]);
    expect(store.getSnapshot().undoCount).toBe(0);
    expect(sent.at(-1)?.type).toBe('resync'); expect(sent.at(-1)?.frameId).toBe(3);
    const innerEdit = buildEdits(inner, item, '#00f', 'global')[0];
    expect(innerEdit.id).not.toBe(topEdit.id);
    store.apply([innerEdit]); store.commit();
    const committed = sent.filter(m => m.type === 'edit:apply').at(-1)?.payload as { edits: typeof topEdit[] };
    expect(committed.edits.map(edit => edit.id)).toEqual([innerEdit.id]);
    receive({ v: 1, id: 'old-verify', type: 'edit:verified', documentId: report.element.ref.documentId, frameId: 0, payload: { edits: [{ ...innerEdit, verified: true }], diagnostics: [] } });
    expect(store.getSnapshot().edits[0].verified).toBe(false);
  });

  it('retains a pending local edit when an older resync snapshot arrives', () => {
    const { store, sent, receive } = setup(); const item = reportItems(report, 'all')[0];
    const edits = buildEdits(report, item, '#ffaa00', 'global');
    store.apply(edits); store.commit();
    receive({ v: 1, id: 'stale-resync', type: 'resync', payload: { report, edits: [] } });
    expect(store.getSnapshot().edits[0].to).toBe('#ffaa00');
    for (const mutation of sent.filter(m => m.type === 'edit:apply')) {
      receive({ v: 1, id: mutation.id, type: 'edit:verified', payload: { edits: edits.map(e => ({ ...e, verified: true })), diagnostics: [] } });
    }
    receive({ v: 1, id: 'current-resync', type: 'resync', payload: { report, edits: [] } });
    expect(store.getSnapshot().edits).toEqual([]);
  });

  it('rejects a stale disabled verification for a newly re-enabled edit', () => {
    const { store, receive } = setup(); const item = reportItems(report, 'all')[0];
    const edit = buildEdits(report, item, '#ffaa00', 'global')[0];
    store.apply([edit]); store.commit();
    store.toggle(edit.id); store.toggle(edit.id);
    receive({ v: 1, id: 'old-disable', type: 'edit:verified', payload: { edits: [{ ...edit, enabled: false, verified: true }], diagnostics: [] } });
    expect(store.getSnapshot().edits[0].enabled).toBe(true);
  });

});
