import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { captureElement } from '../../../src/adapters/capture-live';
import { App } from '../../../src/panel/App';
import { PanelStore } from '../../../src/panel/store';
import type { ElementTokenReport } from '../../../src/core/model';
import type { Envelope } from '../../../src/transport/protocol';

let root: Root | undefined;
let container: HTMLDivElement;
let fixture: HTMLIFrameElement;
let store: PanelStore | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  container.style.cssText = 'width:1200px;height:720px';
  document.body.append(container);
  fixture = document.createElement('iframe');
  fixture.style.cssText = 'position:absolute;left:-10000px;width:400px;height:300px';
  document.body.append(fixture);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  store?.dispose();
  store = undefined;
  container.remove();
  fixture.remove();
});

async function capture(cssValue: string, svg = false): Promise<ElementTokenReport> {
  const markup = svg ? '<svg width="100" height="80"><rect id="target" class="icon" width="80" height="60"/></svg>' : '<button id="target">Inspect a live element</button>';
  await new Promise<void>(resolve => {
    fixture.onload = () => resolve();
    fixture.srcdoc = `<style>:root{--color-sample:${cssValue}}#target{background-color:var(--color-sample);color:var(--color-sample);fill:var(--color-sample);box-shadow:0px 4px 12px currentColor}</style>${markup}`;
  });
  return captureElement(fixture.contentDocument!.querySelector('#target')!);
}

async function mount(report: ElementTokenReport) {
  let receive: (message: Envelope) => void = () => {};
  store = new PanelStore({
    on(listener) { receive = listener; return () => {}; },
    send(message) {
      if (message.type === 'resync') queueMicrotask(() => receive({ ...message, payload: { report, edits: [] } }));
    },
  });
  root = createRoot(container);
  await act(async () => root!.render(createElement(App, { store: store!, demo: true })));
  expect(container.querySelector('.app')).not.toBeNull();
  expect(container.querySelector('.pick-button')?.textContent).toContain('Pick element');
  // A subsequent Pick action rerenders the same report while awaiting the next
  // page selection. The complete panel must remain mounted through that update.
  await act(async () => container.querySelector<HTMLButtonElement>('.pick-button')!.click());
  expect(container.querySelector('.pick-button')?.textContent).toContain('Picking');
}

describe('panel resilience with browser-captured page colors', () => {
  it.each([
    ['missing OKLCH chroma', 'oklch(0.5 none none)'],
    ['all missing OKLCH channels', 'oklch(none none none)'],
    ['missing alpha', 'oklch(.5 .2 240 / none)'],
    ['non-finite color channels', 'oklch(.5 1e999 90)'],
    ['missing RGB channels', 'rgb(none none none)'],
    ['currentColor keyword', 'currentColor'],
    ['inherit keyword', 'inherit'],
    ['initial keyword', 'initial'],
    ['unset keyword', 'unset'],
    ['mixed color', 'color-mix(in srgb, red 30%, blue)'],
    ['light-dark color', 'light-dark(white, black)'],
    ['system color', 'CanvasText'],
    ['empty custom property', ''],
    ['invalid custom property', 'not-a-color('],
    ['relative RGB color', 'rgb(from red r g b / 50%)'],
    ['wide gamut color', 'color(display-p3 1 0.2 0.3)'],
  ])('keeps the editor mounted for %s', async (_name, value) => {
    await mount(await capture(value));
  });

  it('renders a selected SVG element using contextual fill and shadow colors', async () => {
    await mount(await capture('currentColor', true));
    expect(container.textContent).toContain('rect');
  });
});
