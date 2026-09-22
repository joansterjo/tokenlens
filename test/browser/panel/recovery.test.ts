import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../../src/panel/App';
import { ErrorBoundary } from '../../../src/panel/ErrorBoundary';
import { PanelStore, buildEdits, reportItems } from '../../../src/panel/store';
import { parseSession } from '../../../src/core/emit';
import type { ElementTokenReport } from '../../../src/core/model';
import type { Envelope } from '../../../src/transport/protocol';
import { VERSION } from '../../../src/shared/version';
import fixture from '../../fixtures/report-01.json';

let root: Root;
let container: HTMLDivElement;
let store: PanelStore;
let deliver: (message: Envelope) => void;
let sent: Envelope[];

function report(documentId = 'recovery-document', frameId = 0): ElementTokenReport {
  const result = structuredClone(fixture) as ElementTokenReport;
  result.element.ref.documentId = documentId;
  result.element.ref.frameId = frameId;
  return result;
}

function receiveReport(next: ElementTokenReport) {
  deliver({ v: 1, id: crypto.randomUUID(), type: 'report:result', payload: next });
}

function editCurrentReport() {
  const current = store.getSnapshot().report!;
  store.apply(buildEdits(current, reportItems(current, 'used')[0], '#2277dd', 'global'));
  store.commit();
}

function FailingSelection() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (snapshot.report) throw new Error('Cannot render color from https://private.example/customer?token=secret');
  return createElement('p', null, `Ready to pick again; ${snapshot.edits.length} edits retained.`);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  store = new PanelStore({ on: listener => { deliver = listener; return () => {}; }, send: message => sent.push(message) });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  store.dispose();
  container.remove();
  vi.restoreAllMocks();
});

describe('panel error recovery', () => {
  it('keeps edits exportable after a render failure and retries without losing history', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const blobs: Blob[] = [];
    const downloads: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(value => {
      if (value instanceof Blob) blobs.push(value);
      return 'blob:tokenlens-recovery-test';
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    receiveReport(report());
    editCurrentReport();
    const before = store.getSnapshot();
    await act(async () => root.render(createElement(ErrorBoundary, { store, onRetry: store.recoverEditor, children: createElement(FailingSelection) })));

    expect(container.textContent).toContain('The editor hit a problem.');
    expect(container.textContent).toContain(`v${VERSION}`);
    expect(container.querySelector('pre')?.textContent).toContain('Cannot render color from [URL omitted]');
    expect(container.querySelector('pre')?.textContent).not.toContain('private.example');
    expect(logged.mock.calls.some(call => call[0] === 'TokenLens editor failed')).toBe(true);
    const button = (text: string) => [...container.querySelectorAll('button')].find(element => element.textContent === text)!;
    await act(async () => button('Save session JSON').click());
    await act(async () => button('Save CSS').click());
    expect(downloads).toEqual(['tokenlens-recovery-session.json', 'tokenlens-recovery-overrides.css']);
    expect(parseSession(await blobs[0].text()).edits[0].to).toBe('#2277dd');
    expect(await blobs[1].text()).toContain('#2277dd');
    expect(store.getSnapshot().edits).toEqual(before.edits);

    await act(async () => button('Retry editor').click());
    expect(container.textContent).toContain('Ready to pick again; 1 edits retained.');
    expect(store.getSnapshot().report).toBeNull();
    expect(store.getSnapshot().edits).toEqual(before.edits);
    expect(store.getSnapshot().undoCount).toBe(before.undoCount);
    await act(async () => store.undo());
    expect(store.getSnapshot().edits).toHaveLength(0);
  });

  it.each(['document', 'frame'])('preserves the recovery session identity until a different %s is inspected', kind => {
    receiveReport(report());
    editCurrentReport();
    store.recoverEditor();
    store.pick();
    expect(sent.at(-1)).toMatchObject({ type: 'pick:start', documentId: 'recovery-document', frameId: 0 });

    receiveReport(report());
    expect(store.getSnapshot().edits).toHaveLength(1);
    expect(store.getSnapshot().undoCount).toBe(1);
    store.recoverEditor();
    receiveReport(report(kind === 'document' ? 'another-document' : 'recovery-document', kind === 'frame' ? 1 : 0));
    expect(store.getSnapshot().edits).toHaveLength(0);
    expect(store.getSnapshot().undoCount).toBe(0);
    expect(store.getSnapshot().redoCount).toBe(0);
  });

  it('opens and changes theme when browser preference storage is unavailable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
    await act(async () => root.render(createElement(ErrorBoundary, { store, children: createElement(App, { store, demo: true }) })));
    expect(container.textContent).toContain('Pick your first element');
    expect(container.textContent).not.toContain('The editor hit a problem.');
    const previousTheme = document.documentElement.dataset.theme;
    const themeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Light theme"],button[aria-label="Dark theme"]')!;
    await act(async () => themeButton.click());
    expect(document.documentElement.dataset.theme).not.toBe(previousTheme);
    expect(warning.mock.calls.some(call => call[0] === 'TokenLens could not read its theme preference')).toBe(true);
    expect(warning.mock.calls.some(call => call[0] === 'TokenLens could not save its theme preference')).toBe(true);
    expect(container.textContent).not.toContain('The editor hit a problem.');
  });
});
