import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../../src/panel/App';
import { PanelStore } from '../../../src/panel/store';
import { createMockTransport } from '../../../src/adapters/mock-transport';
import type { Envelope } from '../../../src/transport/protocol';
import type { Edit } from '../../../src/core/model';

let root: Root; let container: HTMLDivElement; let store: PanelStore; let sent: Envelope[];
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)!;
const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function click(element: HTMLElement) { expect(element).toBeTruthy(); await act(async () => element.click()); }
async function fill(input: HTMLInputElement, value: string) {
  expect(input).toBeTruthy();
  await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function blur(input: HTMLInputElement) { await act(async () => input.blur()); }
const lastEdits = () => (sent.filter(m => m.type === 'edit:apply' && (m.payload as { edits: Edit[] }).edits.length).at(-1)?.payload as { edits: Edit[] }).edits;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = []; const transport = createMockTransport();
  store = new PanelStore({ on: transport.on, send: message => { sent.push(message); transport.send(message); } });
  container = document.createElement('div'); container.style.width = '1200px'; container.style.height = '720px'; document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(App, { store, demo: true })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); store.dispose(); });

describe('panel live editing flows', () => {
  it('edits a color immediately, changes scope, and undoes the whole interaction', async () => {
    await fill(field('CSS color'), '#00aa88'); await blur(field('CSS color'));
    expect(lastEdits()[0].to).toBe('#00aa88'); expect(lastEdits()[0].mode).toBe('token');
    const elementScope = container.querySelector<HTMLButtonElement>('.scope-switch button:last-child')!;
    await click(elementScope); await fill(field('CSS color'), '#cc2288'); await blur(field('CSS color'));
    expect(lastEdits().at(-1)?.mode).toBe('element');
    expect(lastEdits().at(-1)?.scopeSelector).toBe('[data-testid="primary-action"]');
    await click(button('Undo')); expect(store.getSnapshot().edits).toHaveLength(1);
    await click(button('Redo')); expect(store.getSnapshot().edits).toHaveLength(2);
  });
  it('keeps invalid color text from changing the live preview', async () => {
    await fill(field('CSS color'), '#123456');
    const count = sent.length;
    await fill(field('CSS color'), 'banana(');
    expect(sent).toHaveLength(count);
    expect(container.textContent).toContain('Enter a valid CSS color');
    expect(store.getSnapshot().edits[0].to).toBe('#123456');
  });
  it('edits a numeric token and changes its unit without a submit button', async () => {
    await click([...container.querySelectorAll<HTMLButtonElement>('.token-row')].find(row => row.textContent?.includes('--space-4'))!);
    await fill(field('space-4'), '24'); await blur(field('space-4'));
    expect(lastEdits()[0].to).toBe('24px');
    const unit = container.querySelector<HTMLSelectElement>('select[aria-label="space-4 unit"]')!;
    await act(async () => { unit.value = 'rem'; unit.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(lastEdits()[0].to).toBe('24rem');
  });
  it('adds and edits independent shadow layers', async () => {
    await click([...container.querySelectorAll<HTMLButtonElement>('.token-row')].find(row => row.textContent?.includes('--shadow-button'))!);
    await click(button('Add shadow layer'));
    expect(lastEdits()[0].to).toContain(', 0px 4px 16px 0px rgb(0 0 0 / 0.12)');
    const blurInput = container.querySelector<HTMLInputElement>('input[aria-label="blur"]')!;
    await fill(blurInput, '20'); await blur(blurInput);
    expect(lastEdits()[0].to).toContain('20px');
    await click(button('Delete layer 2')); expect(lastEdits()[0].to).not.toContain('0.12');
  });
  it('keeps a literal property edit visible when switching from the token list', async () => {
    await click(button('Properties'));
    await fill(field('CSS color'), '#00aaff'); await blur(field('CSS color'));
    expect(field('CSS color').value).toBe('#00aaff');
    expect(lastEdits()[0].mode).toBe('element'); expect(lastEdits()[0].property).toBe('background-color');
  });
  it('exports the verified edits and independently reverts one change', async () => {
    await fill(field('CSS color'), '#ff8800'); await blur(field('CSS color'));
    await click(button('Export'));
    const output = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Exported CSS"]')!;
    expect(output.value).toContain('#ff8800'); expect(output.value).toContain('tokenlens-session v1');
    await click(container.querySelector<HTMLButtonElement>('.edit-row button[aria-label^="Revert edit"]')!);
    expect(store.getSnapshot().edits).toHaveLength(0);
  });
});
