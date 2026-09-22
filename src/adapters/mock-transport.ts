import type { Transport } from '../core/ports';
import type { Edit, ElementTokenReport } from '../core/model';
import type { Envelope } from '../transport/protocol';
import demo from '../../test/fixtures/report-01.json';

/** Explicitly labeled demo mode, never used in an extension DevTools context. */
export function createMockTransport(): Transport {
  const listeners = new Set<(m: Envelope) => void>();
  let edits: Edit[] = [];
  const report = structuredClone(demo) as ElementTokenReport;
  const emit = (m: Envelope) => queueMicrotask(() => listeners.forEach(f => f(m)));
  return {
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    send(m) {
      if (m.type === 'resync') emit({ ...m, type: 'resync', payload: { report, edits } });
      if (m.type === 'pick:start' || m.type === 'report:request') emit({ ...m, type: 'report:result', payload: report });
      if (m.type === 'edit:apply') {
        const incoming = (m.payload as { edits: Edit[] }).edits;
        const map = new Map(edits.map(e => [e.id, e])); incoming.forEach(e => map.set(e.id, { ...e, verified: true, rung: 'doubled' })); edits = [...map.values()];
        emit({ ...m, type: 'edit:verified', payload: { edits, diagnostics: [] } });
      }
      if (m.type === 'edit:revert') { const p = m.payload as { ids?: string[]; all?: boolean }; edits = p.all ? [] : edits.filter(e => !p.ids?.includes(e.id)); emit({ ...m, type: 'edit:verified', payload: { edits, diagnostics: [] } }); }
      if (m.type === 'audit:start') emit({ ...m, type: 'audit:result', payload: { tokens: Object.values(report.tokensInScope).map(t => ({ name: t.name, value: t.terminalValue, category: t.category, consumers: 3, scopes: [':root'] })), findings: [], total: 12, scanned: 12, truncated: false } });
    },
  };
}
