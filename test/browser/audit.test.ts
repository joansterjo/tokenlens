import { expect, test } from 'vitest';
import { auditPage } from '../../src/adapters/audit-live';
import { cssPath } from '../../src/adapters/capture-live';
async function fixture(name: string, run: (doc: Document) => Promise<void>) {
  const html = await (await fetch(`/test/fixtures/${name}.html`)).text();
  const frame = document.createElement('iframe'); frame.style.cssText = 'position:absolute;left:-10000px;width:1000px;height:700px';
  document.body.append(frame);
  await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.srcdoc = html; });
  try { await run(frame.contentDocument!); } finally { frame.remove(); }
}
test('audit finds planted hardcoded brand, near duplicate, page-scoped orphan and low contrast', async () => {
  await fixture('13-design-system', async doc => {
    const result = await auditPage(new AbortController().signal, () => {}, doc);
    expect(result.findings.some(f => f.type === 'hardcoded' && f.selector === '.hardcoded')).toBe(true);
    expect(result.findings.some(f => f.type === 'duplicate' && f.message.includes('--brand-near'))).toBe(true);
    expect(result.findings.some(f => f.type === 'orphan' && f.token === '--orphan-token')).toBe(true);
    expect(result.findings.some(f => f.type === 'contrast' && f.selector === cssPath(doc.querySelector('.low-contrast')!))).toBe(true);
    expect(result.findings.some(f => f.type === 'orphan' && f.token === '--brand-500')).toBe(false);
    expect(result.tokens.find(t => t.name === '--action-bg')?.consumers).toBeGreaterThan(0);
  });
});
test('audit supports cancellation during a large scan', async () => {
  await fixture('07-heavy', async doc => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), 1);
    await expect(auditPage(controller.signal, () => {}, doc)).rejects.toMatchObject({ name: 'AbortError' });
    expect(doc.querySelector('span[style*="visibility: hidden"]')).toBeNull();
  });
});
