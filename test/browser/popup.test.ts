import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Popup } from '../../src/popup/main';
import type { ConnectionResponse, SiteConnection } from '../../src/shared/connection';

let root: Root;
let container: HTMLDivElement;
let status: SiteConnection;
let injectResponse: ConnectionResponse | undefined;
let grantAccess: boolean;
const requestPermission = vi.fn(async () => grantAccess);
const sendMessage = vi.fn(async (message: { type: string }) => {
  if (message.type === 'tokenlens:inject') {
    if (injectResponse?.status) status = injectResponse.status;
    return injectResponse;
  }
  return { ok: true, status };
});
const button = () => container.querySelector<HTMLButtonElement>('.popup-action')!;
const text = () => container.textContent ?? '';
const mount = async () => { root = createRoot(container); await act(async () => root.render(createElement(Popup))); };

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  status = { tabId: 7, url: 'https://example.com/design', hostname: 'example.com', supported: true, hasPermission: false, connected: false, devtoolsOpen: false };
  injectResponse = { ok: true, status: { ...status, hasPermission: true, connected: true } };
  grantAccess = true;
  requestPermission.mockClear();
  sendMessage.mockClear();
  vi.stubGlobal('chrome', { runtime: { id: 'tokenlens-test', sendMessage }, tabs: { query: vi.fn(async () => [{ id: 7, url: status.url }]) }, permissions: { request: requestPermission } });
  container = document.createElement('div'); document.body.append(container);
  await mount();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('popup connection onboarding', () => {
  it('requests permission in the click gesture and confirms the inspector before showing connected', async () => {
    expect(button().textContent).toBe('Connect this site');
    await act(async () => {
      button().click();
      expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'tokenlens:inject', tabId: 7 });
    expect(container.querySelector('h1')?.textContent).toBe('Connected. Now open DevTools.');
    expect(text()).toContain('Inspector ready');
    expect(button().textContent).toBe('Close popup — open DevTools');
  });

  it('restores readiness when the popup reopens instead of offering to connect again', async () => {
    await act(async () => button().click());
    await act(async () => root.unmount());
    await mount();
    expect(text()).toContain('Connected. Now open DevTools.');
    expect(text()).toContain('Site access allowed');
    expect(text()).not.toContain('Connect this site');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('gives recovery guidance when a manual panel check still cannot find DevTools', async () => {
    await act(async () => button().click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh status"]')!.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('close and reopen it');
  });

  it('keeps a denied permission visible through automatic status refresh', async () => {
    grantAccess = false;
    await act(async () => button().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Site access was not granted');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Site access was not granted');
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'tokenlens:inject')).toBe(false);
    expect(text()).toContain('Inspector waiting');
  });

  it('does not interpret a missing background response as success', async () => {
    injectResponse = undefined;
    await act(async () => button().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The inspector did not connect');
    expect(text()).toContain('Inspector waiting');
    expect(text()).not.toContain('Inspector ready');
  });

  it('reconnects an allowed site without requesting permission again', async () => {
    status = { ...status, hasPermission: true };
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(button().textContent).toBe('Connect page inspector');
    await act(async () => button().click());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(text()).toContain('Inspector ready');
  });

  it('closes the popup with a clear manual tab instruction instead of promising to open a panel', async () => {
    status = { ...status, hasPermission: true, connected: true, devtoolsOpen: true };
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('h1')?.textContent).toBe('Connected. Choose Tokens.');
    expect(button().textContent).toBe('Close popup — choose Tokens');
    expect(text()).not.toContain('Open Tokens panel');
    await act(async () => button().click());
    expect(sendMessage.mock.calls.every(([message]) => message.type === 'tokenlens:status')).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('explains unsupported pages and never offers a connection prompt', async () => {
    status = { ...status, url: 'chrome://extensions/', hostname: 'chrome://extensions', supported: false, reason: 'Chrome protects its internal pages. Open a regular website.' };
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(text()).toContain('Open a website to begin.');
    expect(text()).toContain('Chrome protects its internal pages');
    expect(button().textContent).toBe('Check again');
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
